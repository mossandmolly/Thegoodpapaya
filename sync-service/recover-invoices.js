/**
 * recover-invoices.js — emergency invoice + payment-link recovery
 *
 * Rebuilds Zoho Books invoices + Razorpay payment links directly from a
 * CSV snapshot (orders.csv + order_items.csv + catalog.csv, as produced by
 * the ops-dashboard's hourly export-csv Edge Function, all from the same
 * timestamped run) — for use when the ops-dashboard or the Supabase
 * orders/order_items tables are unavailable or being restored, but Zoho
 * Books and Razorpay themselves are reachable and the CSVs are the last
 * known good state of what still needs invoicing.
 *
 * Eligibility (mirrors the ops-dashboard's own invoicing gate):
 *   - sales_order_id's 10-character date prefix (format is
 *     YYYY-MM-DD-CustomerName[-N]) matches --date (default: today)
 *   - every non-cancelled order_items row for that order has status='final'
 *   - the order does not already have a zoho_invoice_id / invoice_status
 *     'done' in orders.csv — this script only CREATES new invoices, it
 *     never regenerates/replaces an existing one (that needs the
 *     unapply-payment/delete/recreate dance the live generate-invoice
 *     function does, which isn't something to run unattended mid-recovery)
 *
 * Every non-free-text item's rate comes from catalog.csv (case-insensitive
 * item_name match), same as generate-invoice. Items whose description
 * contains "replacement"/"free"/"free sample" are billed at ₹0. If any
 * non-free item on an order has no catalog match, the whole order is
 * skipped (logged, not partially invoiced) — resolve the catalog and
 * re-run.
 *
 * Safety: DRY RUN BY DEFAULT. Without --live this only computes what it
 * would do and writes a recovery-plan-<stamp>.json for you to review —
 * it never calls Zoho or Razorpay. Pass --live to actually create
 * invoices and payment links.
 *
 * Output (only in --live mode):
 *   - orders-recovered-<stamp>.csv   next to --orders: a full copy of the
 *     input with zoho_invoice_id/invoice_number/invoice_total/
 *     invoice_status/razorpay_link_id/razorpay_url filled in for every
 *     order this run successfully invoiced. This is NOT written back to
 *     Supabase — once the DB is back up, reconcile it against this file.
 *   - recovery-log-<stamp>.json      next to --orders: invoiced/skipped/
 *     errored orders with reasons.
 *
 * ONE-TIME SETUP (do this today, not mid-emergency): put a file named
 * ".env" next to this script (same folder) with these lines filled in —
 * see .env.example in this same folder for the full list:
 *   ZOHO_CLIENT_ID=...
 *   ZOHO_CLIENT_SECRET=...
 *   ZOHO_REFRESH_TOKEN=...
 *   ZOHO_ORGANIZATION_ID=...
 *   ZOHO_BASE_URL=https://www.zohoapis.in/books/v3
 *   RAZORPAY_KEY_ID=...
 *   RAZORPAY_KEY_SECRET=...
 *   SUPABASE_URL=...                 (only needed for auto-fetch mode)
 *   SUPABASE_SERVICE_ROLE_KEY=...    (only needed for auto-fetch mode)
 * That's it — no `npm install` (this file has zero dependencies, just
 * plain Node), and the .env is found next to the script regardless of
 * which directory you run the command from.
 *
 * EMERGENCY USE (the only part that matters when it's actually urgent) —
 * one line, run from anywhere, using the CSVs you already have on disk:
 *
 *   node /path/to/recover-invoices.js --orders orders.csv --items order_items.csv --catalog catalog.csv
 *
 * That's a dry run for today's date — it prints what it would invoice and
 * writes a recovery-plan-<stamp>.json next to your orders.csv, no Zoho/
 * Razorpay calls made. Once it looks right, add --live to actually create
 * the invoices + payment links:
 *
 *   node /path/to/recover-invoices.js --orders orders.csv --items order_items.csv --catalog catalog.csv --live
 *
 * Don't have the CSVs yet? Omit --orders/--items/--catalog entirely and it
 * auto-downloads the latest ones from the exports Storage bucket instead
 * (needs SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY in .env):
 *
 *   node /path/to/recover-invoices.js --live
 *
 * Add --date 2026-07-14 to target a day other than today.
 */
const fs   = require('fs');
const path = require('path');

// ── Load .env from next to THIS script (not the current directory) so it
// works no matter where you run the command from — no `cd` needed, and no
// dotenv dependency to install. Real environment variables, if already
// exported, always win over the file. ─────────────────────────────────────
(function loadDotEnvNextToScript() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
})();

