// Supabase Edge Function — hourly snapshot of packer-editable fields
// Called by cron-job.org every hour
// Also purges snapshots older than 7 days

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
    const supabaseUrl = env('SUPABASE_URL');
    const snapshotAt  = new Date().toISOString();

    // 1. Fetch all current operations rows (only the fields we snapshot)
    const opsRes = await fetch(
      `${supabaseUrl}/rest/v1/operations?select=id,final_quantity,status`,
      { headers: sbHeaders() }
    );
    if (!opsRes.ok) throw new Error(`Fetch operations failed: ${await opsRes.text()}`);
    const ops: any[] = await opsRes.json();

    if (ops.length === 0) {
      return new Response(
        JSON.stringify({ message: 'No operations to snapshot' }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    // 2. Insert snapshot rows
    const snapshots = ops.map(op => ({
      snapshot_at:    snapshotAt,
      operation_id:   op.id,
      final_quantity: op.final_quantity,
      status:         op.status,
    }));

    const insertRes = await fetch(
      `${supabaseUrl}/rest/v1/operations_snapshots`,
      {
        method:  'POST',
        headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
        body:    JSON.stringify(snapshots),
      }
    );
    if (!insertRes.ok) throw new Error(`Insert snapshots failed: ${await insertRes.text()}`);

    // 3. Purge snapshots older than 7 days
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const purgeRes = await fetch(
      `${supabaseUrl}/rest/v1/operations_snapshots?snapshot_at=lt.${encodeURIComponent(cutoff)}`,
      { method: 'DELETE', headers: sbHeaders() }
    );
    if (!purgeRes.ok) throw new Error(`Purge failed: ${await purgeRes.text()}`);

    return new Response(
      JSON.stringify({ snapshotted: ops.length, snapshot_at: snapshotAt }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }
});
