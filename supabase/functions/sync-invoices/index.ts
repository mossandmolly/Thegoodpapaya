// Supabase Edge Function — Zoho → Supabase invoice sync
// Deployed via: Supabase Dashboard → Edge Functions → New Function
// Scheduled via: Supabase Dashboard → Database → Extensions → pg_cron (see bottom of this file)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Config from environment ───────────────────────────────────
const ZOHO_CLIENT_ID     = Deno.env.get('ZOHO_CLIENT_ID')!;
const ZOHO_CLIENT_SECRET = Deno.env.get('ZOHO_CLIENT_SECRET')!;
const ZOHO_REFRESH_TOKEN = Deno.env.get('ZOHO_REFRESH_TOKEN')!;
const ZOHO_ORG_ID        = Deno.env.get('ZOHO_ORGANIZATION_ID')!;
const ZOHO_BASE          = Deno.env.get('ZOHO_BASE_URL') ?? 'https://www.zohoapis.in/books/v3';
const RAZORPAY_KEY_ID    = Deno.env.get('RAZORPAY_KEY_ID')!;
const RAZORPAY_KEY_SECRET= Deno.env.get('RAZORPAY_KEY_SECRET')!;
const LOOKBACK_MINUTES   = parseInt(Deno.env.get('SYNC_LOOKBACK_MINUTES') ?? '10');

const db = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

// ── Zoho OAuth ────────────────────────────────────────────────
let cachedToken: string | null = null;
let tokenExpiry = 0;

