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
  const res = await fetch(`${env('SUPABASE_URL')}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method:  'POST',
    headers: { ...sbHeaders(), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body:    JSON.stringify(rows),
  });
  if (!res.ok) console.error(`sbUpsert(${table}) failed (${res.status}):`, await res.text());
}

// ── Name normalisation ────────────────────────────────────────────────────────

// Dedup key: strip everything except letters, digits, spaces → lowercase.
// "Villa-83", "VILLA 83", "villa 83" all → "villa 83"
function dedupKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Score a raw Zoho customer name — higher = preferred candidate when duplicates exist.
// Prefers: proper mixed casing, starts with letters (society first, not door number),
// space-separated parts, no special characters like parens/slashes/quotes.
function scoreCustomerName(name: string): number {
  let score = 0;
  if (name !== name.toUpperCase() && name !== name.toLowerCase()) score += 4; // mixed case
  if (/^[A-Za-z]/.test(name))                                                 score += 3; // letter-first (society then door)
  if (/ /.test(name))                                                          score += 2; // space-separated
  if (!/[()\/\\'"]/.test(name))                                               score += 1; // no special chars
  return score;
}

// Normalise a customer name word-by-word:
//   - Short alphanumeric unit codes (B-12, 4A, A101, ≤5 chars containing a digit) → UPPERCASE
//   - Pure numbers (83, 4) → keep as-is
//   - Regular words → Sentence-case (first letter up, rest down)
function normaliseCustomerName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').split(' ').map(word => {
    if (!word) return word;
    if (/^\d+$/.test(word)) return word;                                        // pure number
    if (word.length <= 5 && /\d/.test(word) && /^[A-Za-z\d][\w\-\/]*$/.test(word)) {
      return word.toUpperCase();                                                 // unit code: B-12, 4A, C/102
    }
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();          // regular word
  }).join(' ');
}

// Normalise an item name: sentence case (first letter up, rest down).
// "ALPHONSO MANGOES" → "Alphonso mangoes"
// "Dragon Fruit (1 kg)" → "Dragon fruit (1 kg)"
function normaliseItemName(raw: string): string {
  const s = raw.trim().replace(/\s+/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// Deduplicate customer names: group by dedupKey, pick best-scored candidate, normalise it.
function deduplicateCustomers(names: string[]): string[] {
  const groups = new Map<string, string[]>();
  for (const name of names) {
    const key = dedupKey(name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(name);
  }
  const result: string[] = [];
  for (const candidates of groups.values()) {
    const best = [...candidates].sort((a, b) => scoreCustomerName(b) - scoreCustomerName(a))[0];
    result.push(normaliseCustomerName(best));
  }
  return result.sort((a, b) => a.localeCompare(b));
}

// Deduplicate items: group by dedupKey, pick best-scored candidate (prefers mixed case),
// then normalise to sentence case.
function deduplicateItems(items: { name: string; unit: string }[]): { name: string; unit: string }[] {
  const groups = new Map<string, { name: string; unit: string }[]>();
  for (const item of items) {
    const key = dedupKey(item.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }
  const result: { name: string; unit: string }[] = [];
  for (const candidates of groups.values()) {
    const best = [...candidates].sort((a, b) => {
      const mixA = a.name !== a.name.toUpperCase() && a.name !== a.name.toLowerCase() ? 1 : 0;
      const mixB = b.name !== b.name.toUpperCase() && b.name !== b.name.toLowerCase() ? 1 : 0;
      return mixB - mixA;
    })[0];
    result.push({ name: normaliseItemName(best.name), unit: best.unit });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Zoho helpers ──────────────────────────────────────────────────────────────

// In-memory (fast path within a warm isolate) backed by the shared
// zoho_token_cache row (migration 046) — this used to refresh on every
// single call, force=1 or not, with no caching at all.
let cachedToken = '';
let tokenExpiry = 0;

async function getZohoToken(): Promise<{ access_token: string; orgId: string } | null> {
  const orgId = env('ZOHO_ORG_ID') || env('ZOHO_ORGANIZATION_ID');
  if (!orgId) return null;

  if (cachedToken && Date.now() < tokenExpiry - 60_000) return { access_token: cachedToken, orgId };

  const cachedRows = await sbSelect('zoho_token_cache', 'access_token,expires_at,refresh_token', '&id=eq.1');
  const cached = cachedRows[0];
  if (cached && new Date(cached.expires_at).getTime() > Date.now() + 60_000) {
    cachedToken = cached.access_token;
    tokenExpiry = new Date(cached.expires_at).getTime();
    return { access_token: cachedToken, orgId };
  }

  const cid = env('ZOHO_CLIENT_ID'), cs = env('ZOHO_CLIENT_SECRET');
  // Zoho rotates refresh_token on (at least some) refresh calls and
  // invalidates the old one — prefer whatever the shared cache has last
  // persisted over the static env secret, which goes stale after a rotation.
  const rt = cached?.refresh_token || env('ZOHO_REFRESH_TOKEN');
  if (!cid || !cs || !rt) return null;

  const tokenRes = await fetch('https://accounts.zoho.in/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: cid, client_secret: cs, refresh_token: rt }).toString(),
  });
  const { access_token, expires_in, refresh_token: newRefreshToken } = await tokenRes.json();
  if (!access_token) return null;

  cachedToken = access_token;
  tokenExpiry = Date.now() + (expires_in ?? 3600) * 1000;
  await sbUpsert('zoho_token_cache', [{
    id: 1, access_token: cachedToken, expires_at: new Date(tokenExpiry).toISOString(),
    ...(newRefreshToken ? { refresh_token: newRefreshToken } : {}),
  }], 'id');

  return { access_token: cachedToken, orgId };
}

async function fetchAndCacheItems(accessToken: string, orgId: string): Promise<number> {
  const res  = await fetch(
    `https://www.zohoapis.in/books/v3/items?organization_id=${orgId}&status=active&per_page=200`,
    { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } }
  );
  const data = await res.json();

  const raw = (data.items ?? [])
    .map((i: any) => ({ name: (i.name ?? '').trim(), unit: (i.unit ?? '').trim() }))
    .filter((i: any) => i.name);

  const normalised = deduplicateItems(raw);
  if (normalised.length) {
    await sbUpsert('item_master', normalised.map(i => ({ ...i, source: 'zoho' })), 'name');
  }
  return normalised.length;
}

