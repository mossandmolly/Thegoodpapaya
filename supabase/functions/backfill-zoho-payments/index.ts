// Supabase Edge Function — backfill-zoho-payments
//
// ONE-OFF historical cleanup: nothing before this ever pushed
// orders.payment_collected=true BACK into Zoho for an order whose Zoho
// payment recording silently failed or was skipped (e.g. the
// customers.zoho_contact_id gap fixed alongside this — see
// generate-invoice's getOrCreateContact backfill and razorpay-webhook's
// switch to reading customer_id off the invoice itself). sync-invoices'
// reconciliation only ever reads FROM Zoho INTO orders, never the other
// direction, so any order stuck in that gap stays showing unpaid in Zoho
// forever unless something actively fixes it. This is that fix, run once.
//
// For every order where payment_collected=true and a zoho_invoice_id
// exists: fetch the invoice's current Zoho balance directly. If Zoho still
// shows an outstanding balance, record a payment for exactly that amount
// (not order.amount_paid — Zoho's own number is the one that needs to hit
// zero) via /customerpayments, using the invoice's own customer_id (same
// sales_order_id -> zoho_invoice_id -> customer_id chain razorpay-webhook
// now uses — never a name-keyed lookup). If Zoho already shows the invoice
// paid, it's left untouched.
//
// Input:  { dryRun?: boolean (default true), offset?: number, limit?: number, datePrefix?: string }
// datePrefix (e.g. "2026-08-14") scopes to one day's orders only — omit to
// scan all-time (oldest date first, since sales_order_id sorts
// alphabetically).
// Output: { processed, alreadyPaidInZoho, recorded, errors, nextOffset, results: [...] }
//
// dryRun (default true!) only fetches each invoice's Zoho balance and
// reports what WOULD be recorded — it never calls /customerpayments. Always
// run with dryRun:true first and read the results before calling again with
// dryRun:false. offset/limit page through matching orders in batches so one
// invocation doesn't run into the edge function time limit or Zoho's own
// API rate limit; nextOffset in the response tells you where to resume,
// null once every matching order's been processed.
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

// Shared Zoho OAuth token cache — same pattern as every other Zoho-touching
// function (generate-invoice, cancel-order, razorpay-webhook, ...).
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
  // Zoho rotates refresh_token on (at least some) refresh calls and
  // invalidates the old one — persist whatever it returns so every
  // function keeps reading a live one instead of the static env secret.
  const { error: cacheErr } = await supabase.from('zoho_token_cache').upsert({
    id: 1, access_token: cachedToken, expires_at: new Date(tokenExpiry).toISOString(),
    ...(data.refresh_token ? { refresh_token: data.refresh_token } : {}),
  });
  if (cacheErr) console.error('zoho_token_cache upsert failed:', cacheErr.message);
  return cachedToken;
}

function zohoUrl(path: string, orgId: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `https://www.zohoapis.in/books/v3${path}${sep}organization_id=${orgId}`;
}

async function fetchInvoice(
  invoiceId: string, token: string, orgId: string,
): Promise<{ balance: number; customer_id: string | null; status: string } | null> {
  const res  = await fetch(zohoUrl(`/invoices/${invoiceId}`, orgId), {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  const data = await res.json();
  if (!res.ok || !data?.invoice) return null;
  return {
    balance:     parseFloat(data.invoice.balance ?? data.invoice.total ?? '0'),
    customer_id: data.invoice.customer_id ?? null,
    status:      data.invoice.status ?? '',
  };
}

async function recordPayment(
  customerId: string, invoiceId: string, amount: number, token: string, orgId: string,
): Promise<void> {
  const res  = await fetch(zohoUrl('/customerpayments', orgId), {
    method: 'POST',
    headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_id:      customerId,
      payment_mode:     'onlinepayment',
      amount,
      date:              new Date().toISOString().slice(0, 10),
      reference_number:  'Backfill: unrecorded payment', // Zoho caps this field at 50 chars
      invoices: [{ invoice_id: invoiceId, amount_applied: amount }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || `Zoho payment recording failed (${res.status})`);
}

const SLEEP_MS = 300; // stay well under Zoho's per-minute rate limit across a batch
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    await requireAuth(req);
    const body: any    = await req.json().catch(() => ({}));
    const dryRun        = body.dryRun !== false; // default true — must explicitly pass false to write
    const offset: number = body.offset ?? 0;
    const limit: number  = body.limit ?? 50;

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));
    const orgId     = env('ZOHO_ORGANIZATION_ID');

    // Optional datePrefix (e.g. "2026-08-14") scopes this to one day's
    // orders instead of all-time — sales_order_id sorts alphabetically, so
    // an unscoped run walks oldest-date-first (2026-07-... before
    // 2026-08-...), not most-recent-first.
    const datePrefix: string | undefined = body.datePrefix;
    let query = supabase
      .from('orders')
      .select('sales_order_id, zoho_invoice_id, amount_paid')
      .eq('payment_collected', true)
      .not('zoho_invoice_id', 'is', null);
    if (datePrefix) query = query.like('sales_order_id', `${datePrefix}-%`);
    const { data: orders, error: ordersErr } = await query
      .order('sales_order_id')
      .range(offset, offset + limit - 1);
    if (ordersErr) throw new Error(ordersErr.message);

    const results: Array<{ sales_order_id: string; action: string; detail?: string }> = [];
    let alreadyPaidInZoho = 0;
    let recorded = 0;
    let errors = 0;

    for (const order of orders ?? []) {
      try {
        const token   = await getZohoToken(supabase);
        const invoice = await fetchInvoice(order.zoho_invoice_id, token, orgId);

        if (!invoice) {
          results.push({ sales_order_id: order.sales_order_id, action: 'invoice_not_found', detail: order.zoho_invoice_id });
          errors++;
        } else if (invoice.status === 'void') {
          results.push({ sales_order_id: order.sales_order_id, action: 'skipped_void_invoice' });
        } else if (invoice.balance <= 0) {
          results.push({ sales_order_id: order.sales_order_id, action: 'already_paid_in_zoho' });
          alreadyPaidInZoho++;
        } else if (!invoice.customer_id) {
          results.push({ sales_order_id: order.sales_order_id, action: 'no_customer_id_on_invoice' });
          errors++;
        } else if (dryRun) {
          results.push({ sales_order_id: order.sales_order_id, action: 'would_record_payment', detail: `₹${invoice.balance}` });
        } else {
          await recordPayment(invoice.customer_id, order.zoho_invoice_id, invoice.balance, token, orgId);
          results.push({ sales_order_id: order.sales_order_id, action: 'recorded_payment', detail: `₹${invoice.balance}` });
          recorded++;
        }
      } catch (e: any) {
        results.push({ sales_order_id: order.sales_order_id, action: 'error', detail: e.message });
        errors++;
      }
      await sleep(SLEEP_MS);
    }

    const nextOffset = (orders?.length ?? 0) === limit ? offset + limit : null;

    return new Response(
      JSON.stringify({
        dryRun, processed: orders?.length ?? 0, alreadyPaidInZoho, recorded, errors, nextOffset, results,
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
