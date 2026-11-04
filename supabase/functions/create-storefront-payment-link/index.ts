// Supabase Edge Function — create-storefront-payment-link
//
// Public, unauthenticated twin of create-order-payment-link (which requires
// a logged-in ops session) — this is what storefront/invoices.html's "Pay
// Now" button calls when an invoice has no payment_link yet (most commonly:
// the order never had orders.phone set, so generate-invoice's own
// best-effort link creation skipped it — see that function's comment).
//
// SECURITY: this has no login check at all — anyone can call it with any
// sales_order_id + any phone. To stop that being used to attach a stranger's
// phone number to someone else's order (hijacking their payment link),
// the phone passed in MUST already match a phone_number on record for this
// exact invoice in invoice_line_items — the same phone-matching rule
// get_invoices_by_phone itself uses to find the invoice in the first place.
// In practice this means: only someone who could already see this invoice
// through the normal phone lookup can ever successfully call this for it.
//
// Input:  { sales_order_id: string, phone: string }
// Output: { payment_url, razorpay_link_id }
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function env(key: string) {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Missing env: ${key}`);
  return val;
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function cancelPaymentLink(linkId: string, auth: string): Promise<void> {
  await fetch(`https://api.razorpay.com/v1/payment_links/${linkId}/cancel`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}` },
  });
}

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
      notes: { sales_order_id: salesOrderId, source: 'storefront' },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.description || 'Razorpay error');
  return { id: data.id, short_url: data.short_url };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const { sales_order_id, phone: rawPhone } = await req.json();
    if (!sales_order_id) throw new Error('Missing sales_order_id');
    const phone = String(rawPhone || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
    if (!/^\d{10}$/.test(phone)) throw new Error('Invalid phone number');

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    const { data: order, error: orderErr } = await supabase
      .from('orders').select('*').eq('sales_order_id', sales_order_id).single();
    if (orderErr || !order) throw new Error(`Order ${sales_order_id} not found`);
    if (order.invoice_status !== 'done' || !order.invoice_total) {
      throw new Error('Order has not been invoiced yet');
    }
    if ((order.balance_due ?? order.invoice_total) <= 0) {
      throw new Error('This invoice is already paid');
    }

    // The ownership check described above — same three phone forms
    // get_invoices_by_phone matches on (bare / +91-prefixed / stripped).
    const { data: matches, error: matchErr } = await supabase
      .from('invoice_line_items')
      .select('id')
      .eq('sales_order_id', sales_order_id)
      .or(`phone_number.eq.${phone},phone_number.eq.+91${phone}`)
      .limit(1);
    if (matchErr) throw new Error(matchErr.message);
    if (!matches || !matches.length) {
      throw new Error('This phone number is not on file for this invoice');
    }

    const keyId     = env('RAZORPAY_KEY_ID');
    const keySecret = env('RAZORPAY_KEY_SECRET');
    const auth      = btoa(`${keyId}:${keySecret}`);

    // Shouldn't normally happen — the frontend only calls this when
    // payment_link is already empty — but guards against a race (two tabs,
    // or a retry) the same way create-order-payment-link does.
    if (order.razorpay_link_id) {
      await cancelPaymentLink(order.razorpay_link_id, auth);
    }

    const amountPaise = Math.round(order.invoice_total * 100);
    const link = await createPaymentLink(amountPaise, order.customer_name, phone, sales_order_id, auth);

    await supabase.from('orders').update({
      phone,
      razorpay_link_id: link.id,
      razorpay_url:     link.short_url,
      admin_action_needed: false,
      admin_action_reason: null,
    }).eq('sales_order_id', sales_order_id);

    // No invoice_line_items write needed — get_invoices_by_phone reads
    // payment_link live from orders (migration 128), and phone_number on
    // invoice_line_items is already correct (that's how this invoice was
    // found at all).

    return new Response(
      JSON.stringify({ payment_url: link.short_url, razorpay_link_id: link.id }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
