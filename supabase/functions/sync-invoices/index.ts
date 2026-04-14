// Supabase Edge Function — Zoho → Supabase invoice sync
// No external imports — uses Supabase REST API directly via fetch

function env(key: string, fallback = '') {
  return Deno.env.get(key) ?? fallback;
}

// ── Supabase REST helpers ─────────────────────────────────────
function sbHeaders() {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  return {
    'Authorization': `Bearer ${key}`,
    'apikey': key,
    'Content-Type': 'application/json',
  };
}

async function sbUpsert(table: string, rows: any[], onConflict: string) {
  const url = `${env('SUPABASE_URL')}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...sbHeaders(), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase upsert ${table} failed: ${text}`);
  }
}

async function sbSelectOne(table: string, filter: string): Promise<any> {
  const url = `${env('SUPABASE_URL')}/rest/v1/${table}?${filter}&limit=1`;
  const res = await fetch(url, { headers: { ...sbHeaders(), 'Prefer': 'return=representation' } });
  if (!res.ok) return null;
  const data = await res.json();
  return Array.isArray(data) ? (data[0] ?? null) : null;
}

// ── Zoho OAuth ────────────────────────────────────────────────
let cachedToken = '';
let tokenExpiry = 0;

async function getZohoToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry - 60_000) return cachedToken;
  const res = await fetch('https://accounts.zoho.in/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: env('ZOHO_REFRESH_TOKEN'),
      client_id:     env('ZOHO_CLIENT_ID'),
      client_secret: env('ZOHO_CLIENT_SECRET'),
      grant_type:    'refresh_token',
    }),
  });
  const rawText = await res.text();
  console.log('[debug] Zoho token status:', res.status);
  console.log('[debug] Zoho token response:', rawText.substring(0, 300));
  let data: any;
  try { data = JSON.parse(rawText); } catch { throw new Error(`Zoho returned non-JSON: ${rawText.substring(0, 200)}`); }
  if (!data.access_token) throw new Error(`Zoho token failed: ${JSON.stringify(data)}`);
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

function zohoHeaders(token: string) {
  return {
    Authorization: `Zoho-oauthtoken ${token}`,
  };
}

