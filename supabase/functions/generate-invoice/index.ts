// Supabase Edge Function — generate-invoice
//
// Input:  { sales_order_id: string, rate_overrides?: { [item_name: string]: string } }
// Output (success):          { invoice_id, invoice_number, sales_order_id, free_items, payment_link }
// Output (needs resolution): { needs_resolution: true, unresolved: [{ item_name, suggestions }] }
//
// Fast path (no prior Zoho invoice):  create only (~600ms)
// Slow path (prior invoice exists):   fetch payments → unapply → delete → create → reapply (~2-3s)
//
// Reads line items from order_items (status='final' only) — every item must
// be packed and marked final before this is called; the frontend only shows
// the "generate invoice" action once that's true for the whole order.
//
// Rate comes live from Zoho Books' /items endpoint (the source of truth for
// pricing), matched to item_name case-insensitively — NOT from the local
// catalog table, which is only a mirror kept fresh as a side effect here and
// can otherwise silently lag behind a price changed directly in Zoho.
// Items whose description contains "replacement", "free", or "free sample"
// are billed at ₹0 regardless of the Zoho rate — reported back in free_items
// so the frontend can show it in the confirmation summary.
// If a non-free item's name doesn't match any live Zoho item at all, the
// request comes back with needs_resolution + closest-name suggestions
// instead of failing outright; resubmit with
// rate_overrides = { item_name: zoho_item_name } once the caller has picked
// the right one, and it'll use that item's live rate.
//
// Sets cf_requested_quantity custom field per line item.
// Updates orders.invoice_status, zoho_invoice_id, invoice_number, invoice_total, balance_due.
// Marks the order_items 'invoiced' on success.
// Does NOT reset amount_paid — cumulative across regenerations.
//
// Also (re)generates the Razorpay payment link, best-effort, if orders.phone
// is set — cancels any prior link first so a stale/wrong-amount link can't be
// paid. If there's no phone on file, payment_link comes back null and the
// dashboard shows a manual "Generate Payment Link" action instead
// (see create-order-payment-link). Unrelated to create-payment-link, which
// serves the public shop checkout.
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_ORGANIZATION_ID
//   CRON_SECRET (only read when a request sends x-cron-secret)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Mirrors ops-dashboard/parser.html's own FREE_ITEM_RE — keep both in
// sync. no_bill (order_items column, migration 049) is the explicit
// "don't bill" override — either it or the keyword is enough to zero-bill.
const FREE_ITEM_RE = /\b(replacement|exchange|free sample|free)\b/i;
function isFreeItem(i: { description?: string | null; no_bill?: boolean }): boolean {
  return FREE_ITEM_RE.test(i.description ?? '') || !!i.no_bill;
}

// Small edit-distance so a typo'd or aliased item name ("Papaya Ripe" vs
// "Ripe Papaya") still surfaces the right catalog row instead of just failing.
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

function closestCatalogNames(name: string, catalogNames: string[], n = 3): string[] {
  return [...catalogNames]
    .map(c => ({ c, d: levenshtein(name.toLowerCase(), c.toLowerCase()) }))
    .sort((x, y) => x.d - y.d)
    .slice(0, n)
    .map(x => x.c);
}

// ── Razorpay payment link (best-effort, only if a phone is on file) ────────
// A regenerated invoice can have a different total, so any existing link is
// cancelled and a fresh one created — never blocks invoice generation itself.
async function razorpayCancelLink(linkId: string, auth: string): Promise<void> {
  await fetch(`https://api.razorpay.com/v1/payment_links/${linkId}/cancel`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}` },
  });
}

async function razorpayCreateLink(
  amountPaise: number, customerName: string, phone: string, salesOrderId: string, auth: string,
): Promise<{ id: string; short_url: string }> {
  const res = await fetch('https://api.razorpay.com/v1/payment_links', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount:   amountPaise,
      currency: 'INR',
      description: `The Good Papaya — order ${salesOrderId}`,
      customer: { name: customerName, contact: `+91${phone.replace(/^\+91/, '')}` },
      notify:          { sms: true, whatsapp: true, email: false },
      reminder_enable: false,
      notes: { sales_order_id: salesOrderId, source: 'ops-dashboard' },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.description || 'Razorpay error');
  return { id: data.id, short_url: data.short_url };
}

// ── Razorpay Dynamic QR Code — the delivery-panel mechanism (dispatch-order/
// sync-invoices) — kept in sync with a regenerated invoice the same way the
// payment link above is. orders.qr_code_id/razorpay_link_id are mutually
// exclusive at any given time (see reconcileOrderPayment in sync-invoices),
// so only whichever one is currently active on the order gets touched here —
// never both, and never invented fresh if neither was active yet.
async function razorpayCloseQr(qrCodeId: string, auth: string): Promise<void> {
  await fetch(`https://api.razorpay.com/v1/payments/qr_codes/${qrCodeId}/close`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}` },
  });
}

