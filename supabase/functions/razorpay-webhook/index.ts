// Supabase Edge Function — Razorpay payment webhook
//
// Verifies HMAC-SHA256 signature, then cumulatively adds the payment amount to
// orders.amount_paid and recalculates balance_due.
//
// Handles two event types, both requiring sales_order_id in notes:
//   - payment_link.paid  — the manual "Generate Payment Link" flow
//   - qr_code.credited   — the delivery-panel Dynamic QR (dispatch-order)
// amount_paid is never reset — it accumulates across all payments and invoice regenerations.
//
// Required secrets: RAZORPAY_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function env(key: string) {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Missing env: ${key}`);
  return val;
}

async function verifySignature(body: string, signature: string, secret: string): Promise<boolean> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const raw = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  const hex = Array.from(new Uint8Array(raw)).map(b => b.toString(16).padStart(2, '0')).join('');
  return hex === signature;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const body      = await req.text();
  const signature = req.headers.get('x-razorpay-signature') ?? '';

  const valid = await verifySignature(body, signature, env('RAZORPAY_WEBHOOK_SECRET'));
  if (!valid) return new Response(JSON.stringify({ error: 'Invalid signature' }), { status: 401 });

  let payload: any;
  try { payload = JSON.parse(body); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  if (payload.event !== 'payment_link.paid' && payload.event !== 'qr_code.credited') {
    return new Response(JSON.stringify({ ok: true, ignored: true }), { status: 200 });
  }

  const paymentEntity = payload.payload?.payment?.entity;
  const notesEntity    = payload.event === 'qr_code.credited'
    ? payload.payload?.qr_code?.entity
    : payload.payload?.payment_link?.entity;
  const salesOrderId  = notesEntity?.notes?.sales_order_id as string | undefined;
  const amountPaise   = paymentEntity?.amount as number | undefined;

  if (!salesOrderId) {
    console.warn('Razorpay webhook: no sales_order_id in notes');
    return new Response(JSON.stringify({ ok: true, msg: 'no sales_order_id' }), { status: 200 });
  }
  if (!amountPaise) {
    console.warn('Razorpay webhook: no payment amount');
    return new Response(JSON.stringify({ ok: true, msg: 'no amount' }), { status: 200 });
  }

  const amountRupees = amountPaise / 100;
  const supabase     = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

  // Load current amounts
  const { data: order, error: orderErr } = await supabase
    .from('orders')
    .select('amount_paid, invoice_total')
    .eq('sales_order_id', salesOrderId)
    .single();

  if (orderErr || !order) {
    console.error('Order not found for payment:', salesOrderId);
    return new Response(JSON.stringify({ ok: true, msg: 'order not found' }), { status: 200 });
  }

  const newAmountPaid = (order.amount_paid ?? 0) + amountRupees;
  const balanceDue    = Math.max(0, (order.invoice_total ?? 0) - newAmountPaid);

  const { error } = await supabase
    .from('orders')
    .update({ amount_paid: newAmountPaid, balance_due: balanceDue })
    .eq('sales_order_id', salesOrderId);

  if (error) console.error('Orders update failed:', error.message);

  return new Response(
    JSON.stringify({ ok: true, sales_order_id: salesOrderId, amount_added: amountRupees }),
    { headers: { 'Content-Type': 'application/json' } },
  );
});
