// Supabase Edge Function — insert manually entered orders into operations
// Called by order-entry.js with: { records: [...] }
// No admin password required — user must be authenticated via Supabase session

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const { records } = await req.json();

    if (!records?.length) {
      return new Response(
        JSON.stringify({ error: 'No records provided' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseUrl = env('SUPABASE_URL');
    const serviceKey  = env('SUPABASE_SERVICE_ROLE_KEY');

    const res = await fetch(`${supabaseUrl}/rest/v1/operations`, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${serviceKey}`,
        'apikey':        serviceKey,
        'Content-Type':  'application/json',
        'Prefer':        'return=minimal',
      },
      body: JSON.stringify(records),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message ?? `Insert failed: ${res.status}`);
    }

    return new Response(
      JSON.stringify({ inserted: records.length }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }
});
