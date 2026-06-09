// ── State ─────────────────────────────────────────────────────
let _rowIdx        = 0;
let _customers     = [];   // string[]
let _items         = [];   // { name, unit }[]
let _pendingSubmit = null;

// ── Singleton combobox ────────────────────────────────────────
let _cbEl    = null;
let _cbInput = null;
let _cbOpts  = null;

function _cbInit() {
  _cbEl = document.createElement('div');
  _cbEl.className = 'cb-dropdown';
  document.body.appendChild(_cbEl);

  _cbEl.addEventListener('mousedown', e => {
    e.preventDefault();
    const item = e.target.closest('.cb-item');
    if (!item || !_cbInput) return;
    _cbInput.value = item.dataset.value;
    _cbInput.dispatchEvent(new Event('change', { bubbles: true }));
    _cbClose();
  });

  document.addEventListener('mousedown', e => {
    if (_cbEl && !_cbEl.contains(e.target) && e.target !== _cbInput) _cbClose();
  });
}

function _cbOpen(input, opts) {
  _cbInput = input;
  _cbOpts  = opts;
  _cbRender();
}

function _cbRender() {
  const q       = (_cbInput.value || '').toLowerCase();
  const matches = (_cbOpts || []).filter(o => !q || o.toLowerCase().includes(q)).slice(0, 30);
  if (!matches.length) { _cbClose(); return; }

  _cbEl.innerHTML = matches.map(o => {
    const idx = q ? o.toLowerCase().indexOf(q) : -1;
    const hl  = idx >= 0
      ? escHtml(o.slice(0, idx)) + '<strong>' + escHtml(o.slice(idx, idx + q.length)) + '</strong>' + escHtml(o.slice(idx + q.length))
      : escHtml(o);
    return `<div class="cb-item" data-value="${escHtml(o)}">${hl}</div>`;
  }).join('');

  const r = _cbInput.getBoundingClientRect();
  Object.assign(_cbEl.style, {
    display: 'block',
    left:    r.left + window.scrollX + 'px',
    top:     r.bottom + window.scrollY + 2 + 'px',
    width:   Math.max(r.width, 180) + 'px',
  });
}

function _cbClose() {
  if (_cbEl) _cbEl.style.display = 'none';
  _cbInput = null;
}

function attachCombobox(input, getOpts) {
  input.addEventListener('focus',   () => _cbOpen(input, getOpts()));
  input.addEventListener('input',   () => _cbInput === input ? _cbRender() : _cbOpen(input, getOpts()));
  input.addEventListener('blur',    () => setTimeout(() => { if (_cbInput === input) _cbClose(); }, 160));
  input.addEventListener('keydown', e  => { if (e.key === 'Escape' || e.key === 'Tab') _cbClose(); });
}

