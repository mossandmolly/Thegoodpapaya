// Supabase Edge Function — secure orders CSV upload
// Verifies admin password server-side before inserting
// Uses service role key — browser never touches operations directly

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
    'Prefer':        'return=minimal',
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const { password, records } = await req.json();

    // Verify admin password server-side
    if (!password || password !== env('ADMIN_PASSWORD')) {
      return new Response(
        JSON.stringify({ error: 'Wrong password' }),
        { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    if (!records?.length) {
      return new Response(
        JSON.stringify({ error: 'No records provided' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseUrl = env('SUPABASE_URL');
    const uploadDate  = records[0].invoice_date;

    // Delete existing records for this date
    const delRes = await fetch(
      `${supabaseUrl}/rest/v1/operations?invoice_date=eq.${uploadDate}`,
      { method: 'DELETE', headers: sbHeaders() }
    );
    if (!delRes.ok) throw new Error(`Delete failed: ${await delRes.text()}`);

    // Insert fresh records
    const insRes = await fetch(
      `${supabaseUrl}/rest/v1/operations`,
      { method: 'POST', headers: sbHeaders(), body: JSON.stringify(records) }
    );
    if (!insRes.ok) throw new Error(`Insert failed: ${await insRes.text()}`);

    return new Response(
      JSON.stringify({ inserted: records.length, date: uploadDate }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }
});