async function razorpayCreateQr(
  amountPaise: number, customerName: string, salesOrderId: string, auth: string,
): Promise<{ id: string; image_url: string }> {
  const res = await fetch('https://api.razorpay.com/v1/payments/qr_codes', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type:           'upi_qr',
      name:            `Order ${salesOrderId}`,
      usage:          'single_use',
      fixed_amount:    true,
      payment_amount:  amountPaise,
      description:    `The Good Papaya — order ${salesOrderId}`,
      close_by:        Math.floor(Date.now() / 1000) + 24 * 60 * 60,
      notes:          { sales_order_id: salesOrderId, customer_name: customerName, source: 'delivery-qr' },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.description || 'Razorpay QR error');
  return { id: data.id, image_url: data.image_url };
}

function env(key: string) {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Missing env: ${key}`);
  return val;
}

// This function uses the service role internally, so it bypasses RLS
// regardless of who calls it — the anon key alone is enough to invoke it at
// the platform level. Requiring a real logged-in user session here is what
// actually restricts this to signed-in ops staff (it also touches real Zoho
// invoices and Razorpay payment links, so this matters more than most).
//
// x-cron-secret is the one exception — auto-invoice-final-orders (see
// migration 055) calls this on a schedule with no user session to send, the
// same shared-secret pattern export-csv/purge-delivery-photos already use.
async function requireAuth(req: Request): Promise<void> {
  const cronSecret = req.headers.get('x-cron-secret');
  if (cronSecret) {
    if (cronSecret !== env('CRON_SECRET')) throw new Error('Not authorized');
    return;
  }
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) throw new Error('Not authenticated');
  const res = await fetch(`${env('SUPABASE_URL')}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${jwt}`, apikey: env('SUPABASE_SERVICE_ROLE_KEY') },
  });
  if (!res.ok) throw new Error('Not authenticated');
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-cron-secret',
};

// ── Zoho OAuth ────────────────────────────────────────────────────────────────
// Two-tier cache: an in-memory one (fast path within a warm isolate) backed
// by a shared `zoho_token_cache` row in Postgres. The in-memory cache alone
// isn't enough — generate-invoice, cancel-order, and download-invoice each
// run as separate functions with their OWN isolates, so switching between
// actions (e.g. downloading invoices, then generating more) used to mean
// each function fetched its own fresh token from Zoho, working against the
// very rate limit the cache was meant to avoid ("You have made too many
// requests continuously"). The DB row lets every function reuse the same
// token and refresh it only once across the whole system.
let cachedToken = '';
let tokenExpiry = 0;

async function getZohoToken(supabase: ReturnType<typeof createClient>): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry - 60_000) return cachedToken;

  const { data: row } = await supabase
    .from('zoho_token_cache').select('access_token,expires_at').eq('id', 1).maybeSingle();
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
      refresh_token: env('ZOHO_REFRESH_TOKEN'),
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Zoho OAuth failed: ${JSON.stringify(data)}`);
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in ?? 3600) * 1000;
  const { error: cacheErr } = await supabase.from('zoho_token_cache').upsert({
    id: 1, access_token: cachedToken, expires_at: new Date(tokenExpiry).toISOString(),
  });
  if (cacheErr) console.error('zoho_token_cache upsert failed:', cacheErr.message);
  return cachedToken;
}

function zohoUrl(path: string, orgId: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `https://www.zohoapis.in/books/v3${path}${sep}organization_id=${orgId}`;
}

