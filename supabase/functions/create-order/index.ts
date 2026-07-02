// Supabase Edge Function — create order header rows using the service role
//
// The `orders` table's RLS locks writes to service-role only (it carries
// real Zoho invoice / Razorpay payment state), so the parser can't upsert
// it directly with the public anon key. This function is the write path.
//
// Input:  { headers: [{ sales_order_id, customer_name, source?, payment_method?, invoice_status? }] }
// Output: { created: <count submitted> }
//
// Existing rows are left untouched (ignore-duplicates on sales_order_id) —
// this never overwrites an order that already has real invoice/payment data.
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
    const { headers } = await req.json();

    if (!headers?.length) {
      return new Response(
        JSON.stringify({ error: 'No headers provided' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    const rows = (headers as any[]).map(h => ({
      sales_order_id: h.sales_order_id,
      customer_name:  h.customer_name,
      source:         h.source ?? 'manual',
      payment_method: h.payment_method ?? 'cod',
      invoice_status: h.invoice_status ?? 'pending',
    }));

    const res = await fetch(`${env('SUPABASE_URL')}/rest/v1/orders?on_conflict=sales_order_id`, {
      method:  'POST',
      headers: { ...sbHeaders(), Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body:    JSON.stringify(rows),
    });
    if (!res.ok) throw new Error(await res.text());

    return new Response(
      JSON.stringify({ created: rows.length }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
