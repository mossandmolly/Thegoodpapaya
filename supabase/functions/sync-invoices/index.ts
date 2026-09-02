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

// A plain UPDATE, never capable of inserting a new row — unlike sbUpsert,
// which briefly caused a real crash: reconcileOrderPayment/
// closeOrderPaymentMechanisms/sweepStaleQrCodes all look up an existing
// order first and only ever mean to patch it, but sbUpsert's
// merge-duplicates upsert falls back to a genuine INSERT whenever
// on_conflict doesn't find a match at write time (e.g. the row changed
// between the read and the write) — which then fails on orders' NOT NULL
// columns (customer_name etc.) since only a few fields are being patched.
// A no-op PATCH against a since-vanished sales_order_id is harmless; a
// failed INSERT of a garbage half-empty row is not.
async function sbUpdate(table: string, salesOrderId: string, patch: Record<string, unknown>) {
  const url = `${env('SUPABASE_URL')}/rest/v1/${table}?sales_order_id=eq.${encodeURIComponent(salesOrderId)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Supabase update ${table}: ${await res.text()}`);
}

async function sbSelectOne(table: string, filter: string): Promise<any> {
  const url = `${env('SUPABASE_URL')}/rest/v1/${table}?${filter}&limit=1`;
  const res = await fetch(url, { headers: { ...sbHeaders(), 'Prefer': 'return=representation' } });
  if (!res.ok) {
    // Used to fail silently here (return null on any error, same as an
    // empty/not-found result) — that made a real outage indistinguishable
    // from "no row", which is exactly how fetchAlreadySyncedState's read
    // failing could go unnoticed and quietly disable the whole
    // already-synced skip check (see its own comment).
    console.error(`[sync] Supabase select ${table} failed (${res.status}): ${await res.text()}`);
    return null;
  }
  const data = await res.json();
  return Array.isArray(data) ? (data[0] ?? null) : null;
}

async function sbSelectMany(table: string, filter: string): Promise<any[]> {
  const url = `${env('SUPABASE_URL')}/rest/v1/${table}?${filter}`;
  const res = await fetch(url, { headers: { ...sbHeaders(), 'Prefer': 'return=representation' } });
  if (!res.ok) {
    console.error(`[sync] Supabase select ${table} failed (${res.status}): ${await res.text()}`);
    return [];
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function sbDeleteWhere(table: string, filter: string) {
  const url = `${env('SUPABASE_URL')}/rest/v1/${table}?${filter}`;
  const res = await fetch(url, { method: 'DELETE', headers: sbHeaders() });
  if (!res.ok) throw new Error(`Supabase delete ${table}: ${await res.text()}`);
}

// Generic PATCH-by-filter — unlike sbUpdate (hardcoded to orders,
// filtered by sales_order_id), used where the filter column varies
// (invoice_line_items, filtered by zoho_invoice_id, in syncStalePaymentLinks).
async function sbPatchWhere(table: string, filter: string, patch: Record<string, unknown>) {
  const url = `${env('SUPABASE_URL')}/rest/v1/${table}?${filter}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Supabase patch ${table}: ${await res.text()}`);
}

// ── Zoho OAuth ────────────────────────────────────────────────
// Shared zoho_token_cache row every other Zoho-touching function uses (see
// cancel-order for the full rationale) — this used to be a private
// in-memory-only cache, which meant every cold start (this function runs on
// a per-minute cron, so cold starts are frequent) refreshed independently
// of, and far more often than, every other Zoho-touching function.
let cachedToken = '';
let tokenExpiry = 0;

async function getZohoToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry - 60_000) return cachedToken;

  const row = await sbSelectOne('zoho_token_cache', 'id=eq.1&select=access_token,expires_at,refresh_token');
  if (row && new Date(row.expires_at).getTime() > Date.now() + 60_000) {
    cachedToken = row.access_token;
    tokenExpiry = new Date(row.expires_at).getTime();
    return cachedToken;
  }

  const res = await fetch('https://accounts.zoho.in/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      // Zoho rotates refresh_token on (at least some) refresh calls and
      // invalidates the old one — prefer whatever the shared cache has
      // last persisted over the static env secret, which goes stale after
      // a rotation triggered by any function, not just this one.
      refresh_token: row?.refresh_token || env('ZOHO_REFRESH_TOKEN'),
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
  try {
    await sbUpsert('zoho_token_cache', [{
      id: 1, access_token: cachedToken, expires_at: new Date(tokenExpiry).toISOString(),
      ...(data.refresh_token ? { refresh_token: data.refresh_token } : {}),
    }], 'id');
  } catch (e) { console.error('zoho_token_cache upsert failed:', e); }
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
// sales_order_id encodes its business date in IST (see the frontend's own
// CALENDAR_TODAY) — plain UTC "today" would be wrong for part of the day,
// since IST is 5.5hrs ahead.
function todayIST(): string {
  return new Date(Date.now() + 330 * 60 * 1000).toISOString().substring(0, 10);
}

async function fetchModifiedInvoices(since: string): Promise<any[]> {
  const token = await getZohoToken();
  const istDate = todayIST();
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
async function cancelPaymentLink(linkId: string) {
  try {
    const auth = btoa(`${env('RAZORPAY_KEY_ID')}:${env('RAZORPAY_KEY_SECRET')}`);
    await fetch(`https://api.razorpay.com/v1/payment_links/${linkId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}` },
    });
  } catch (_e) {} // best effort
}

