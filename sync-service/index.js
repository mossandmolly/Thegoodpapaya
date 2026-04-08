/**
 * The Good Papaya — Zoho → Supabase sync service
 *
 * Runs every SYNC_INTERVAL_MINUTES (default 5).
 * For each modified Zoho invoice:
 *   1. Fetch line items
 *   2. Upsert rows into invoice_line_items
 *   3. If new invoice → create Razorpay payment link, save back
 */
require('dotenv').config();
const cron   = require('node-cron');
const zoho   = require('./zoho');
const rp     = require('./razorpay');
const db     = require('./supabase-client');

const LOOKBACK_MINUTES = parseInt(process.env.SYNC_LOOKBACK_MINUTES || '10', 10);
const INTERVAL         = parseInt(process.env.SYNC_INTERVAL_MINUTES  || '5',  10);

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function sinceTimestamp() {
  const d = new Date(Date.now() - LOOKBACK_MINUTES * 60 * 1000);
  // Zoho format: "YYYY-MM-DD HH:MM:SS"
  return d.toISOString().replace('T', ' ').substring(0, 19);
}

/**
 * Look up customer phone from our customers table.
 * Falls back to a default if not found (you'd fix the data in that case).
 */
async function resolvePhone(customerName) {
  const { data } = await db
    .from('customers')
    .select('phone_number')
    .eq('customer_name', customerName)
    .single();
  return data?.phone_number ?? null;
}

/**
 * Check whether a Razorpay payment link already exists for this invoice.
 */
async function existingPaymentLink(zohoInvoiceId) {
  const { data } = await db
    .from('invoice_line_items')
    .select('payment_link, payment_link_id')
    .eq('zoho_invoice_id', zohoInvoiceId)
    .not('payment_link', 'is', null)
    .limit(1)
    .single();
  return data ?? null;
}

// ──────────────────────────────────────────────────────────────
// Core sync function
// ──────────────────────────────────────────────────────────────

async function syncInvoices() {
  const since = sinceTimestamp();
  console.log(`[sync] Fetching invoices modified since ${since}`);

  let summaries;
  try {
    summaries = await zoho.fetchModifiedInvoices(since);
  } catch (err) {
    console.error('[sync] Failed to fetch invoices from Zoho:', err.message);
    return;
  }

  console.log(`[sync] ${summaries.length} invoice(s) to process`);

  for (const summary of summaries) {
    try {
      await processInvoice(summary);
    } catch (err) {
      console.error(`[sync] Error processing invoice ${summary.invoice_id}:`, err.message);
    }
  }

  console.log('[sync] Done.');
}

async function processInvoice(summary) {
  const detail = await zoho.fetchInvoiceDetail(summary.invoice_id);

  const customerName  = detail.customer_name;
  const phone         = await resolvePhone(customerName);
  const invoiceDate   = detail.date;          // "YYYY-MM-DD"
  const invoiceNumber = detail.invoice_number;
  const zohoInvoiceId = detail.invoice_id;
  const invoiceTotal  = parseFloat(detail.total);
  const pdfUrl        = await zoho.fetchInvoicePdfUrl(zohoInvoiceId);

  if (!phone) {
    console.warn(`[sync] No phone found for customer "${customerName}" — skipping`);
    return;
  }

  // ── 1. Get or create Razorpay link ──────────────────────────
  let paymentLink   = null;
  let paymentLinkId = null;
  const existing    = await existingPaymentLink(zohoInvoiceId);

  if (existing) {
    paymentLink   = existing.payment_link;
    paymentLinkId = existing.payment_link_id;
  } else if (detail.status !== 'paid' && invoiceTotal > 0) {
    try {
      const rpl = await rp.createPaymentLink({
        invoiceNumber,
        customerName,
        phone,
        amountInPaise: Math.round(invoiceTotal * 100),
      });
      paymentLink   = rpl.short_url;
      paymentLinkId = rpl.id;
      console.log(`[sync] Created Razorpay link for ${invoiceNumber}: ${paymentLink}`);
    } catch (err) {
      console.error(`[sync] Razorpay link creation failed for ${invoiceNumber}:`, err.message);
    }
  }

  // ── 2. Upsert one row per line item ──────────────────────────
  const rows = (detail.line_items || []).map(li => ({
    customer_name:   customerName,
    phone_number:    phone,
    invoice_date:    invoiceDate,
    invoice_number:  invoiceNumber,
    zoho_invoice_id: zohoInvoiceId,
    item_name:       li.name || li.item_name,
    item_quantity:   parseFloat(li.quantity),
    item_price:      parseFloat(li.rate),
    invoice_total:   invoiceTotal,
    payment_link:    paymentLink,
    payment_link_id: paymentLinkId,
    payment_status:  detail.status === 'paid' ? 'paid' : 'pending',
    pdf_url:         pdfUrl,
  }));

  if (rows.length === 0) {
    console.warn(`[sync] Invoice ${invoiceNumber} has no line items`);
    return;
  }

  const { error } = await db
    .from('invoice_line_items')
    .upsert(rows, { onConflict: 'zoho_invoice_id,item_name' });

  if (error) {
    throw new Error(`Supabase upsert failed: ${error.message}`);
  }

  console.log(`[sync] Upserted ${rows.length} row(s) for invoice ${invoiceNumber}`);
}

// ──────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────

// Run immediately on startup, then on schedule
syncInvoices();

const cronExpression = `*/${INTERVAL} * * * *`;
console.log(`[sync] Scheduling cron: ${cronExpression}`);
cron.schedule(cronExpression, syncInvoices);
