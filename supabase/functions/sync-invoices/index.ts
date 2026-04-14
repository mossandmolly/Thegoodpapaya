// Supabase Edge Function — Zoho Inventory → Supabase invoice sync
// Modes:
//   POST /sync-invoices                    → 5-min sync (today's invoices + deletion check)
//   POST /sync-invoices?mode=reconcile     → daily noon run (D-1 to D-7)
//
// Changelog:
//   2026-04-14  Use invoice_date_start/end filter (last_modified_time not supported by Zoho Inventory)
//   2026-04-14  Daily reconciliation checks last 7 days (not 60)
//   2026-04-14  Razorpay link uses outstanding balance, recreated when balance changes
//   2026-04-14  Void invoices removed from Supabase + Razorpay link cancelled
//   2026-04-14  Tracks balance and amount_paid per invoice
//   2026-04-14  Zero external imports — uses Supabase REST API directly via fetch

// ── Supabase REST helpers ─────────────────────────────────────
function env(key: string, fallback = '') {
  return Deno.env.get(key) ?? fallback;
}

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
  if (!res.ok) throw new Error(`Supabase upsert ${table}: ${await res.text()}`);
}

async function sbSelectOne(table: string, filter: string): Promise<any> {
  const url = `${env('SUPABASE_URL')}/rest/v1/${table}?${filter}&limit=1`;
  const res = await fetch(url, { headers: { ...sbHeaders(), 'Prefer': 'return=representation' } });
  if (!res.ok) return null;
  const data = await res.json();
  return Array.isArray(data) ? (data[0] ?? null) : null;
}

async function sbSelectMany(table: string, filter: string): Promise<any[]> {
  const url = `${env('SUPABASE_URL')}/rest/v1/${table}?${filter}`;
  const res = await fetch(url, { headers: { ...sbHeaders(), 'Prefer': 'return=representation' } });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function sbDeleteWhere(table: string, filter: string) {
  const url = `${env('SUPABASE_URL')}/rest/v1/${table}?${filter}`;
  const res = await fetch(url, { method: 'DELETE', headers: sbHeaders() });
  if (!res.ok) throw new Error(`Supabase delete ${table}: ${await res.text()}`);
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
  const raw = await res.text();
  let data: any;
  try { data = JSON.parse(raw); } catch { throw new Error(`Zoho token: non-JSON response`); }
  if (!data.access_token) throw new Error(`Zoho token failed: ${raw}`);
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

function zohoHeaders(token: string) {
  return { Authorization: `Zoho-oauthtoken ${token}` };
}

function withOrg(url: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}organization_id=${env('ZOHO_ORGANIZATION_ID')}`;
}

function zohoBase() {
  return env('ZOHO_BASE_URL', 'https://www.zohoapis.in/inventory/v1');
}

// ── Zoho API ──────────────────────────────────────────────────
async function fetchModifiedInvoices(since: string): Promise<any[]> {
  const token = await getZohoToken();
  const istDate = new Date(Date.now() + 330 * 60 * 1000).toISOString().substring(0, 10);
  let page = 1;
  const invoices: any[] = [];
  while (true) {
    const url = withOrg(`${zohoBase()}/invoices?date_start=${istDate}&date_end=${istDate}&page=${page}&per_page=200`);
    const res  = await fetch(url, { headers: zohoHeaders(token) });
    const raw  = await res.text();
    console.log('[debug] invoices response:', raw.substring(0, 300));
    let data: any;
    try { data = JSON.parse(raw); } catch { throw new Error(`Zoho invoices non-JSON (${res.status}): ${raw.substring(0, 200)}`); }
    if (!data.invoices?.length) break;
    invoices.push(...data.invoices);
    if (!data.page_context?.has_more_page) break;
    page++;
  }
  return invoices;
}

async function fetchInvoiceDetail(invoiceId: string): Promise<any> {
  const token = await getZohoToken();
  const res = await fetch(withOrg(`${zohoBase()}/invoices/${invoiceId}`), { headers: zohoHeaders(token) });
  const data = await res.json();
  return data.invoice;
}

// Fetch all Zoho invoice IDs for a date range (for reconciliation)
async function fetchZohoInvoiceIds(dateStart: string, dateEnd: string): Promise<Set<string>> {
  const token = await getZohoToken();
  let page = 1;
  const ids = new Set<string>();
  while (true) {
    const url = withOrg(`${zohoBase()}/invoices?invoice_date_start=${dateStart}&invoice_date_end=${dateEnd}&page=${page}&per_page=200`);
    const res  = await fetch(url, { headers: zohoHeaders(token) });
    const data = await res.json();
    if (!data.invoices?.length) break;
    for (const inv of data.invoices) ids.add(inv.invoice_id);
    if (!data.page_context?.has_more_page) break;
    page++;
  }
  return ids;
}

async function fetchContactPhones(contactId: string): Promise<{ phone: string; label: string }[]> {
  if (!contactId) return [];
  const token = await getZohoToken();
  try {
    const res  = await fetch(withOrg(`${zohoBase()}/contacts/${contactId}`), { headers: zohoHeaders(token) });
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

async function cancelPaymentLink(linkId: string) {
  try {
    const auth = btoa(`${env('RAZORPAY_KEY_ID')}:${env('RAZORPAY_KEY_SECRET')}`);
    await fetch(`https://api.razorpay.com/v1/payment_links/${linkId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}` },
    });
  } catch (_e) {} // best effort
}

