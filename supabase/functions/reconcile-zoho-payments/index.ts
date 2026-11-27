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
//   1. List every Zoho customer payment recorded in the window (GET
//      /customerpayments, paginated) — the SAME payments tend to reappear
//      in this list run after run, since the window is rolling, not
//      "since last run".
//   2. Skip anything whose reference_number marks it as ALREADY one of
//      this app's own two channels — "Razorpay ..." (razorpay-webhook) or
//      "Manual (..." (mark-order-paid) — those already sync
//      orders/invoice_line_items synchronously, so there's never anything
//      to reconcile for them.
//   3. Skip anything whose Razorpay-unrelated payment_id is already
//      logged in zoho_payment_reconcile_log (migration 177) — i.e.
//      already evaluated by a previous run of this same job. This is the
//      step that makes the rolling re-scan cheap: at real volume
//      (thousands of payments/day), re-fetching every distinct invoice's
//      balance on every run forever would be thousands of wasted Zoho
//      calls per run and a real risk of the function timing out before
//      finishing. With this log, each payment only ever costs one
//      invoice-balance fetch, ever, regardless of how many more times the
//      rolling window keeps re-showing it.
//   4. For each remaining, not-yet-logged payment's distinct invoice_id(s),
//      fetch that invoice's CURRENT live balance from Zoho (never trust
//      the payment list's own amount_applied — only the invoice's own
//      running balance says whether it's now actually fully paid).
//   5. Balance > 0 (partially paid, or this payment doesn't fully close
//      it) — skip, and deliberately leave its payment_id(s) UNLOGGED, so
//      a still-partially-paid invoice keeps getting re-checked by future
//      runs instead of being given up on. Balance === 0 — log the
//      payment_id(s) either way (nothing left to check for them again),
//      and additionally: if the local orders row doesn't already show
//      balance_due=0/payment_collected=true, update orders AND every
//      matching invoice_line_items row to fully paid, and best-effort
//      cancel any still-live Razorpay link/QR on the order (money came
//      through a different channel, so a live link/QR left behind is a
//      double-payment risk, not just stale bookkeeping — same cleanup
//      mark-order-paid itself does).
//
// Never WRITES anything back to Zoho — this only ever reads Zoho's own
// payment/invoice state and syncs it into this app's local tables.
//
// Output: { processed, updated, alreadyInSync, skippedOwnChannel, skippedAlreadyLogged, errors }
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

// Marks these payment_ids as evaluated so the rolling-window re-scan
// never triggers another invoice-balance fetch for them. Best-effort
// (upsert, ignore conflict) — a failure here just means this payment
// gets harmlessly re-checked next run, never a correctness issue.
async function logPaymentIds(supabase: ReturnType<typeof createClient>, paymentIds: Set<string>, invoiceId: string): Promise<void> {
  if (!paymentIds.size) return;
  const rows = [...paymentIds].map(payment_id => ({ payment_id, invoice_id: invoiceId }));
  const { error } = await supabase.from('zoho_payment_reconcile_log').upsert(rows, { onConflict: 'payment_id', ignoreDuplicates: true });
  if (error) console.error('zoho_payment_reconcile_log upsert failed:', error.message);
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

    // Which of these payment_ids has a previous run already evaluated? —
    // the rolling window keeps re-showing the same payments run after
    // run, so without this every one of them would otherwise trigger a
    // fresh invoice-balance fetch forever. Chunked .in() lookups since a
    // high-volume window can carry thousands of candidate ids.
    const candidatePaymentIds = payments
      .filter(p => !isOwnChannelPayment(p.reference_number))
      .map(p => p.payment_id)
      .filter(Boolean);
    const alreadyLoggedIds = new Set<string>();
    for (let i = 0; i < candidatePaymentIds.length; i += 300) {
      const chunk = candidatePaymentIds.slice(i, i + 300);
      const { data: logged, error: logErr } = await supabase
        .from('zoho_payment_reconcile_log').select('payment_id').in('payment_id', chunk);
      if (logErr) throw new Error(logErr.message);
      (logged ?? []).forEach(r => alreadyLoggedIds.add(r.payment_id));
    }

    // invoice_id -> every NEW (not already-logged, not own-channel)
    // payment_id that touched it this run — logged as processed once
    // that invoice has actually been checked, below.
    const invoiceToPaymentIds = new Map<string, Set<string>>();
    let skippedOwnChannel = 0, skippedAlreadyLogged = 0;
    for (const p of payments) {
      if (isOwnChannelPayment(p.reference_number)) { skippedOwnChannel++; continue; }
      if (alreadyLoggedIds.has(p.payment_id)) { skippedAlreadyLogged++; continue; }
      for (const inv of p.invoices ?? []) {
        if (!invoiceToPaymentIds.has(inv.invoice_id)) invoiceToPaymentIds.set(inv.invoice_id, new Set());
        invoiceToPaymentIds.get(inv.invoice_id)!.add(p.payment_id);
      }
    }

    let updated = 0, alreadyInSync = 0;
    const errors: { invoice_id: string; message: string }[] = [];
    const keyId = Deno.env.get('RAZORPAY_KEY_ID'), keySecret = Deno.env.get('RAZORPAY_KEY_SECRET');
    const razorpayAuth = (keyId && keySecret) ? btoa(`${keyId}:${keySecret}`) : null;

    for (const [invoiceId, paymentIds] of invoiceToPaymentIds) {
      try {
        const zohoInvoice = await fetchZohoInvoice(invoiceId, token, orgId);
        const zohoBalance = parseFloat(zohoInvoice.balance ?? '0');
        if (zohoBalance > 0) continue; // not fully paid yet — leave unlogged, re-check next run

        const { data: order, error: orderErr } = await supabase
          .from('orders').select('sales_order_id, balance_due, payment_collected, razorpay_link_id, qr_code_id')
          .eq('zoho_invoice_id', invoiceId).maybeSingle();
        if (orderErr) throw new Error(orderErr.message);
        if (!order) { await logPaymentIds(supabase, paymentIds, invoiceId); continue; } // Zoho-only invoice, no local order — nothing to sync, but done checking

        if (order.payment_collected && (order.balance_due ?? 0) === 0) {
          alreadyInSync++;
          await logPaymentIds(supabase, paymentIds, invoiceId);
          continue;
        }

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

        await logPaymentIds(supabase, paymentIds, invoiceId);
        updated++;
      } catch (e: any) {
        errors.push({ invoice_id: invoiceId, message: e.message });
      }
    }

    return new Response(
      JSON.stringify({
        date_start: dateStart, date_end: dateEnd,
        processed: invoiceToPaymentIds.size, updated, alreadyInSync,
        skippedOwnChannel, skippedAlreadyLogged, errors,
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
