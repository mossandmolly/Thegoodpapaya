// Supabase Edge Function — returns customer and item master lists for order-entry autocomplete
// GET /get-masters          → fast: customers from DB, items from cache (lazy Zoho refresh if stale)
// GET /get-masters?force=1  → sync customers + items from Zoho right now, then return fresh data

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

async function getZohoToken(): Promise<{ access_token: string; orgId: string } | null> {
  const cid = env('ZOHO_CLIENT_ID'), cs = env('ZOHO_CLIENT_SECRET'), rt = env('ZOHO_REFRESH_TOKEN');
  if (!cid || !cs || !rt) return null;

  const tokenRes = await fetch('https://accounts.zoho.in/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: cid, client_secret: cs, refresh_token: rt }).toString(),
  });
  const { access_token } = await tokenRes.json();
  if (!access_token) return null;

  const orgId = env('ZOHO_ORG_ID') || env('ZOHO_ORGANIZATION_ID');
  if (!orgId) return null;

  return { access_token, orgId };
}

async function fetchAndCacheItems(accessToken: string, orgId: string): Promise<number> {
  const res  = await fetch(
    `https://www.zohoapis.in/books/v3/items?organization_id=${orgId}&status=active&per_page=200`,
    { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } }
  );
  const data = await res.json();
  const items = (data.items ?? []).map((i: any) => ({
    name:   (i.name ?? '').trim(),
    unit:   (i.unit ?? '').trim(),
    source: 'zoho',
  })).filter((i: any) => i.name);

  await sbUpsert('item_master', items, 'name');
  return items.length;
}

async function fetchAndCacheCustomers(accessToken: string, orgId: string): Promise<number> {
  const rows: { customer_name: string; phone_number: string }[] = [];
  let page = 1;

  while (true) {
    const res  = await fetch(
      `https://www.zohoapis.in/books/v3/contacts?organization_id=${orgId}&contact_type=customer&status=active&per_page=200&page=${page}`,
      { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } }
    );
    const data = await res.json();
    const contacts = data.contacts ?? [];
    if (!contacts.length) break;

    for (const c of contacts) {
      const phone = ((c.mobile || c.phone || '') as string).trim().replace(/[\s\-()]/g, '');
      const name  = ((c.contact_name || '') as string).trim();
      if (name && phone) rows.push({ customer_name: name, phone_number: phone });
    }

    if (!data.page_context?.has_more_page) break;
    page++;
  }

  if (rows.length) await sbUpsert('customers', rows, 'customer_name');
  return rows.length;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  const url   = new URL(req.url);
  const force = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true';

  try {
    let syncedCustomers = 0;
    let syncedItems     = 0;

    if (force) {
      // ── Force sync: pull everything from Zoho right now ──
      const zoho = await getZohoToken();
      if (zoho) {
        [syncedCustomers, syncedItems] = await Promise.all([
          fetchAndCacheCustomers(zoho.access_token, zoho.orgId),
          fetchAndCacheItems(zoho.access_token, zoho.orgId),
        ]);
      }
    } else {
      // ── Normal path: lazy refresh items in background if stale (>1hr) ──
      const oneHourAgo  = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const recentItems = await sbSelect('item_master', 'name',
        `&order=created_at.desc&limit=1&created_at=gte.${encodeURIComponent(oneHourAgo)}`);

      if (!recentItems.length) {
        getZohoToken()
          .then(zoho => zoho ? fetchAndCacheItems(zoho.access_token, zoho.orgId) : 0)
          .catch(e  => console.error('Zoho items sync error:', e.message));
      }
    }

    // ── Read from DB and return ──
    const [customerRows, storedItems] = await Promise.all([
      sbSelect('customers', 'customer_name'),
      sbSelect('item_master', 'name,unit'),
    ]);

    const customers = deduplicateNames(customerRows.map((r: any) => r.customer_name));
    const items     = (storedItems as any[])
      .map(r => ({ name: r.name as string, unit: (r.unit ?? '') as string }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return new Response(
      JSON.stringify({ customers, items, ...(force ? { syncedCustomers, syncedItems } : {}) }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }
});