// ── Remove invoice from Supabase + cancel payment link ────────
async function removeInvoice(zohoInvoiceId: string, invoiceNumber: string, reason: string) {
  const row = await sbSelectOne('invoice_line_items',
    `zoho_invoice_id=eq.${zohoInvoiceId}&payment_link_id=not.is.null&select=payment_link_id`
  );
  if (row?.payment_link_id) await cancelPaymentLink(row.payment_link_id);
  await sbDeleteWhere('invoice_line_items', `zoho_invoice_id=eq.${encodeURIComponent(zohoInvoiceId)}`);
  console.log(`[sync] Removed ${invoiceNumber} (${reason})`);
}

// ── Customer sync ─────────────────────────────────────────────
async function resolveAndSyncCustomer(customerName: string, zohoContactId: string): Promise<string | null> {
  await sbUpsert('customers', [{ customer_name: customerName }], 'customer_name');
  const phones = await fetchContactPhones(zohoContactId);
  if (phones.length > 0) {
    await sbUpsert('customer_phones',
      phones.map(p => ({ customer_name: customerName, phone_number: p.phone, label: p.label })),
      'customer_name,phone_number'
    );
    return phones[0].phone;
  }
  const row = await sbSelectOne('customer_phones', `customer_name=eq.${encodeURIComponent(customerName)}&select=phone_number`);
  return row?.phone_number ?? null;
}

