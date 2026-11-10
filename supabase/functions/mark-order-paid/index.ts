// Supabase Edge Function — mark-order-paid
//
// Manual "this customer paid outside Razorpay" action from Order Overview —
// cash handed to a rider after the fact, or a payment screenshot shared
// directly. Unlike mark-delivered's own payment_collected_method='cash'
// (which only ever wrote to Supabase), this is the first path where a cash/
// screenshot payment actually gets recorded against the real Zoho invoice
// too, not just the local copy.
//
// Two-step, same function both times:
//   1. commit=false (or omitted) — a dry run. Fetches the Zoho invoice's
//      CURRENT live balance (never trusts whatever Supabase last synced)
//      and compares it to what orders.balance_due expects, so the frontend
//      can show an accurate confirm dialog ("Zoho shows ₹X due — mark as
//      paid?") before anything is written anywhere. Returns a discrepancy
//      flag if the two don't match (e.g. Zoho was already paid by some
//      other path, or orders.balance_due is stale) — the frontend's own
//      job to decide whether to still let the user proceed.
//   2. commit=true — re-fetches the live Zoho balance FRESH (not the
//      number from step 1, in case something changed in the gap between
//      the dialog showing and the user confirming), then:
//        - if that live balance is still > 0: records a 'cash' payment in
//          Zoho for exactly that amount (fully clearing it), and updates
//          orders to match.
//        - if it's already 0 (paid some other way since step 1, or always
//          was and this is just a Supabase catch-up): records nothing new
//          in Zoho — nothing to record — just syncs orders' own fields.
//      Either way, cancels any still-active Razorpay link/QR on the order —
//      unlike a normal full payment (where Razorpay itself already closed
//      the mechanism that got paid), the money here came through an
//      entirely different channel, so a live link/QR left behind is a real
//      double-payment risk, not just stale bookkeeping.
//
// Also doubles as the verification step for a rider's own payment claim at
// delivery (mark-delivered sets orders.payment_pending_verification instead
// of trusting that claim directly — see its header comment) — a commit
// here always clears that flag, whether or not the order actually had a
// pending claim on it.
//
// Input:  { sales_order_id, commit?: boolean, method?: 'cash'|'screenshot'|'online', marked_by?: string }
// Output (dry run):  { zoho_balance, zoho_total, zoho_status, local_balance, discrepancy }
// Output (commit):   { sales_order_id, amount_recorded, balance_due: 0 }
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_ORGANIZATION_ID
//   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET

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

// ── Zoho OAuth — same shared zoho_token_cache row every other Zoho-touching
// function uses (generate-invoice, sync-invoices, razorpay-webhook, ...).
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
  return `https://www.zohoapis.in/books/v3${path}${sep}organization_id=${orgId}`;
}

