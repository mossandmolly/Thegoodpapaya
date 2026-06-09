// Supabase Edge Function — returns customer and item master lists for order-entry autocomplete
// Customers: read from `customers` table (synced by sync-invoices, phone required)
// Items: cached in `item_master`, refreshed from Zoho when stale (>1hr)

function env(key: string, fallback = '') { return Deno.env.get(key) ?? fallback; }

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

function sbHeaders() {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  return { 'Authorization': `Bearer ${key}`, 'apikey': key, 'Content-Type': 'application/json' };
}

async function sbSelect(table: string, select = '*', extra = ''): Promise<any[]> {
  const url = `${env('SUPABASE_URL')}/rest/v1/${table}?select=${select}${extra}`;
  const res  = await fetch(url, { headers: sbHeaders() });
  if (!res.ok) return [];
  return await res.json() as any[];
}

async function sbUpsert(table: string, rows: any[], onConflict: string) {
  if (!rows.length) return;
  await fetch(`${env('SUPABASE_URL')}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method:  'POST',
    headers: { ...sbHeaders(), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body:    JSON.stringify(rows),
  });
}

function deduplicateNames(names: string[]): string[] {
  const seen = new Map<string, string>();
  for (const raw of names) {
    const trimmed = (raw || '').trim();
    if (!trimmed) continue;
    if (!seen.has(trimmed.toLowerCase())) seen.set(trimmed.toLowerCase(), trimmed);
  }
  return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
}

async function fetchZohoItems(): Promise<{ name: string; unit: string }[]> {
  const cid = env('ZOHO_CLIENT_ID'), cs = env('ZOHO_CLIENT_SECRET'), rt = env('ZOHO_REFRESH_TOKEN');
  if (!cid || !cs || !rt) return [];

  const tokenRes = await fetch('https://accounts.zoho.in/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: cid, client_secret: cs, refresh_token: rt }).toString(),
  });
  const { access_token } = await tokenRes.json();
  if (!access_token) return [];

  const orgId = env('ZOHO_ORG_ID') || env('ZOHO_ORGANIZATION_ID');
  if (!orgId) return [];

  const res  = await fetch(
    `https://www.zohoapis.in/books/v3/items?organization_id=${orgId}&status=active&per_page=200`,
    { headers: { Authorization: `Zoho-oauthtoken ${access_token}` } }
  );
  const data = await res.json();
  return (data.items ?? []).map((i: any) => ({ name: (i.name ?? '').trim(), unit: (i.unit ?? '').trim() }));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    // ── Customers: read directly from `customers` table ──
    const rows = await sbSelect('customers', 'customer_name');
    const customers = deduplicateNames(rows.map((r: any) => r.customer_name));

    // ── Items: serve from item_master; only hit Zoho if stale/empty ──
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const recentItems = await sbSelect('item_master', 'name,unit,created_at',
      `&order=created_at.desc&limit=1&created_at=gte.${encodeURIComponent(oneHourAgo)}`);

    if (!recentItems.length) {
      // Cache is empty or stale — refresh from Zoho in background, still return fast
      fetchZohoItems().then(zohoItems => {
        if (zohoItems.length) {
          sbUpsert('item_master', zohoItems.map(i => ({ name: i.name, unit: i.unit, source: 'zoho' })), 'name');
        }
      }).catch(e => console.error('Zoho sync error:', e.message));
    }

    const storedItems = await sbSelect('item_master', 'name,unit');
    const items = (storedItems as any[])
      .map(r => ({ name: r.name as string, unit: (r.unit ?? '') as string }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return new Response(
      JSON.stringify({ customers, items }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }
});
