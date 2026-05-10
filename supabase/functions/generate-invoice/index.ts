// Supabase Edge Function — generate-invoice
//
// Input:  { order_ids: string[], checker?: string }
// Output: { invoices: [{ order_id, zoho_invoice_id, zoho_invoice_number, zoho_url }] }
//
// For each order_id:
//   1. Load order_items (exclude REMOVED, include NOBILL at zero rate)
//   2. Get/create Zoho contact by customer_name
//   3. Create Zoho Books invoice
//   4. Update orders + order_items in Supabase
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_ORG_ID

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

// ── Zoho OAuth: get a fresh access token from the refresh token ─────────────
async function getZohoAccessToken(): Promise<string> {
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

// ── Find or create a Zoho contact by name ────────────────────────────────────
async function getOrCreateContact(
  name: string,
  phone: string | null,
  token: string,
  orgId: string,
): Promise<string> {
  // Search by name
  const search = await fetch(
    `https://www.zohoapis.in/books/v3/contacts?organization_id=${orgId}&contact_name=${encodeURIComponent(name)}`,
    { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
  );
  const searchData = await search.json();
  const existing = searchData?.contacts?.find(
    (c: any) => c.contact_name.toLowerCase() === name.toLowerCase()
  );
  if (existing) return existing.contact_id;

  // Create new contact
  const body: any = { contact_name: name, contact_type: 'customer' };
  if (phone) body.contact_persons = [{ phone }];

  const create = await fetch(
    `https://www.zohoapis.in/books/v3/contacts?organization_id=${orgId}`,
    {
      method:  'POST',
      headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ JSONString: JSON.stringify(body) }),
    }
  );
  const createData = await create.json();
  if (createData.code !== 0) throw new Error(`Zoho create contact failed: ${createData.message}`);
  return createData.contact.contact_id;
}

// ── Create a Zoho Books invoice ───────────────────────────────────────────────
async function createZohoInvoice(
  contactId: string,
  lineItems: Array<{ name: string; qty: number; rate: number; description?: string }>,
  salesId: string,
  date: string,
  token: string,
  orgId: string,
): Promise<{ invoice_id: string; invoice_number: string; invoice_url: string }> {
  const invoiceBody = {
    customer_id:    contactId,
    invoice_number: salesId,  // use sales_id as invoice reference
    date,
    line_items: lineItems.map(i => ({
      name:        i.name,
      description: i.description || '',
      quantity:    i.qty,
      rate:        i.rate,
    })),
  };

  const res = await fetch(
    `https://www.zohoapis.in/books/v3/invoices?organization_id=${orgId}`,
    {
      method:  'POST',
      headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ JSONString: JSON.stringify(invoiceBody) }),
    }
  );
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Zoho invoice creation failed: ${data.message}`);

  const inv = data.invoice;
  return {
    invoice_id:     inv.invoice_id,
    invoice_number: inv.invoice_number,
    invoice_url:    `https://books.zoho.in/app#/invoices/${inv.invoice_id}`,
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const { order_ids, checker } = await req.json();
    if (!Array.isArray(order_ids) || !order_ids.length) throw new Error('No order_ids provided');

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));
    const token    = await getZohoAccessToken();
    const orgId    = env('ZOHO_ORG_ID');

    const results = [];

    for (const orderId of order_ids) {
      // Load order header
      const { data: order, error: orderErr } = await supabase
        .from('orders')
        .select('*')
        .eq('sales_id', orderId)
        .single();
      if (orderErr || !order) throw new Error(`Order ${orderId} not found`);

      // Load active order_items (exclude REMOVED)
      const { data: items, error: itemsErr } = await supabase
        .from('order_items')
        .select('*')
        .eq('order_id', orderId)
        .neq('item_status', 'REMOVED');
      if (itemsErr) throw new Error(itemsErr.message);
      if (!items?.length) throw new Error(`No items for order ${orderId}`);

      // Validate all items have final_qty unless NOBILL
      const missing = items.filter(i => i.item_status !== 'NOBILL' && !i.final_qty);
      if (missing.length) {
        throw new Error(`${order.customer_name}: missing final qty for ${missing.map((i: any) => i.item_name).join(', ')}`);
      }

      // Build line items
      const lineItems = items.map((i: any) => ({
        name:        i.item_name,
        qty:         i.item_status === 'NOBILL' ? (i.final_qty ?? i.requested_qty ?? 0) : (i.final_qty ?? 0),
        rate:        i.item_status === 'NOBILL' ? 0 : (i.unit_price ?? 0),
        description: i.description || undefined,
      }));

      // Get or create Zoho contact
      const contactId = await getOrCreateContact(
        order.customer_name,
        order.phone ? `+91${order.phone}` : null,
        token,
        orgId,
      );

      // Create invoice (delete existing first if re-generating)
      if (order.zoho_invoice_id) {
        await fetch(
          `https://www.zohoapis.in/books/v3/invoices/${order.zoho_invoice_id}?organization_id=${orgId}`,
          { method: 'DELETE', headers: { Authorization: `Zoho-oauthtoken ${token}` } }
        );
      }

      const orderDate = order.order_date || order.created_at?.split('T')[0] || new Date().toISOString().split('T')[0];
      const inv = await createZohoInvoice(contactId, lineItems, orderId, orderDate, token, orgId);

      // Update order in Supabase
      await supabase.from('orders').update({
        zoho_invoice_id:     inv.invoice_id,
        zoho_invoice_number: inv.invoice_number,
        zoho_invoice_url:    inv.invoice_url,
        status:              'invoice_generated',
      }).eq('sales_id', orderId);

      // Mark all items as invoice_generated
      await supabase.from('order_items').update({
        status: 'invoice_generated',
      }).eq('order_id', orderId).neq('item_status', 'REMOVED');

      results.push({
        order_id:            orderId,
        customer:            order.customer_name,
        zoho_invoice_id:     inv.invoice_id,
        zoho_invoice_number: inv.invoice_number,
        zoho_url:            inv.invoice_url,
      });
    }

    return new Response(
      JSON.stringify({ invoices: results }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }
});
