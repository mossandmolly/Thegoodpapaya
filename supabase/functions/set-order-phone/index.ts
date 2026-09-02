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
// Writes to two places:
//   1. orders.phone for THIS order — so it's picked up immediately by
//      anything reading it right away (mark-delivered's switchToPaymentLink
//      if the rider marks it delivered-unpaid later today, generate-invoice's
//      payment-link step, Order Overview's own display).
//   2. customer_phones (customer_name, phone) — so orders_fill_phone_from_
//      customer (migration 102) auto-fills every SUBSEQUENT order for this
//      same customer, no re-entry needed. Upserted, not deleted-and-
//      replaced: a customer can have more than one number on file (e.g. a
//      prior Zoho-synced one) — the backfill trigger prefers whichever was
//      added most recently.
//
// Deliberately does NOT touch invoice_status, QR, or payment links itself —
// an order can be OFD (or delivered) with no phone at all; this just makes
// one available going forward. mark-delivered's own switchToPaymentLink
// already fires the actual payment-link creation when needed.
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

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

// Same rule as parser.html's isValidPhoneForPayment — Razorpay's own
// contact-field constraint (8-14 chars) is the practical floor/ceiling
// here too, so a stray non-phone value can't sail through and only fail
// opaquely later at Razorpay.
function isValidPhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 14;
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    await requireAuth(req);
    const { sales_order_id, phone: rawPhone } = await req.json();
    if (!sales_order_id) throw new Error('Missing sales_order_id');
    const phone = (rawPhone || '').trim();
    if (!phone) throw new Error('Missing phone number');
    if (!isValidPhone(phone)) throw new Error('Phone number must be 8-14 digits');

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    const { data: order, error: orderErr } = await supabase
      .from('orders').select('customer_name').eq('sales_order_id', sales_order_id).single();
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

    return new Response(
      JSON.stringify({ sales_order_id, phone }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
