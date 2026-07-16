// Supabase Edge Function — update-order-notes
//
// Lets an admin add/edit an order's internal note, its deliver_by
// deadline, and/or its trip_override from Order overview, after the order
// was already created. orders' RLS locks writes to service-role only, so
// this is the write path — same pattern as every other orders mutation in
// this app.
//
// Distinct from delivery_notes (the rider's own remark, written from the
// Delivery tab) and order_items.delivery_instructions (parsed per item) —
// admin_notes is the admin-facing internal note field.
//
// trip_override moves this one order into a different trip grouping
// (Overview/Packer/Delivery's trip view) without touching its actual
// community — pass null/empty to clear it back to the community-derived
// default.
//
// deliver_after is the mirror of deliver_by — an earliest-time constraint
// ("deliver after 4pm") rather than a deadline. Both together express a
// "between X and Y" window.
//
// Input:  { sales_order_id: string, admin_notes?: string, deliver_by?: string|null, deliver_after?: string|null, trip_override?: string|null }
// Output: { sales_order_id, admin_notes, deliver_by, deliver_after, trip_override }
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
    const { sales_order_id, admin_notes, deliver_by, deliver_after, trip_override } = await req.json();
    if (!sales_order_id) throw new Error('Missing sales_order_id');

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    const update: Record<string, unknown> = {};
    if (admin_notes !== undefined)    update.admin_notes    = admin_notes || null;
    if (deliver_by !== undefined)     update.deliver_by     = deliver_by || null;
    if (deliver_after !== undefined)  update.deliver_after   = deliver_after || null;
    if (trip_override !== undefined)  update.trip_override  = trip_override || null;
    if (!Object.keys(update).length) throw new Error('Nothing to update');

    const { data, error } = await supabase
      .from('orders')
      .update(update)
      .eq('sales_order_id', sales_order_id)
      .select('sales_order_id, admin_notes, deliver_by, deliver_after, trip_override')
      .single();
    if (error) throw new Error(error.message);
    if (!data) throw new Error(`Order ${sales_order_id} not found`);

    return new Response(
      JSON.stringify(data),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
