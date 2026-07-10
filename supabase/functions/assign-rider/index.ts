// Supabase Edge Function — assign-rider
//
// Lets a delivery rider self-assign a batch of orders to themselves under
// the single shared delivery login — there's no per-rider auth account, so
// "who" is just a name the rider typed into their own device once (see the
// frontend's gp_rider_name in localStorage), passed straight through here
// and stored on the order. orders' RLS locks writes to service-role only,
// so this is the write path.
//
// Input:  { sales_order_ids: string[], rider: string | null }
// Output: { updated: number }
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

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    const { error, count } = await supabase
      .from('orders')
      .update({ assigned_rider: rider || null }, { count: 'exact' })
      .in('sales_order_id', sales_order_ids);
    if (error) throw new Error(error.message);

    return new Response(
      JSON.stringify({ updated: count ?? sales_order_ids.length }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