async function closeQrCode(qrCodeId: string) {
  try {
    const auth = btoa(`${env('RAZORPAY_KEY_ID')}:${env('RAZORPAY_KEY_SECRET')}`);
    await fetch(`https://api.razorpay.com/v1/payments/qr_codes/${qrCodeId}/close`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}` },
    });
  } catch (_e) {} // best effort
}

async function createOrderQr(amountPaise: number, salesOrderId: string, customerName: string): Promise<{ id: string; image_url: string } | null> {
  const auth = btoa(`${env('RAZORPAY_KEY_ID')}:${env('RAZORPAY_KEY_SECRET')}`);
  const res = await fetch('https://api.razorpay.com/v1/payments/qr_codes', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'upi_qr', name: `Order ${salesOrderId}`, usage: 'single_use',
      fixed_amount: true, payment_amount: amountPaise,
      description: `The Good Papaya — order ${salesOrderId}`,
      close_by: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
      notes: { sales_order_id: salesOrderId, customer_name: customerName, source: 'delivery-qr' },
    }),
  });
  const data = await res.json();
  if (!res.ok) { console.error('[sync] QR creation failed:', data?.error?.description); return null; }
  return { id: data.id, image_url: data.image_url };
}

async function createOrderPaymentLink(amountPaise: number, customerName: string, phone: string, salesOrderId: string): Promise<{ id: string; short_url: string } | null> {
  const auth = btoa(`${env('RAZORPAY_KEY_ID')}:${env('RAZORPAY_KEY_SECRET')}`);
  const res = await fetch('https://api.razorpay.com/v1/payment_links', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: amountPaise, currency: 'INR',
      description: `The Good Papaya — order ${salesOrderId}`,
      customer: { name: customerName, contact: `+91${phone.replace(/^\+91/, '')}` },
      notify: { sms: true, whatsapp: true, email: false },
      reminder_enable: false,
      notes: { sales_order_id: salesOrderId, source: 'ops-dashboard' },
    }),
  });
  const data = await res.json();
  if (!res.ok) { console.error('[sync] Payment link creation failed:', data?.error?.description); return null; }
  return { id: data.id, short_url: data.short_url };
}

// ── Orders reconciliation (Delivery panel / Order Overview surfaces) ──
// Separate from the invoice_line_items tracking above. orders.
// razorpay_link_id and orders.qr_code_id/qr_image_url are what the
// ops-dashboard's Delivery panel and Order Overview actually display —
// until now nothing kept those in sync with Zoho directly (only the
// Razorpay webhook did, and only for payments actually made through
// Razorpay; a payment recorded directly in Zoho, or a manual discount,
// left a stale, still-payable link/QR behind). Runs every 5 minutes
// alongside the invoice_line_items sync above, keyed by the same Zoho
// invoice's reference_number (== sales_order_id).
// Returns the order's payment link as it stands after reconciliation
// (null if none active, or not an ops-dashboard order at all) — the
// invoice_line_items rows below (what the customer-facing invoices site
// actually reads) mirror whatever's true on `orders` right now, so the
// "Pay Now" button there reflects a link created any way: auto-generated
// here, by generate-invoice, or manually from Order Overview.
async function reconcileOrderPayment(
  salesOrderId: string, customerName: string, phone: string | null,
  invoiceBalance: number, amountPaid: number,
): Promise<{ url: string | null; id: string | null }> {
  const order = await sbSelectOne('orders',
    `sales_order_id=eq.${encodeURIComponent(salesOrderId)}&select=razorpay_link_id,razorpay_url,qr_code_id,balance_due,payment_collected,delivery_status`
  );
  if (!order) return { url: null, id: null }; // not an ops-dashboard order (e.g. shop/website order) — nothing to reconcile

  const balanceUnchanged = order.balance_due != null &&
    Math.round(parseFloat(order.balance_due) * 100) === Math.round(invoiceBalance * 100);

  // Always keep the numbers themselves current, even when nothing else
  // changes — this is what covers a cash payment or manual discount
  // recorded only in Zoho, with no Razorpay payment to trigger the webhook.
  const updates: Record<string, unknown> = { amount_paid: amountPaid, balance_due: invoiceBalance };

  // Fallback for whatever the webhook might have missed (a payment
  // recorded directly in Zoho, a failed webhook delivery, etc.) — only
  // flips false→true, never re-stamps payment_collected_at on a cycle
  // where nothing actually changed.
  if (invoiceBalance <= 0 && !order.payment_collected) {
    updates.payment_collected = true;
    updates.payment_collected_method = 'online';
    updates.payment_collected_at = new Date().toISOString();
  }

  if (!balanceUnchanged) {
    if (order.qr_code_id)        { await closeQrCode(order.qr_code_id);       updates.qr_code_id = null;      updates.qr_image_url = null; updates.qr_created_at = null; }
    if (order.razorpay_link_id)  { await cancelPaymentLink(order.razorpay_link_id); updates.razorpay_link_id = null; updates.razorpay_url = null; }

    // TEMPORARILY DISABLED — Razorpay QR/link regeneration turned off while
    // debugging sync-invoices/invoice_line_items. The close-above still
    // runs (clears a stale-amount QR/link), this just stops a new one from
    // being created in its place. Re-enable by uncommenting below once the
    // sync issue is resolved.
    //
    // // Regenerating only ever makes sense for a live, still-OFD order from
    // // TODAY — closing a stale-amount QR/link above is always correct
    // // regardless of date, but creating a fresh one for an order from a
    // // previous business day (or one that's already delivered/not yet
    // // dispatched) would just be spending real Razorpay API calls on an
    // // order nobody's actively delivering right now. sweepStaleQrCodes has
    // // this same today+ofd gate for the same reason.
    // const canRegenerate = order.delivery_status === 'ofd' && salesOrderId.startsWith(todayIST());
    //
    // if (invoiceBalance > 0 && canRegenerate) {
    //   // Regenerate whichever mechanism was already active — don't invent a
    //   // new one for an order nobody's dispatched/linked yet.
    //   if (order.qr_code_id) {
    //     const qr = await createOrderQr(Math.round(invoiceBalance * 100), salesOrderId, customerName);
    //     if (qr) { updates.qr_code_id = qr.id; updates.qr_image_url = qr.image_url; updates.qr_created_at = new Date().toISOString(); }
    //   } else if (order.razorpay_link_id && phone) {
    //     const link = await createOrderPaymentLink(Math.round(invoiceBalance * 100), customerName, phone, salesOrderId);
    //     if (link) { updates.razorpay_link_id = link.id; updates.razorpay_url = link.short_url; }
    //   }
    // }
  }

  await sbUpdate('orders', salesOrderId, updates);

  // 'razorpay_url' in updates (even set to null, e.g. just-cancelled above)
  // means this cycle changed it — that's the authoritative post-update
  // value; otherwise nothing changed this cycle, so whatever was already
  // on the order stands.
  const finalUrl = 'razorpay_url' in updates ? (updates.razorpay_url as string | null) : (order.razorpay_url ?? null);
  const finalId  = 'razorpay_link_id' in updates ? (updates.razorpay_link_id as string | null) : (order.razorpay_link_id ?? null);
  return { url: finalUrl, id: finalId };
}

// Called when the Zoho invoice behind an order disappears (voided) — closes
// whatever was active on the order without recreating anything, since
// there's no invoice left to bill against.
async function closeOrderPaymentMechanisms(salesOrderId: string) {
  const order = await sbSelectOne('orders',
    `sales_order_id=eq.${encodeURIComponent(salesOrderId)}&select=qr_code_id,razorpay_link_id`
  );
  if (!order || (!order.qr_code_id && !order.razorpay_link_id)) return;

  const updates: Record<string, unknown> = {};
  if (order.qr_code_id)       { await closeQrCode(order.qr_code_id);       updates.qr_code_id = null; updates.qr_image_url = null; updates.qr_created_at = null; }
  if (order.razorpay_link_id) { await cancelPaymentLink(order.razorpay_link_id); updates.razorpay_link_id = null; updates.razorpay_url = null; }
  await sbUpdate('orders', salesOrderId, updates);
}

// ── Proactive QR refresh sweep ─────────────────────────────────
// Razorpay auto-closes a dynamic QR after its close_by (~2hrs), but nothing
// otherwise updates our own stored qr_image_url — the Delivery panel could
// keep showing a QR Razorpay's already silently killed. Rather than wait
// for that and just clear it, refresh (close + recreate, resetting the
// clock) any QR that has less than 60 minutes left before that ~2hr
// expiry — i.e. reached 60 minutes old — and is still needed. Since this
// sync now runs hourly (not every few minutes), that 60-min margin is what
// guarantees a QR gets caught and refreshed by the very next run, before
// it can ever actually expire on a customer mid-delivery. Purely a time
// check: no rider location or delivery-sequence awareness needed.
//
// Scoped to TODAY's orders only (sales_order_id prefix) — an order still
// sitting at delivery_status='ofd' from a previous day is a dangling/stuck
// order (never marked delivered, cancelled, or otherwise closed out), not a
// live delivery in progress. Without this, the sweep would keep spending
// real Razorpay QR-creation calls indefinitely refreshing a QR nobody's
// ever going to scan again.
async function sweepStaleQrCodes() {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const stale = await sbSelectMany('orders',
    `sales_order_id=like.${encodeURIComponent(todayIST())}-*&qr_code_id=not.is.null&delivery_status=eq.ofd&payment_collected=eq.false&qr_created_at=lt.${encodeURIComponent(cutoff)}&select=sales_order_id,customer_name,invoice_total,qr_code_id`
  );
  if (!stale.length) return;
  console.log(`[sync] ${stale.length} QR(s) within 60 min of expiry — refreshing`);

  for (const order of stale) {
    try {
      await closeQrCode(order.qr_code_id);
      const qr = await createOrderQr(Math.round(order.invoice_total * 100), order.sales_order_id, order.customer_name);
      if (qr) {
        await sbUpdate('orders', order.sales_order_id, {
          qr_code_id: qr.id, qr_image_url: qr.image_url, qr_created_at: new Date().toISOString(),
        });
        console.log(`[sync] Refreshed QR for ${order.sales_order_id}`);
      }
    } catch (e: any) {
      console.error(`[sync] QR refresh failed for ${order.sales_order_id}:`, e.message);
    }
  }
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

  // Voided invoice → remove from Supabase, and close whatever payment
  // mechanism was active on the order (previously left dangling — the
  // invoice backing it is gone, so it should never be payable anymore).
  if (detail.status === 'void') {
    await removeInvoice(detail.invoice_id, detail.invoice_number, 'voided in Zoho');
    if (detail.reference_number) {
      try { await closeOrderPaymentMechanisms(detail.reference_number); }
      catch (e: any) { console.error(`[sync] Void cleanup failed for ${detail.reference_number}:`, e.message); }
    }
    return;
  }

  const customerName  = detail.customer_name;
  const zohoContactId = detail.customer_id;
  const phone: string | null = await resolveAndSyncCustomer(customerName, zohoContactId);

  if (!phone) console.warn(`[sync] No phone for "${customerName}" — syncing without Razorpay link`);

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

  // Best-effort, independent of the invoice_line_items sync below — a
  // failure here shouldn't stop that from completing. paymentLink stays
  // {url:null,id:null} for a non-ops-dashboard order (no reference_number
  // at all, e.g. a shop/website order) or if reconciliation itself throws —
  // invoice_line_items below just won't carry a link in that case, same as
  // today.
  let paymentLink: { url: string | null; id: string | null } = { url: null, id: null };
  if (detail.reference_number) {
    try {
      paymentLink = await reconcileOrderPayment(detail.reference_number, customerName, phone, invoiceBalance, amountPaid);
    } catch (e: any) {
      console.error(`[sync] Order reconcile failed for ${detail.reference_number}:`, e.message);
    }
  }

  // ── Upsert line items ─────────────────────────────────────────
  // Mirror of what's actually on the Zoho invoice, plus whatever payment
  // link is currently live on the order (from reconcileOrderPayment just
  // above) — payment_link/payment_link_id are what the customer-facing
  // invoices website's "Pay Now" button actually reads (get_invoices_by_
  // phone, migration 032), so this is the only place that column gets
  // written; it used to just sit unpopulated forever.
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
      payment_status:     paymentStatus,
      payment_link:       paymentLink.url,
      payment_link_id:    paymentLink.id,
      sales_order_id:     detail.reference_number || null,
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
// Compares today's Zoho invoice IDs with what's in Supabase for today.
// Takes zohoIds as a param instead of re-fetching — syncInvoices() already
// pulled today's full invoice list a moment ago via fetchModifiedInvoices;
// re-listing the same day again here was a second full Zoho call every
// single run for no reason.
async function reconcileTodayDeletions(zohoIds: Set<string>) {
  const today = todayIST();

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
// fetchModifiedInvoices always returns EVERY invoice dated today (Zoho
// Inventory's list endpoint has no real "changed since X" filter — see its
// own comment), so without this check every 3-minute cycle was calling
// fetchInvoiceDetail + fetchContactPhones (2 Zoho API calls) for every
// single one of today's invoices, all over again, all day — the exact
// thing that was exhausting the Inventory API's daily rate limit within a
// couple hours. Zoho's list response already includes balance/status per
// invoice at no extra cost; skip the expensive per-invoice detail+contact
// calls (and the resulting invoice_line_items rewrite) entirely for any
// invoice whose balance and status already match what's on file — nothing
// about it could have changed in a way this sync cares about. Always
// processes an invoice Supabase hasn't seen yet at all (first time either
// today or ever), so nothing new is ever silently skipped.
type SyncedState = { balance: number; status: string; salesOrderId: string | null; paymentLinkId: string | null };

async function fetchAlreadySyncedState(today: string): Promise<Map<string, SyncedState>> {
  const rows = await sbSelectMany('invoice_line_items',
    `invoice_date=eq.${today}&select=zoho_invoice_id,balance,payment_status,sales_order_id,payment_link_id`
  );
  const map = new Map<string, SyncedState>();
  for (const r of rows) if (!map.has(r.zoho_invoice_id)) map.set(r.zoho_invoice_id, {
    balance: parseFloat(r.balance) || 0, status: r.payment_status,
    salesOrderId: r.sales_order_id || null, paymentLinkId: r.payment_link_id || null,
  });
  // Diagnostic: if this comes back 0 on a day that clearly has synced
  // invoices, the skip check below is about to do nothing all run — either
  // the sbSelectMany call above just logged its own error, or `today`
  // doesn't match what's actually stored in invoice_date.
  console.log(`[sync] Already-synced state: ${map.size} invoice(s) on file for ${today}`);
  return map;
}

// A payment link changing (created/regenerated/cancelled from Order
// Overview or mark-delivered's auto-link) never touches the Zoho invoice
// itself — no balance/status change — so invoiceUnchanged below has no way
// to see it, and an invoice sitting "unchanged" would otherwise never get
// its payment_link/_id refreshed until something else about it changes.
// Runs only against invoices this cycle already decided to skip (Zoho
// calls unaffected) — purely Supabase reads/writes, one order lookup per
// skipped invoice that actually has a sales_order_id on file.
async function syncStalePaymentLinks(skipped: any[], alreadySynced: Map<string, SyncedState>) {
  for (const summary of skipped) {
    const existing = alreadySynced.get(summary.invoice_id);
    if (!existing?.salesOrderId) continue;
    const order = await sbSelectOne('orders',
      `sales_order_id=eq.${encodeURIComponent(existing.salesOrderId)}&select=razorpay_link_id,razorpay_url`
    );
    if (!order) continue;
    const currentLinkId = order.razorpay_link_id || null;
    if (currentLinkId === existing.paymentLinkId) continue; // nothing changed
    try {
      await sbPatchWhere('invoice_line_items', `zoho_invoice_id=eq.${encodeURIComponent(summary.invoice_id)}`, {
        payment_link: order.razorpay_url || null, payment_link_id: currentLinkId,
      });
      console.log(`[sync] Payment link refreshed for invoice ${summary.invoice_id} (order ${existing.salesOrderId})`);
    } catch (e: any) {
      console.error(`[sync] Payment link refresh failed for ${summary.invoice_id}:`, e.message);
    }
  }
}

let loggedMissingSummaryFields = false;

function invoiceUnchanged(summary: any, existing: SyncedState | undefined): boolean {
  if (!existing) return false; // never synced (today) — always process
  // Missing fields on the list summary (shouldn't happen, but Zoho's exact
  // list-response shape isn't something this sandbox can verify live) —
  // fail open to "process it" rather than risk silently skipping a real
  // change we can't actually see. Logged once per run (not once per
  // invoice) so a systematic shape mismatch — which would silently disable
  // this skip check for every invoice, every run — actually shows up in
  // the logs instead of just looking like "lots of things changed".
  if (summary.balance === undefined || summary.status === undefined) {
    if (!loggedMissingSummaryFields) {
      loggedMissingSummaryFields = true;
      console.error(`[sync] Zoho list summary missing balance/status — got keys: ${Object.keys(summary).join(',')}`);
    }
    return false;
  }
  const summaryBalance = Math.round((parseFloat(summary.balance) || 0) * 100);
  const existingBalance = Math.round(existing.balance * 100);
  const summaryStatus =
    summary.status === 'paid' ? 'paid' :
    summary.status === 'partially_paid' ? 'partially_paid' : 'pending';
  return summaryBalance === existingBalance && summaryStatus === existing.status;
}

async function syncInvoices() {
  loggedMissingSummaryFields = false;
  const today = todayIST();

  console.log(`[sync] Fetching today's (${today}) invoices from Zoho`);
  const summaries = await fetchModifiedInvoices(today);
  const alreadySynced = await fetchAlreadySyncedState(today);
  const toProcess = summaries.filter(s => !invoiceUnchanged(s, alreadySynced.get(s.invoice_id)));
  const skipped   = summaries.filter(s => invoiceUnchanged(s, alreadySynced.get(s.invoice_id)));
  console.log(`[sync] ${summaries.length} invoice(s) today, ${toProcess.length} actually changed since last sync`);

  for (const summary of toProcess) {
    try { await processInvoice(summary); }
    catch (e: any) { console.error(`[sync] Error on ${summary.invoice_id}:`, e.message); }
  }

  // Zoho-side unchanged doesn't mean payment-link-unchanged — see
  // syncStalePaymentLinks' own comment. Supabase-only, no Zoho calls.
  try { await syncStalePaymentLinks(skipped, alreadySynced); }
  catch (e: any) { console.error(`[sync] Stale payment link sync error:`, e.message); }

  // Also check for deletions in today's invoices — reuses the list we just
  // fetched above instead of asking Zoho for the same day all over again.
  try { await reconcileTodayDeletions(new Set(summaries.map((s: any) => s.invoice_id))); }
  catch (e: any) { console.error(`[sync] Today reconcile error:`, e.message); }

  // QR refresh sweep moved to its own mode=qr-sweep cron (see Deno.serve
  // below) — it's Razorpay-only, no Zoho calls, so it runs on its own tight
  // interval instead of being stretched out to whatever this sync's Zoho
  // API budget allows.

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
    } else if (mode === 'qr-sweep') {
      // Razorpay-only (no Zoho calls at all) — runs on its own tight cron,
      // independent of the Zoho sync interval, so QR refresh timing never
      // has to trade off against Zoho API consumption. See
      // supabase/migrations for the schedule.
      await sweepStaleQrCodes();
    } else {
      await syncInvoices();
    }
    return new Response(JSON.stringify({ ok: true, mode }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e: any) {
    console.error('[sync] Fatal:', e.message);
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});

// ── pg_cron schedules ──────────────────────────────────────────
// See supabase/migrations/100_sync_invoices_hourly_cron.sql — hourly, not
// every 3-5 min (that cadence hit Zoho's rate limit). Do not re-schedule a
// tighter interval here without updating that migration to match.
//
// Daily noon reconciliation:
// select cron.schedule('reconcile-invoices-daily-noon', '0 6 * * *', $$
//   select net.http_post(
//     url := 'https://fykqprogzqcfzrgwlrem.supabase.co/functions/v1/sync-invoices?mode=reconcile',
//     headers := '{"Authorization": "Bearer YOUR_ANON_KEY"}'::jsonb
//   );
// $$);
// Note: cron runs in UTC. 0 6 * * * = 11:30 AM IST
