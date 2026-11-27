// Supabase Edge Function — check-stale-payments
//
// Finds orders (Oct 27 onward — same cutoff My Invoices/Phone Lookup use)
// still sitting at balance_due > 0 even though the same house has a MORE
// RECENT order that's already paid — almost always because the older one
// actually did get paid and nobody marked it. For each one, checks Zoho's
// own LIVE invoice balance (never trusts anything cached in Supabase) and
// only updates orders.balance_due/payment_collected for ones Zoho itself
// confirms are paid.
//
// Paginated on purpose — processes one page of flagged invoices per call
// (default 25) rather than all ~400+ in one request, so a single
// invocation can't run long enough to hit the function's execution
// timeout. The ops-dashboard calls this in a loop, accumulating a running
// total, until done:true.
//
// Houses with a phone on file are checked before houses without one —
// the flagged list itself is sorted that way, same ordering every page.
//
// commit:false (default) — dry run, nothing written, just reports what
// WOULD change. commit:true — actually applies the updates for whatever
// Zoho confirms paid.
//
// Input:  { commit?: boolean, offset?: number, limit?: number }
// Output: { totalFlagged, offset, nextOffset, done, results: [{
//             sales_order_id, customer_name, phone, outcome: 'paid'|'pending'|'error',
//             zoho_balance?, error?
//           }] }
//
// Server-side restricted to Somya/Rohith (same as fix-phone-mapping) —
// this writes real payment data across real customer orders.
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

const ALLOWED_EMAILS = new Set(['somya@thegoodpapaya.com', 'rohith@thegoodpapaya.com']);

async function requireAdminAuth(req: Request): Promise<void> {
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) throw new Error('Not authenticated');
  const res = await fetch(`${env('SUPABASE_URL')}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${jwt}`, apikey: env('SUPABASE_SERVICE_ROLE_KEY') },
  });
  if (!res.ok) throw new Error('Not authenticated');
  const user = await res.json();
  const email = (user?.email || '').toLowerCase();
  if (!ALLOWED_EMAILS.has(email)) throw new Error('Not authorized for this action');
}

const CUTOFF_DATE = '2026-10-27';

function normalizeKey(name: string): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function orderDateOf(salesOrderId: string): string {
  return (salesOrderId || '').slice(0, 10);
}

// Same shared zoho_token_cache row every other Zoho-touching function uses.
async function getZohoToken(supabase: ReturnType<typeof createClient>): Promise<string> {
  const { data: row } = await supabase
    .from('zoho_token_cache').select('access_token,expires_at,refresh_token').eq('id', 1).maybeSingle();
  if (row && new Date(row.expires_at).getTime() > Date.now() + 60_000) {
    return row.access_token;
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
  const expiresAt = new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString();
  await supabase.from('zoho_token_cache').upsert({
    id: 1, access_token: data.access_token, expires_at: expiresAt,
    ...(data.refresh_token ? { refresh_token: data.refresh_token } : {}),
  });
  return data.access_token;
}

async function fetchZohoInvoice(invoiceId: string, token: string, orgId: string): Promise<any> {
  // Switched from Zoho Books to Zoho Inventory's API (higher rate limit,
  // same org/contacts/items/invoices data) — override via ZOHO_BASE_URL
  // if this ever needs to roll back to Books without a redeploy.
  const base = Deno.env.get('ZOHO_BASE_URL') ?? 'https://www.zohoapis.in/inventory/v1';
  const res = await fetch(
    `${base}/invoices/${invoiceId}?organization_id=${orgId}`,
    { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
  );
  const data = await res.json();
  if (!res.ok || !data.invoice) throw new Error(data?.message || `Zoho fetch failed (${res.status})`);
  return data.invoice;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    await requireAdminAuth(req);
    const { commit, offset, limit } = await req.json().catch(() => ({}));
    const pageOffset = Number(offset) || 0;
    const pageLimit = Math.min(Number(limit) || 25, 100);

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    const { data: orders, error: ordersErr } = await supabase
      .from('orders')
      .select('sales_order_id,customer_name,phone,balance_due,zoho_invoice_id')
      .not('zoho_invoice_id', 'is', null)
      .neq('status', 'cancelled');
    if (ordersErr) throw new Error(ordersErr.message);

    const inWindow = (orders ?? []).filter(o => orderDateOf(o.sales_order_id) >= CUTOFF_DATE);

    const byCust = new Map<string, typeof inWindow>();
    for (const o of inWindow) {
      const key = normalizeKey(o.customer_name);
      if (!byCust.has(key)) byCust.set(key, []);
      byCust.get(key)!.push(o);
    }

    const flagged: typeof inWindow = [];
    for (const rows of byCust.values()) {
      const paidDates = rows.filter(o => (+o.balance_due || 0) <= 0).map(o => orderDateOf(o.sales_order_id));
      if (!paidDates.length) continue;
      const recentPaidDate = paidDates.reduce((a, b) => (b > a ? b : a));
      for (const o of rows) {
        if ((+o.balance_due || 0) > 0 && orderDateOf(o.sales_order_id) < recentPaidDate) {
          flagged.push(o);
        }
      }
    }

    // Houses with a phone first, then everyone else — same ordering on
    // every page since it's recomputed fresh each call (cheap: no Zoho
    // calls in this part), so pagination stays consistent across calls.
    flagged.sort((a, b) => {
      const aHasPhone = a.phone ? 0 : 1, bHasPhone = b.phone ? 0 : 1;
      if (aHasPhone !== bHasPhone) return aHasPhone - bHasPhone;
      return a.sales_order_id.localeCompare(b.sales_order_id);
    });

    const page = flagged.slice(pageOffset, pageOffset + pageLimit);
    const token = page.length ? await getZohoToken(supabase) : '';
    const orgId = Deno.env.get('ZOHO_ORGANIZATION_ID') || Deno.env.get('ZOHO_ORG_ID') || '';

    const results = [];
    for (const o of page) {
      try {
        const inv = await fetchZohoInvoice(o.zoho_invoice_id, token, orgId);
        const zohoBalance = parseFloat(inv.balance ?? '0');
        const zohoTotal = parseFloat(inv.total ?? '0');

        if (zohoBalance <= 0) {
          if (commit) {
            const { error: updErr } = await supabase.from('orders').update({
              balance_due: 0,
              payment_collected: true,
              payment_collected_method: 'online',
              payment_collected_at: new Date().toISOString(),
              amount_paid: zohoTotal,
            }).eq('sales_order_id', o.sales_order_id);
            if (updErr) throw new Error(updErr.message);
          }
          results.push({ sales_order_id: o.sales_order_id, customer_name: o.customer_name, phone: o.phone, outcome: 'paid', zoho_balance: zohoBalance });
        } else {
          results.push({ sales_order_id: o.sales_order_id, customer_name: o.customer_name, phone: o.phone, outcome: 'pending', zoho_balance: zohoBalance });
        }
      } catch (e: any) {
        results.push({ sales_order_id: o.sales_order_id, customer_name: o.customer_name, phone: o.phone, outcome: 'error', error: e.message });
      }
    }

    const nextOffset = pageOffset + page.length;
    return new Response(
      JSON.stringify({
        totalFlagged: flagged.length,
        offset: pageOffset,
        nextOffset,
        done: nextOffset >= flagged.length,
        results,
      }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
