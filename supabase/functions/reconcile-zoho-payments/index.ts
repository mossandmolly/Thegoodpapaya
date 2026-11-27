// Supabase Edge Function — reconcile-zoho-payments
//
// Catches the one real gap neither razorpay-webhook nor mark-order-paid
// can ever see: a payment entered DIRECTLY in Zoho's own web UI (bank
// transfer, cheque, cash entered by hand there) completely bypassing this
// app. Both of those existing paths already update orders/invoice_line_items
// in the same request that pushes the payment into Zoho, so there's never
// anything to reconcile for a payment that came through either of them —
// this is purely for the case where Zoho knows about a payment and our own
// tables don't yet.
//
// Meant to be triggered every 3 hours by pg_cron (see migration 175), same
// shared x-cron-secret pattern as auto-invoice-final-orders/extract-
// delivery-windows. Looks back a rolling 24 hours by default (Zoho's own
// customerpayments date filter is day-granular, not hour-granular, so
// this actually scans yesterday+today and relies on the idempotent
// "already in sync? skip" check below rather than a precise cutoff).
//
// Optional body { date_start, date_end } (YYYY-MM-DD, both inclusive)
// overrides that default window entirely — for a manual one-off backfill
// over an explicit range (e.g. "reconcile everything between Oct 27 and
// Nov 5") rather than the cron's own rolling-24h call. Safe to run
// against a wide range: every check is the same idempotent "already in
// sync? skip" logic, so re-running over a range that overlaps a previous
// run (cron or manual) just finds nothing new to do for anything already
// settled.
//
// Pipeline:
//   1. List every Zoho customer payment recorded in the last 2 Zoho-side
//      calendar days (GET /customerpayments, paginated).
//   2. Skip anything whose reference_number marks it as ALREADY one of
//      this app's own two channels — "Razorpay ..." (razorpay-webhook) or
//      "Manual (..." (mark-order-paid). Not strictly required for
//      correctness (step 4's own comparison would no-op these anyway,
//      since both paths already sync orders/invoice_line_items
//      synchronously) but avoids a wasted invoice re-fetch for the
//      overwhelming majority of payments, which did come through one of
//      those two paths.
//   3. For each remaining payment's distinct invoice_id(s), fetch that
//      invoice's CURRENT live balance from Zoho (never trust the payment
//      list's own amount_applied — only the invoice's own running balance
//      says whether it's now actually fully paid).
//   4. Balance > 0 (partially paid, or this payment doesn't fully close
//      it) — skip; nothing to do until it's genuinely fully paid. Balance
//      === 0 and the local orders row already shows balance_due=0 /
//      payment_collected=true — also skip (already in sync, most likely
//      because it WAS one of this app's own two channels after all, or a
//      previous run of this same job already caught it). Otherwise:
//      update orders AND every matching invoice_line_items row to fully
//      paid, and best-effort cancel any still-live Razorpay link/QR on
//      the order (money came through a different channel, so a live
//      link/QR left behind is a double-payment risk, not just stale
//      bookkeeping — same cleanup mark-order-paid itself does).
//
// Never WRITES anything back to Zoho — this only ever reads Zoho's own
// payment/invoice state and syncs it into this app's local tables.
//
// Output: { processed, updated, alreadyInSync, skippedOwnChannel, errors }
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_ORGANIZATION_ID
//   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET (optional — link/QR cleanup is best-effort)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function env(key: string) {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Missing env: ${key}`);
  return val;
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-cron-secret',
};

