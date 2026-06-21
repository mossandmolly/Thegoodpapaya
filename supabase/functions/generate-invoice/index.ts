// Supabase Edge Function — generate-invoice
//
// Input:  { sales_order_id: string }
// Output: { invoice_id, invoice_number, sales_order_id }
//
// Fast path (no prior Zoho invoice):  create only (~600ms)
// Slow path (prior invoice exists):   fetch payments → unapply → delete → create → reapply (~2-3s)
//
// Reads line items from operations (not order_items).
// Sets cf_requested_quantity custom field per line item.
// Updates orders.invoice_status, zoho_invoice_id, invoice_number, invoice_total, balance_due.
// Does NOT reset amount_paid — cumulative across regenerations.
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

function zohoHeaders(token: string): HeadersInit {
  return { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' };
}

// ── Find or create a Zoho contact ────────────────────────────────────────────
async function getOrCreateContact(
  name: string, phone: string | null, token: string, orgId: string,
): Promise<string> {
  const search = await fetch(
    zohoUrl(`/contacts?contact_name=${encodeURIComponent(name)}`, orgId),
    { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
  );
  const sd = await search.json();
  const existing = sd.contacts?.find(
    (c: any) => c.contact_name.toLowerCase() === name.toLowerCase(),
  );
  if (existing) return existing.contact_id;

  const body: any = { contact_name: name, contact_type: 'customer' };
  if (phone) body.contact_persons = [{ phone }];
  const create = await fetch(zohoUrl('/contacts', orgId), {
    method: 'POST',
    headers: zohoHeaders(token),
    body: JSON.stringify({ JSONString: JSON.stringify(body) }),
  });
  const cd = await create.json();
  if (cd.code !== 0) throw new Error(`Zoho create contact failed: ${cd.message}`);
  return cd.contact.contact_id;
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
  if (data.code !== 0) throw new Error(`Zoho delete invoice failed: ${data.message}`);
}

// ── Create Zoho Books invoice ─────────────────────────────────────────────────
async function createZohoInvoice(
  contactId: string,
  salesOrderId: string,
  date: string,
  lineItems: Array<{ name: string; requested_qty: number; qty: number; rate: number; description?: string }>,
  token: string,
  orgId: string,
): Promise<{ invoice_id: string; invoice_number: string; invoice_total: number }> {
  const body = {
    customer_id:      contactId,
    reference_number: salesOrderId,
    date,
    line_items: lineItems.map(i => ({
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
    body: JSON.stringify({ JSONString: JSON.stringify(body) }),
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

async function applyPaymentToInvoice(
  invoiceId: string, paymentId: string, amount: number, token: string, orgId: string,
): Promise<void> {
  const res  = await fetch(zohoUrl(`/invoices/${invoiceId}/payments`, orgId), {
    method: 'POST',
    headers: zohoHeaders(token),
    body: JSON.stringify({
      JSONString: JSON.stringify({ payments: [{ payment_id: paymentId, amount_applied: amount }] }),
    }),
  });
  const data = await res.json();
  if (data.code !== 0) console.warn(`Payment reapply warning: ${data.message}`);
}

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const { sales_order_id } = await req.json();
    if (!sales_order_id) throw new Error('Missing sales_order_id');

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));
    const token    = await getZohoToken();
    const orgId    = env('ZOHO_ORGANIZATION_ID');

    // Load order header and operations line items in parallel
    const [{ data: order, error: orderErr }, { data: items, error: itemsErr }] = await Promise.all([
      supabase.from('orders').select('*').eq('sales_order_id', sales_order_id).single(),
      supabase.from('operations').select('*').eq('sales_order_id', sales_order_id).neq('status', 'removed'),
    ]);
    if (orderErr || !order) throw new Error(`Order ${sales_order_id} not found`);
    if (itemsErr) throw new Error(itemsErr.message);
    if (!items?.length) throw new Error(`No operations items for ${sales_order_id}`);

    const missing = items.filter((i: any) => i.status !== 'nobill' && !i.final_quantity);
    if (missing.length) {
      throw new Error(`Missing final qty: ${missing.map((i: any) => i.item_name).join(', ')}`);
    }

    const lineItems = items.map((i: any) => ({
      name:          i.item_name,
      requested_qty: i.requested_quantity ?? 0,
      qty:           i.status === 'nobill'
        ? (i.final_quantity ?? i.requested_quantity ?? 0)
        : (i.final_quantity ?? 0),
      rate:          i.status === 'nobill' ? 0 : (i.unit_price ?? 0),
      description:   i.description || undefined,
    }));

    const contactId = await getOrCreateContact(
      order.customer_name,
      order.phone ? `+91${order.phone.replace(/^\+91/, '')}` : null,
      token, orgId,
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

    return new Response(
      JSON.stringify({ invoice_id, invoice_number, sales_order_id }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