async function getZohoToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry - 60_000) return cachedToken;
  const res = await fetch('https://accounts.zoho.in/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: ZOHO_REFRESH_TOKEN,
      client_id:     ZOHO_CLIENT_ID,
      client_secret: ZOHO_CLIENT_SECRET,
      grant_type:    'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Zoho token failed: ${JSON.stringify(data)}`);
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

function zohoHeaders(token: string) {
  return {
    Authorization: `Zoho-oauthtoken ${token}`,
    'X-com-zoho-books-organizationid': ZOHO_ORG_ID,
  };
}

// ── Zoho API calls ────────────────────────────────────────────
async function fetchModifiedInvoices(since: string) {
  const token = await getZohoToken();
  let page = 1;
  const invoices: any[] = [];
  while (true) {
    const url = `${ZOHO_BASE}/invoices?last_modified_time=${encodeURIComponent(since)}&page=${page}&per_page=200`;
    const res  = await fetch(url, { headers: zohoHeaders(token) });
    const data = await res.json();
    if (!data.invoices?.length) break;
    invoices.push(...data.invoices);
    if (!data.page_context?.has_more_page) break;
    page++;
  }
  return invoices;
}

async function fetchInvoiceDetail(invoiceId: string) {
  const token = await getZohoToken();
  const res   = await fetch(`${ZOHO_BASE}/invoices/${invoiceId}`, { headers: zohoHeaders(token) });
  const data  = await res.json();
  return data.invoice;
}

async function fetchContactPhones(contactId: string): Promise<{ phone: string; label: string }[]> {
  if (!contactId) return [];
  const token = await getZohoToken();
  try {
    const res  = await fetch(`${ZOHO_BASE}/contacts/${contactId}`, { headers: zohoHeaders(token) });
    const data = await res.json();
    const c    = data.contact;
    const results: { phone: string; label: string }[] = [];

    const add = (raw: string, label: string) => {
      const n = normalisePhone(raw);
      if (n) results.push({ phone: n, label });
    };

    add(c?.mobile, 'mobile');
    add(c?.phone,  'landline');
    for (const p of c?.contact_persons ?? []) {
      const label = [p.first_name, p.last_name].filter(Boolean).join(' ') || 'contact';
      add(p.mobile, label);
      add(p.phone,  label);
    }

    // deduplicate
    const seen = new Set<string>();
    return results.filter(r => { if (seen.has(r.phone)) return false; seen.add(r.phone); return true; });
  } catch { return []; }
}

function normalisePhone(raw: string): string | null {
  if (!raw) return null;
  const d = raw.replace(/\D/g, '');
  if (d.length === 10)                        return '+91' + d;
  if (d.length === 12 && d.startsWith('91'))  return '+' + d;
  if (d.length === 11 && d.startsWith('0'))   return '+91' + d.slice(1);
  return null;
}

// ── Razorpay ──────────────────────────────────────────────────
async function createPaymentLink(invoiceNumber: string, customerName: string, phone: string, amountInPaise: number) {
  const auth = btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`);
  const res  = await fetch('https://api.razorpay.com/v1/payment_links', {
    method:  'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount:          amountInPaise,
      currency:        'INR',
      description:     `Payment for ${invoiceNumber} — The Good Papaya`,
      customer:        { name: customerName, contact: phone.replace('+', '') },
      notify:          { sms: true, email: false },
      reminder_enable: true,
      notes:           { invoice_number: invoiceNumber },
      callback_url:    'https://thegoodpapaya.com/pages/invoices?payment=success',
      callback_method: 'get',
    }),
  });
  const data = await res.json();
  return { id: data.id, short_url: data.short_url };
}

// ── Customer sync ─────────────────────────────────────────────
async function resolveAndSyncCustomer(customerName: string, zohoContactId: string): Promise<string | null> {
  await db.from('customers').upsert({ customer_name: customerName }, { onConflict: 'customer_name' });

  const phones = await fetchContactPhones(zohoContactId);
  if (phones.length > 0) {
    await db.from('customer_phones').upsert(
      phones.map(p => ({ customer_name: customerName, phone_number: p.phone, label: p.label })),
      { onConflict: 'customer_name,phone_number' }
    );
    return phones[0].phone;
  }

  const { data } = await db.from('customer_phones').select('phone_number').eq('customer_name', customerName).limit(1).single();
  return data?.phone_number ?? null;
}

// ── Main sync logic ───────────────────────────────────────────
async function syncInvoices() {
  const since = new Date(Date.now() - LOOKBACK_MINUTES * 60 * 1000)
    .toISOString().replace('T', ' ').substring(0, 19);

  console.log(`[sync] Fetching invoices modified since ${since}`);
  const summaries = await fetchModifiedInvoices(since);
  console.log(`[sync] ${summaries.length} invoice(s) to process`);

  for (const summary of summaries) {
    try {
      const detail         = await fetchInvoiceDetail(summary.invoice_id);
      const customerName   = detail.customer_name;
      const zohoContactId  = detail.customer_id;
      const phone          = await resolveAndSyncCustomer(customerName, zohoContactId);

      if (!phone) { console.warn(`[sync] No phone for "${customerName}" — skipping`); continue; }

      const invoiceDate    = detail.date;
      const invoiceNumber  = detail.invoice_number;
      const zohoInvoiceId  = detail.invoice_id;
      const invoiceTotal   = parseFloat(detail.total);

      // Get or create Razorpay link
      let paymentLink: string | null   = null;
      let paymentLinkId: string | null = null;

      const { data: existing } = await db
        .from('invoice_line_items')
        .select('payment_link, payment_link_id')
        .eq('zoho_invoice_id', zohoInvoiceId)
        .not('payment_link', 'is', null)
        .limit(1).single();

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

      const { error } = await db.from('invoice_line_items').upsert(rows, { onConflict: 'zoho_invoice_id,item_name' });
      if (error) throw new Error(`Supabase upsert failed: ${error.message}`);
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
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500 });
  }
});

// ── Schedule with pg_cron ─────────────────────────────────────
// Run this ONCE in Supabase SQL Editor after deploying the function:
//
// select cron.schedule(
//   'sync-invoices-every-5-min',
//   '*/5 * * * *',
//   $$
//     select net.http_post(
//       url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/sync-invoices',
//       headers := '{"Authorization": "Bearer YOUR_ANON_KEY"}'::jsonb
//     );
//   $$
// );
