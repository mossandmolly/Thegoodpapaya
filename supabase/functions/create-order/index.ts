// Supabase Edge Function — create order header rows using the service role
//
// The `orders` table's RLS locks writes to service-role only (it carries
// real Zoho invoice / Razorpay payment state), so the parser can't upsert
// it directly with the public anon key. This function is the write path.
//
// Also derives the society/community name from each customer_name (first
// token before the first space, e.g. "Dhavala A502" -> "Dhavala") and
// upserts it into `communities` — grows that reference table from real
// order data instead of maintaining a static list.
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    await requireAuth(req);
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

    // Best-effort: grow the communities table from these customer names.
    // Never fails the request — a name-check pattern miss shouldn't block order creation.
    try {
      const societies = [...new Set(
        rows.map(r => (r.customer_name || '').trim().split(' ')[0]).filter(Boolean),
      )].map(name => ({ name }));

      if (societies.length) {
        await fetch(`${env('SUPABASE_URL')}/rest/v1/communities?on_conflict=name`, {
          method:  'POST',
          headers: { ...sbHeaders(), Prefer: 'resolution=ignore-duplicates,return=minimal' },
          body:    JSON.stringify(societies),
        });
      }
    } catch (_e) {
      // swallow — communities is a nice-to-have, not load-bearing for this request
    }

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