// ── Minimal Zoho Books + Razorpay calls, inlined with plain fetch (built
// into Node 18+) instead of pulling in zoho.js/razorpay.js — those require
// axios, which would mean an `npm install` before this script can even
// run. Duplicated logic on purpose: this file must work standalone. ──────
function env(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Missing ${key} — fill it into the .env next to this script`);
  return val;
}

async function zohoAccessToken() {
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

function zohoUrl(path_) {
  const sep = path_.includes('?') ? '&' : '?';
  return `${env('ZOHO_BASE_URL')}${path_}${sep}organization_id=${env('ZOHO_ORGANIZATION_ID')}`;
}

function canonicalKey(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function getOrCreateContact(name, phone, token) {
  const search = await fetch(zohoUrl(`/contacts?contact_name=${encodeURIComponent(name)}`), {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  const sd = await search.json();
  const targetKey = canonicalKey(name);
  const existing = (sd.contacts || []).find(c => canonicalKey(c.contact_name) === targetKey);
  if (existing) return existing.contact_id;

  const body = { contact_name: name, contact_type: 'customer' };
  if (phone) body.contact_persons = [{ phone }];
  const create = await fetch(zohoUrl('/contacts'), {
    method: 'POST',
    headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const cd = await create.json();
  if (cd.code !== 0) throw new Error(`Zoho create contact failed: ${cd.message}`);
  return cd.contact.contact_id;
}

async function createZohoInvoice(contactId, salesOrderId, date, lineItems, token) {
  const body = {
    customer_id:      contactId,
    reference_number: salesOrderId,
    date,
    line_items: lineItems.map(i => ({
      name:        i.name,
      description: i.description || '',
      quantity:    i.qty,
      rate:        i.rate,
      custom_fields: [{ api_name: 'cf_requested_quantity', value: i.requestedQty }],
    })),
  };
  const res = await fetch(zohoUrl('/invoices'), {
    method: 'POST',
    headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Zoho create invoice failed: ${data.message}`);
  const inv = data.invoice;
  return { invoice_id: inv.invoice_id, invoice_number: inv.invoice_number, invoice_total: parseFloat(inv.total ?? '0') };
}

async function createPaymentLink(amountPaise, customerName, phone, salesOrderId) {
  const auth = Buffer.from(`${env('RAZORPAY_KEY_ID')}:${env('RAZORPAY_KEY_SECRET')}`).toString('base64');
  const res = await fetch('https://api.razorpay.com/v1/payment_links', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: amountPaise,
      currency: 'INR',
      description: `The Good Papaya — order ${salesOrderId}`,
      customer: { name: customerName, contact: phone },
      notify: { sms: true, email: false },
      reminder_enable: false,
      notes: { sales_order_id: salesOrderId, source: 'recovery-script' },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.description || 'Razorpay error');
  return { id: data.id, short_url: data.short_url };
}

// ── tiny CSV parser/writer — matches export-csv's escaping (quote fields
// containing a comma/quote/newline, double up embedded quotes) ───────────
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip, \n follows */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0];
  return rows.slice(1)
    .filter(r => r.length > 1 || r[0] !== '')
    .map(r => Object.fromEntries(headers.map((h, idx) => [h, r[idx] ?? ''])));
}

function stringifyCsv(rows, headers) {
  const esc = v => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map(h => esc(r[h])).join(','));
  return lines.join('\n');
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { live: false, date: new Date().toISOString().slice(0, 10) };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--orders') out.orders = args[++i];
    else if (a === '--items') out.items = args[++i];
    else if (a === '--catalog') out.catalog = args[++i];
    else if (a === '--date') out.date = args[++i];
    else if (a === '--live') out.live = true;
    else throw new Error(`Unknown arg: ${a}`);
  }
  // Partial manual overrides aren't supported — either give all three paths
  // yourself, or none and let auto-fetch grab all three together.
  const manualCount = [out.orders, out.items, out.catalog].filter(Boolean).length;
  if (manualCount !== 0 && manualCount !== 3) {
    throw new Error('Pass all three of --orders/--items/--catalog, or none to auto-fetch the latest.');
  }
  return out;
}