function zohoHeaders(token: string): HeadersInit {
  return { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' };
}

// ── Live item rates ───────────────────────────────────────────────────────────
// Zoho Books is the single source of truth for pricing. This used to read
// rates from the local `catalog` table instead — a mirror that only updates
// when someone remembers to run sync-catalog — so a price changed directly
// in Zoho could sit un-synced indefinitely while invoices kept going out at
// the old rate. Pulling live here means every invoice bills whatever Zoho
// says right now, full stop.
async function fetchZohoItems(
  token: string, orgId: string,
): Promise<Array<{ name: string; rate: number; item_id: string; unit: string }>> {
  let page = 1;
  const all: Array<{ name: string; rate: number; item_id: string; unit: string }> = [];
  while (true) {
    const res = await fetch(
      zohoUrl(`/items?status=active&page=${page}&per_page=200`, orgId),
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
    );
    const d = await res.json();
    if (!res.ok) throw new Error(`Zoho items fetch failed: ${d.message || res.status}`);
    const items = d.items ?? [];
    all.push(...items.map((i: any) => ({
      name: i.name as string, rate: i.rate ?? 0, item_id: i.item_id as string, unit: i.unit || 'kg',
    })));
    if (!d.page_context?.has_more_page) break;
    page++;
  }
  return all;
}

// Same identity rule as the frontend's canonicalCustomerKey — case AND
// punctuation/spacing insensitive — so "Assetz 12-098" and "Assetz 12098"
// match the same Zoho contact instead of the old plain-lowercase compare
// (which only caught case differences) creating a duplicate for the latter.
function canonicalKey(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ── Find or create a Zoho contact ────────────────────────────────────────────
// Backfills customers.zoho_contact_id here, best-effort, the moment a
// contact_id is resolved — previously this only ever got written by the
// separate sync-customers function, which someone has to trigger manually.
// A customer's very first invoice would create/find their Zoho contact fine
// (invoicing itself never depended on the local row), but left
// customers.zoho_contact_id null until the next manual sync — silently
// breaking razorpay-webhook's recordZohoPayment lookup (keyed on this same
// column) for every payment in between. Keyed on customer_name, same as
// order.customer_name that razorpay-webhook looks up by.
async function getOrCreateContact(
  name: string, phone: string | null, token: string, orgId: string,
  supabase: ReturnType<typeof createClient>,
): Promise<string> {
  const search = await fetch(
    zohoUrl(`/contacts?contact_name=${encodeURIComponent(name)}`, orgId),
    { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
  );
  const sd = await search.json();
  const targetKey = canonicalKey(name);
  const existing = sd.contacts?.find(
    (c: any) => canonicalKey(c.contact_name) === targetKey,
  );

  let contactId: string;
  if (existing) {
    contactId = existing.contact_id;
  } else {
    const body: any = { contact_name: name, contact_type: 'customer' };
    if (phone) body.contact_persons = [{ phone }];
    const create = await fetch(zohoUrl('/contacts', orgId), {
      method: 'POST',
      headers: zohoHeaders(token),
      body: JSON.stringify(body),
    });
    const cd = await create.json();
    if (cd.code !== 0) throw new Error(`Zoho create contact failed: ${cd.message}`);
    contactId = cd.contact.contact_id;
  }

  supabase.from('customers').upsert(
    { customer_name: name, zoho_contact_id: contactId, active: true },
    { onConflict: 'customer_name' },
  ).then(({ error }) => { if (error) console.error('customers.zoho_contact_id backfill failed:', error.message); });

  return contactId;
}

// ── Payments applied to a Zoho invoice ───────────────────────────────────────
async function fetchAppliedPayments(
  invoiceId: string, token: string, orgId: string,
): Promise<Array<{ payment_id: string; amount_applied: number }>> {
  const res  = await fetch(zohoUrl(`/invoices/${invoiceId}/payments`, orgId), {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  const data = await res.json();
  return (data.payments ?? []).map((p: any) => ({
    payment_id:     p.payment_id as string,
    amount_applied: parseFloat(p.amount_applied ?? p.amount ?? 0),
  }));
}

async function unapplyPayment(
  invoiceId: string, paymentId: string, token: string, orgId: string,
): Promise<void> {
  await fetch(zohoUrl(`/invoices/${invoiceId}/payments/${paymentId}`, orgId), {
    method: 'DELETE',
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
}

async function deleteZohoInvoice(invoiceId: string, token: string, orgId: string): Promise<void> {
  const res  = await fetch(zohoUrl(`/invoices/${invoiceId}`, orgId), {
    method: 'DELETE',
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  const data = await res.json();
  // code 0 = success; 5/1002 = not found — already gone (e.g. someone deleted
  // it directly in Zoho), which is exactly as good as this call having
  // deleted it itself, so regeneration should proceed rather than fail.
  if (data.code !== 0 && data.code !== 5 && data.code !== 1002) {
    throw new Error(`Zoho delete invoice failed (${data.code}): ${data.message}`);
  }
}

// GST place of supply is the customer's delivery location, not where we
// source fruit from (wholesale origin is irrelevant to GST) — every
// delivery today is a Bangalore-area residential address, so this is
// Karnataka on every invoice. Named here as a single source of truth
// rather than a literal in the request body, since the day a delivery
// goes outside Karnataka this needs to become per-order, not a constant.
const PLACE_OF_SUPPLY = 'KA';

// ── Create Zoho Books invoice ─────────────────────────────────────────────────
async function createZohoInvoice(
  contactId: string,
  salesOrderId: string,
  date: string,
  lineItems: Array<{ name: string; requested_qty: number; qty: number; rate: number; description?: string; item_id?: string }>,
  token: string,
  orgId: string,
): Promise<{ invoice_id: string; invoice_number: string; invoice_total: number }> {
  const body = {
    customer_id:      contactId,
    reference_number: salesOrderId,
    date,
    place_of_supply:  PLACE_OF_SUPPLY,
    // item_id, when known, is what actually links this line to the right
    // Zoho catalog item — name alone is Zoho's case-sensitive fallback,
    // exactly what created "ghost" unlinked items before (see the comment
    // where lineItems gets built).
    line_items: lineItems.map(i => ({
      ...(i.item_id ? { item_id: i.item_id } : {}),
      name:        i.name,
      description: i.description || '',
      quantity:    i.qty,
      rate:        i.rate,
      custom_fields: [{ api_name: 'cf_requested_quantity', value: i.requested_qty }],
    })),
  };
  const res  = await fetch(zohoUrl('/invoices', orgId), {
    method: 'POST',
    headers: zohoHeaders(token),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Zoho create invoice failed: ${data.message}`);
  const inv  = data.invoice;
  return {
    invoice_id:    inv.invoice_id,
    invoice_number: inv.invoice_number,
    invoice_total: parseFloat(inv.total ?? '0'),
  };
}

// Zoho creates every invoice as 'draft' by default — a draft invoice can't
// have a payment properly recorded/reflected against it (Zoho's own
// customerpayments API and balance tracking expect a real, issued
// invoice), which is why payments coming in via Razorpay were failing to
// show as paid anywhere downstream. Marking it sent immediately after
// creation is what actually makes it a live, payable invoice. Best-effort
// — a failure here shouldn't fail invoice generation itself, though it
// does mean this specific invoice would need a manual "mark as sent" in
// Zoho to unblock payment tracking.
async function markZohoInvoiceSent(invoiceId: string, token: string, orgId: string): Promise<void> {
  try {
    await fetch(zohoUrl(`/invoices/${invoiceId}/status/sent`, orgId), {
      method: 'POST',
      headers: zohoHeaders(token),
    });
  } catch (_e) {} // best effort
}

async function applyPaymentToInvoice(
  invoiceId: string, paymentId: string, amount: number, token: string, orgId: string,
): Promise<void> {
  const res  = await fetch(zohoUrl(`/invoices/${invoiceId}/payments`, orgId), {
    method: 'POST',
    headers: zohoHeaders(token),
    body: JSON.stringify({ payments: [{ payment_id: paymentId, amount_applied: amount }] }),
  });
  const data = await res.json();
  if (data.code !== 0) console.warn(`Payment reapply warning: ${data.message}`);
}

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    await requireAuth(req);
    const { sales_order_id, rate_overrides } = await req.json();
    if (!sales_order_id) throw new Error('Missing sales_order_id');
    const overrides: Record<string, string> = rate_overrides ?? {};

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));
    const token    = await getZohoToken(supabase);
    const orgId    = env('ZOHO_ORGANIZATION_ID');

    // Load order header and its billable order_items in parallel. 'invoiced'
    // items are included alongside 'final' ones — otherwise regenerating (see
    // the slow path below, which deletes the existing Zoho invoice first)
    // would only pull newly-final items and drop everything billed by a prior
    // run, since generate-invoice itself is what flips final -> invoiced.
    const [{ data: order, error: orderErr }, { data: items, error: itemsErr }] = await Promise.all([
      supabase.from('orders').select('*').eq('sales_order_id', sales_order_id).single(),
      supabase.from('order_items').select('*').eq('sales_order_id', sales_order_id).in('status', ['final', 'invoiced']),
    ]);
    if (orderErr || !order) throw new Error(`Order ${sales_order_id} not found`);
    if (itemsErr) throw new Error(itemsErr.message);
    if (!items?.length) throw new Error(`No final items for ${sales_order_id} — pack and mark every item final first`);

    const missing = items.filter((i: any) => i.final_quantity == null);
    if (missing.length) {
      throw new Error(`Missing final qty: ${missing.map((i: any) => i.item_name).join(', ')}`);
    }

    const zohoItems = await fetchZohoItems(token, orgId);
    const catalogNames = zohoItems.map(i => i.name);
    const rateByLowerName = new Map(zohoItems.map(i => [i.name.toLowerCase(), i.rate]));
    // The actual fix for "ghost items" (see fix-invoice-item-casing, the
    // one-off batch correction already run for historical invoices): Zoho
    // was never told which catalog item a line is, only its name — so any
    // casing mismatch between order_items.item_name and Zoho's own item
    // name (e.g. an AI-parsed "Kiwi Green" vs the catalog's "Kiwi green")
    // makes Zoho create a brand new unlinked item instead of matching the
    // existing one. Sending item_id explicitly (looked up case-
    // insensitively, same as rate already is) makes the match exact and
    // casing-proof — the name field becomes informational only once an id
    // is present.
    const itemIdByLowerName = new Map(zohoItems.map(i => [i.name.toLowerCase(), i.item_id]));

    // Best-effort: keep the local catalog mirror fresh as a side effect of
    // every invoice, since Config/Stock/Packer still read it for unit labels
    // and autocomplete — but this never gates or blocks invoicing itself.
    // Upserts on item_name (catalog's own unique column — see migration
    // 013), not zoho_item_id: that index is only unique among non-null
    // values, so conflicting on it silently fails to catch a pre-existing
    // row at the same item_name under a different/no zoho_item_id, which
    // then throws catalog's OWN item_name uniqueness constraint instead.
    // i.name is Zoho's exact casing verbatim (matches sync-catalog) — Zoho
    // item matching/pricing is case-sensitive, so this table must mirror
    // that exactly for every order (built from this same autocomplete) to
    // invoice against the right item.
    supabase.from('catalog').upsert(
      zohoItems.map(i => ({
        item_name: i.name, unit_price: i.rate, unit: i.unit, active: true,
        zoho_item_id: i.item_id, synced_at: new Date().toISOString(),
      })),
      { onConflict: 'item_name' },
    ).then(({ error }) => { if (error) console.error('Catalog mirror refresh failed:', error.message); });

    const freeItems: string[] = [];
    const unresolved: Array<{ item_name: string; suggestions: string[] }> = [];
    const lineItems: Array<{ name: string; requested_qty: number; qty: number; rate: number; description?: string; item_id?: string }> = [];

    for (const i of items) {
      const isFree = isFreeItem(i);
      if (isFree) {
        freeItems.push(i.item_name);
        lineItems.push({
          name: i.item_name, requested_qty: i.requested_quantity ?? 0,
          qty: i.final_quantity ?? 0, rate: 0, description: i.description || undefined,
          item_id: itemIdByLowerName.get((i.item_name as string).toLowerCase()),
        });
        continue;
      }

      let lookupKey = (i.item_name as string).toLowerCase();
      let rate = rateByLowerName.get(lookupKey);
      if (rate === undefined && overrides[i.item_name]) {
        lookupKey = overrides[i.item_name].toLowerCase();
        rate = rateByLowerName.get(lookupKey);
      }
      if (rate === undefined) {
        unresolved.push({ item_name: i.item_name, suggestions: closestCatalogNames(i.item_name, catalogNames) });
        continue;
      }

      lineItems.push({
        name: i.item_name, requested_qty: i.requested_quantity ?? 0,
        qty: i.final_quantity ?? 0, rate, description: i.description || undefined,
        item_id: itemIdByLowerName.get(lookupKey),
      });
    }

    if (unresolved.length) {
      return new Response(
        JSON.stringify({ needs_resolution: true, unresolved }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    const contactId = await getOrCreateContact(
      order.customer_name,
      order.phone ? `+91${order.phone.replace(/^\+91/, '')}` : null,
      token, orgId, supabase,
    );

    // Slow path: existing invoice — unapply payments, delete, recreate, reapply
    let priorPayments: Array<{ payment_id: string; amount_applied: number }> = [];
    if (order.zoho_invoice_id) {
      priorPayments = await fetchAppliedPayments(order.zoho_invoice_id, token, orgId);
      await Promise.all(
        priorPayments.map(p => unapplyPayment(order.zoho_invoice_id, p.payment_id, token, orgId)),
      );
      await deleteZohoInvoice(order.zoho_invoice_id, token, orgId);
    }

    const invoiceDate = order.invoice_date ?? new Date().toISOString().split('T')[0];
    const { invoice_id, invoice_number, invoice_total } = await createZohoInvoice(
      contactId, sales_order_id, invoiceDate, lineItems, token, orgId,
    );
    await markZohoInvoiceSent(invoice_id, token, orgId);

    // Reapply prior payments to new invoice
    for (const p of priorPayments) {
      await applyPaymentToInvoice(invoice_id, p.payment_id, p.amount_applied, token, orgId);
    }

    const amountPaid = order.amount_paid ?? 0;
    const balanceDue = Math.max(0, invoice_total - amountPaid);

    await supabase.from('orders').update({
      zoho_invoice_id: invoice_id,
      invoice_number,
      invoice_date:    invoiceDate,
      invoice_total,
      balance_due:     balanceDue,
      invoice_status:  'done',
    }).eq('sales_order_id', sales_order_id);

    await supabase.from('order_items')
      .update({ status: 'invoiced' })
      .in('id', items.map((i: any) => i.id));

    // Best-effort: (re)generate whichever payment mechanism was already
    // active on this order so it reflects the current invoice total — never
    // invents one that wasn't there before (an order nobody's dispatched or
    // manually linked yet stays untouched), and never creates a second one
    // alongside whichever's already active (orders.qr_code_id and
    // razorpay_link_id are mutually exclusive by design).
    let paymentLink: string | null = null;
    try {
      const keyId     = Deno.env.get('RAZORPAY_KEY_ID');
      const keySecret = Deno.env.get('RAZORPAY_KEY_SECRET');
      if (keyId && keySecret) {
        const auth = btoa(`${keyId}:${keySecret}`);
        if (order.qr_code_id) {
          await razorpayCloseQr(order.qr_code_id, auth);
          const qr = await razorpayCreateQr(
            Math.round(invoice_total * 100), order.customer_name, sales_order_id, auth,
          );
          await supabase.from('orders').update({
            qr_code_id:    qr.id,
            qr_image_url:  qr.image_url,
            qr_created_at: new Date().toISOString(),
          }).eq('sales_order_id', sales_order_id);
        } else if (order.razorpay_link_id && order.phone) {
          await razorpayCancelLink(order.razorpay_link_id, auth);
          const link = await razorpayCreateLink(
            Math.round(invoice_total * 100), order.customer_name, order.phone, sales_order_id, auth,
          );
          await supabase.from('orders').update({
            razorpay_link_id: link.id,
            razorpay_url:     link.short_url,
          }).eq('sales_order_id', sales_order_id);
          paymentLink = link.short_url;
        }
      }
    } catch (_e) {
      // swallow — payment link/QR refresh is a nice-to-have, not load-bearing for invoicing
    }

    return new Response(
      JSON.stringify({ invoice_id, invoice_number, sales_order_id, free_items: freeItems, payment_link: paymentLink }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
