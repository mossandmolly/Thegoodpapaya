// Supabase Edge Function — zoho-vegetable-sales-report
//
// ON-DEMAND reporting tool: pulls REAL invoices straight from Zoho for a
// date range and derives everything the Veg Performance tab shows (order
// mix classification, AOV, daily trend, Top Vegetables, vegetable value) —
// except rider attribution, which Zoho has no concept of at all. The
// client joins the returned invoices' `reference_number` (== sales_order_id)
// against orders.assigned_rider itself for that part.
//
// Uses the Books API (books/v3), not Inventory (inventory/v1) — a
// deliberately different quota pool from sync-invoices, since Inventory's
// rate limit was exhausted this session. If Books is also blocked, this
// will surface that plainly rather than silently returning nothing.
//
// Classification/exclusion mirrors the app's own order_items-based rule
// (Config tab → catalog.category; a line with rate*quantity == 0 is
// treated as free/replacement/no-bill, same convention as "Zero-bill
// replacement/exchange/don't-bill items in invoicing" already uses for
// real Zoho invoices — simpler and more reliable here than text-matching
// descriptions, since it's what Zoho itself actually charged).
//
// Deliberately ON-DEMAND, not wired into any automatic load — a week's
// range is 700+ invoices, i.e. 700+ Zoho calls; firing that on every tab
// open or date-range click would risk repeating the exact runaway-call
// pattern that exhausted the Inventory quota this session, just against
// Books instead. Paced (SLEEP_MS) and paginated (offset/limit) so a
// single run can't itself trip a rate limit — dry-run a small range first.
//
// Input:  { start_date: 'YYYY-MM-DD', end_date: 'YYYY-MM-DD', offset?: number, limit?: number }
//   Defaults to the last 7 days (today inclusive) if start_date/end_date omitted.
// Output: {
//   start_date, end_date, invoices_in_range, invoices_processed_this_batch,
//   zoho_calls_made, next_offset,
//   summary: { total, vegOnly, mixed, fruitOnly, other,
//              aov: { veg:{sum,n}, mixed:{sum,n}, fruit:{sum,n} },
//              byDay: { 'YYYY-MM-DD': { total, veg } },
//              vegRevenue, allRevenue },
//   vegetables: [{ item_name, orders, qty, value }],
//   invoices: [{ reference_number, customer_name, date, total, bucket }],  // for client-side rider join
//   unmatched: [item names with no catalog.category match]
// }
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

