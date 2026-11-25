// Supabase Edge Function — cancel-order-item
//
// Customer-facing single-item cancellation from My Orders (storefront/
// orders.html) — the same soft-cancel the ops dashboard's own item-level
// "✕" already does (order_items.status = 'cancelled', pre_cancel_status
// recorded, migration 074 — same shape staff's own Uncancel could
// restore), just reachable without a staff login, since there's no
// customer account to authenticate instead. Ownership is verified by
// phone match against the order (same normalization the storefront's own
// lookup RPCs already use), not a server-side identity.
//
// Never a hard delete — a customer can only ever soft-cancel, matching
// "Cancel for packing" from the ops dashboard, never "Delete clean".
// Only usable on an order that hasn't been invoiced yet — My Orders
// itself already only shows these; this is defense in depth against a
// tampered request.
//
// If this cancellation leaves every item on the order cancelled, the
// order itself is closed out too (orders.status = 'cancelled') — an
// order reachable from My Orders is never invoiced yet by definition, so
// there's no Zoho invoice/Razorpay link to clean up the way the
// staff-only cancel-order function has to.
//
// Input:  { sales_order_id, item_id, phone }
// Output: { cancelled: true, order_cancelled: boolean }
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
  'Access-Control-Allow-Headers': 'Content-Type',
};

function normalizePhone(raw: unknown): string {
  return String(raw || '').replace(/^\+91/, '').replace(/\D/g, '');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const { sales_order_id, item_id, phone } = await req.json();
    if (!sales_order_id) throw new Error('Missing sales_order_id');
    if (!item_id) throw new Error('Missing item_id');
    const normalPhone = normalizePhone(phone);
    if (!/^\d{10}$/.test(normalPhone)) throw new Error('Invalid phone number');

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    const { data: order, error: orderErr } = await supabase
      .from('orders').select('sales_order_id, phone, invoice_status')
      .eq('sales_order_id', sales_order_id).maybeSingle();
    if (orderErr) throw new Error(orderErr.message);
    if (!order) throw new Error('Order not found');

    if (normalizePhone(order.phone) !== normalPhone) {
      throw new Error('This order does not belong to that phone number');
    }
    if ((order.invoice_status ?? 'pending') === 'done') {
      throw new Error('This order has already been invoiced and can no longer be changed here.');
    }

    const { data: item, error: itemErr } = await supabase
      .from('order_items').select('id, sales_order_id, status')
      .eq('id', item_id).maybeSingle();
    if (itemErr) throw new Error(itemErr.message);
    if (!item || item.sales_order_id !== sales_order_id) throw new Error('Item not found on this order');
    if (item.status === 'cancelled') throw new Error('This item is already cancelled');

    const { error: updateErr } = await supabase.from('order_items')
      .update({
        status: 'cancelled',
        pre_cancel_status: item.status,
        // Distinguishes this from the ops dashboard's own staff-initiated
        // soft-cancel, which never sets these — order_items.status alone
        // looks identical either way (migration 172).
        self_cancelled: true,
        self_cancelled_at: new Date().toISOString(),
      })
      .eq('id', item_id);
    if (updateErr) throw new Error(updateErr.message);

    // If every item on this order is now cancelled, close the order out
    // too — never a Zoho/Razorpay cleanup needed here, since an order
    // reachable from My Orders is never invoiced yet by definition.
    const { data: remaining, error: remainingErr } = await supabase
      .from('order_items').select('status').eq('sales_order_id', sales_order_id);
    if (remainingErr) throw new Error(remainingErr.message);
    const allCancelled = (remaining ?? []).every(r => r.status === 'cancelled');
    if (allCancelled) {
      await supabase.from('orders').update({ status: 'cancelled' }).eq('sales_order_id', sales_order_id);
    }

    return new Response(
      JSON.stringify({ cancelled: true, order_cancelled: allCancelled }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