// ── Easy mode: pull the latest exports/orders/{orders,order_items,catalog}
// CSVs straight from Storage instead of making you find/download them ─────
async function fetchLatestExports() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'No --orders/--items/--catalog given, and SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ' +
      'aren\'t set for auto-fetch — either fill those into .env, or pass all three CSV paths manually.'
    );
  }

  const listRes = await fetch(`${url}/storage/v1/object/list/exports`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: 'orders/', limit: 1000, sortBy: { column: 'name', order: 'desc' } }),
  });
  if (!listRes.ok) throw new Error(`Storage list failed: ${listRes.status} ${await listRes.text()}`);
  const files = await listRes.json();

  const latestOf = prefix => {
    // Filenames are "<prefix>-<ISO-timestamp-with-dashes>.csv" — sorts
    // correctly as plain strings, so the first match after a desc sort is
    // the newest without needing to parse anything.
    const match = files.find(f => f.name.startsWith(`${prefix}-`));
    if (!match) throw new Error(`No ${prefix}-*.csv found in exports/orders/ — has export-csv run since it started producing catalog CSVs?`);
    return match.name;
  };

  const cacheDir = path.join(__dirname, 'exports-cache');
  fs.mkdirSync(cacheDir, { recursive: true });

  const download = async name => {
    const res = await fetch(`${url}/storage/v1/object/exports/orders/${name}`, {
      headers: { Authorization: `Bearer ${key}`, apikey: key },
    });
    if (!res.ok) throw new Error(`Download failed for ${name}: ${res.status}`);
    const dest = path.join(cacheDir, name);
    fs.writeFileSync(dest, await res.text());
    return dest;
  };

  const [orders, items, catalog] = await Promise.all([
    download(latestOf('orders')),
    download(latestOf('order_items')),
    download(latestOf('catalog')),
  ]);
  console.log(`[recover] auto-fetched latest exports into ${cacheDir}`);
  return { orders, items, catalog };
}

const FREE_ITEM_RE = /\b(replacement|free sample|free)\b/i;

function normalisePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return '+91' + digits;
  if (digits.length === 12 && digits.startsWith('91')) return '+' + digits;
  return null;
}

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

// ── Build the eligible-order plan from the three CSVs (no network calls) ──
function buildPlan(orders, items, catalog, date) {
  const ordersById = new Map(orders.map(o => [o.sales_order_id, o]));
  const itemsByOrder = new Map();
  for (const it of items) {
    if (!it.sales_order_id) continue;
    if (!itemsByOrder.has(it.sales_order_id)) itemsByOrder.set(it.sales_order_id, []);
    itemsByOrder.get(it.sales_order_id).push(it);
  }
  const rateByLowerName = new Map(
    catalog.map(c => [c.item_name.toLowerCase(), parseFloat(c.unit_price || '0')])
  );

  const eligible = [];
  const skipped = [];

  for (const [soid, orderItems] of itemsByOrder) {
    if (soid.slice(0, 10) !== date) continue;
    const order = ordersById.get(soid);
    if (!order) { skipped.push({ sales_order_id: soid, reason: 'No matching row in orders.csv' }); continue; }
    if (order.zoho_invoice_id || order.invoice_status === 'done') {
      skipped.push({ sales_order_id: soid, reason: 'Already invoiced (zoho_invoice_id/invoice_status=done present)' });
      continue;
    }
    if (order.status === 'cancelled' || order.invoice_status === 'cancelled') {
      skipped.push({ sales_order_id: soid, reason: 'Order is cancelled' });
      continue;
    }

    const active = orderItems.filter(i => i.status !== 'cancelled');
    if (!active.length) { skipped.push({ sales_order_id: soid, reason: 'No active (non-cancelled) items' }); continue; }
    const notFinal = active.filter(i => i.status !== 'final');
    if (notFinal.length) {
      skipped.push({
        sales_order_id: soid,
        reason: `Not all items final: ${notFinal.map(i => `${i.item_name} (${i.status})`).join(', ')}`,
      });
      continue;
    }
    const missingQty = active.filter(i => i.final_quantity === '' || i.final_quantity == null);
    if (missingQty.length) {
      skipped.push({ sales_order_id: soid, reason: `Missing final_quantity: ${missingQty.map(i => i.item_name).join(', ')}` });
      continue;
    }

    const freeItems = [];
    const unresolved = [];
    const lineItems = [];
    for (const i of active) {
      const isFree = FREE_ITEM_RE.test(i.description || '');
      if (isFree) {
        freeItems.push(i.item_name);
        lineItems.push({ name: i.item_name, requestedQty: parseFloat(i.requested_quantity || '0'), qty: parseFloat(i.final_quantity), rate: 0, description: i.description || undefined });
        continue;
      }
      const rate = rateByLowerName.get(i.item_name.toLowerCase());
      if (rate === undefined) { unresolved.push(i.item_name); continue; }
      lineItems.push({ name: i.item_name, requestedQty: parseFloat(i.requested_quantity || '0'), qty: parseFloat(i.final_quantity), rate, description: i.description || undefined });
    }
    if (unresolved.length) {
      skipped.push({ sales_order_id: soid, reason: `No catalog rate for: ${unresolved.join(', ')}` });
      continue;
    }

    eligible.push({
      sales_order_id: soid,
      customer_name:  order.customer_name,
      phone:          normalisePhone(order.phone),
      line_items:     lineItems,
      free_items:     freeItems,
    });
  }

  return { eligible, skipped };
}

