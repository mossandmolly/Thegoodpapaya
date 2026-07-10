// Supabase Edge Function — assign-rider
//
// Lets a delivery rider self-assign a batch of orders to themselves under
// the single shared delivery login — there's no per-rider auth account, so
// "who" is just a name the rider typed into their own device once (see the
// frontend's gp_rider_name in localStorage), passed straight through here
// and stored on the order. orders' RLS locks writes to service-role only,
// so this is the write path.
//
// This is a claim, not a plain overwrite: the update only touches rows
// where assigned_rider is still null, in one atomic UPDATE...WHERE, so two
// riders selecting the same unassigned order at nearly the same moment
// can't silently clobber each other — whichever request's UPDATE commits
// first wins that row, and the loser gets it back in already_taken instead
// of quietly overwriting the winner's claim.
//
// Input:  { sales_order_ids: string[], rider: string }
// Output: { updated: number, claimed: string[], already_taken: string[] }
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function env(key: string) {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Missing env: ${key}`);
  return val;
}

// This function uses the service role internally, so it bypasses RLS
// regardless of who calls it — the anon key alone is enough to invoke it at
// the platform level. Requiring a real logged-in user session here is what
// actually restricts this to signed-in ops staff.
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
    const { sales_order_ids, rider } = await req.json();
    if (!Array.isArray(sales_order_ids) || !sales_order_ids.length) {
      throw new Error('Missing sales_order_ids');
    }
    if (!rider) throw new Error('Missing rider');

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    // .select() after an update returns exactly the rows the WHERE clause
    // actually matched and updated — i.e. exactly the ones that were still
    // unclaimed a moment ago. Anything in sales_order_ids that isn't in
    // that result was already assigned to someone else before this request
    // landed.
    const { data, error } = await supabase
      .from('orders')
      .update({ assigned_rider: rider })
      .in('sales_order_id', sales_order_ids)
      .is('assigned_rider', null)
      .select('sales_order_id');
    if (error) throw new Error(error.message);

    const claimed = (data ?? []).map((r: any) => r.sales_order_id as string);
    const alreadyTaken = sales_order_ids.filter((id: string) => !claimed.includes(id));

    return new Response(
      JSON.stringify({ updated: claimed.length, claimed, already_taken: alreadyTaken }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
