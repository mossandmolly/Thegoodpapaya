// Supabase Edge Function — returns customer and item master lists for order-entry autocomplete
// GET /get-masters
// Returns: { customers: string[], items: { name: string, unit: string }[] }
//
// Customers: union of `customers` table + `customer_master`, normalised and deduplicated
// Items:     Zoho Books active items (synced into item_master) + any manual additions

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

async function sbSelect(table: string, select = '*'): Promise<any[]> {
  const url = `${env('SUPABASE_URL')}/rest/v1/${table}?select=${select}`;
  const res  = await fetch(url, { headers: sbHeaders() });
  if (!res.ok) return [];
  return await res.json() as any[];
}

async function sbUpsert(table: string, rows: any[], onConflict: string) {
  if (!rows.length) return;
  const url = `${env('SUPABASE_URL')}/rest/v1/${table}?on_conflict=${onConflict}`;
  await fetch(url, {
    method:  'POST',
    headers: { ...sbHeaders(), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body:    JSON.stringify(rows),
  });
}

// ── Customer name normalisation ───────────────────────────────
// Rule: first letter of first word capitalised, rest lowercase.
// First space = delimiter between society and door number.
// e.g. "VILLA 83" → "Villa 83", "villa 83" → "Villa 83"
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
    const key  = norm.toLowerCase();
    if (!map.has(key)) map.set(key, norm);
  }
  return Array.from(map.values()).sort((a, b) => a.localeCompare(b));
}

// ── Zoho OAuth ────────────────────────────────────────────────
async function getZohoToken(): Promise<string | null> {
  const { ZOHO_CLIENT_ID: cid, ZOHO_CLIENT_SECRET: cs, ZOHO_REFRESH_TOKEN: rt } =
    Object.fromEntries(['ZOHO_CLIENT_ID','ZOHO_CLIENT_SECRET','ZOHO_REFRESH_TOKEN'].map(k => [k, env(k)]));
  if (!cid || !cs || !rt) return null;

  const res  = await fetch('https://accounts.zoho.in/oauth/v2/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({ grant_type: 'refresh_token', client_id: cid, client_secret: cs, refresh_token: rt }).toString(),
  });
  const data = await res.json();
  return data.access_token ?? null;
}

async function fetchZohoItems(): Promise<{ name: string; unit: string }[]> {
  const token = await getZohoToken();
  if (!token) return [];
  const orgId = env('ZOHO_ORG_ID') || env('ZOHO_ORGANIZATION_ID');
  if (!orgId) return [];

  const res  = await fetch(
    `https://www.zohoapis.in/books/v3/items?organization_id=${orgId}&status=active&per_page=200`,
    { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
  );
  const data = await res.json();
  return (data.items ?? []).map((i: any) => ({ name: (i.name ?? '').trim(), unit: (i.unit ?? '').trim() }));
}

// ── Main handler ──────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    // ── Customers ──────────────────────────────────────────────
    const [existingCustomers, masterCustomers] = await Promise.all([
      sbSelect('customers',       'customer_name'),
      sbSelect('customer_master', 'name'),
    ]);

    const allCustomerNames = [
      ...existingCustomers.map((r: any) => r.customer_name as string),
      ...masterCustomers.map((r: any) => r.name as string),
    ].filter(Boolean);

    const customers = deduplicateNames(allCustomerNames);

    // Back-fill customer_master with normalised names from customers table
    const normalisedRows = customers.map(n => ({ name: n, source: 'zoho' }));
    await sbUpsert('customer_master', normalisedRows, 'name');

    // ── Items ──────────────────────────────────────────────────
    let zohoItems: { name: string; unit: string }[] = [];
    try { zohoItems = await fetchZohoItems(); } catch (e: any) { console.error('Zoho items error:', e.message); }

    // Sync Zoho items into item_master
    if (zohoItems.length) {
      await sbUpsert('item_master', zohoItems.map(i => ({ name: i.name, unit: i.unit, source: 'zoho' })), 'name');
    }

    // Read item_master (includes Zoho + any manual additions)
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
