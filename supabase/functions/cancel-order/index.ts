// Supabase Edge Function — cancel-order
//
// We never hard-delete an order (this function used to — that's the old
// behavior, from before the order_items rebuild). Cancelling is now a
// terminal status change:
//  1. If a Zoho invoice exists: unapply any payments (left as unused/
//     available credit on the customer's Zoho account — Zoho's own payment
//     model treats an unapplied payment as customer credit automatically, no
//     separate credit-note step needed) then delete the invoice.
//  2. Cancel the Razorpay payment link, if one exists (best-effort).
//  3. Delete invoice_queue and invoice_line_items rows for this
//     sales_order_id — neither has a cascade that would clean them up once
//     we stop deleting the orders row.
//  4. Set orders.status = 'cancelled', invoice_status = 'cancelled', and
//     clear the now-stale Zoho/Razorpay fields (the orders row itself stays
//     — never deleted).
//  5. Set every order_items row for this sales_order_id to status =
//     'cancelled', regardless of what stage each item was at.
//
// Input:  { sales_order_id: string }
// Output: { sales_order_id, cancelled: true, results: string[] }
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

// This function uses the service role internally, so it bypasses RLS
// regardless of who calls it — the anon key alone is enough to invoke it at
// the platform level. Requiring a real logged-in user session here is what
// actually restricts this to signed-in ops staff (it also deletes real Zoho
// invoices and Razorpay links, so this matters more than most).
async function requireAuth(req: Request): Promise<void> {
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
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

// ── Zoho OAuth ────────────────────────────────────────────────────────────────
// Two-tier cache: an in-memory one (fast path within a warm isolate) backed
// by a shared `zoho_token_cache` row in Postgres — generate-invoice,
// cancel-order, and download-invoice each run as separate functions with
// their OWN isolates, so an in-memory-only cache meant switching between
// actions (e.g. cancelling orders right after generating invoices) still
// hit Zoho's OAuth endpoint fresh from each function, defeating the whole
// point of caching ("You have made too many requests continuously"). The
// DB row lets every function reuse the same token and refresh it only once
// across the whole system.
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
  // code 0 = success; 5/1002 = not found (already gone — treat as OK)
  if (data.code !== 0 && data.code !== 5 && data.code !== 1002) {
    throw new Error(`Zoho delete invoice failed (${data.code}): ${data.message}`);
  }
}

// ── Razorpay ──────────────────────────────────────────────────────────────────
async function cancelRazorpayLink(linkId: string): Promise<void> {
  try {
    const auth = btoa(`${env('RAZORPAY_KEY_ID')}:${env('RAZORPAY_KEY_SECRET')}`);
    await fetch(`https://api.razorpay.com/v1/payment_links/${linkId}/cancel`, {
      method:  'POST',
      headers: { Authorization: `Basic ${auth}` },
    });
  } catch (_) {} // best effort
}

