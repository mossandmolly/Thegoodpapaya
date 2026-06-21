// Supabase Edge Function — cancel-order
//
// Input:  { sales_order_id: string }
// Output: { ok: true, results: string[] }
//
// Steps:
//   1. Fetch order from orders (get zoho_invoice_id, razorpay_link_id)
//   2. Unapply Zoho payments → delete Zoho invoice
//   3. Cancel Razorpay payment link
//   4. Delete invoice_queue, operations, orders rows
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_ORGANIZATION_ID
//   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET

function env(key: string) {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Missing env: ${key}`);
  return val;
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

function sbHeaders() {
  return {
    'Authorization': `Bearer ${env('SUPABASE_SERVICE_ROLE_KEY')}`,
    'apikey':        env('SUPABASE_SERVICE_ROLE_KEY'),
    'Content-Type':  'application/json',
  };
}

async function sbFetch(path: string, opts?: RequestInit) {
  const url = `${env('SUPABASE_URL')}/rest/v1/${path}`;
  const res  = await fetch(url, { ...opts, headers: { ...sbHeaders(), ...(opts?.headers as any) } });
  if (!res.ok) throw new Error(await res.text());
  return res;
}

// ── Zoho OAuth ────────────────────────────────────────────────────────────────
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
  // code 0 = success; 5 = not found (already gone — treat as OK)
  if (data.code !== 0 && data.code !== 5) {
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

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const { sales_order_id } = await req.json();
    if (!sales_order_id) {
      return new Response(
        JSON.stringify({ error: 'sales_order_id required' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    // 1. Fetch order record
    const orderRes = await sbFetch(
      `orders?sales_order_id=eq.${encodeURIComponent(sales_order_id)}&select=zoho_invoice_id,razorpay_link_id,invoice_status`,
    );
    const orders = await orderRes.json();
    const order  = orders[0];

    if (!order) {
      return new Response(
        JSON.stringify({ error: 'Order not found' }),
        { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    const results: string[] = [];

    // 2. Unapply payments + delete Zoho invoice
    if (order.zoho_invoice_id) {
      try {
        const token  = await getZohoToken();
        const orgId  = env('ZOHO_ORGANIZATION_ID');
        const payments = await fetchAppliedPayments(order.zoho_invoice_id, token, orgId);
        await Promise.all(
          payments.map(p => unapplyPayment(order.zoho_invoice_id, p.payment_id, token, orgId)),
        );
        await deleteZohoInvoice(order.zoho_invoice_id, token, orgId);
        results.push(`Zoho invoice ${order.zoho_invoice_id} deleted (${payments.length} payments unapplied)`);
      } catch (e: any) {
        results.push(`Zoho delete failed (non-fatal): ${e.message}`);
      }
    }

    // 3. Cancel Razorpay link
    if (order.razorpay_link_id) {
      await cancelRazorpayLink(order.razorpay_link_id);
      results.push('Razorpay link cancelled');
    }

    // 4. Delete invoice_queue row (cascade-safe — uses ON DELETE CASCADE too)
    await sbFetch(`invoice_queue?sales_order_id=eq.${encodeURIComponent(sales_order_id)}`, { method: 'DELETE' });

    // 5. Delete operations rows
    await sbFetch(`operations?sales_order_id=eq.${encodeURIComponent(sales_order_id)}`, { method: 'DELETE' });

    // 6. Delete order row
    await sbFetch(`orders?sales_order_id=eq.${encodeURIComponent(sales_order_id)}`, { method: 'DELETE' });

    results.push('DB records deleted');

    return new Response(
      JSON.stringify({ ok: true, sales_order_id, results }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
