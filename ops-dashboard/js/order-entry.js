// ── State ─────────────────────────────────────────────────────
let _items = [];

// ── Init ──────────────────────────────────────────────────────
(function init() {
  document.getElementById('oe-date').value = todayIST();

  // Submit on Enter in any field
  ['oe-customer', 'oe-item', 'oe-qty', 'oe-desc'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
      if (e.key === 'Enter') addItem();
    });
  });
})();

// ── Add item to local list ────────────────────────────────────
function addItem() {
  const date     = document.getElementById('oe-date').value;
  const customer = document.getElementById('oe-customer').value.trim();
  const item     = document.getElementById('oe-item').value.trim();
  const qty      = parseFloat(document.getElementById('oe-qty').value);
  const desc     = document.getElementById('oe-desc').value.trim();

  if (!date)     { showToast('Select a date', 'error'); return; }
  if (!customer) { showToast('Enter a customer / door number', 'error'); return; }
  if (!item)     { showToast('Enter a fruit or item name', 'error'); return; }
  if (!qty || qty <= 0) { showToast('Enter a valid quantity', 'error'); return; }

  _items.push({ date, customer, item, qty, desc });

  // Clear item/qty/desc — keep date and customer for quick multi-item entry
  document.getElementById('oe-item').value = '';
  document.getElementById('oe-qty').value  = '';
  document.getElementById('oe-desc').value = '';
  document.getElementById('oe-item').focus();

  renderList();
}

// ── New customer — clear form and focus customer field ────────
function newCustomer() {
  document.getElementById('oe-customer').value = '';
  document.getElementById('oe-item').value     = '';
  document.getElementById('oe-qty').value      = '';
  document.getElementById('oe-desc').value     = '';
  document.getElementById('oe-customer').focus();
}

// ── Add item for a specific customer from the list ────────────
function addItemForCustomer(name) {
  document.getElementById('oe-customer').value = name;
  document.getElementById('oe-item').value     = '';
  document.getElementById('oe-qty').value      = '';
  document.getElementById('oe-desc').value     = '';
  document.getElementById('oe-item').focus();
  document.getElementById('oe-item').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ── Remove one item ───────────────────────────────────────────
function removeItem(idx) {
  _items.splice(idx, 1);
  renderList();
}

// ── Clear all ─────────────────────────────────────────────────
function clearAll() {
  if (_items.length && !confirm('Remove all items from the list?')) return;
  _items = [];
  renderList();
}

// ── Render pending list ───────────────────────────────────────
function renderList() {
  const wrap   = document.getElementById('oe-list-wrap');
  const list   = document.getElementById('oe-list');
  const count  = document.getElementById('oe-count');
  const status = document.getElementById('oe-status');

  status.textContent = '';

  if (!_items.length) {
    wrap.classList.add('hidden');
    return;
  }

  wrap.classList.remove('hidden');
  count.textContent = `(${_items.length})`;

  // Group by customer for a cleaner view
  const byCustomer = {};
  _items.forEach((it, idx) => {
    if (!byCustomer[it.customer]) byCustomer[it.customer] = [];
    byCustomer[it.customer].push({ ...it, idx });
  });

  list.innerHTML = Object.entries(byCustomer).map(([cust, items]) => `
    <div style="border:1px solid var(--border);border-radius:10px;margin-bottom:10px;overflow:hidden">
      <div style="background:#f5f5f5;padding:8px 14px;font-weight:600;font-size:0.88rem;display:flex;justify-content:space-between;align-items:center;gap:8px">
        <span style="flex:1">${escHtml(cust)}</span>
        <span style="color:var(--text-muted);font-weight:400;font-size:0.8rem">${items[0].date}</span>
        <button class="btn btn-sm btn-secondary" onclick="addItemForCustomer('${escHtml(cust)}')" style="font-size:0.75rem;padding:3px 10px">＋ item</button>
      </div>
      ${items.map(it => `
        <div style="display:flex;align-items:center;gap:10px;padding:9px 14px;border-top:1px solid #f0f0f0">
          <div style="flex:1">
            <span style="font-weight:500">${escHtml(it.item)}</span>
            <span style="color:var(--text-muted);margin-left:8px">${it.qty}</span>
            ${it.desc ? `<div style="font-size:0.78rem;color:var(--text-muted);margin-top:2px">${escHtml(it.desc)}</div>` : ''}
          </div>
          <button class="btn btn-sm btn-danger" onclick="removeItem(${it.idx})">×</button>
        </div>`).join('')}
    </div>`).join('');
}

// ── Submit to Supabase ────────────────────────────────────────
async function submitOrders() {
  if (!_items.length) return;

  const btn    = document.getElementById('oe-submit-btn');
  const status = document.getElementById('oe-status');

  btn.disabled    = true;
  btn.textContent = 'Submitting…';
  status.textContent = '';

  const batchId = `MANUAL-${Date.now()}`;

  const records = _items.map(it => ({
    sales_order_id:     batchId,
    invoice_date:       it.date,
    customer_name:      it.customer,
    item_name:          it.item,
    description:        it.desc || null,
    requested_quantity: it.qty,
    status:             'draft',
  }));

  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/add-orders`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON}`,
        'apikey':        SUPABASE_ANON,
      },
      body: JSON.stringify({ records }),
    });

    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Submit failed');

    showToast(`${result.inserted} order${result.inserted !== 1 ? 's' : ''} submitted ✓`);
    status.innerHTML = `<span style="color:var(--green)">✓ ${result.inserted} items added to packer view</span>`;
    _items = [];
    renderList();

    // Reset form for next batch
    document.getElementById('oe-customer').value = '';
    document.getElementById('oe-item').value     = '';
    document.getElementById('oe-qty').value      = '';
    document.getElementById('oe-desc').value     = '';

  } catch (e) {
    status.innerHTML = `<span style="color:var(--red)">${e.message}</span>`;
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Submit Orders';
  }
}

// ── Utility ───────────────────────────────────────────────────
function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