// ── Process a single invoice ──────────────────────────────────
async function processInvoice(summary: any) {
  const detail = await fetchInvoiceDetail(summary.invoice_id);
  if (!detail) return;

  // Voided invoice → remove from Supabase
  if (detail.status === 'void') {
    await removeInvoice(detail.invoice_id, detail.invoice_number, 'voided in Zoho');
    return;
  }

  const customerName  = detail.customer_name;
  const zohoContactId = detail.customer_id;
  const phone         = await resolveAndSyncCustomer(customerName, zohoContactId);

  if (!phone) { console.warn(`[sync] No phone for "${customerName}" — skipping`); return; }

  const invoiceDate   = detail.date;
  const invoiceNumber = detail.invoice_number;
  const zohoInvoiceId = detail.invoice_id;
  const invoiceTotal  = parseFloat(detail.total ?? '0');
  // balance = outstanding amount; fall back to total if not present
  const invoiceBalance = parseFloat(detail.balance ?? detail.total ?? '0');
  const amountPaid    = parseFloat(detail.payment_made ?? detail.total_payments_made ?? '0');

  const paymentStatus =
    detail.status === 'paid'           ? 'paid' :
    detail.status === 'partially_paid' ? 'partially_paid' : 'pending';

  // ── Razorpay link: create/reuse/recreate based on outstanding balance ──
  let paymentLink: string | null = null;
  let paymentLinkId: string | null = null;

  const existing = await sbSelectOne('invoice_line_items',
    `zoho_invoice_id=eq.${zohoInvoiceId}&payment_link=not.is.null&select=payment_link,payment_link_id,balance,invoice_total`
  );

  // Compare stored balance (or total if balance not yet stored) vs current
  const storedBalance = parseFloat(existing?.balance ?? existing?.invoice_total ?? '-1');
  const balanceChanged = existing && Math.round(storedBalance * 100) !== Math.round(invoiceBalance * 100);

  if (existing && !balanceChanged) {
    // Reuse — nothing changed
    paymentLink   = existing.payment_link;
    paymentLinkId = existing.payment_link_id;
  } else {
    // Cancel old link if balance changed
    if (existing?.payment_link_id && balanceChanged) {
      await cancelPaymentLink(existing.payment_link_id);
      console.log(`[sync] Cancelled old link for ${invoiceNumber} — balance changed (${storedBalance} → ${invoiceBalance})`);
    }
    // Create new link for outstanding balance (not total)
    if (paymentStatus !== 'paid' && invoiceBalance > 0) {
      try {
        const rpl = await createPaymentLink(invoiceNumber, customerName, phone, Math.round(invoiceBalance * 100));
        paymentLink   = rpl.short_url;
        paymentLinkId = rpl.id;
        console.log(`[sync] ${balanceChanged ? 'Recreated' : 'Created'} Razorpay link for ${invoiceNumber} — ₹${invoiceBalance}`);
      } catch (e: any) { console.error(`[sync] Razorpay failed for ${invoiceNumber}:`, e.message); }
    }
  }

  // ── Upsert line items ─────────────────────────────────────────
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
      balance:            invoiceBalance,
      amount_paid:        amountPaid,
      payment_link:       paymentLink,
      payment_link_id:    paymentLinkId,
      payment_status:     paymentStatus,
      pdf_url:            `https://inventory.zoho.in/app#/invoices/${zohoInvoiceId}`,
    };
  });

  if (rows.length === 0) { console.warn(`[sync] No line items for ${invoiceNumber}`); return; }

  // Delete existing line items for this invoice then insert fresh set
  // (handles removed line items — upsert alone won't delete orphaned rows)
  await sbDeleteWhere('invoice_line_items', `zoho_invoice_id=eq.${encodeURIComponent(zohoInvoiceId)}`);
  await sbUpsert('invoice_line_items', rows, 'zoho_invoice_id,item_name');
  console.log(`[sync] Upserted ${rows.length} row(s) for ${invoiceNumber} (${paymentStatus}, balance ₹${invoiceBalance})`);
}

// ── Today's deletion detection ────────────────────────────────
// Compares today's Zoho invoice IDs with what's in Supabase for today
async function reconcileTodayDeletions() {
  const today = new Date().toISOString().substring(0, 10);
  const zohoIds = await fetchZohoInvoiceIds(today, today);

  const sbRows = await sbSelectMany('invoice_line_items',
    `invoice_date=eq.${today}&select=zoho_invoice_id,invoice_number`
  );
  const sbInvoices = new Map<string, string>();
  for (const r of sbRows) sbInvoices.set(r.zoho_invoice_id, r.invoice_number);

  for (const [id, number] of sbInvoices) {
    if (!zohoIds.has(id)) {
      await removeInvoice(id, number, 'deleted from Zoho today');
    }
  }
}

