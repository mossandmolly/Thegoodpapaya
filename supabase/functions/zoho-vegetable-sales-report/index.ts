// Supabase Edge Function — zoho-vegetable-sales-report
//
// ONE-OFF reporting tool: pulls REAL invoice line items straight from Zoho
// for a date range and aggregates them by item, filtered to whatever this
// app currently has marked category='vegetable' in `catalog`. Zoho has no
// concept of "vegetable" itself — that classification only exists in
// catalog.category, set via ops-dashboard's Config tab — so this is the
// only way to get a real (not order_items-approximated) vegetable sales
// number: fetch every invoice in range, look at its actual line items.
//
// Uses the Books API (books/v3), not Inventory (inventory/v1) — a
// deliberately different quota pool from sync-invoices, since Inventory's
// rate limit was exhausted this session. If Books is also blocked, this
// will surface that plainly rather than silently returning nothing.
//
// Paced deliberately (SLEEP_MS between invoice-detail calls) and paginated
// (limit/offset) so a single run can't itself trip a rate limit — always
// dry-run this on a SMALL date range first to see how many Zoho calls
// it's actually going to make before running the real range.
//
// Input:  { start_date: 'YYYY-MM-DD', end_date: 'YYYY-MM-DD', offset?: number, limit?: number }
//   Defaults to the last 7 days (today inclusive) if start_date/end_date omitted.
// Output: { start_date, end_date, invoices_in_range, invoices_processed_this_batch,
//           zoho_calls_made, next_offset, vegetables: [{ item_name, invoices, qty, value }] }
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_ORGANIZATION_ID

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function env(key: string) {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Missing env: ${key}`);
  return val;
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

async function requireAuth(req: Request): Promise<void> {
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) throw new Error('Not authenticated');
  const res = await fetch(`${env('SUPABASE_URL')}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${jwt}`, apikey: env('SUPABASE_SERVICE_ROLE_KEY') },
  });
  if (!res.ok) throw new Error('Not authenticated');
}

// Same shared zoho_token_cache row every other Zoho-touching function uses.
let cachedToken = '';
let tokenExpiry = 0;
async function getZohoToken(supabase: ReturnType<typeof createClient>): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry - 60_000) return cachedToken;
  const { data: row } = await supabase
    .from('zoho_token_cache').select('access_token,expires_at,refresh_token').eq('id', 1).maybeSingle();
  if (row && new Date(row.expires_at).getTime() > Date.now() + 60_000) {
    cachedToken = row.access_token;
    tokenExpiry = new Date(row.expires_at).getTime();
    return cachedToken;
  }
  const res = await fetch('https://accounts.zoho.in/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     env('ZOHO_CLIENT_ID'),
      client_secret: env('ZOHO_CLIENT_SECRET'),
      refresh_token: row?.refresh_token || env('ZOHO_REFRESH_TOKEN'),
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Zoho OAuth failed: ${JSON.stringify(data)}`);
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in ?? 3600) * 1000;
  const { error: cacheErr } = await supabase.from('zoho_token_cache').upsert({
    id: 1, access_token: cachedToken, expires_at: new Date(tokenExpiry).toISOString(),
    ...(data.refresh_token ? { refresh_token: data.refresh_token } : {}),
  });
  if (cacheErr) console.error('zoho_token_cache upsert failed:', cacheErr.message);
  return cachedToken;
}

// Books, not Inventory — deliberately a different rate-limit pool.
function booksUrl(path: string, orgId: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `https://www.zohoapis.in/books/v3${path}${sep}organization_id=${orgId}`;
}

const SLEEP_MS = 400; // stay well under Zoho's per-minute rate limit across a batch
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    await requireAuth(req);
    const body = await req.json().catch(() => ({}));
    const today = new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10); // IST
    const startDate: string = body.start_date || new Date(Date.now() - 6 * 86400_000 + 330 * 60 * 1000).toISOString().slice(0, 10);
    const endDate: string   = body.end_date   || today;
    const offset: number    = body.offset ?? 0;
    const limit: number     = body.limit ?? 25; // invoices per batch — conservative, this is 1 Zoho call each

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));
    const orgId = env('ZOHO_ORGANIZATION_ID');
    let zohoCalls = 0;

    // Vegetable item names, from THIS app's own catalog — Zoho has no idea
    // what a "vegetable" is, this is the only source of that mapping.
    const { data: vegRows, error: vegErr } = await supabase
      .from('catalog').select('item_name').eq('category', 'vegetable');
    if (vegErr) throw new Error(`catalog read failed: ${vegErr.message}`);
    const vegetableNames = new Set((vegRows ?? []).map((r: any) => (r.item_name || '').trim().toLowerCase()));

    const token = await getZohoToken(supabase);
    zohoCalls++;

    // List every invoice in range (paginated, lightweight — no line items
    // yet, just IDs) so we know the full set before deciding which slice
    // of it this batch will actually fetch detail for.
    const invoiceIds: string[] = [];
    let page = 1;
    while (true) {
      const res = await fetch(booksUrl(`/invoices?date_start=${startDate}&date_end=${endDate}&page=${page}&per_page=200`, orgId), {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
      });
      zohoCalls++;
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || `Zoho invoice list failed (${res.status}): ${JSON.stringify(data).slice(0, 200)}`);
      for (const inv of data.invoices ?? []) invoiceIds.push(inv.invoice_id);
      if (!data.page_context?.has_more_page) break;
      page++;
    }

    const batchIds = invoiceIds.slice(offset, offset + limit);
    const vegStats: Record<string, { invoices: Set<string>; qty: number; value: number }> = {};

    for (const invoiceId of batchIds) {
      const res = await fetch(booksUrl(`/invoices/${invoiceId}`, orgId), {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
      });
      zohoCalls++;
      const data = await res.json();
      if (!res.ok || !data?.invoice) continue; // best-effort — one bad invoice shouldn't kill the whole batch
      for (const li of data.invoice.line_items ?? []) {
        const name = (li.name ?? li.item_name ?? '').trim();
        if (!vegetableNames.has(name.toLowerCase())) continue;
        const qty = parseFloat(li.quantity) || 0;
        const rate = parseFloat(li.rate) || 0;
        if (!vegStats[name]) vegStats[name] = { invoices: new Set(), qty: 0, value: 0 };
        vegStats[name].invoices.add(invoiceId);
        vegStats[name].qty += qty;
        vegStats[name].value += qty * rate;
      }
      await sleep(SLEEP_MS);
    }

    const vegetables = Object.entries(vegStats)
      .map(([item_name, s]) => ({ item_name, invoices: s.invoices.size, qty: Math.round(s.qty * 100) / 100, value: Math.round(s.value) }))
      .sort((a, b) => b.value - a.value);

    const nextOffset = offset + batchIds.length < invoiceIds.length ? offset + batchIds.length : null;

    return new Response(JSON.stringify({
      start_date: startDate, end_date: endDate,
      invoices_in_range: invoiceIds.length,
      invoices_processed_this_batch: batchIds.length,
      zoho_calls_made: zohoCalls,
      next_offset: nextOffset,
      vegetables,
    }), { headers: { ...CORS, 'Content-Type': 'application/json' } });

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
});