async function fetchZohoInvoice(invoiceId: string, token: string, orgId: string): Promise<any> {
  const res = await fetch(zohoUrl(`/invoices/${invoiceId}`, orgId), {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  const data = await res.json();
  if (!res.ok || !data.invoice) throw new Error(data?.message || 'Could not fetch Zoho invoice');
  return data.invoice;
}

// Same shape recordZohoPayment (razorpay-webhook) uses for an online
// payment — payment_mode is the only thing that differs.
async function recordZohoCashPayment(
  token: string, orgId: string, zohoInvoiceId: string, zohoCustomerId: string,
  amountRupees: number, referenceNumber: string,
): Promise<void> {
  const res = await fetch(zohoUrl('/customerpayments', orgId), {
    method: 'POST',
    headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_id:  zohoCustomerId,
      payment_mode: 'cash',
      amount:       amountRupees,
      date:         new Date().toISOString().slice(0, 10),
      reference_number: referenceNumber,
      invoices: [{ invoice_id: zohoInvoiceId, amount_applied: amountRupees }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || `Zoho payment recording failed (${res.status})`);
}

async function cancelPaymentLink(linkId: string, auth: string): Promise<void> {
  await fetch(`https://api.razorpay.com/v1/payment_links/${linkId}/cancel`, {
    method: 'POST', headers: { Authorization: `Basic ${auth}` },
  });
}

async function closeQrCode(qrCodeId: string, auth: string): Promise<void> {
  await fetch(`https://api.razorpay.com/v1/payments/qr_codes/${qrCodeId}/close`, {
    method: 'POST', headers: { Authorization: `Basic ${auth}` },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    await requireAuth(req);
    const { sales_order_id, commit, method, marked_by } = await req.json();
    if (!sales_order_id) throw new Error('Missing sales_order_id');

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    const { data: order, error: orderErr } = await supabase
      .from('orders').select('*').eq('sales_order_id', sales_order_id).single();
    if (orderErr || !order) throw new Error(`Order ${sales_order_id} not found`);
    if (!order.zoho_invoice_id) throw new Error('Order has not been invoiced yet');

    const token = await getZohoToken(supabase);
    const orgId = env('ZOHO_ORGANIZATION_ID');
    const zohoInvoice = await fetchZohoInvoice(order.zoho_invoice_id, token, orgId);
    const zohoBalance = parseFloat(zohoInvoice.balance ?? '0');
    const zohoTotal   = parseFloat(zohoInvoice.total ?? '0');
    const localBalance = order.balance_due ?? order.invoice_total ?? 0;

    if (!commit) {
      // Dry run — nothing written. Round to paise before comparing; a
      // sub-paisa float difference isn't a real discrepancy.
      const discrepancy = Math.round(zohoBalance * 100) !== Math.round(localBalance * 100);
      return new Response(
        JSON.stringify({
          zoho_balance: zohoBalance, zoho_total: zohoTotal, zoho_status: zohoInvoice.status,
          local_balance: localBalance, discrepancy,
        }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    // Commit — re-check fresh (zohoBalance above, just fetched) rather than
    // trusting any number the frontend might still be holding from an
    // earlier dry-run call.
    const methodLabel = method === 'screenshot' ? 'screenshot' : method === 'online' ? 'online' : 'cash';
    let amountRecorded = 0;
    if (zohoBalance > 0) {
      const reference = `Manual (${methodLabel}) — marked by ${marked_by || 'ops'}`;
      await recordZohoCashPayment(token, orgId, order.zoho_invoice_id, zohoInvoice.customer_id, zohoBalance, reference);
      amountRecorded = zohoBalance;
    }

    const updates: Record<string, unknown> = {
      balance_due: 0,
      payment_collected: true,
      payment_collected_method: methodLabel,
      payment_collected_at: new Date().toISOString(),
      qr_code_id: null, qr_image_url: null, qr_created_at: null,
      razorpay_link_id: null, razorpay_url: null,
      // This is the verification step for whatever a rider may have
      // claimed at delivery (mark-delivered no longer trusts that claim
      // directly — see its own header comment) — clear it now that it's
      // been checked and confirmed, whether or not it actually came from a
      // rider's claim in the first place (Somya/Rohith can also use this
      // for a payment nobody at delivery flagged at all).
      payment_pending_verification: false,
      payment_claimed_method: null,
      payment_claimed_at: null,
      payment_claimed_by: null,
    };
    // amount_paid is cumulative everywhere else in this app — add whatever
    // was actually just recorded. If Zoho's balance was already 0 (paid
    // some other way, nothing recorded here), sync straight to the
    // invoice's full total instead, since that's the only true figure
    // available for "how much has actually been paid on this invoice".
    updates.amount_paid = amountRecorded > 0
      ? (order.amount_paid ?? 0) + amountRecorded
      : zohoTotal;

    const { error: updateErr } = await supabase.from('orders').update(updates).eq('sales_order_id', sales_order_id);
    if (updateErr) throw new Error(updateErr.message);

    // Best-effort — the payment is already recorded and orders already
    // updated above regardless; a stray live link/QR left behind is a
    // lesser problem than failing the whole mark-as-paid action over it.
    try {
      const keyId = Deno.env.get('RAZORPAY_KEY_ID'), keySecret = Deno.env.get('RAZORPAY_KEY_SECRET');
      if (keyId && keySecret) {
        const auth = btoa(`${keyId}:${keySecret}`);
        if (order.razorpay_link_id) await cancelPaymentLink(order.razorpay_link_id, auth);
        if (order.qr_code_id)       await closeQrCode(order.qr_code_id, auth);
      }
    } catch (e: any) {
      console.error(`[mark-order-paid] ${sales_order_id}: Razorpay link/QR cleanup failed: ${e.message}`);
    }

    return new Response(
      JSON.stringify({ sales_order_id, amount_recorded: amountRecorded, balance_due: 0 }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
