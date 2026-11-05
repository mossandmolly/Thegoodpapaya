// Supabase Edge Function — set-order-phone
//
// Manual phone-number entry for a single order, from Order Overview's
// "+ Add phone" action — the only standing UI for typing a customer's
// phone in directly (previously this only ever happened as a side effect
// of generating a payment link, via create-order-payment-link).
//
// Input:  { sales_order_id: string, phone: string }
// Output: { sales_order_id, phone }
//
// Writes to three places:
//   1. orders.phone for THIS order — so it's picked up immediately by
//      anything reading it right away (Order Overview's own display, the
//      link-creation step below).
//   2. customer_phones (customer_name, phone) — so orders_fill_phone_from_
//      customer (migration 102) auto-fills every SUBSEQUENT order for this
//      same customer, no re-entry needed. Upserted, not deleted-and-
//      replaced: a customer can have more than one number on file (e.g. a
//      prior Zoho-synced one) — the backfill trigger prefers whichever was
//      added most recently.
//   3. invoice_line_items.phone_number for this order's existing invoice,
//      if it has one — that column (not orders.phone) is what
//      get_invoices_by_phone actually matches customers to invoices
//      through, frozen at whatever it was when generate-invoice ran. Without
//      this, a phone added after invoicing still leaves the customer unable
//      to find the invoice by searching the storefront themselves.
//
// Also creates a Razorpay payment link on the spot, best-effort, when this
// phone is the thing that was actually missing for one to exist: the order
// is already invoiced, still has a balance due, and has no QR or link
// active yet. That's the one real gap left once a phone gets added AFTER
// invoicing — generate-invoice's own link creation only ever runs once, at
// invoice time, and skips entirely when there's no phone yet (see its own
// comment); nothing used to pick it back up later. (mark-delivered used to
// cover this via switchToPaymentLink, removed earlier — this is its
// replacement, firing right when the missing phone shows up instead of
// waiting for a delivery-time check.) Never touches an order that already
// has a QR or link, invoiced or not — this only ever fills a genuine gap,
// never regenerates or interferes with something already active.
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function env(key: string) {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Missing env: ${key}`);
  return val;
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Strips whatever country code and spacing someone typed — "+91 98766
// 97877", "91-9876697877", "9876697877" all normalize to the same stored
// value. Country code length varies (91 is 2 digits, 1 is 1, others go up
// to 3), but the local mobile number itself is reliably 10 digits
// worldwide, so "keep only the last 10 digits once there are more than
// 10" is a simple rule that works regardless of which country code was
// typed, without needing to recognize country codes individually.
function normalizePhoneDigits(raw: string): string {
  const digits = (raw || '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

// Same rule as parser.html's isValidPhoneForPayment — applied to the
// already-normalized (country-code-stripped) value, so this is really just
// a local-number sanity floor/ceiling now, not meant to tolerate a
// still-prefixed number.
function isValidPhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 10;
}

// This function uses the service role internally, so it bypasses RLS
// regardless of who calls it — the anon key alone is enough to invoke it at
// the platform level. Requiring a real logged-in user session here is what
// actually restricts this to signed-in ops staff, same pattern as every
// other orders-mutating function in this app.
async function requireAuth(req: Request): Promise<void> {
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) throw new Error('Not authenticated');
  const res = await fetch(`${env('SUPABASE_URL')}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${jwt}`, apikey: env('SUPABASE_SERVICE_ROLE_KEY') },
  });
  if (!res.ok) throw new Error('Not authenticated');
}

// Same shape every other Razorpay link creation path in this app uses
// (generate-invoice, create-order-payment-link, create-storefront-payment-
// link) — notes.sales_order_id is what razorpay-webhook matches the
// eventual payment back to the order with, so this has to stay identical.
async function createPaymentLink(
  amountPaise: number, customerName: string, phone: string, salesOrderId: string, auth: string,
): Promise<{ id: string; short_url: string }> {
  const res = await fetch('https://api.razorpay.com/v1/payment_links', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount:   amountPaise,
      currency: 'INR',
      description: `The Good Papaya — order ${salesOrderId}`,
      customer: { name: customerName, contact: `+91${phone.replace(/^\+91/, '')}` },
      notify:          { sms: true, whatsapp: true, email: false },
      reminder_enable: false,
      notes: { sales_order_id: salesOrderId, source: 'ops-dashboard' },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.description || 'Razorpay error');
  return { id: data.id, short_url: data.short_url };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    await requireAuth(req);
    const { sales_order_id, phone: rawPhone } = await req.json();
    if (!sales_order_id) throw new Error('Missing sales_order_id');
    if (!(rawPhone || '').trim()) throw new Error('Missing phone number');
    const phone = normalizePhoneDigits(rawPhone);
    if (!isValidPhone(phone)) throw new Error('Phone number must be 8-10 digits (after removing country code)');

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .select('customer_name, invoice_status, invoice_total, balance_due, qr_code_id, razorpay_link_id')
      .eq('sales_order_id', sales_order_id).single();
    if (orderErr || !order) throw new Error(`Order ${sales_order_id} not found`);

    const { error: updateErr } = await supabase
      .from('orders').update({ phone }).eq('sales_order_id', sales_order_id);
    if (updateErr) throw new Error(updateErr.message);

    const { error: phoneErr } = await supabase
      .from('customer_phones')
      .upsert(
        { customer_name: order.customer_name, phone_number: phone, label: 'manual' },
        { onConflict: 'customer_name,phone_number' },
      );
    // Best-effort — the order itself is already updated above, which is
    // what today's flows (payment link, invoice lookup) actually need
    // right now. A failure here only means future orders won't auto-fill,
    // not that this save failed.
    if (phoneErr) console.error(`[set-order-phone] customer_phones upsert failed for "${order.customer_name}":`, phoneErr.message);

    // Backfill invoice_line_items.phone_number too — it's written once, at
    // invoice time, from whatever orders.phone was THEN (null, if this
    // phone was missing when generate-invoice ran), and get_invoices_by_
    // phone matches customers to invoices through THIS column, never
    // orders.phone. Without this, a phone added after invoicing lets a
    // payment link get created (see below) but the customer still can't
    // find the invoice at all by searching the storefront — only a direct
    // SMS/WhatsApp from Razorpay would ever reach them. No-op (0 rows) if
    // this order has no invoice yet.
    const { error: iliPhoneErr } = await supabase
      .from('invoice_line_items').update({ phone_number: phone }).eq('sales_order_id', sales_order_id);
    if (iliPhoneErr) console.error(`[set-order-phone] invoice_line_items phone backfill failed for ${sales_order_id}:`, iliPhoneErr.message);

    // The gap this closes: invoiced, still owed, and nothing active to pay
    // it with yet — the only reason that combination exists is this phone
    // was missing until right now. Never fires if a QR or link is already
    // there (nothing to fill), or the order isn't invoiced yet (generate-
    // invoice's own link creation will run when it is).
    let payment_url: string | null = null;
    const balanceDue = order.balance_due ?? order.invoice_total;
    const needsLink = order.invoice_status === 'done' && order.invoice_total
      && balanceDue > 0 && !order.qr_code_id && !order.razorpay_link_id;
    if (needsLink) {
      try {
        const keyId = Deno.env.get('RAZORPAY_KEY_ID'), keySecret = Deno.env.get('RAZORPAY_KEY_SECRET');
        if (keyId && keySecret) {
          const auth = btoa(`${keyId}:${keySecret}`);
          const link = await createPaymentLink(
            Math.round(order.invoice_total * 100), order.customer_name, phone, sales_order_id, auth,
          );
          await supabase.from('orders').update({
            razorpay_link_id: link.id, razorpay_url: link.short_url,
          }).eq('sales_order_id', sales_order_id);
          payment_url = link.short_url;
        } else {
          console.warn(`[set-order-phone] ${sales_order_id}: RAZORPAY_KEY_ID/SECRET not set — skipping pay link`);
        }
      } catch (e: any) {
        // Best-effort — the phone itself is already saved above regardless.
        console.error(`[set-order-phone] ${sales_order_id}: payment link creation failed: ${e.message}`);
      }
    }

    return new Response(
      JSON.stringify({ sales_order_id, phone, payment_url }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
