// Supabase Edge Function — look up customer_name for a set of sales_order_id
// values, using the service role.
//
// orders' RLS locks reads to service-role only (same reason writes are
// locked down — it carries real Zoho/Razorpay state), so the parser can't
// select from it directly with the public anon key. Without this function
// the read silently returns zero rows (RLS filters instead of erroring on
// SELECT), which is why customer names were falling back to the raw
// sales_order_id.
//
// Input:  { sales_order_ids: string[] }
// Output: { customers: [{ sales_order_id, customer_name }] }
//
// Required env vars (auto-provided by the Supabase Edge Function runtime):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

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

function sbHeaders() {
  return {
    'Authorization': `Bearer ${env('SUPABASE_SERVICE_ROLE_KEY')}`,
    'apikey':        env('SUPABASE_SERVICE_ROLE_KEY'),
    'Content-Type':  'application/json',
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const { sales_order_ids } = await req.json();

    if (!sales_order_ids?.length) {
      return new Response(
        JSON.stringify({ error: 'No sales_order_ids provided' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    const idList = (sales_order_ids as string[]).map(id => `"${id}"`).join(',');
    const res = await fetch(
      `${env('SUPABASE_URL')}/rest/v1/orders?select=sales_order_id,customer_name&sales_order_id=in.(${idList})`,
      { headers: sbHeaders() },
    );
    if (!res.ok) throw new Error(await res.text());
    const customers = await res.json();

    return new Response(
      JSON.stringify({ customers }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