async function main() {
  const parsed = parseArgs();
  const { date, live } = parsed;
  const { orders: ordersPath, items: itemsPath, catalog: catalogPath } =
    parsed.orders ? parsed : await fetchLatestExports();

  const dir = path.dirname(path.resolve(ordersPath));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const orders  = parseCsv(fs.readFileSync(ordersPath, 'utf8'));
  const items   = parseCsv(fs.readFileSync(itemsPath, 'utf8'));
  const catalog = parseCsv(fs.readFileSync(catalogPath, 'utf8'));

  const { eligible, skipped } = buildPlan(orders, items, catalog, date);

  console.log(`\n[recover] date=${date}  eligible=${eligible.length}  skipped=${skipped.length}  live=${live}\n`);

  if (!live) {
    const planPath = path.join(dir, `recovery-plan-${stamp}.json`);
    fs.writeFileSync(planPath, JSON.stringify({ date, eligible, skipped }, null, 2));
    console.log(`Dry run only — no Zoho/Razorpay calls made. Review the plan:\n  ${planPath}`);
    console.log(`\nRe-run with --live once it looks right to actually create invoices + payment links.`);
    for (const e of eligible) console.log(`  would invoice: ${e.sales_order_id} (${e.line_items.length} items${e.free_items.length ? `, ${e.free_items.length} free` : ''})`);
    for (const s of skipped) console.log(`  skip: ${s.sales_order_id} — ${s.reason}`);
    return;
  }

  const invoiced = [];
  const errors = [];
  const zohoToken = await zohoAccessToken();

  for (const order of eligible) {
    try {
      const contactId = await getOrCreateContact(order.customer_name, order.phone, zohoToken);
      const invoice = await createZohoInvoice(contactId, order.sales_order_id, date, order.line_items, zohoToken);

      let paymentLink = null, paymentLinkId = null;
      if (order.phone) {
        try {
          const link = await createPaymentLink(
            Math.round(invoice.invoice_total * 100), order.customer_name, order.phone, order.sales_order_id,
          );
          paymentLink = link.short_url;
          paymentLinkId = link.id;
        } catch (linkErr) {
          console.warn(`[recover] Payment link failed for ${order.sales_order_id}: ${linkErr.message}`);
        }
      }

      invoiced.push({ ...order, ...invoice, razorpay_link_id: paymentLinkId, razorpay_url: paymentLink });
      console.log(`[recover] invoiced ${order.sales_order_id} -> ${invoice.invoice_number} (₹${invoice.invoice_total})${paymentLink ? ' + payment link' : ''}`);
    } catch (err) {
      errors.push({ sales_order_id: order.sales_order_id, error: err.message });
      console.error(`[recover] FAILED ${order.sales_order_id}: ${err.message}`);
    }
    await sleep(300); // Zoho rate-limit courtesy delay
  }

  const invoicedById = new Map(invoiced.map(i => [i.sales_order_id, i]));
  const extraCols = ['zoho_invoice_id', 'invoice_number', 'invoice_total', 'invoice_status', 'invoice_date', 'razorpay_link_id', 'razorpay_url'];
  const headers = orders.length ? [...new Set([...Object.keys(orders[0]), ...extraCols])] : extraCols;
  const updatedOrders = orders.map(o => {
    const hit = invoicedById.get(o.sales_order_id);
    if (!hit) return o;
    return {
      ...o,
      zoho_invoice_id:  hit.invoice_id,
      invoice_number:   hit.invoice_number,
      invoice_total:    hit.invoice_total,
      invoice_status:   'done',
      invoice_date:     o.invoice_date || date,
      razorpay_link_id: hit.razorpay_link_id || o.razorpay_link_id,
      razorpay_url:     hit.razorpay_url || o.razorpay_url,
    };
  });

  const outOrdersPath = path.join(dir, `orders-recovered-${stamp}.csv`);
  fs.writeFileSync(outOrdersPath, stringifyCsv(updatedOrders, headers));
  const logPath = path.join(dir, `recovery-log-${stamp}.json`);
  fs.writeFileSync(logPath, JSON.stringify({ date, invoiced, skipped, errors }, null, 2));

  console.log(`\nDone. invoiced=${invoiced.length} skipped=${skipped.length} errors=${errors.length}`);
  console.log(`  ${outOrdersPath}`);
  console.log(`  ${logPath}`);
  console.log(`\nThis was NOT written back to Supabase — reconcile the DB against orders-recovered-${stamp}.csv once it's back up.`);
}

main().catch(err => {
  console.error('[recover] Fatal:', err.message);
  process.exit(1);
});
