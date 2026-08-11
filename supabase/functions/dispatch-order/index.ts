// Supabase Edge Function — dispatch-order
//
// Advances an order from 'not_dispatched' to 'ofd' (out for delivery) once
// every one of its non-cancelled items has been checked off as physically
// collected into the rider's bag — the frontend calls this the moment that
// condition becomes true, right after the last item's collected checkbox
// is ticked. orders' RLS locks writes to service-role only, so this is the
// write path (order_items.collected itself is a direct, unrestricted write
// from the frontend since order_items isn't locked the same way).
//
// Idempotent/guarded: only actually updates if the order is currently
// 'not_dispatched' — calling it again on an already-dispatched (or
// delivered) order is a harmless no-op rather than clobbering later state.
//
// An order should never end up OFD without a named rider attached — if
// `rider` is passed and the order isn't already assigned to someone, this
// claims it for that rider as part of the same dispatch, same "no
// unassigned deliveries" rule assign-rider enforces on its own path.
// Never overwrites an existing assignment.
//
// Input:  { sales_order_id: string, rider?: string }
// Output: { sales_order_id, delivery_status, dispatched: boolean }
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
    const { sales_order_id, rider } = await req.json();
    if (!sales_order_id) throw new Error('Missing sales_order_id');

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    const update: Record<string, unknown> = { delivery_status: 'ofd', dispatched_at: new Date().toISOString() };
    if (rider) {
      const { data: existing } = await supabase
        .from('orders').select('assigned_rider').eq('sales_order_id', sales_order_id).maybeSingle();
      if (!existing?.assigned_rider) update.assigned_rider = rider;
    }

    const { data, error } = await supabase
      .from('orders')
      .update(update)
      .eq('sales_order_id', sales_order_id)
      .eq('delivery_status', 'not_dispatched')
      .select('sales_order_id, delivery_status')
      .maybeSingle();
    if (error) throw new Error(error.message);

    if (data) {
      return new Response(
        JSON.stringify({ ...data, dispatched: true }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }
    // Already past not_dispatched (or the row doesn't exist) — report the
    // current state rather than erroring, since a caller racing another
    // rider's checkbox tap shouldn't see this as a failure.
    const { data: current } = await supabase
      .from('orders').select('sales_order_id, delivery_status')
      .eq('sales_order_id', sales_order_id).maybeSingle();
    return new Response(
      JSON.stringify({ ...(current || { sales_order_id, delivery_status: null }), dispatched: false }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