function classify(hasFruit: boolean, hasVeg: boolean): 'veg' | 'mixed' | 'fruit' | 'other' {
  if (hasVeg && !hasFruit) return 'veg';
  if (hasVeg && hasFruit)  return 'mixed';
  if (hasFruit && !hasVeg) return 'fruit';
  return 'other';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    await requireAuth(req);
    const body = await req.json().catch(() => ({}));
    const today = new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10); // IST
    const startDate: string = body.start_date || new Date(Date.now() - 6 * 86400_000 + 330 * 60 * 1000).toISOString().slice(0, 10);
    const endDate: string   = body.end_date   || today;
    const offset: number    = body.offset ?? 0;
    const limit: number     = body.limit ?? 25; // invoices per batch — this is 1 Zoho call each

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));
    const orgId = env('ZOHO_ORGANIZATION_ID');
    let zohoCalls = 0;

    // catalog.category — Zoho has no idea what "vegetable"/"fruit" mean,
    // this app's own Config-tab mapping is the only source of that.
    const { data: catRows, error: catErr } = await supabase
      .from('catalog').select('item_name,category');
    if (catErr) throw new Error(`catalog read failed: ${catErr.message}`);
    const catMap = new Map<string, string>();
    for (const r of catRows ?? []) if (r.category) catMap.set((r.item_name || '').trim().toLowerCase(), r.category);

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
    const unmatched = new Set<string>();
    const invoicesOut: { reference_number: string | null; customer_name: string; date: string; total: number; bucket: string }[] = [];

    let vegOnly = 0, mixed = 0, fruitOnly = 0, other = 0;
    const aov: Record<string, { sum: number; n: number }> = { veg: { sum: 0, n: 0 }, mixed: { sum: 0, n: 0 }, fruit: { sum: 0, n: 0 } };
    const byDay: Record<string, { total: number; veg: number }> = {};
    let vegRevenue = 0, allRevenue = 0;

    for (const invoiceId of batchIds) {
      const res = await fetch(booksUrl(`/invoices/${invoiceId}`, orgId), {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
      });
      zohoCalls++;
      const data = await res.json();
      if (!res.ok || !data?.invoice) continue; // best-effort — one bad invoice shouldn't kill the whole batch
      const inv = data.invoice;
      if (inv.status === 'void') continue; // never a real sale

      let hasFruit = false, hasVeg = false;
      for (const li of inv.line_items ?? []) {
        const name = (li.name ?? li.item_name ?? '').trim();
        const qty = parseFloat(li.quantity) || 0;
        const rate = parseFloat(li.rate) || 0;
        const lineTotal = qty * rate;
        // rate*qty == 0 is this app's own "not actually billed" convention
        // for free/replacement/sample items (see "Zero-bill replacement/
        // exchange" invoicing rule) — real Zoho confirmation of the same
        // exclusion order_items' isFreeItem() approximates client-side.
        if (lineTotal === 0) continue;
        const category = catMap.get(name.toLowerCase());
        if (!category) { unmatched.add(name); continue; }
        allRevenue += lineTotal;
        if (category === 'vegetable') {
          hasVeg = true;
          vegRevenue += lineTotal;
          if (!vegStats[name]) vegStats[name] = { invoices: new Set(), qty: 0, value: 0 };
          vegStats[name].invoices.add(invoiceId);
          vegStats[name].qty += qty;
          vegStats[name].value += lineTotal;
        } else if (category === 'fruit') {
          hasFruit = true;
        }
      }

      const bucket = classify(hasFruit, hasVeg);
      if (bucket === 'veg') vegOnly++; else if (bucket === 'mixed') mixed++; else if (bucket === 'fruit') fruitOnly++; else other++;

      const invTotal = parseFloat(inv.total) || 0;
      if (aov[bucket] && invTotal > 0) { aov[bucket].sum += invTotal; aov[bucket].n++; }

      const day = (inv.date || '').slice(0, 10);
      if (day) {
        if (!byDay[day]) byDay[day] = { total: 0, veg: 0 };
        byDay[day].total++;
        if (bucket === 'veg' || bucket === 'mixed') byDay[day].veg++;
      }

      invoicesOut.push({
        reference_number: inv.reference_number || null,
        customer_name: inv.customer_name || '',
        date: day,
        total: invTotal,
        bucket,
      });

      await sleep(SLEEP_MS);
    }

    const vegetables = Object.entries(vegStats)
      .map(([item_name, s]) => ({ item_name, orders: s.invoices.size, qty: Math.round(s.qty * 100) / 100, value: Math.round(s.value) }))
      .sort((a, b) => b.value - a.value);

    const nextOffset = offset + batchIds.length < invoiceIds.length ? offset + batchIds.length : null;

    return new Response(JSON.stringify({
      start_date: startDate, end_date: endDate,
      invoices_in_range: invoiceIds.length,
      invoices_processed_this_batch: batchIds.length,
      zoho_calls_made: zohoCalls,
      next_offset: nextOffset,
      summary: { total: batchIds.length, vegOnly, mixed, fruitOnly, other, aov, byDay, vegRevenue: Math.round(vegRevenue), allRevenue: Math.round(allRevenue) },
      vegetables,
      invoices: invoicesOut,
      unmatched: [...unmatched],
    }), { headers: { ...CORS, 'Content-Type': 'application/json' } });

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
});