// ── Init ──────────────────────────────────────────────────────
(async function init() {
  _cbInit();
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
    <td><input class="oe-input" type="date"  id="r${n}-date"     value="${lastDate}"></td>
    <td><input class="oe-input" type="text"  id="r${n}-customer" value="${escHtml(lastCust)}" placeholder="Villa 83"  autocomplete="off"></td>
    <td><input class="oe-input" type="text"  id="r${n}-item"     placeholder="Item" autocomplete="off"></td>
    <td><input class="oe-input oe-qty-input" type="number" id="r${n}-qty" placeholder="1" min="0" step="0.01"></td>
    <td><input class="oe-input" type="text"  id="r${n}-desc"     placeholder="Notes…"></td>
    <td><button class="btn btn-sm oe-add-btn" onclick="addRow(document.getElementById('r${n}-customer').value.trim())" title="Add item for same customer">+</button></td>
    <td><button class="btn btn-sm btn-danger" onclick="removeRow(${n})">×</button></td>`;

  document.getElementById('oe-tbody').appendChild(tr);

  const custInput = document.getElementById(`r${n}-customer`);
  const itemInput = document.getElementById(`r${n}-item`);

  attachCombobox(custInput, () => _customers);
  attachCombobox(itemInput, () => _items.map(i => i.name));

  itemInput.focus();

  document.getElementById(`r${n}-qty`).addEventListener('keydown', e => {
    if (e.key === 'Enter') addRow(custInput.value.trim());
  });
}

function removeRow(n) {
  document.getElementById(`oe-row-${n}`)?.remove();
}

// ── Collect all non-empty rows ────────────────────────────────
function collectRows() {
  const rows = [];
  document.getElementById('oe-tbody').querySelectorAll('tr').forEach(tr => {
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

  const knownCustomers = new Set(_customers.map(c => c.toLowerCase()));
  const knownItems     = new Set(_items.map(i => i.name.toLowerCase()));

  const newCustomers = [...new Set(
    rows.map(r => r.customer).filter(c => !knownCustomers.has(c.toLowerCase()))
  )];
  const newItems = [...new Set(
    rows.map(r => r.item).filter(i => !knownItems.has(i.toLowerCase()))
  )].map(name => ({ name, unit: '' }));

  try {
    _pendingSubmit = { records, newCustomers, newItems };
    await doSubmit({});
  } catch (e) {
    status.innerHTML = `<span style="color:var(--red)">${e.message}</span>`;
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Submit orders →';
  }
}

// ── Core submit ───────────────────────────────────────────────
async function doSubmit(phones) {
  const { records, newCustomers, newItems } = _pendingSubmit;
  const status = document.getElementById('oe-status');

  const res    = await fetch(`${SUPABASE_URL}/functions/v1/add-orders`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_ANON}`, 'apikey': SUPABASE_ANON },
    body:    JSON.stringify({ records, newCustomers, newItems, phones }),
  });
  const result = await res.json();

  if (result.missingPhones?.length) { showPhonePrompt(result.missingPhones); return; }
  if (!res.ok) throw new Error(result.error || 'Submit failed');

  newCustomers.forEach(c => { if (!_customers.includes(c)) _customers.push(c); });
  newItems.forEach(i => { if (!_items.find(x => x.name === i.name)) _items.push(i); });

  hidePhonePrompt();
  showToast(`${result.inserted} order${result.inserted !== 1 ? 's' : ''} submitted ✓`);
  status.innerHTML = `<span style="color:var(--green)">✓ ${result.inserted} items sent to packer view</span>`;
  _pendingSubmit = null;

  document.getElementById('oe-tbody').innerHTML = '';
  addRow('');
}

// ── Phone prompt ──────────────────────────────────────────────
function showPhonePrompt(missingNames) {
  let wrap = document.getElementById('oe-phone-prompt');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id        = 'oe-phone-prompt';
    wrap.className = 'phone-prompt';
    document.getElementById('oe-status').insertAdjacentElement('afterend', wrap);
  }
  wrap.innerHTML = `
    <h4>Phone numbers required</h4>
    <p>These customers aren't in the system yet — enter their mobile numbers to continue.</p>
    ${missingNames.map(name => `
      <div class="phone-prompt-row">
        <label>${escHtml(name)}</label>
        <input type="tel" id="ph-${slugify(name)}" placeholder="+91 99999 99999" data-customer="${escHtml(name)}">
      </div>`).join('')}
    <button class="btn btn-primary btn-sm" style="margin-top:4px" onclick="submitWithPhones()">Continue →</button>`;
  wrap.style.display = 'block';
  wrap.querySelector('input')?.focus();
}

function hidePhonePrompt() {
  const wrap = document.getElementById('oe-phone-prompt');
  if (wrap) wrap.style.display = 'none';
}

async function submitWithPhones() {
  const phones = {};
  for (const input of document.querySelectorAll('#oe-phone-prompt input[data-customer]')) {
    const name = input.getAttribute('data-customer');
    const val  = input.value.trim();
    if (!val) { showToast(`Enter phone for ${name}`, 'error'); input.focus(); return; }
    phones[name] = val;
  }
  try { await doSubmit(phones); }
  catch (e) { document.getElementById('oe-status').innerHTML = `<span style="color:var(--red)">${e.message}</span>`; }
}

// ── Sync customers + items from Zoho ─────────────────────────
async function syncFromZoho() {
  const btn   = document.getElementById('sync-btn');
  const count = document.getElementById('section-count');
  btn.disabled    = true;
  btn.textContent = '↻ Syncing…';

  try {
    const res    = await fetch(`${SUPABASE_URL}/functions/v1/get-masters?force=1`, {
      headers: { 'Authorization': `Bearer ${SUPABASE_ANON}`, 'apikey': SUPABASE_ANON },
    });
    const data   = await res.json();
    if (!res.ok) throw new Error(data.error || 'Sync failed');

    _customers = data.customers || [];
    _items     = data.items     || [];
    count.textContent = `${_customers.length} customers · ${_items.length} items loaded`;
    showToast(`Synced ${data.syncedCustomers} customers · ${data.syncedItems} items from Zoho`);
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled    = false;
    btn.textContent = '↻ Sync from Zoho';
  }
}

function slugify(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '-'); }

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