// ── 5-minute sync job ─────────────────────────────────────────
async function syncInvoices() {
  const lookback = parseInt(env('SYNC_LOOKBACK_MINUTES', '10'));
  const since = new Date().toISOString().substring(0, 10); // YYYY-MM-DD (only format Zoho Inventory accepts)

  console.log(`[sync] Fetching invoices modified since ${since}`);
  const summaries = await fetchModifiedInvoices(since);
  console.log(`[sync] ${summaries.length} invoice(s) to process`);

  for (const summary of summaries) {
    try { await processInvoice(summary); }
    catch (e: any) { console.error(`[sync] Error on ${summary.invoice_id}:`, e.message); }
  }

  // Also check for deletions in today's invoices
  try { await reconcileTodayDeletions(); }
  catch (e: any) { console.error(`[sync] Today reconcile error:`, e.message); }

  console.log('[sync] Done.');
}

// ── Daily reconciliation (D-1 and earlier, runs at noon) ──────
async function reconcileOldInvoices() {
  const today     = new Date().toISOString().substring(0, 10);
  const since7   = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().substring(0, 10);
  // yesterday (D-1)
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().substring(0, 10);

  console.log(`[reconcile] Checking D-1 and earlier (${since7} to ${yesterday})`);

  // 1. Fetch all Zoho invoice IDs from last 7 days (excluding today)
  const zohoIds = await fetchZohoInvoiceIds(since7, yesterday);
  console.log(`[reconcile] ${zohoIds.size} active Zoho invoice(s) found`);

  // 2. Fetch all Supabase invoice IDs for same period (excluding today)
  const sbRows = await sbSelectMany('invoice_line_items',
    `invoice_date=lt.${today}&invoice_date=gte.${since7}&select=zoho_invoice_id,invoice_number`
  );
  const sbInvoices = new Map<string, string>();
  for (const r of sbRows) sbInvoices.set(r.zoho_invoice_id, r.invoice_number);

  // 3. Delete orphaned Supabase entries (invoices no longer in Zoho)
  for (const [id, number] of sbInvoices) {
    if (!zohoIds.has(id)) {
      try { await removeInvoice(id, number, 'not found in Zoho (reconcile)'); }
      catch (e: any) { console.error(`[reconcile] Remove error for ${number}:`, e.message); }
    }
  }

  // 4. Process all modified invoices for D-1 and earlier
  const since24h = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString().substring(0, 19);
  const modified = await fetchModifiedInvoices(since24h);
  const oldModified = modified.filter(s => (s.date ?? s.invoice_date ?? '') < today);
  console.log(`[reconcile] ${oldModified.length} modified older invoice(s) to reprocess`);

  for (const summary of oldModified) {
    try { await processInvoice(summary); }
    catch (e: any) { console.error(`[reconcile] Error on ${summary.invoice_id}:`, e.message); }
  }

  console.log('[reconcile] Done.');
}

// ── Edge Function handler ─────────────────────────────────────
Deno.serve(async (req) => {
  try {
    const mode = new URL(req.url).searchParams.get('mode') ?? 'sync';
    if (mode === 'reconcile') {
      await reconcileOldInvoices();
    } else {
      await syncInvoices();
    }
    return new Response(JSON.stringify({ ok: true, mode }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e: any) {
    console.error('[sync] Fatal:', e.message);
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});

// ── pg_cron schedules (run ONCE in SQL Editor) ────────────────
// 5-minute sync:
// select cron.schedule('sync-invoices-every-5-min', '*/5 * * * *', $$
//   select net.http_post(
//     url := 'https://fykqprogzqcfzrgwlrem.supabase.co/functions/v1/sync-invoices',
//     headers := '{"Authorization": "Bearer YOUR_ANON_KEY"}'::jsonb
//   );
// $$);
//
// Daily noon reconciliation:
// select cron.schedule('reconcile-invoices-daily-noon', '0 6 * * *', $$
//   select net.http_post(
//     url := 'https://fykqprogzqcfzrgwlrem.supabase.co/functions/v1/sync-invoices?mode=reconcile',
//     headers := '{"Authorization": "Bearer YOUR_ANON_KEY"}'::jsonb
//   );
// $$);
// Note: cron runs in UTC. 0 6 * * * = 11:30 AM IST
