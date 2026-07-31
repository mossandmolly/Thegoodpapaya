// Supabase Edge Function — unassign-rider
//
// Reverses assign-rider for one order. If it's currently 'ofd', also resets
// delivery_status back to 'not_dispatched' (clearing dispatched_at) and
// un-collects every active item — a different rider taking over needs to
// physically re-verify/re-load the bag before re-triggering OFD themselves,
// not silently inherit the previous rider's collected-checkbox state.
//
// Only allowed pre-delivery — once an order is delivered or partially
// delivered, whoever did that work is part of the delivery record, not
// something to silently erase.
//
// Input:  { sales_order_id: string }
// Output: { sales_order_id, delivery_status, assigned_rider }
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function env(key: string) {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Missing env: ${key}`);
  return val;
}

async function requireAuth(req: Request): Promise<void> {
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) throw new Error('Not authenticated');
  const res = await fetch(`${env('SUPABASE_URL')}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${jwt}`, apikey: env('SUPABASE_SERVICE_ROLE_KEY') },
  });
  if (!res.ok) throw new Error('Not authenticated');
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    await requireAuth(req);
    const { sales_order_id } = await req.json();
    if (!sales_order_id) throw new Error('Missing sales_order_id');

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    const { data: order, error: fetchErr } = await supabase
      .from('orders').select('delivery_status').eq('sales_order_id', sales_order_id).maybeSingle();
    if (fetchErr) throw new Error(fetchErr.message);
    if (!order) throw new Error(`Order ${sales_order_id} not found`);
    if (order.delivery_status === 'delivered' || order.delivery_status === 'partially_delivered') {
      throw new Error('Already delivered — the assigned rider is part of the delivery record and can\'t be cleared.');
    }

    const wasOfd = order.delivery_status === 'ofd';
    const update: Record<string, unknown> = { assigned_rider: null };
    if (wasOfd) {
      update.delivery_status = 'not_dispatched';
      update.dispatched_at = null;
    }

    const { error: updateErr } = await supabase
      .from('orders').update(update).eq('sales_order_id', sales_order_id);
    if (updateErr) throw new Error(updateErr.message);

    if (wasOfd) {
      const { error: itemsErr } = await supabase
        .from('order_items').update({ collected: false })
        .eq('sales_order_id', sales_order_id).neq('status', 'cancelled');
      if (itemsErr) throw new Error(itemsErr.message);
    }

    return new Response(
      JSON.stringify({
        sales_order_id,
        delivery_status: wasOfd ? 'not_dispatched' : order.delivery_status,
        assigned_rider: null,
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
