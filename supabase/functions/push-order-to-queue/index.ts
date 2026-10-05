// Supabase Edge Function — push-order-to-queue
//
// Sets (or clears) which packer_queues row an order belongs to. orders' RLS
// locks writes to service-role only, so this is the write path — same
// pattern as every other orders mutation in this app (see
// update-order-notes). packer_queues itself is open-RLS and read/written
// directly by the client (same as packers/communities/community_priority);
// only the orders.queue_id/queue_pushed_at write needs this function.
//
// Input:  { sales_order_id: string, queue_id: string|null }
// Output: { sales_order_id, queue_id, queue_pushed_at }
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
    const { sales_order_id, queue_id } = await req.json();
    if (!sales_order_id) throw new Error('Missing sales_order_id');

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    const update = queue_id
      ? { queue_id, queue_pushed_at: new Date().toISOString() }
      : { queue_id: null, queue_pushed_at: null };

    const { data, error } = await supabase
      .from('orders')
      .update(update)
      .eq('sales_order_id', sales_order_id)
      .select('sales_order_id, queue_id, queue_pushed_at')
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
