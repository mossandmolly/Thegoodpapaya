/**
 * The Good Papaya — Invoices page JS
 *
 * Features:
 *  - Phone + OTP login (Supabase Auth)
 *  - Shows 5 invoices at a time, grouped by invoice number
 *  - "Load more" / "Show previous" navigation
 *  - Razorpay Pay Now + PDF link per invoice
 */

(function () {
  'use strict';

  const PAGE_SIZE = 5;

  // ── Supabase client ──────────────────────────────────────────
  const { createClient } = supabase;
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON);

  // ── DOM refs ─────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const authSection     = $('auth-section');
  const invoicesSection = $('invoices-section');
  const loadingSection  = $('loading-section');
  const stepPhone       = $('step-phone');
  const stepOtp         = $('step-otp');
  const phoneInput      = $('phone-input');
  const otpInput        = $('otp-input');
  const sendOtpBtn      = $('send-otp-btn');
  const verifyBtn       = $('verify-otp-btn');
  const backBtn         = $('back-btn');
  const phoneError      = $('phone-error');
  const otpError        = $('otp-error');
  const otpHint         = $('otp-hint');
  const invoiceList     = $('invoices-list');
  const logoutBtn       = $('logout-btn');
  const welcomeName     = $('welcome-name');
  const paginationWrap  = $('pagination');
  const toast           = $('toast');

  let pendingPhone    = '';
  let allInvoices     = [];   // array of grouped invoice objects
  let currentPage     = 0;   // 0-based page index

  // ── Toast ────────────────────────────────────────────────────
  function showToast(msg, ms = 3500) {
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), ms);
  }

  // ── Init ────────────────────────────────────────────────────
  async function init() {
    const { data: { session } } = await sb.auth.getSession();
    loadingSection.style.display = 'none';
    if (session) {
      await showInvoices(session);
    } else {
      authSection.style.display = 'flex';
    }

    const params = new URLSearchParams(window.location.search);
    if (params.get('payment') === 'success') {
      showToast('Payment received! Your invoice will update shortly.');
    }
  }

  // ── OTP flow ─────────────────────────────────────────────────
  sendOtpBtn.addEventListener('click', async () => {
    phoneError.textContent = '';
    const raw   = phoneInput.value.trim();
    const phone = raw.startsWith('+') ? raw : '+91' + raw.replace(/\D/g, '');
    if (phone.replace(/\D/g, '').length < 10) {
      phoneError.textContent = 'Please enter a valid mobile number.';
      return;
    }
    sendOtpBtn.disabled = true;
    sendOtpBtn.textContent = 'Sending…';
    const { error } = await sb.auth.signInWithOtp({ phone });
    sendOtpBtn.disabled = false;
    sendOtpBtn.textContent = 'Send OTP';
    if (error) { phoneError.textContent = error.message; return; }
    pendingPhone = phone;
    otpHint.textContent = `OTP sent to ${phone}`;
    stepPhone.style.display = 'none';
    stepOtp.style.display   = 'block';
    otpInput.focus();
  });

  phoneInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendOtpBtn.click(); });
  otpInput.addEventListener('keydown',   e => { if (e.key === 'Enter') verifyBtn.click();  });

  verifyBtn.addEventListener('click', async () => {
    otpError.textContent = '';
    const token = otpInput.value.trim();
    if (token.length < 6) { otpError.textContent = 'Enter the 6-digit OTP.'; return; }
    verifyBtn.disabled = true;
    verifyBtn.textContent = 'Verifying…';
    const { data, error } = await sb.auth.verifyOtp({ phone: pendingPhone, token, type: 'sms' });
    verifyBtn.disabled = false;
    verifyBtn.textContent = 'Verify & Continue';
    if (error) { otpError.textContent = error.message; return; }
    authSection.style.display = 'none';
    await showInvoices(data.session);
  });

  backBtn.addEventListener('click', () => {
    stepOtp.style.display   = 'none';
    stepPhone.style.display = 'block';
    otpInput.value = '';
  });

  logoutBtn.addEventListener('click', async () => {
    await sb.auth.signOut();
    allInvoices = [];
    currentPage = 0;
    invoicesSection.style.display = 'none';
    stepOtp.style.display   = 'none';
    stepPhone.style.display = 'block';
    phoneInput.value = '';
    authSection.style.display = 'flex';
  });

  // ── Load all rows, group by invoice ──────────────────────────
  async function showInvoices(session) {
    invoicesSection.style.display = 'block';
    invoiceList.innerHTML = skeletonHtml();
    paginationWrap.innerHTML = '';

    const phone = session.user.phone;

    const { data: rows, error } = await sb
      .from('invoice_line_items')
      .select('*')
      .eq('phone_number', phone)
      .order('invoice_date', { ascending: false })
      .order('invoice_number', { ascending: false });

    if (error) {
      invoiceList.innerHTML = `<p class="error-msg">Failed to load invoices: ${esc(error.message)}</p>`;
      return;
    }

    if (!rows || rows.length === 0) {
      invoiceList.innerHTML = emptyStateHtml();
      return;
    }

    // Resolve customer name for greeting
    if (welcomeName && rows[0].customer_name) {
      welcomeName.textContent = rows[0].customer_name;
    }

    allInvoices = groupByInvoice(rows);
    currentPage = 0;
    renderPage();
  }

  // ── Group flat rows → array of invoice objects ───────────────
  function groupByInvoice(rows) {
    const map = new Map();
    for (const row of rows) {
      if (!map.has(row.invoice_number)) {
        map.set(row.invoice_number, {
          invoice_number: row.invoice_number,
          invoice_date:   row.invoice_date,
          invoice_total:  row.invoice_total,
          payment_status: row.payment_status,
          payment_link:   row.payment_link,
          pdf_url:        row.pdf_url,
          items:          [],
        });
      }
      map.get(row.invoice_number).items.push(row);
    }
    return Array.from(map.values());
  }

  // ── Render current page ───────────────────────────────────────
  function renderPage() {
    const start   = currentPage * PAGE_SIZE;
    const end     = start + PAGE_SIZE;
    const page    = allInvoices.slice(start, end);
    const total   = allInvoices.length;
    const hasPrev = currentPage > 0;
    const hasNext = end < total;

    // Cards
    invoiceList.innerHTML = page.map(renderInvoiceCard).join('');

    // Pagination
    const from = start + 1;
    const to   = Math.min(end, total);

    paginationWrap.innerHTML = `
      <div class="pagination-inner">
        <span class="pagination-count">${from}–${to} of ${total} invoice${total !== 1 ? 's' : ''}</span>
        <div class="pagination-btns">
          <button class="btn btn-outline btn-sm" id="prev-page" ${hasPrev ? '' : 'disabled'}>&#8592; Newer</button>
          <button class="btn btn-outline btn-sm" id="next-page" ${hasNext ? '' : 'disabled'}>Older &#8594;</button>
        </div>
      </div>`;

    if (hasPrev) {
      $('prev-page').addEventListener('click', () => { currentPage--; renderPage(); window.scrollTo(0, 0); });
    }
    if (hasNext) {
      $('next-page').addEventListener('click', () => { currentPage++; renderPage(); window.scrollTo(0, 0); });
    }
  }

  // ── Render one invoice card ───────────────────────────────────
  function renderInvoiceCard(inv) {
    const dateStr  = new Date(inv.invoice_date + 'T00:00:00')
      .toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    const badgeCls = inv.payment_status === 'paid' ? 'badge-paid' : 'badge-pending';
    const badgeTxt = inv.payment_status === 'paid' ? 'Paid' : 'Due';
    const totalFmt = '₹' + Number(inv.invoice_total).toLocaleString('en-IN', { minimumFractionDigits: 2 });

    const payBtn = (inv.payment_status !== 'paid' && inv.payment_link)
      ? `<a href="${esc(inv.payment_link)}" target="_blank" rel="noopener" class="btn btn-primary btn-sm">Pay now</a>`
      : '';

    const pdfBtn = inv.pdf_url
      ? `<a href="${esc(inv.pdf_url)}" target="_blank" rel="noopener" class="btn btn-ghost btn-sm">
           <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:3px"><path d="M12 10v6m0 0l-3-3m3 3l3-3M3 17V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>PDF
         </a>`
      : '';

    const itemRows = inv.items.map(it => {
      const lineTotal = (it.item_quantity * it.item_price).toLocaleString('en-IN', { minimumFractionDigits: 2 });
      return `<tr>
        <td>${esc(it.item_name)}</td>
        <td class="text-right num">${Number(it.item_quantity).toLocaleString('en-IN')}</td>
        <td class="text-right num">₹${Number(it.item_price).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
        <td class="text-right num">₹${lineTotal}</td>
      </tr>`;
    }).join('');

    return `
      <div class="invoice-card card">
        <div class="invoice-card-header">
          <div class="invoice-meta">
            <span class="invoice-number">${esc(inv.invoice_number)}</span>
            <span class="invoice-date">${dateStr}</span>
          </div>
          <div class="invoice-actions">
            <span class="badge ${badgeCls}">${badgeTxt}</span>
            <span class="invoice-total">${totalFmt}</span>
            ${payBtn}
            ${pdfBtn}
          </div>
        </div>
        <div class="items-wrap">
          <table class="items-table">
            <thead>
              <tr>
                <th>Item</th>
                <th class="text-right">Qty</th>
                <th class="text-right">Rate</th>
                <th class="text-right">Amount</th>
              </tr>
            </thead>
            <tbody>${itemRows}</tbody>
          </table>
          <div class="invoice-total-row">
            <span>Total</span>
            <span>${totalFmt}</span>
          </div>
        </div>
      </div>`;
  }

  // ── Helpers ──────────────────────────────────────────────────
  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function skeletonHtml() {
    return Array.from({ length: 3 }, () => `
      <div class="card invoice-card">
        <div class="skeleton" style="width:35%;margin-bottom:.8rem"></div>
        <div class="skeleton" style="width:60%"></div>
        <div class="skeleton" style="width:45%;margin-top:.4rem"></div>
      </div>`).join('');
  }

  function emptyStateHtml() {
    return `
      <div class="empty-state">
        <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
          <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
        </svg>
        <p>No invoices found for your number.</p>
        <p style="font-size:.8rem;margin-top:.25rem">Orders placed on WhatsApp will appear here once invoiced.</p>
      </div>`;
  }

  init();
})();
