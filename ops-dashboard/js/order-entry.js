// ── State ─────────────────────────────────────────────────────
let _rowIdx    = 0;
let _customers = [];   // string[]
let _items     = [];   // { name, unit }[]

// ── Init ──────────────────────────────────────────────────────
(async function init() {
  document.getElementById('section-count').textContent = 'Loading customers and items…';

  try {
    const res  = await fetch(`${SUPABASE_URL}/functions/v1/get-masters`, {
      headers: { 'Authorization': `Bearer ${SUPABASE_ANON}`, 'apikey': SUPABASE_ANON },
    });
    const data = await res.json();
    _customers = data.customers || [];
    _items     = data.items     || [];
  } catch (e) {
    console.warn('Could not load masters:', e.message);
  }

  const custList = document.getElementById('customer-list');
  _customers.forEach(c => {
    const opt = document.createElement('option'); opt.value = c;
    custList.appendChild(opt);
  });

  const itemList = document.getElementById('item-list');
  _items.forEach(i => {
    const opt = document.createElement('option'); opt.value = i.name;
    if (i.unit) opt.label = i.unit;
    itemList.appendChild(opt);
  });

  document.getElementById('section-count').textContent =
    `${_customers.length} customers · ${_items.length} items loaded`;

  addRow();
})();

// ── Add a new row ─────────────────────────────────────────────
function addRow(prefillCustomer) {
  _rowIdx++;
  const n        = _rowIdx;
  const lastDate = getLastVal('date') || todayIST();
  const lastCust = prefillCustomer !== undefined ? prefillCustomer : (getLastVal('customer') || '');

  const tr = document.createElement('tr');
  tr.id    = `oe-row-${n}`;
  tr.innerHTML = `
    <td><input class="oe-input" type="date"   id="r${n}-date"     value="${lastDate}"></td>
    <td><input class="oe-input" type="text"   id="r${n}-customer" value="${escHtml(lastCust)}" list="customer-list" placeholder="Villa 83" autocomplete="off"></td>
    <td><input class="oe-input" type="text"   id="r${n}-item"     list="item-list"    placeholder="Alphonso Mango" autocomplete="off"></td>
    <td><input class="oe-input oe-qty-input"  type="number" id="r${n}-qty" placeholder="1" min="0" step="0.01"></td>
    <td><input class="oe-input" type="text"   id="r${n}-desc"     placeholder="Notes…"></td>
    <td><button class="btn btn-sm btn-danger" onclick="removeRow(${n})">×</button></td>`;

  document.getElementById('oe-tbody').appendChild(tr);
  document.getElementById(`r${n}-item`).focus();

  // Enter on qty → add new row for same customer
  document.getElementById(`r${n}-qty`).addEventListener('keydown', e => {
    if (e.key === 'Enter') addRow(document.getElementById(`r${n}-customer`).value.trim());
  });
}

function removeRow(n) {
  document.getElementById(`oe-row-${n}`)?.remove();
}

// ── Collect all non-empty rows ────────────────────────────────
function collectRows() {
  const rows  = [];
  const trs   = document.getElementById('oe-tbody').querySelectorAll('tr');
  trs.forEach(tr => {
    const n    = tr.id.replace('oe-row-', '');
    const date = document.getElementById(`r${n}-date`)?.value;
    const cust = document.getElementById(`r${n}-customer`)?.value.trim();
    const item = document.getElementById(`r${n}-item`)?.value.trim();
    const qty  = parseFloat(document.getElementById(`r${n}-qty`)?.value);
    const desc = document.getElementById(`r${n}-desc`)?.value.trim();
    if (date && cust && item && qty > 0) rows.push({ date, customer: cust, item, qty, desc });
  });
  return rows;
}

function getLastVal(field) {
  const trs = [...document.getElementById('oe-tbody').querySelectorAll('tr')];
  if (!trs.length) return '';
  const last = trs[trs.length - 1].id.replace('oe-row-', '');
  return document.getElementById(`r${last}-${field}`)?.value || '';
}

// ── Submit ────────────────────────────────────────────────────
async function submitOrders() {
  const rows = collectRows();
  if (!rows.length) { showToast('Add at least one valid row', 'error'); return; }

  const btn    = document.getElementById('oe-submit-btn');
  const status = document.getElementById('oe-status');

  btn.disabled    = true;
  btn.textContent = 'Submitting…';
  status.textContent = '';

  const batchId = `MANUAL-${Date.now()}`;

  const records = rows.map(r => ({
    sales_order_id:     batchId,
    invoice_date:       r.date,
    customer_name:      r.customer,
    item_name:          r.item,
    description:        r.desc || null,
    requested_quantity: r.qty,
    status:             'draft',
  }));

  // Detect new customers / items not in master lists
  const knownCustomers = new Set(_customers.map(c => c.toLowerCase()));
  const knownItems     = new Set(_items.map(i => i.name.toLowerCase()));

  const newCustomers = [...new Set(
    rows.map(r => r.customer).filter(c => !knownCustomers.has(c.toLowerCase()))
  )];
  const newItems = [...new Set(
    rows.map(r => r.item).filter(i => !knownItems.has(i.toLowerCase()))
  )].map(name => ({ name, unit: '' }));

  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/add-orders`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_ANON}`, 'apikey': SUPABASE_ANON },
      body:    JSON.stringify({ records, newCustomers, newItems }),
    });

    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Submit failed');

    // Update local master lists so they appear immediately in autocomplete
    newCustomers.forEach(c => {
      _customers.push(c);
      const opt = document.createElement('option'); opt.value = c;
      document.getElementById('customer-list').appendChild(opt);
    });
    newItems.forEach(i => {
      _items.push(i);
      const opt = document.createElement('option'); opt.value = i.name;
      document.getElementById('item-list').appendChild(opt);
    });

    showToast(`${result.inserted} order${result.inserted !== 1 ? 's' : ''} submitted ✓`);
    status.innerHTML = `<span style="color:var(--green)">✓ ${result.inserted} items sent to packer view${newCustomers.length || newItems.length ? ' · ' + (newCustomers.length + newItems.length) + ' new master entries saved' : ''}</span>`;

    // Clear table, add one fresh row
    document.getElementById('oe-tbody').innerHTML = '';
    addRow('');

  } catch (e) {
    status.innerHTML = `<span style="color:var(--red)">${e.message}</span>`;
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Submit Orders';
  }
}

// ── Utility ───────────────────────────────────────────────────
function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
