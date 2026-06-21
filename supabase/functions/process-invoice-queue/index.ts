// Supabase Edge Function — process-invoice-queue
//
// Called on-demand (by queue-invoices) or by pg_cron.
// Each run:
//   1. Recovers stale 'processing' rows stuck >5 min (reset to 'queued')
//   2. Picks up to 10 'queued' items with retry_count < 3
//   3. Fast-path orders (no prior Zoho invoice) processed first
//   4. Processes batch in parallel
//   5. On success → 'done'
//      On failure → retry_count++; if <3 → 'queued' again; if 3 → 'failed'
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

const MAX_RETRIES = 3;
const STALE_MINUTES = 5;

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

function zohoH(token: string): HeadersInit {
  return { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' };
}

// ── Zoho helpers ──────────────────────────────────────────────────────────────
async function getOrCreateContact(
  name: string, phone: string | null, token: string, orgId: string,
): Promise<string> {
  const search = await fetch(
    zohoUrl(`/contacts?contact_name=${encodeURIComponent(name)}`, orgId),
    { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
  );
  const sd  = await search.json();
  const hit = sd.contacts?.find((c: any) => c.contact_name.toLowerCase() === name.toLowerCase());
  if (hit) return hit.contact_id;

  const body: any = { contact_name: name, contact_type: 'customer' };
  if (phone) body.contact_persons = [{ phone }];
  const create = await fetch(zohoUrl('/contacts', orgId), {
    method: 'POST', headers: zohoH(token),
    body: JSON.stringify({ JSONString: JSON.stringify(body) }),
  });
  const cd = await create.json();
  if (cd.code !== 0) throw new Error(`Create contact failed: ${cd.message}`);
  return cd.contact.contact_id;
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
    method: 'DELETE', headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
}

async function deleteZohoInvoice(invoiceId: string, token: string, orgId: string): Promise<void> {
  const res  = await fetch(zohoUrl(`/invoices/${invoiceId}`, orgId), {
    method: 'DELETE', headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Delete invoice failed: ${data.message}`);
}

async function createZohoInvoice(
  contactId: string, salesOrderId: string, date: string,
  lineItems: Array<{ name: string; requested_qty: number; qty: number; rate: number; description?: string }>,
  token: string, orgId: string,
): Promise<{ invoice_id: string; invoice_number: string; invoice_total: number }> {
  const body = {
    customer_id:      contactId,
    reference_number: salesOrderId,
    date,
    line_items: lineItems.map(i => ({
      name: i.name, description: i.description || '', quantity: i.qty, rate: i.rate,
      custom_fields: [{ api_name: 'cf_requested_quantity', value: i.requested_qty }],
    })),
  };
  const res  = await fetch(zohoUrl('/invoices', orgId), {
    method: 'POST', headers: zohoH(token),
    body: JSON.stringify({ JSONString: JSON.stringify(body) }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Create invoice failed: ${data.message}`);
  return {
    invoice_id:     data.invoice.invoice_id,
    invoice_number: data.invoice.invoice_number,
    invoice_total:  parseFloat(data.invoice.total ?? '0'),
  };
}

async function applyPayment(
  invoiceId: string, paymentId: string, amount: number, token: string, orgId: string,
): Promise<void> {
  const res  = await fetch(zohoUrl(`/invoices/${invoiceId}/payments`, orgId), {
    method: 'POST', headers: zohoH(token),
    body: JSON.stringify({
      JSONString: JSON.stringify({ payments: [{ payment_id: paymentId, amount_applied: amount }] }),
    }),
  });
  const data = await res.json();
  if (data.code !== 0) console.warn(`Payment reapply warning: ${data.message}`);
}

// ── Process a single order ────────────────────────────────────────────────────
async function processOrder(
  supabase: ReturnType<typeof createClient>,
  token: string, orgId: string, salesOrderId: string,
): Promise<void> {
  const [{ data: order }, { data: items }] = await Promise.all([
    supabase.from('orders').select('*').eq('sales_order_id', salesOrderId).single(),
    supabase.from('operations').select('*').eq('sales_order_id', salesOrderId).neq('status', 'removed'),
  ]);
  if (!order) throw new Error(`Order ${salesOrderId} not found`);
  if (!items?.length) throw new Error(`No items for ${salesOrderId}`);

  const missing = items.filter((i: any) => i.status !== 'nobill' && !i.final_quantity);
  if (missing.length) throw new Error(`Missing final qty: ${missing.map((i: any) => i.item_name).join(', ')}`);

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

  // Slow path: unapply payments, delete old invoice
  let priorPayments: Array<{ payment_id: string; amount_applied: number }> = [];
  if (order.zoho_invoice_id) {
    priorPayments = await fetchAppliedPayments(order.zoho_invoice_id, token, orgId);
    await Promise.all(
      priorPayments.map(p => unapplyPayment(order.zoho_invoice_id, p.payment_id, token, orgId)),
    );
    await deleteZohoInvoice(order.zoho_invoice_id, token, orgId);
  }

  const invoiceDate = order.invoice_date ?? order.order_date ?? new Date().toISOString().split('T')[0];
  const { invoice_id, invoice_number, invoice_total } = await createZohoInvoice(
    contactId, salesOrderId, invoiceDate, lineItems, token, orgId,
  );

  for (const p of priorPayments) {
    await applyPayment(invoice_id, p.payment_id, p.amount_applied, token, orgId);
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
  }).eq('sales_order_id', salesOrderId);
}

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (_req) => {
  const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

  // ── 1. Recover stale 'processing' rows ────────────────────────
  const staleThreshold = new Date(Date.now() - STALE_MINUTES * 60 * 1000).toISOString();
  await supabase
    .from('invoice_queue')
    .update({ status: 'queued' })
    .eq('status', 'processing')
    .lt('last_attempted_at', staleThreshold);

  // ── 2. Pick up to 10 queued items (retry_count < MAX_RETRIES) ─
  const { data: queueItems } = await supabase
    .from('invoice_queue')
    .select('sales_order_id, retry_count, orders(zoho_invoice_id)')
    .eq('status', 'queued')
    .lt('retry_count', MAX_RETRIES)
    .order('created_at')
    .limit(10);

  if (!queueItems?.length) {
    return new Response(
      JSON.stringify({ processed: 0 }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Fast-path (no existing invoice) first, slow-path last
  const sorted = [...queueItems].sort((a: any, b: any) =>
    (a.orders?.zoho_invoice_id ? 1 : 0) - (b.orders?.zoho_invoice_id ? 1 : 0),
  );
  const ids = sorted.map((q: any) => q.sales_order_id as string);

  // ── 3. Mark batch as processing ───────────────────────────────
  const now = new Date().toISOString();
  await Promise.all([
    supabase.from('invoice_queue')
      .update({ status: 'processing', last_attempted_at: now })
      .in('sales_order_id', ids),
    supabase.from('orders')
      .update({ invoice_status: 'processing' })
      .in('sales_order_id', ids),
  ]);

  // ── 4. Single Zoho token for the whole batch ──────────────────
  let token: string;
  try { token = await getZohoToken(); }
  catch (e: any) {
    // Token failure → reset all to queued (not a per-order failure)
    await supabase.from('invoice_queue').update({ status: 'queued' }).in('sales_order_id', ids);
    await supabase.from('orders').update({ invoice_status: 'queued' }).in('sales_order_id', ids);
    return new Response(
      JSON.stringify({ error: `Zoho token failed: ${e.message}` }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const orgId   = env('ZOHO_ORGANIZATION_ID');
  const results = await Promise.allSettled(
    ids.map(id => processOrder(supabase, token, orgId, id)),
  );

  // ── 5. Update queue based on results ─────────────────────────
  const retryCounts = Object.fromEntries(
    queueItems.map((q: any) => [q.sales_order_id, q.retry_count as number]),
  );

  await Promise.all(results.map(async (result, i) => {
    const id = ids[i];
    if (result.status === 'fulfilled') {
      await supabase.from('invoice_queue').update({ status: 'done' }).eq('sales_order_id', id);
    } else {
      const msg      = (result as PromiseRejectedResult).reason?.message ?? 'Unknown error';
      const attempts = (retryCounts[id] ?? 0) + 1;
      const nextStatus = attempts >= MAX_RETRIES ? 'failed' : 'queued';
      await Promise.all([
        supabase.from('invoice_queue').update({
          status:        nextStatus,
          error_message: msg,
          retry_count:   attempts,
        }).eq('sales_order_id', id),
        supabase.from('orders').update({
          invoice_status: nextStatus === 'failed' ? 'failed' : 'queued',
        }).eq('sales_order_id', id),
      ]);
    }
  }));

  const done   = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;

  return new Response(
    JSON.stringify({ processed: ids.length, done, failed }),
    { headers: { 'Content-Type': 'application/json' } },
  );
});
