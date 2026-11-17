// check-stale-payments.js — run locally (never deployed) to find orders
// that are still sitting at balance_due > 0 even though the same house
// has paid a MORE RECENT order since then — almost always because the
// older one actually did get paid and nobody marked it. For each one
// flagged this way, this checks Zoho's own LIVE invoice balance (never
// trusts anything cached in Supabase) and only updates orders.balance_due/
// payment_collected for the ones Zoho itself confirms are paid.
//
// Dry run by default — prints exactly what it WOULD change, writes
// nothing. Pass --commit to actually apply the updates.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   ZOHO_CLIENT_ID=... ZOHO_CLIENT_SECRET=... ZOHO_REFRESH_TOKEN=... ZOHO_ORGANIZATION_ID=... \
//   node scripts/check-stale-payments.js            # dry run
//   ...same env vars... node scripts/check-stale-payments.js --commit
//
// Requires Node 18+ (built-in fetch). No npm install needed.

const COMMIT = process.argv.includes('--commit');
const CUTOFF_DATE = '2026-10-27'; // same Oct 27 window My Invoices/Phone Lookup use
const ZOHO_DELAY_MS = 400; // light pacing between Zoho calls — 432 invoices is a lot in one run

function env(key) {
  const v = process.env[key];
  if (!v) { console.error(`Missing required env var: ${key}`); process.exit(1); }
  return v;
}

const SUPABASE_URL = env('SUPABASE_URL');
const SERVICE_KEY = env('SUPABASE_SERVICE_ROLE_KEY');
const ZOHO_CLIENT_ID = env('ZOHO_CLIENT_ID');
const ZOHO_CLIENT_SECRET = env('ZOHO_CLIENT_SECRET');
const ZOHO_REFRESH_TOKEN = env('ZOHO_REFRESH_TOKEN');
const ZOHO_ORG_ID = process.env.ZOHO_ORGANIZATION_ID || process.env.ZOHO_ORG_ID;
if (!ZOHO_ORG_ID) { console.error('Missing required env var: ZOHO_ORGANIZATION_ID (or ZOHO_ORG_ID)'); process.exit(1); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sb(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Prefer: method === 'PATCH' ? 'return=minimal' : 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${method} ${path} failed (${res.status}): ${await res.text()}`);
  return method === 'PATCH' ? null : res.json();
}

async function getZohoToken() {
  const res = await fetch('https://accounts.zoho.in/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: ZOHO_CLIENT_ID,
      client_secret: ZOHO_CLIENT_SECRET,
      refresh_token: ZOHO_REFRESH_TOKEN,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Zoho OAuth failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function fetchZohoInvoice(invoiceId, token) {
  const res = await fetch(
    `https://www.zohoapis.in/books/v3/invoices/${invoiceId}?organization_id=${ZOHO_ORG_ID}`,
    { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
  );
  const data = await res.json();
  if (!res.ok || !data.invoice) throw new Error(data?.message || `Zoho fetch failed (${res.status})`);
  return data.invoice;
}

function normalizeKey(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function orderDateOf(salesOrderId) {
  return (salesOrderId || '').slice(0, 10); // sales_order_id always starts with YYYY-MM-DD
}

async function main() {
  console.log(COMMIT ? '*** LIVE RUN — will write to Supabase ***' : 'Dry run — no writes will happen (pass --commit to apply)');
  console.log('');

  // Same shape as the SQL used to identify these: invoiced, not cancelled,
  // dated on/after the Oct 27 cutoff.
  const orders = await sb(
    `orders?select=sales_order_id,customer_name,phone,balance_due,zoho_invoice_id,amount_paid` +
    `&zoho_invoice_id=not.is.null&status=neq.cancelled&order=sales_order_id.asc`,
  );
  const inWindow = orders.filter(o => orderDateOf(o.sales_order_id) >= CUTOFF_DATE);

  const byCust = new Map();
  for (const o of inWindow) {
    const key = normalizeKey(o.customer_name);
    if (!byCust.has(key)) byCust.set(key, []);
    byCust.get(key).push(o);
  }

  const flagged = [];
  for (const [, rows] of byCust) {
    const paidDates = rows.filter(o => (+o.balance_due || 0) <= 0).map(o => orderDateOf(o.sales_order_id));
    if (!paidDates.length) continue;
    const recentPaidDate = paidDates.reduce((a, b) => (b > a ? b : a));
    for (const o of rows) {
      if ((+o.balance_due || 0) > 0 && orderDateOf(o.sales_order_id) < recentPaidDate) {
        flagged.push(o);
      }
    }
  }

  // Houses with a phone first — you're more likely to recognize/trust
  // those results at a glance, and they're the ones a customer could
  // actually follow up with if something looks off. No-phone houses
  // follow after.
  flagged.sort((a, b) => {
    const aHasPhone = a.phone ? 0 : 1, bHasPhone = b.phone ? 0 : 1;
    if (aHasPhone !== bHasPhone) return aHasPhone - bHasPhone;
    return a.sales_order_id.localeCompare(b.sales_order_id);
  });

  console.log(`Found ${flagged.length} stale-pending invoices to check against Zoho.\n`);

  const token = await getZohoToken();

  let checked = 0, updatedPaid = 0, stillPending = 0, errored = 0;
  const updatedRows = [];
  const erroredRows = [];

  for (const o of flagged) {
    checked++;
    const label = `${o.sales_order_id} (${o.customer_name}${o.phone ? ', ' + o.phone : ', no phone'})`;
    try {
      const inv = await fetchZohoInvoice(o.zoho_invoice_id, token);
      const zohoBalance = parseFloat(inv.balance ?? '0');
      const zohoTotal = parseFloat(inv.total ?? '0');

      if (zohoBalance <= 0) {
        updatedPaid++;
        updatedRows.push(label);
        console.log(`✓ PAID in Zoho — ${label}`);
        if (COMMIT) {
          await sb(`orders?sales_order_id=eq.${encodeURIComponent(o.sales_order_id)}`, {
            method: 'PATCH',
            body: {
              balance_due: 0,
              payment_collected: true,
              payment_collected_method: 'online',
              payment_collected_at: new Date().toISOString(),
              amount_paid: zohoTotal,
            },
          });
        }
      } else {
        stillPending++;
        console.log(`  still pending (₹${zohoBalance.toFixed(2)} due in Zoho) — ${label}`);
      }
    } catch (e) {
      errored++;
      erroredRows.push(`${label} — ${e.message}`);
      console.log(`✗ Could not check — ${label} — ${e.message}`);
    }
    await sleep(ZOHO_DELAY_MS);
  }

  console.log('\n──────── Summary ────────');
  console.log(`Checked:                ${checked}`);
  console.log(`Updated to paid:        ${updatedPaid}${COMMIT ? '' : '  (dry run — nothing actually written; re-run with --commit to apply)'}`);
  console.log(`Still pending in Zoho:  ${stillPending}`);
  console.log(`Could not verify:       ${errored}`);
  if (erroredRows.length) {
    console.log('\nCould not verify (check these manually — often a stale/deleted zoho_invoice_id, same as the regenerate-invoice case):');
    erroredRows.forEach(r => console.log('  - ' + r));
  }
}

main().catch(e => { console.error('Fatal error:', e.message); process.exit(1); });
