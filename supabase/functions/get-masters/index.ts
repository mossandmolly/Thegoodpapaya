// Supabase Edge Function — returns customer and item master lists for order-entry autocomplete
// Serves from item_master table (Supabase) — only calls Zoho if table is empty or stale (>1hr)

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

function normaliseName(raw: string): string {
  const s = raw.trim().replace(/\s+/g, ' ');
  const i = s.indexOf(' ');
  if (i === -1) return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  const first = s.slice(0, i);
  const rest  = s.slice(i + 1);
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase() + ' ' + rest;
}

function deduplicateNames(names: string[]): string[] {
  const map = new Map<string, string>();
  for (const raw of names) {
    const norm = normaliseName(raw);
    if (!map.has(norm.toLowerCase())) map.set(norm.toLowerCase(), norm);
  }
  return Array.from(map.values()).sort((a, b) => a.localeCompare(b));
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
    // ── Customers: read from DB only (already synced by sync-invoices) ──
    const [existingCustomers, masterCustomers] = await Promise.all([
      sbSelect('customers',       'customer_name'),
      sbSelect('customer_master', 'name'),
    ]);

    const allNames = [
      ...existingCustomers.map((r: any) => r.customer_name as string),
      ...masterCustomers.map((r: any) => r.name as string),
    ].filter(Boolean);

    const customers = deduplicateNames(allNames);

    // Back-fill normalised names (fire-and-forget, don't await)
    sbUpsert('customer_master', customers.map(n => ({ name: n, source: 'zoho' })), 'name');

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