// orders.qr_code_id was previously left untouched by cancel-order entirely
// — the dynamic QR stayed live on Razorpay's side even after the order (and
// its invoice) was gone, and the stale reference would resurface later if
// the order got reopened/reinvoiced, since generate-invoice's "regenerate
// whichever was active" logic would find it still set.
async function closeRazorpayQr(qrCodeId: string): Promise<void> {
  try {
    const auth = btoa(`${env('RAZORPAY_KEY_ID')}:${env('RAZORPAY_KEY_SECRET')}`);
    await fetch(`https://api.razorpay.com/v1/payments/qr_codes/${qrCodeId}/close`, {
      method:  'POST',
      headers: { Authorization: `Basic ${auth}` },
    });
  } catch (_) {} // best effort
}

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    await requireAuth(req);
    const { sales_order_id } = await req.json();
    if (!sales_order_id) throw new Error('Missing sales_order_id');

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    const { data: order, error: orderErr } = await supabase
      .from('orders').select('*').eq('sales_order_id', sales_order_id).single();
    if (orderErr || !order) throw new Error(`Order ${sales_order_id} not found`);

    const results: string[] = [];

    if (order.status === 'cancelled') {
      return new Response(
        JSON.stringify({ ok: true, sales_order_id, results: ['Already cancelled'] }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    // 1. Unapply payments (left as unused customer credit in Zoho) + delete invoice
    if (order.zoho_invoice_id) {
      try {
        const token  = await getZohoToken(supabase);
        const orgId  = env('ZOHO_ORGANIZATION_ID');
        const payments = await fetchAppliedPayments(order.zoho_invoice_id, token, orgId);
        for (const p of payments) {
          await unapplyPayment(order.zoho_invoice_id, p.payment_id, token, orgId);
        }
        await deleteZohoInvoice(order.zoho_invoice_id, token, orgId);
        results.push(`Zoho invoice ${order.zoho_invoice_id} deleted (${payments.length} payment(s) unapplied as customer credit)`);
      } catch (e: any) {
        results.push(`Zoho delete failed (non-fatal): ${e.message}`);
      }
    }

    // 2. Cancel Razorpay link/QR, if any
    if (order.razorpay_link_id) {
      await cancelRazorpayLink(order.razorpay_link_id);
      results.push('Razorpay link cancelled');
    }
    if (order.qr_code_id) {
      await closeRazorpayQr(order.qr_code_id);
      results.push('Razorpay QR closed');
    }

    // 3. Clean up invoice_queue / invoice_line_items — neither has a cascade
    // that fires now that we don't delete the orders row.
    await supabase.from('invoice_queue').delete().eq('sales_order_id', sales_order_id);
    const { error: liErr } = await supabase
      .from('invoice_line_items').delete().eq('sales_order_id', sales_order_id);
    if (liErr) throw new Error(`Could not clean up invoice_line_items: ${liErr.message}`);

    // 4. Soft-cancel the order — never delete the row itself. Records what
    // invoice_status was right before this so uncancel-order can restore it
    // exactly (e.g. an order that was 'done' comes back 'done', not
    // 'pending') — the Zoho invoice/Razorpay mechanism themselves are real
    // external state that's actually gone (deleted/cancelled above) and
    // can't be un-deleted, only the local status label can be restored.
    const { error: orderUpdErr } = await supabase.from('orders').update({
      status:                   'cancelled',
      zoho_invoice_id:          null,
      invoice_number:           null,
      invoice_total:            null,
      balance_due:              null,
      invoice_status:           'cancelled',
      pre_cancel_invoice_status: order.invoice_status,
      razorpay_link_id:         null,
      razorpay_url:             null,
      qr_code_id:               null,
      qr_image_url:             null,
      qr_created_at:            null,
    }).eq('sales_order_id', sales_order_id);
    if (orderUpdErr) throw new Error(orderUpdErr.message);

    // 5. Every item on this order becomes 'cancelled', whatever stage it was
    // at — pre_cancel_status records that stage first, per item, so
    // uncancel-order can restore each one exactly (an 'invoiced' item comes
    // back 'invoiced', not reset to 'open'). Already-cancelled items are
    // left untouched, keeping whatever pre_cancel_status they already have.
    const { data: itemsBefore, error: itemsFetchErr } = await supabase
      .from('order_items').select('id,status').eq('sales_order_id', sales_order_id).neq('status', 'cancelled');
    if (itemsFetchErr) throw new Error(itemsFetchErr.message);
    for (const item of itemsBefore ?? []) {
      const { error: itemUpdErr } = await supabase
        .from('order_items').update({ status: 'cancelled', pre_cancel_status: item.status }).eq('id', item.id);
      if (itemUpdErr) throw new Error(itemUpdErr.message);
    }

    results.push('Order and items marked cancelled');

    return new Response(
      JSON.stringify({ ok: true, sales_order_id, results }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
