// Supabase Edge Function — create-order-payment-link
//
// Creates (or recreates) a Razorpay payment link for an already-invoiced
// order and stores it back on the orders row — separate from
// create-payment-link, which serves the public shop checkout and has no
// concept of sales_order_id/orders at all.
//
// Input:  { sales_order_id: string, phone?: string }
// Output: { payment_url, razorpay_link_id }
//
// phone is optional if the order already has one on file; if provided it's
// persisted onto orders.phone so future regenerations don't need to ask
// again. If neither is available, this fails with "Missing phone number".
//
// If the order already has a razorpay_link_id (e.g. this is a re-generate
// after the invoice amount changed), the old link is cancelled first
// (best-effort) so a customer can't pay a stale link with the wrong amount.
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
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
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
      notify:          { sms: true, email: false },
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
    const { sales_order_id, phone: inputPhone } = await req.json();
    if (!sales_order_id) throw new Error('Missing sales_order_id');

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    const { data: order, error: orderErr } = await supabase
      .from('orders').select('*').eq('sales_order_id', sales_order_id).single();
    if (orderErr || !order) throw new Error(`Order ${sales_order_id} not found`);
    if (order.invoice_status !== 'done' || !order.invoice_total) {
      throw new Error('Order has not been invoiced yet');
    }

    const phone = (inputPhone || order.phone || '').trim();
    if (!phone) throw new Error('Missing phone number');

    const keyId     = env('RAZORPAY_KEY_ID');
    const keySecret = env('RAZORPAY_KEY_SECRET');
    const auth      = btoa(`${keyId}:${keySecret}`);

    if (order.razorpay_link_id) {
      await cancelPaymentLink(order.razorpay_link_id, auth);
    }

    const amountPaise = Math.round(order.invoice_total * 100);
    const link = await createPaymentLink(amountPaise, order.customer_name, phone, sales_order_id, auth);

    await supabase.from('orders').update({
      phone,
      razorpay_link_id: link.id,
      razorpay_url:     link.short_url,
    }).eq('sales_order_id', sales_order_id);

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
