// Supabase Edge Function — invalidate-order-invoice
//
// Called whenever Today's Orders edits an already-invoiced order (item
// added, quantity/description changed) — the existing Zoho invoice no
// longer reflects reality the moment that happens, so it's deleted right
// away rather than left sitting in Zoho showing stale numbers until the
// next explicit "generate invoice" click.
//
// Unlike cancel-order, this does NOT touch order/item status — the order
// stays exactly as active/final/invoiced as the caller already set it; this
// only clears the invoice + payment link side of things.
//
//  1. If a Zoho invoice exists: unapply any payments (left as unused
//     customer credit in Zoho automatically) then delete the invoice.
//  2. Cancel the Razorpay payment link, if any — it was sized for the now-
//     deleted invoice's total.
//  3. Delete invoice_queue / invoice_line_items rows for this sales_order_id.
//  4. Clear orders.zoho_invoice_id/invoice_number/invoice_total/balance_due/
//     razorpay_link_id/razorpay_url and reset invoice_status to 'pending'.
//
// Input:  { sales_order_id: string }
// Output: { sales_order_id, invalidated: true }
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
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

async function getZohoToken(): Promise<string> {
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
  return data.access_token;
}

function zohoUrl(path: string, orgId: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `https://www.zohoapis.in/books/v3${path}${sep}organization_id=${orgId}`;
}

async function fetchAppliedPayments(
  invoiceId: string, token: string, orgId: string,
): Promise<Array<{ payment_id: string }>> {
  const res  = await fetch(zohoUrl(`/invoices/${invoiceId}/payments`, orgId), {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  const data = await res.json();
  return (data.payments ?? []).map((p: any) => ({ payment_id: p.payment_id as string }));
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
  // code 0 = success; 5 = not found (already gone — treat as OK)
  if (data.code !== 0 && data.code !== 5) {
    throw new Error(`Zoho delete invoice failed (${data.code}): ${data.message}`);
  }
}

async function cancelRazorpayLink(linkId: string): Promise<void> {
  try {
    const auth = btoa(`${env('RAZORPAY_KEY_ID')}:${env('RAZORPAY_KEY_SECRET')}`);
    await fetch(`https://api.razorpay.com/v1/payment_links/${linkId}/cancel`, {
      method:  'POST',
      headers: { Authorization: `Basic ${auth}` },
    });
  } catch (_) {} // best effort
}

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

    if (order.zoho_invoice_id) {
      const token = await getZohoToken();
      const orgId = env('ZOHO_ORGANIZATION_ID');
      const payments = await fetchAppliedPayments(order.zoho_invoice_id, token, orgId);
      for (const p of payments) {
        await unapplyPayment(order.zoho_invoice_id, p.payment_id, token, orgId);
      }
      await deleteZohoInvoice(order.zoho_invoice_id, token, orgId);
    }

    if (order.razorpay_link_id) {
      await cancelRazorpayLink(order.razorpay_link_id);
    }

    await supabase.from('invoice_queue').delete().eq('sales_order_id', sales_order_id);
    await supabase.from('invoice_line_items').delete().eq('sales_order_id', sales_order_id);

    const { error: updErr } = await supabase.from('orders').update({
      zoho_invoice_id:  null,
      invoice_number:   null,
      invoice_total:    null,
      balance_due:      null,
      invoice_status:   'pending',
      razorpay_link_id: null,
      razorpay_url:     null,
    }).eq('sales_order_id', sales_order_id);
    if (updErr) throw new Error(updErr.message);

    return new Response(
      JSON.stringify({ sales_order_id, invalidated: true }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