async function fetchAndCacheCustomers(accessToken: string, orgId: string): Promise<number> {
  const raw: { customer_name: string; phone_number: string }[] = [];
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
      if (name && phone) raw.push({ customer_name: name, phone_number: phone });
    }

    if (!data.page_context?.has_more_page) break;
    page++;
  }

  if (!raw.length) return 0;

  // Deduplicate and normalise names; preserve the phone from the best-scored entry.
  const groups = new Map<string, { customer_name: string; phone_number: string }[]>();
  for (const row of raw) {
    const key = dedupKey(row.customer_name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  const normalised: { customer_name: string; phone_number: string }[] = [];
  for (const candidates of groups.values()) {
    const best = [...candidates].sort((a, b) => scoreCustomerName(b.customer_name) - scoreCustomerName(a.customer_name))[0];
    normalised.push({ customer_name: normaliseCustomerName(best.customer_name), phone_number: best.phone_number });
  }

  await sbUpsert('customers', normalised, 'customer_name');
  return normalised.length;
}

// ── Handler ───────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  const url   = new URL(req.url);
  const force = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true';

  try {
    let syncedCustomers = 0;
    let syncedItems     = 0;

    if (force) {
      const zoho = await getZohoToken();
      if (zoho) {
        [syncedCustomers, syncedItems] = await Promise.all([
          fetchAndCacheCustomers(zoho.access_token, zoho.orgId),
          fetchAndCacheItems(zoho.access_token, zoho.orgId),
        ]);
      }
    } else {
      // Lazy refresh items in background if cache is stale (>1hr)
      const oneHourAgo  = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const recentItems = await sbSelect('item_master', 'name',
        `&order=created_at.desc&limit=1&created_at=gte.${encodeURIComponent(oneHourAgo)}`);

      if (!recentItems.length) {
        getZohoToken()
          .then(zoho => zoho ? fetchAndCacheItems(zoho.access_token, zoho.orgId) : 0)
          .catch(e  => console.error('Zoho items sync error:', e.message));
      }
    }

    // Read from DB and return normalised lists
    const [customerRows, storedItems] = await Promise.all([
      sbSelect('customers', 'customer_name'),
      sbSelect('item_master', 'name,unit'),
    ]);

    const customers = deduplicateCustomers(customerRows.map((r: any) => r.customer_name));
    const items     = deduplicateItems(
      (storedItems as any[]).map(r => ({ name: r.name as string, unit: (r.unit ?? '') as string }))
    );

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
