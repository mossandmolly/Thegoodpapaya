// Supabase Edge Function — insert manually entered orders into operations
// Called by order-entry.js with: { records: [...], newCustomers?: string[], newItems?: {name,unit}[] }
// Saves any new customer/item names into master tables for future autocomplete.

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

function sbHeaders(serviceKey: string) {
  return { 'Authorization': `Bearer ${serviceKey}`, 'apikey': serviceKey, 'Content-Type': 'application/json' };
}

async function sbUpsert(url: string, serviceKey: string, table: string, rows: any[], onConflict: string) {
  if (!rows.length) return;
  await fetch(`${url}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method:  'POST',
    headers: { ...sbHeaders(serviceKey), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body:    JSON.stringify(rows),
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const { records, newCustomers = [], newItems = [] } = await req.json();

    if (!records?.length) {
      return new Response(
        JSON.stringify({ error: 'No records provided' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseUrl = env('SUPABASE_URL');
    const serviceKey  = env('SUPABASE_SERVICE_ROLE_KEY');

    // Insert orders
    const res = await fetch(`${supabaseUrl}/rest/v1/operations`, {
      method:  'POST',
      headers: { ...sbHeaders(serviceKey), 'Prefer': 'return=minimal' },
      body:    JSON.stringify(records),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message ?? `Insert failed: ${res.status}`);
    }

    // Save new master entries in parallel (best effort — don't fail the order if this errors)
    await Promise.allSettled([
      sbUpsert(supabaseUrl, serviceKey, 'customer_master',
        (newCustomers as string[]).filter(Boolean).map(n => ({ name: n.trim(), source: 'manual' })),
        'name'),
      sbUpsert(supabaseUrl, serviceKey, 'item_master',
        (newItems as any[]).filter(i => i?.name).map(i => ({ name: i.name.trim(), unit: i.unit ?? '', source: 'manual' })),
        'name'),
    ]);

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
