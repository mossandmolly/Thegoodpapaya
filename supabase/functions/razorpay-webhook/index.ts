// Supabase Edge Function — Razorpay payment webhook
//
// Verifies HMAC-SHA256 signature, then cumulatively adds the payment amount to
// orders.amount_paid and recalculates balance_due, and records the same
// payment against the order's Zoho invoice — so a payment made via Razorpay
// (either channel below) shows up as paid/partially paid in Zoho too,
// without waiting on sync-invoices' 5-min poll to notice it indirectly.
//
// Handles two event types, both requiring sales_order_id in notes:
//   - payment_link.paid  — the manual "Generate Payment Link" flow
//   - qr_code.credited   — the delivery-panel Dynamic QR (dispatch-order)
// amount_paid is never reset — it accumulates across all payments and invoice regenerations.
//
// Required secrets: RAZORPAY_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_ORGANIZATION_ID

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function env(key: string) {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Missing env: ${key}`);
  return val;
}

async function verifySignature(body: string, signature: string, secret: string): Promise<boolean> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const raw = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  const hex = Array.from(new Uint8Array(raw)).map(b => b.toString(16).padStart(2, '0')).join('');
  return hex === signature;
}

// ── Zoho OAuth ────────────────────────────────────────────────────────────
// Same shared zoho_token_cache row every other Zoho-touching function uses
// (generate-invoice, cancel-order, sync-invoices, ...) — see cancel-order
// for the full rationale.
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

// Records the payment against the Zoho invoice directly (POST
// /customerpayments) rather than just PATCHing invoice status — this is
// what actually moves Zoho's own outstanding-balance figure, which is the
// number sync-invoices reads back for its own reconciliation loop, so both
// directions stay consistent with each other.
async function recordZohoPayment(
  supabase: ReturnType<typeof createClient>,
  zohoInvoiceId: string, zohoContactId: string, amountRupees: number,
  razorpayPaymentId: string | undefined, source: 'qr' | 'payment_link',
): Promise<void> {
  const token = await getZohoToken(supabase);
  const orgId = env('ZOHO_ORGANIZATION_ID');
  const res = await fetch(zohoUrl('/customerpayments', orgId), {
    method: 'POST',
    headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_id:  zohoContactId,
      payment_mode: 'onlinepayment',
      amount:       amountRupees,
      date:         new Date().toISOString().slice(0, 10),
      reference_number: razorpayPaymentId ? `Razorpay ${source} — ${razorpayPaymentId}` : `Razorpay ${source}`,
      invoices: [{ invoice_id: zohoInvoiceId, amount_applied: amountRupees }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || `Zoho payment recording failed (${res.status})`);
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const body      = await req.text();
  const signature = req.headers.get('x-razorpay-signature') ?? '';

  const valid = await verifySignature(body, signature, env('RAZORPAY_WEBHOOK_SECRET'));
  if (!valid) return new Response(JSON.stringify({ error: 'Invalid signature' }), { status: 401 });

  let payload: any;
  try { payload = JSON.parse(body); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  if (payload.event !== 'payment_link.paid' && payload.event !== 'qr_code.credited') {
    return new Response(JSON.stringify({ ok: true, ignored: true }), { status: 200 });
  }

  const paymentEntity = payload.payload?.payment?.entity;
  const notesEntity    = payload.event === 'qr_code.credited'
    ? payload.payload?.qr_code?.entity
    : payload.payload?.payment_link?.entity;
  const salesOrderId  = notesEntity?.notes?.sales_order_id as string | undefined;
  const amountPaise   = paymentEntity?.amount as number | undefined;

  if (!salesOrderId) {
    console.warn('Razorpay webhook: no sales_order_id in notes');
    return new Response(JSON.stringify({ ok: true, msg: 'no sales_order_id' }), { status: 200 });
  }
  if (!amountPaise) {
    console.warn('Razorpay webhook: no payment amount');
    return new Response(JSON.stringify({ ok: true, msg: 'no amount' }), { status: 200 });
  }

  const amountRupees = amountPaise / 100;
  const supabase     = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

  // Load current amounts
  const { data: order, error: orderErr } = await supabase
    .from('orders')
    .select('amount_paid, invoice_total, zoho_invoice_id, customer_name')
    .eq('sales_order_id', salesOrderId)
    .single();

  if (orderErr || !order) {
    console.error('Order not found for payment:', salesOrderId);
    return new Response(JSON.stringify({ ok: true, msg: 'order not found' }), { status: 200 });
  }

  const newAmountPaid = (order.amount_paid ?? 0) + amountRupees;
  const balanceDue    = Math.max(0, (order.invoice_total ?? 0) - newAmountPaid);

  const updates: Record<string, unknown> = { amount_paid: newAmountPaid, balance_due: balanceDue };
  // A real Razorpay payment just landed and covers the full invoice —
  // reflect that immediately (this is what the Delivery panel/Order
  // Overview actually check to show "PAID"), not just the raw numbers.
  // A partial payment (balance still > 0) doesn't flip this — only a
  // rider's own delivered-and-paid confirmation should mark those.
  if (balanceDue <= 0) {
    updates.payment_collected = true;
    updates.payment_collected_method = 'online';
    updates.payment_collected_at = new Date().toISOString();
    // Whichever mechanism this payment came through is already spent —
    // a single_use QR auto-closes itself on Razorpay's side, and a paid
    // link stops accepting further payment — so this just clears our own
    // stored reference rather than leaving it to resurface on a future
    // regeneration (no separate close/cancel API call needed here).
    updates.qr_code_id = null;
    updates.qr_image_url = null;
    updates.qr_created_at = null;
    updates.razorpay_link_id = null;
    updates.razorpay_url = null;
  }

  const { error } = await supabase
    .from('orders')
    .update(updates)
    .eq('sales_order_id', salesOrderId);

  if (error) console.error('Orders update failed:', error.message);

  // Best-effort — the orders-table update above is already the source of
  // truth the ops-dashboard reads from; a Zoho hiccup here shouldn't turn
  // an otherwise-successful webhook into a retry storm from Razorpay.
  if (order.zoho_invoice_id) {
    try {
      const { data: customer } = await supabase
        .from('customers').select('zoho_contact_id')
        .eq('customer_name', order.customer_name).maybeSingle();
      if (customer?.zoho_contact_id) {
        await recordZohoPayment(
          supabase, order.zoho_invoice_id, customer.zoho_contact_id, amountRupees,
          paymentEntity?.id, payload.event === 'qr_code.credited' ? 'qr' : 'payment_link',
        );
      } else {
        console.warn(`Razorpay webhook: no zoho_contact_id for "${order.customer_name}" — skipped Zoho payment recording`);
      }
    } catch (e: any) {
      console.error(`Zoho payment recording failed for ${salesOrderId}:`, e.message);
    }
  }

  return new Response(
    JSON.stringify({ ok: true, sales_order_id: salesOrderId, amount_added: amountRupees }),
    { headers: { 'Content-Type': 'application/json' } },
  );
});
