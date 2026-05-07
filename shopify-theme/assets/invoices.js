/**
 * The Good Papaya — Invoices page JS
 *
 * Auth mode: PHONE-ONLY (no OTP) — user enters mobile number, invoices load.
 * OTP mode:  Commented out below. Re-enable once Twilio DLT is approved:
 *            1. Uncomment the OTP section in this file
 *            2. Swap fetchInvoices() to use sb.auth session instead of raw phone
 *            3. Update the template to show the OTP step div
 */

(function () {
  'use strict';

  const PAGE_SIZE = 5;

  // ── Supabase client (anon key — safe, RPCs are security definer) ─
  const { createClient } = supabase;
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON);

  // ── DOM refs ─────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const authSection     = $('auth-section');
  const invoicesSection = $('invoices-section');
  const loadingSection  = $('loading-section');
  const phoneInput      = $('phone-input');
  const viewBtn         = $('view-btn');
  const phoneError      = $('phone-error');
  const invoiceList     = $('invoices-list');
  const logoutBtn       = $('logout-btn');
  const welcomeName     = $('welcome-name');
  const paginationWrap  = $('pagination');
  const toast           = $('toast');

  let allInvoices  = [];
  let allOrders    = [];
  let currentPage  = 0;
  let activePhone  = '';

  // ── Toast ─────────────────────────────────────────────────────────
  function showToast(msg, ms = 3500) {
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), ms);
  }

  // ── Init ──────────────────────────────────────────────────────────
  function init() {
    loadingSection.style.display = 'none';

    // Restore session from localStorage (so user doesn't re-enter on refresh)
    const saved = localStorage.getItem('tgp_phone');
    if (saved) {
      activePhone = saved;
      loadInvoices(saved);
    } else {
      authSection.style.display = 'flex';
    }

    const params = new URLSearchParams(window.location.search);
    if (params.get('payment') === 'success') {
      showToast('Payment received! Your invoice will update shortly.');
    }
  }

  // ── Phone entry ───────────────────────────────────────────────────
  viewBtn.addEventListener('click', handlePhoneSubmit);
  phoneInput.addEventListener('keydown', e => { if (e.key === 'Enter') handlePhoneSubmit(); });

  function handlePhoneSubmit() {
    phoneError.textContent = '';
    const raw   = phoneInput.value.trim();
    const phone = normalisePhone(raw);
    if (!phone) {
      phoneError.textContent = 'Please enter a valid 10-digit mobile number.';
      return;
    }
    activePhone = phone;
    localStorage.setItem('tgp_phone', phone);
    authSection.style.display = 'none';
    loadInvoices(phone);
  }

  // ── Sign out ──────────────────────────────────────────────────────
  logoutBtn.addEventListener('click', () => {
    localStorage.removeItem('tgp_phone');
    activePhone = '';
    allInvoices = [];
    currentPage = 0;
    invoicesSection.style.display = 'none';
    phoneInput.value = '';
    authSection.style.display = 'flex';
  });

  // ── Fetch & render ────────────────────────────────────────────────
  async function loadInvoices(phone) {
    invoicesSection.style.display = 'block';
    invoiceList.innerHTML = skeletonHtml();
    paginationWrap.innerHTML = '';

    const [ordersRes, invoicesRes] = await Promise.all([
      sb.rpc('get_orders_by_phone',  { p_phone: phone }),
      sb.rpc('get_invoices_by_phone', { p_phone: phone }),
    ]);

    const hasOrders   = ordersRes.data?.length   > 0;
    const hasInvoices = invoicesRes.data?.length  > 0;

    if (!hasOrders && !hasInvoices) {
      invoiceList.innerHTML = emptyStateHtml();
      return;
    }

    if (welcomeName) {
      const name = ordersRes.data?.[0]?.contact_name || invoicesRes.data?.[0]?.customer_name || '';
      welcomeName.textContent = name;
    }

    allOrders   = ordersRes.data  || [];
    allInvoices = groupByInvoice(invoicesRes.data || []);
    currentPage = 0;
    renderAll();
  }

  function renderAll() {
    let html = '';

    if (allOrders.length) {
      html += `<div style="font-size:.72rem;font-weight:800;text-transform:uppercase;
        letter-spacing:.07em;color:var(--muted);margin:1rem 0 .65rem">Your Orders</div>`;
      html += allOrders.map(renderOrderCard).join('');
    }

    if (allInvoices.length) {
      html += `<div style="font-size:.72rem;font-weight:800;text-transform:uppercase;
        letter-spacing:.07em;color:var(--muted);margin:1.5rem 0 .65rem">Subscription Invoices</div>`;
      const start = currentPage * PAGE_SIZE;
      const page  = allInvoices.slice(start, start + PAGE_SIZE);
      html += page.map(renderInvoiceCard).join('');
    }

    invoiceList.innerHTML = html;

    if (allInvoices.length > PAGE_SIZE) {
      const total = allInvoices.length;
      const start = currentPage * PAGE_SIZE;
      const end   = Math.min(start + PAGE_SIZE, total);
      paginationWrap.innerHTML = `
        <div class="pagination-inner">
          <span class="pagination-count">${start+1}–${end} of ${total}</span>
          <div class="pagination-btns">
            <button class="btn btn-outline btn-sm" id="prev-page" ${currentPage>0?'':'disabled'}>← Newer</button>
            <button class="btn btn-outline btn-sm" id="next-page" ${end<total?'':'disabled'}>Older →</button>
          </div>
        </div>`;
      if (currentPage > 0) $('prev-page').addEventListener('click', () => { currentPage--; renderAll(); window.scrollTo(0,0); });
      if (end < total)     $('next-page').addEventListener('click', () => { currentPage++; renderAll(); window.scrollTo(0,0); });
    } else {
      paginationWrap.innerHTML = '';
    }
  }

  function renderOrderCard(order) {
    const dateStr = new Date(order.created_at)
      .toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    const statusMap = {
      placed:           ['badge-pending', 'Placed'],
      awaiting_payment: ['badge-pending', 'Awaiting payment'],
      paid:             ['badge-paid',    'Paid'],
      delivered:        ['badge-paid',    'Delivered'],
      cancelled:        ['badge-pending', 'Cancelled'],
    };
    const [badgeCls, badgeTxt] = statusMap[order.status] || ['badge-pending', order.status];
    const methodLabel = order.payment_method === 'cod' ? 'Cash on Delivery' : 'Online';

    function fmtQty(item) {
      if (item.mode === 'weight') {
        const w = parseFloat(item.quantity);
        return w >= 1 ? `${w} kg` : `${Math.round(w * 1000)}g`;
      }
      return String(item.quantity);
    }

    const itemRows = (order.cart || []).map(i => {
      const line = (parseFloat(i.price) * parseFloat(i.quantity)).toFixed(0);
      const desc = i.pills?.length
        ? `<div style="font-size:.75rem;color:var(--muted)">${esc(i.pills.join(', '))}</div>` : '';
      return `<tr>
        <td>${esc(i.title)}${desc}</td>
        <td class="text-right num">${esc(fmtQty(i))}</td>
        <td class="text-right num">₹${line}</td>
      </tr>`;
    }).join('');

    return `
      <div class="invoice-card card">
        <div class="invoice-card-header">
          <div class="invoice-meta">
            <span class="invoice-number">${esc(order.sales_id)}</span>
            <span class="invoice-date">${dateStr} · ${esc(methodLabel)}</span>
          </div>
          <div class="invoice-actions">
            <span class="badge ${badgeCls}">${badgeTxt}</span>
            <span class="invoice-total">₹${Number(order.total).toLocaleString('en-IN')}</span>
          </div>
        </div>
        <div class="items-wrap">
          <table class="items-table">
            <thead><tr>
              <th>Item</th><th class="text-right">Qty</th><th class="text-right">Amount</th>
            </tr></thead>
            <tbody>${itemRows}</tbody>
          </table>
          <div class="invoice-total-row">
            <span>Total</span>
            <span>₹${Number(order.total).toLocaleString('en-IN', { minimumFractionDigits: 0 })}</span>
          </div>
        </div>
      </div>`;
  }

  // ── Group flat rows → invoice objects ─────────────────────────────
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

  // ── Invoice card ──────────────────────────────────────────────────
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
      const req        = Number(it.requested_quantity);
      const fin        = Number(it.final_quantity);
      const lineTotal  = (fin * it.item_price).toLocaleString('en-IN', { minimumFractionDigits: 2 });
      const qtyChanged = req !== fin;
      const qtyHtml    = qtyChanged
        ? `<span class="qty-requested">${req.toLocaleString('en-IN')}</span><span class="qty-arrow">→</span><span class="qty-final">${fin.toLocaleString('en-IN')}</span>`
        : fin.toLocaleString('en-IN');

      return `<tr${qtyChanged ? ' class="qty-adjusted"' : ''}>
        <td>${esc(it.item_name)}</td>
        <td class="text-right num qty-cell">${qtyHtml}</td>
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
                <th class="text-right">Qty <span class="th-hint">(req → del)</span></th>
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

  // ── Utilities ─────────────────────────────────────────────────────
  function normalisePhone(raw) {
    // Accept: 9876543210 / +919876543210 / 919876543210
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 10) return '+91' + digits;
    if (digits.length === 12 && digits.startsWith('91')) return '+' + digits;
    if (digits.length === 13 && raw.startsWith('+91')) return raw.trim();
    return null; // invalid
  }

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
        <p>No orders or invoices found for this number.</p>
        <p style="font-size:.8rem;margin-top:.25rem">Orders placed on the website will appear here.</p>
        <button class="btn btn-outline btn-sm" style="margin-top:1rem" onclick="localStorage.removeItem('tgp_phone');location.reload()">Try a different number</button>
      </div>`;
  }

  // ─────────────────────────────────────────────────────────────────
  // OTP flow — DISABLED until DLT approved
  // To re-enable:
  //   1. Uncomment this entire block
  //   2. In handlePhoneSubmit(), replace localStorage save + loadInvoices()
  //      with: sendOtp(phone)
  //   3. In loadInvoices(), replace rpc call with session-based query
  //   4. Add OTP step HTML back to page.invoices.liquid
  // -----------------------------------------------------------------
  /*
  async function sendOtp(phone) {
    const { error } = await sb.auth.signInWithOtp({ phone });
    if (error) { phoneError.textContent = error.message; return; }
    // show OTP input step ...
  }

  async function verifyOtp(phone, token) {
    const { data, error } = await sb.auth.verifyOtp({ phone, token, type: 'sms' });
    if (error) { otpError.textContent = error.message; return; }
    loadInvoices(phone);
  }
  */

  init();
})();