function todayIST(): string {
  return new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
}
function addDaysISO(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── Zoho OAuth — same shared zoho_token_cache row every other Zoho-touching
// function uses (generate-invoice, mark-order-paid, razorpay-webhook, ...).
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

function zohoUrl(path: string, orgId: string): string {
  const sep = path.includes('?') ? '&' : '?';
  const base = Deno.env.get('ZOHO_BASE_URL') ?? 'https://www.zohoapis.in/inventory/v1';
  return `${base}${path}${sep}organization_id=${orgId}`;
}

type ZohoPayment = {
  payment_id: string;
  reference_number?: string;
  invoices?: { invoice_id: string }[];
};

async function fetchRecentPayments(token: string, orgId: string, dateStart: string, dateEnd: string): Promise<ZohoPayment[]> {
  let page = 1;
  const all: ZohoPayment[] = [];
  while (true) {
    const res = await fetch(
      zohoUrl(`/customerpayments?date_start=${dateStart}&date_end=${dateEnd}&per_page=200&page=${page}`, orgId),
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data?.message || `Zoho customerpayments fetch failed (${res.status})`);
    all.push(...(data.customerpayments ?? []));
    if (!data.page_context?.has_more_page) break;
    page++;
  }
  return all;
}

async function fetchZohoInvoice(invoiceId: string, token: string, orgId: string): Promise<any> {
  const res = await fetch(zohoUrl(`/invoices/${invoiceId}`, orgId), {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  const data = await res.json();
  if (!res.ok || !data.invoice) throw new Error(data?.message || `Zoho invoice fetch failed (${res.status})`);
  return data.invoice;
}

// Reference numbers this app itself writes when IT records a payment —
// recordZohoPayment (razorpay-webhook) and recordZohoCashPayment
// (mark-order-paid) — see each function's own header comment.
function isOwnChannelPayment(referenceNumber: string | undefined): boolean {
  const ref = (referenceNumber || '').toLowerCase();
  return ref.startsWith('razorpay') || ref.startsWith('manual (');
}

async function cancelPaymentLink(linkId: string, auth: string): Promise<void> {
  await fetch(`https://api.razorpay.com/v1/payment_links/${linkId}/cancel`, {
    method: 'POST', headers: { Authorization: `Basic ${auth}` },
  }).catch(() => {});
}
async function closeQrCode(qrCodeId: string, auth: string): Promise<void> {
  await fetch(`https://api.razorpay.com/v1/payments/qr_codes/${qrCodeId}/close`, {
    method: 'POST', headers: { Authorization: `Basic ${auth}` },
  }).catch(() => {});
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const secret = req.headers.get('x-cron-secret') || '';
    if (secret !== env('CRON_SECRET')) throw new Error('Not authorized');

    const body = await req.json().catch(() => ({}));
    const today = todayIST();
    // Explicit range (manual backfill) wins outright if given; otherwise
    // the cron's own rolling-24h default (yesterday+today).
    const dateStart: string = body?.date_start || addDaysISO(today, -1);
    const dateEnd: string   = body?.date_end   || today;

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));
    const token = await getZohoToken(supabase);
    const orgId = env('ZOHO_ORGANIZATION_ID');

    const payments = await fetchRecentPayments(token, orgId, dateStart, dateEnd);

    const invoiceIds = new Set<string>();
    let skippedOwnChannel = 0;
    for (const p of payments) {
      if (isOwnChannelPayment(p.reference_number)) { skippedOwnChannel++; continue; }
      for (const inv of p.invoices ?? []) invoiceIds.add(inv.invoice_id);
    }

    let updated = 0, alreadyInSync = 0;
    const errors: { invoice_id: string; message: string }[] = [];
    const keyId = Deno.env.get('RAZORPAY_KEY_ID'), keySecret = Deno.env.get('RAZORPAY_KEY_SECRET');
    const razorpayAuth = (keyId && keySecret) ? btoa(`${keyId}:${keySecret}`) : null;

    for (const invoiceId of invoiceIds) {
      try {
        const zohoInvoice = await fetchZohoInvoice(invoiceId, token, orgId);
        const zohoBalance = parseFloat(zohoInvoice.balance ?? '0');
        if (zohoBalance > 0) continue; // not fully paid yet — nothing to reconcile

        const { data: order, error: orderErr } = await supabase
          .from('orders').select('sales_order_id, balance_due, payment_collected, razorpay_link_id, qr_code_id')
          .eq('zoho_invoice_id', invoiceId).maybeSingle();
        if (orderErr) throw new Error(orderErr.message);
        if (!order) continue; // Zoho-only invoice with no matching local order — nothing to sync

        if (order.payment_collected && (order.balance_due ?? 0) === 0) { alreadyInSync++; continue; }

        const zohoTotal = parseFloat(zohoInvoice.total ?? '0');
        const { error: updOrderErr } = await supabase.from('orders').update({
          balance_due: 0,
          payment_collected: true,
          payment_collected_method: 'zoho_direct',
          payment_collected_at: new Date().toISOString(),
          amount_paid: zohoTotal,
          qr_code_id: null, qr_image_url: null, qr_created_at: null,
          razorpay_link_id: null, razorpay_url: null,
          payment_pending_verification: false,
          payment_claimed_method: null, payment_claimed_at: null, payment_claimed_by: null,
        }).eq('sales_order_id', order.sales_order_id);
        if (updOrderErr) throw new Error(updOrderErr.message);

        const { error: updLiErr } = await supabase.from('invoice_line_items').update({
          payment_status: 'paid', balance: 0, amount_paid: zohoTotal,
        }).eq('zoho_invoice_id', invoiceId);
        if (updLiErr) throw new Error(updLiErr.message);

        if (razorpayAuth) {
          if (order.razorpay_link_id) await cancelPaymentLink(order.razorpay_link_id, razorpayAuth);
          if (order.qr_code_id)       await closeQrCode(order.qr_code_id, razorpayAuth);
        }

        updated++;
      } catch (e: any) {
        errors.push({ invoice_id: invoiceId, message: e.message });
      }
    }

    return new Response(
      JSON.stringify({ date_start: dateStart, date_end: dateEnd, processed: invoiceIds.size, updated, alreadyInSync, skippedOwnChannel, errors }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