function withOrg(url: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}organization_id=${env('ZOHO_ORGANIZATION_ID')}`;
}

// ── Zoho API calls ────────────────────────────────────────────
async function fetchModifiedInvoices(since: string) {
  const token = await getZohoToken();
  const base = env('ZOHO_BASE_URL', 'https://www.zohoapis.in/inventory/v1');
  const orgId = env('ZOHO_ORGANIZATION_ID');
  console.log('[debug] Zoho org ID:', orgId);
  let page = 1;
  const invoices: any[] = [];
  while (true) {
    const url = withOrg(`${base}/invoices?last_modified_time=${encodeURIComponent(since)}&page=${page}&per_page=200`);
    console.log('[debug] Fetching:', url);
    const res  = await fetch(url, { headers: zohoHeaders(token) });
    const rawText = await res.text();
    console.log('[debug] Invoices status:', res.status, rawText.substring(0, 200));
    let data: any;
    try { data = JSON.parse(rawText); } catch { throw new Error(`Zoho invoices returned non-JSON (status ${res.status}): ${rawText.substring(0, 200)}`); }
    if (!data.invoices?.length) break;
    invoices.push(...data.invoices);
    if (!data.page_context?.has_more_page) break;
    page++;
  }
  return invoices;
}

async function fetchInvoiceDetail(invoiceId: string) {
  const token = await getZohoToken();
  const base = env('ZOHO_BASE_URL', 'https://www.zohoapis.in/inventory/v1');
  const res = await fetch(withOrg(`${base}/invoices/${invoiceId}`), { headers: zohoHeaders(token) });
  const data = await res.json();
  return data.invoice;
}

async function fetchContactPhones(contactId: string): Promise<{ phone: string; label: string }[]> {
  if (!contactId) return [];
  const token = await getZohoToken();
  const base = env('ZOHO_BASE_URL', 'https://www.zohoapis.in/inventory/v1');
  try {
    const res  = await fetch(withOrg(`${base}/contacts/${contactId}`), { headers: zohoHeaders(token) });
    const data = await res.json();
    const c    = data.contact;
    const results: { phone: string; label: string }[] = [];
    const add = (raw: string, label: string) => {
      const n = normalisePhone(raw);
      if (n) results.push({ phone: n, label });
    };
    add(c?.mobile, 'mobile');
    add(c?.phone, 'landline');
    for (const p of c?.contact_persons ?? []) {
      const label = [p.first_name, p.last_name].filter(Boolean).join(' ') || 'contact';
      add(p.mobile, label);
      add(p.phone, label);
    }
    const seen = new Set<string>();
    return results.filter(r => { if (seen.has(r.phone)) return false; seen.add(r.phone); return true; });
  } catch { return []; }
}

function normalisePhone(raw: string): string | null {
  if (!raw) return null;
  const d = raw.replace(/\D/g, '');
  if (d.length === 10)                         return '+91' + d;
  if (d.length === 12 && d.startsWith('91'))   return '+' + d;
  if (d.length === 11 && d.startsWith('0'))    return '+91' + d.slice(1);
  return null;
}

// ── Razorpay ──────────────────────────────────────────────────
async function createPaymentLink(invoiceNumber: string, customerName: string, phone: string, amountInPaise: number) {
  const auth = btoa(`${env('RAZORPAY_KEY_ID')}:${env('RAZORPAY_KEY_SECRET')}`);
  const res = await fetch('https://api.razorpay.com/v1/payment_links', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: amountInPaise, currency: 'INR',
      description: `Payment for ${invoiceNumber} - The Good Papaya`,
      customer: { name: customerName, contact: phone.replace('+', '') },
      notify: { sms: true, email: false },
      reminder_enable: true,
      notes: { invoice_number: invoiceNumber },
      callback_url: 'https://thegoodpapaya.com/pages/invoices?payment=success',
      callback_method: 'get',
    }),
  });
  const data = await res.json();
  return { id: data.id, short_url: data.short_url };
}

// ── Main sync logic ───────────────────────────────────────────
async function syncInvoices() {
  const lookback = parseInt(env('SYNC_LOOKBACK_MINUTES', '10'));
  const since = new Date(Date.now() - lookback * 60 * 1000)
    .toISOString().replace('T', ' ').substring(0, 19);

  console.log(`[sync] Fetching invoices modified since ${since}`);
  const summaries = await fetchModifiedInvoices(since);
  console.log(`[sync] ${summaries.length} invoice(s) to process`);

  for (const summary of summaries) {
    try {
      const detail        = await fetchInvoiceDetail(summary.invoice_id);
      const customerName  = detail.customer_name;
      const zohoContactId = detail.customer_id;

      // Sync customer
      await sbUpsert('customers', [{ customer_name: customerName }], 'customer_name');

      // Sync phones
      const phones = await fetchContactPhones(zohoContactId);
      let phone: string | null = null;
      if (phones.length > 0) {
        await sbUpsert('customer_phones',
          phones.map(p => ({ customer_name: customerName, phone_number: p.phone, label: p.label })),
          'customer_name,phone_number'
        );
        phone = phones[0].phone;
      } else {
        const row = await sbSelectOne('customer_phones', `customer_name=eq.${encodeURIComponent(customerName)}&select=phone_number`);
        phone = row?.phone_number ?? null;
      }

      if (!phone) { console.warn(`[sync] No phone for "${customerName}" — skipping`); continue; }

      const invoiceDate   = detail.date;
      const invoiceNumber = detail.invoice_number;
      const zohoInvoiceId = detail.invoice_id;
      const invoiceTotal  = parseFloat(detail.total);

      // Get or create Razorpay link
      let paymentLink: string | null = null;
      let paymentLinkId: string | null = null;
      const existing = await sbSelectOne('invoice_line_items',
        `zoho_invoice_id=eq.${zohoInvoiceId}&payment_link=not.is.null&select=payment_link,payment_link_id`
      );

      if (existing) {
        paymentLink   = existing.payment_link;
        paymentLinkId = existing.payment_link_id;
      } else if (detail.status !== 'paid' && invoiceTotal > 0) {
        try {
          const rpl = await createPaymentLink(invoiceNumber, customerName, phone, Math.round(invoiceTotal * 100));
          paymentLink   = rpl.short_url;
          paymentLinkId = rpl.id;
          console.log(`[sync] Razorpay link created for ${invoiceNumber}: ${paymentLink}`);
        } catch (e: any) { console.error(`[sync] Razorpay failed for ${invoiceNumber}:`, e.message); }
      }

      // Upsert line items
      const rows = (detail.line_items ?? []).map((li: any) => {
        const finalQty     = parseFloat(li.quantity);
        const requestedQty = li.custom_fields?.find((cf: any) => cf.api_name === 'cf_requested_quantity')?.value ?? finalQty;
        return {
          customer_name:      customerName,
          phone_number:       phone,
          invoice_date:       invoiceDate,
          invoice_number:     invoiceNumber,
          zoho_invoice_id:    zohoInvoiceId,
          item_name:          li.name ?? li.item_name,
          requested_quantity: parseFloat(requestedQty),
          final_quantity:     finalQty,
          item_price:         parseFloat(li.rate),
          invoice_total:      invoiceTotal,
          payment_link:       paymentLink,
          payment_link_id:    paymentLinkId,
          payment_status:     detail.status === 'paid' ? 'paid' : 'pending',
          pdf_url:            `https://books.zoho.in/app#/invoices/${zohoInvoiceId}`,
        };
      });

      if (rows.length === 0) { console.warn(`[sync] No line items for ${invoiceNumber}`); continue; }

      await sbUpsert('invoice_line_items', rows, 'zoho_invoice_id,item_name');
      console.log(`[sync] Upserted ${rows.length} row(s) for ${invoiceNumber}`);

    } catch (e: any) {
      console.error(`[sync] Error on invoice ${summary.invoice_id}:`, e.message);
    }
  }

  console.log('[sync] Done.');
}

// ── Edge Function handler ─────────────────────────────────────
Deno.serve(async () => {
  try {
    await syncInvoices();
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e: any) {
    console.error('[sync] Fatal:', e.message);
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});
