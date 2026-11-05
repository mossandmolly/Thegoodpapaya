// Supabase Edge Function — create-storefront-bulk-payment-link
//
// "Pay All" — creates ONE Razorpay payment link covering every pending
// (unpaid/partially-paid) invoice currently shown to this phone number on
// the storefront, instead of making the customer pay each one separately.
//
// SECURITY: no login check, same posture as create-storefront-payment-link —
// but there's no separate ownership check needed here at all, because the
// list of orders to charge is derived entirely from get_invoices_by_phone
// for the phone number passed in. That RPC only ever returns invoices whose
// invoice_line_items.phone_number matches — the exact same boundary the
// normal "View My Invoices" lookup already relies on. A caller can never
// steer this towards someone else's order.
//
// Input:  { phone: string }
// Output: { payment_url, razorpay_link_id, sales_order_ids: string[], amount }
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
  'Access-Control-Allow-Headers': 'Content-Type, apikey, Authorization',
};

async function cancelPaymentLink(linkId: string, auth: string): Promise<void> {
  await fetch(`https://api.razorpay.com/v1/payment_links/${linkId}/cancel`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}` },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const { phone: rawPhone } = await req.json();
    const phone = String(rawPhone || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
    if (!/^\d{10}$/.test(phone)) throw new Error('Invalid phone number');

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    // Same two-form lookup the storefront itself does (bare vs +91-prefixed
    // — whichever one actually has rows in invoice_line_items.phone_number).
    let { data: rows, error: rpcErr } = await supabase.rpc('get_invoices_by_phone', { p_phone: phone });
    if (!rpcErr && (!rows || !rows.length)) {
      ({ data: rows, error: rpcErr } = await supabase.rpc('get_invoices_by_phone', { p_phone: '+91' + phone }));
    }
    if (rpcErr) throw new Error(rpcErr.message);
    if (!rows || !rows.length) throw new Error('No invoices found for this number');

    // get_invoices_by_phone returns one row per line item — collapse to one
    // entry per invoice (same grouping storefront/invoices.html does
    // client-side), keep only the ones still owing money, and dedupe by
    // sales_order_id (an order could in principle appear more than once if
    // it was ever re-invoiced, though in practice it won't).
    const bySalesOrder = new Map<string, { customer_name: string; balance: number }>();
    for (const r of rows) {
      if (r.payment_status === 'paid') continue;
      const balance = +r.balance || 0;
      if (balance <= 0) continue;
      if (!r.sales_order_id || bySalesOrder.has(r.sales_order_id)) continue;
      bySalesOrder.set(r.sales_order_id, { customer_name: r.customer_name, balance });
    }

    if (bySalesOrder.size === 0) throw new Error('No pending invoices to pay');

    const breakdown = [...bySalesOrder.entries()].map(([sales_order_id, v]) => ({
      sales_order_id, amount: v.balance,
    }));
    const totalRupees = breakdown.reduce((sum, b) => sum + b.amount, 0);
    const amountPaise = Math.round(totalRupees * 100);
    const customerName = [...bySalesOrder.values()][0].customer_name;

    const keyId     = env('RAZORPAY_KEY_ID');
    const keySecret = env('RAZORPAY_KEY_SECRET');
    const auth      = btoa(`${keyId}:${keySecret}`);

    // Cancel whichever individual per-order links were already active —
    // once this bulk link is paid, those orders are fully settled, so a
    // customer paying the old individual link too (or trying to) should
    // never be possible. Best-effort: a cancel failure here shouldn't block
    // creating the real link customers are about to pay.
    for (const [salesOrderId] of bySalesOrder) {
      try {
        const { data: order } = await supabase
          .from('orders').select('razorpay_link_id').eq('sales_order_id', salesOrderId).maybeSingle();
        if (order?.razorpay_link_id) {
          await cancelPaymentLink(order.razorpay_link_id, auth);
          await supabase.from('orders')
            .update({ razorpay_link_id: null, razorpay_url: null })
            .eq('sales_order_id', salesOrderId);
        }
      } catch (e: any) {
        console.error(`[create-storefront-bulk-payment-link] cancel failed for ${salesOrderId}:`, e.message);
      }
    }

    const res = await fetch('https://api.razorpay.com/v1/payment_links', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount:   amountPaise,
        currency: 'INR',
        description: `The Good Papaya — ${breakdown.length} invoice${breakdown.length === 1 ? '' : 's'}`,
        customer: { name: customerName, contact: `+91${phone}` },
        notify:          { sms: true, whatsapp: true, email: false },
        reminder_enable: false,
        // Razorpay notes are short strings only — the real breakdown this
        // webhook actually needs lives in razorpay_bulk_payment_links,
        // keyed by this link's own id. sales_order_ids here is just for
        // anyone reading the Razorpay dashboard directly.
        notes: { sales_order_ids: breakdown.map(b => b.sales_order_id).join(','), phone, bulk: 'true' },
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.description || 'Razorpay error');

    const { error: insertErr } = await supabase.from('razorpay_bulk_payment_links').insert({
      razorpay_link_id: data.id,
      phone,
      breakdown,
    });
    if (insertErr) {
      // Without this row the webhook can't split the payment when it lands
      // — cancel the link rather than leave a payable-but-unsplittable one.
      await cancelPaymentLink(data.id, auth);
      throw new Error('Could not save payment breakdown: ' + insertErr.message);
    }

    return new Response(
      JSON.stringify({
        payment_url: data.short_url,
        razorpay_link_id: data.id,
        sales_order_ids: breakdown.map(b => b.sales_order_id),
        amount: totalRupees,
      }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
