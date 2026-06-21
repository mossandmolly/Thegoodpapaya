// ── State ───────────────────────────────────────────────
let _items     = [];
let _customers = [];
let _rows      = [];
let _pendingSubmitRows = null;

// ── Init ────────────────────────────────────────────────
(async function init() {
  document.getElementById('order-date').value = todayIST();
  setupCombobox();
  addBlankRow(); // show one empty row immediately
  try {
    const [catRes, custRes, socRes] = await Promise.all([
      sb.from('catalog').select('item_name, unit, unit_price').eq('active', true).order('item_name'),
      sb.from('customers').select('customer_name').eq('active', true).order('customer_name'),
      sb.from('societies').select('canonical_name, aliases').eq('active', true).order('canonical_name'),
    ]);
    _items = (catRes.data || []).map(r => ({ name: r.item_name, unit: r.unit || 'kg', unit_price: r.unit_price }));
    const seen = new Set();
    _customers = (custRes.data || []).map(r => r.customer_name).filter(c => {
      if (!c) return false;
      const k = c.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
    if (socRes.data?.length) {
      const canonicals = socRes.data.map(s => s.canonical_name);
      const aliasMap = {};
      socRes.data.forEach(s => (s.aliases || []).forEach(a => { aliasMap[a] = s.canonical_name; }));
      setSocieties(canonicals, aliasMap);
    }
    const el = document.getElementById('status-line');
    if (el) el.textContent = _customers.length + ' customers · ' + _items.length + ' items loaded';
  } catch (e) {
    console.error(e);
  }
  setupSpeech();
})();

// ── Speech ───────────────────────────────────────────────
let _recognition = null, _isRecording = false;

function setupSpeech() {
  const SR     = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micBtn = document.getElementById('mic-btn');
  if (!SR) {
    document.getElementById('mic-status').textContent = 'Speech not supported — paste text instead.';
    micBtn.disabled = true; return;
  }
  _recognition = new SR();
  _recognition.continuous = true; _recognition.interimResults = true; _recognition.lang = 'en-IN';
  let finalTranscript = '';
  _recognition.onstart = () => {
    _isRecording = true;
    finalTranscript = document.getElementById('raw-input').value;
    if (finalTranscript && !finalTranscript.endsWith(' ')) finalTranscript += ' ';
    micBtn.classList.add('recording'); micBtn.textContent = '■';
    document.getElementById('mic-status').textContent = 'Listening…';
  };
  _recognition.onresult = e => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalTranscript += t + ' '; else interim += t;
    }
    document.getElementById('raw-input').value = finalTranscript + interim;
  };
  _recognition.onerror = e => {
    document.getElementById('mic-status').textContent = 'Mic error: ' + e.error;
    _stopRecording();
  };
  _recognition.onend = () => { if (_isRecording) { try { _recognition.start(); } catch (_) { _stopRecording(); } } };
  micBtn.addEventListener('click', () => {
    if (_isRecording) _stopRecording(); else { try { _recognition.start(); } catch (_) {} }
  });
}

function _stopRecording() {
  _isRecording = false;
  if (_recognition) { try { _recognition.stop(); } catch (_) {} }
  const micBtn = document.getElementById('mic-btn');
  micBtn.classList.remove('recording'); micBtn.textContent = '●';
  document.getElementById('mic-status').textContent = '';
}

// ── Parse (typed / spoken text) ─────────────────────────
document.getElementById('parse-btn').addEventListener('click', () => {
  const raw = document.getElementById('raw-input').value.trim();
  if (!raw) { showToast('Nothing to parse', 'error'); return; }
  if (_isRecording) _stopRecording();
  const orderDate = document.getElementById('order-date').value || todayIST();
  const newRows   = parseOrders(raw, _customers, _items.map(i => [i.name, i.unit]), orderDate);
  if (!newRows.length) { showToast('Could not extract any orders', 'error'); return; }
  // Remove the single blank placeholder row if it's the only thing in the table
  if (_rows.length === 1 && !_rows[0].customer && !_rows[0].item) _rows = [];
  _rows = _rows.concat(newRows);
  renderRows();
  document.getElementById('raw-input').value = '';
  showToast('Parsed ' + newRows.length + ' row' + (newRows.length !== 1 ? 's' : ''));
});

// ── Paste table (Excel / Sheets → TSV) ──────────────────
// Tab characters signal structured table; skip NLP and parse columns directly.
// Expected columns: Customer · Item · Qty · Date (optional)
document.getElementById('raw-input').addEventListener('paste', e => {
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if (!text.includes('\t')) return; // no tabs → regular text, let it paste normally

  e.preventDefault();
  const defaultDate = document.getElementById('order-date').value || todayIST();
  const dateRe      = /^\d{4}-\d{2}-\d{2}$/;
  const lines       = text.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.trim());
  if (!lines.length) return;

  // Auto-skip header row if 3rd column (qty) is non-numeric
  let startIdx = 0;
  const firstCols = lines[0].split('\t');
  if (firstCols.length >= 3 && isNaN(parseFloat(firstCols[2]))) startIdx = 1;

  const newRows = [];
  for (let i = startIdx; i < lines.length; i++) {
    const cols    = lines[i].split('\t').map(c => c.trim());
    if (cols.length < 3) continue;
    const customer = cols[0];
    const itemRaw  = cols[1];
    const qty      = parseFloat(cols[2]);
    const dateRaw  = cols[3] || '';
    if (!customer || !itemRaw || isNaN(qty) || qty <= 0) continue;

    const date = dateRaw && dateRe.test(dateRaw) ? dateRaw : defaultDate;
    const cat  = _items.find(it => it.name.toLowerCase() === itemRaw.toLowerCase());
    newRows.push({
      orderDate:     date,
      customer,
      item:          cat ? cat.name : itemRaw,
      description:   '',
      quantity:      qty,
      warn:          !cat,
      warnReason:    !cat ? '"' + itemRaw + '" not in catalog — check spelling' : null,
      isNewCustomer: !_customers.some(c => c.toLowerCase() === customer.toLowerCase()),
    });
  }

  if (!newRows.length) { showToast('No valid rows in pasted table', 'error'); return; }
  if (_rows.length === 1 && !_rows[0].customer && !_rows[0].item) _rows = [];
  _rows = _rows.concat(newRows);
  renderRows();
  showToast('Added ' + newRows.length + ' row' + (newRows.length !== 1 ? 's' : '') + ' from table');
});

document.getElementById('clear-input-btn').addEventListener('click', () => {
  document.getElementById('raw-input').value = '';
});

// ── Row management ───────────────────────────────────────
function addBlankRow(focusField = 'customer') {
  const orderDate = document.getElementById('order-date').value || todayIST();
  _rows.push({ orderDate, customer: '', item: '', description: '', quantity: '', warn: false, warnReason: null, isNewCustomer: false });
  renderRows();
  _focusRowField(_rows.length - 1, focusField);
}

function addSameCustomerRow() {
  const orderDate    = document.getElementById('order-date').value || todayIST();
  const lastCustomer = _rows.length ? _rows[_rows.length - 1].customer : '';
  _rows.push({
    orderDate, customer: lastCustomer, item: '', description: '', quantity: '',
    warn: false, warnReason: null,
    isNewCustomer: lastCustomer ? !_customers.some(c => c.toLowerCase() === lastCustomer.toLowerCase()) : false,
  });
  renderRows();
  _focusRowField(_rows.length - 1, 'item');
}

function _focusRowField(idx, field) {
  setTimeout(() => {
    const tr = document.getElementById('oe-row-' + idx);
    if (tr) tr.querySelector('[data-field="' + field + '"]')?.focus();
  }, 30);
}

function updateRow(idx, field, value) {
  if (!_rows[idx]) return;
  _rows[idx][field] = value;
  if (field === 'item') {
    const cat = _items.find(i => i.name.toLowerCase() === value.toLowerCase());
    _rows[idx].warn       = !!value && !cat;
    _rows[idx].warnReason = (!!value && !cat) ? '"' + value + '" not in catalog' : null;
  }
  if (field === 'customer') {
    _rows[idx].isNewCustomer = !!value && !_customers.some(c => c.toLowerCase() === value.toLowerCase());
  }
}

function deleteRow(idx) {
  _rows.splice(idx, 1);
  if (!_rows.length) addBlankRow(); else renderRows();
}

function escH(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Render rows (table) ──────────────────────────────────
function renderRows() {
  const tbody = document.getElementById('rows-container');
  tbody.innerHTML = '';

  _rows.forEach((r, idx) => {
    const tr = document.createElement('tr');
    tr.className = 'oe-tr' + (r.isNewCustomer ? ' is-new' : '') + (r.warn ? ' is-warn' : '');
    tr.id = 'oe-row-' + idx;

    const warnTitle = r.warnReason ? ' title="' + escH(r.warnReason) + '"' : '';

    tr.innerHTML =
      '<td><input class="oe-in oe-in-date" type="date" value="' + escH(r.orderDate) + '" data-idx="' + idx + '" data-field="orderDate"></td>' +
      '<td><input class="oe-in" type="text" value="' + escH(r.customer) + '" data-idx="' + idx + '" data-field="customer" placeholder="Customer" autocomplete="off"></td>' +
      '<td><input class="oe-in" type="text" value="' + escH(r.item) + '" data-idx="' + idx + '" data-field="item" placeholder="Item" autocomplete="off"' + warnTitle + '></td>' +
      '<td><input class="oe-in oe-in-qty" type="text" value="' + escH(r.quantity) + '" data-idx="' + idx + '" data-field="quantity" placeholder="0"></td>' +
      '<td><input class="oe-in" type="text" value="' + escH(r.description) + '" data-idx="' + idx + '" data-field="description" placeholder="Note…"></td>' +
      '<td><button class="oe-del" data-del="' + idx + '" title="Remove">✕</button></td>';

    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('[data-del]').forEach(btn =>
    btn.addEventListener('click', () => deleteRow(parseInt(btn.dataset.del)))
  );
  tbody.querySelectorAll('.oe-in').forEach(input => {
    input.addEventListener('change', e => {
      updateRow(parseInt(e.target.dataset.idx), e.target.dataset.field, e.target.value);
      _refreshRow(parseInt(e.target.dataset.idx));
    });
    if (input.dataset.field === 'customer') attachCombobox(input, () => _customers);
    if (input.dataset.field === 'item')     attachCombobox(input, () => _items.map(i => i.name));
  });
}

function _refreshRow(idx) {
  const r  = _rows[idx]; if (!r) return;
  const tr = document.getElementById('oe-row-' + idx); if (!tr) return;
  tr.className = 'oe-tr' + (r.isNewCustomer ? ' is-new' : '') + (r.warn ? ' is-warn' : '');
  const itemInput = tr.querySelector('[data-field="item"]');
  if (itemInput) {
    itemInput.title = r.warnReason || '';
  }
}

// ── Combobox ─────────────────────────────────────────────
let _cbDropdown = null, _cbActiveInput = null, _cbGetOpts = null;

function setupCombobox() {
  _cbDropdown = document.getElementById('oe-cb-dropdown');
  _cbDropdown.addEventListener('mousedown', e => {
    e.preventDefault();
    const item = e.target.closest('.oe-cb-item'); if (!item || !_cbActiveInput) return;
    _cbActiveInput.value = item.dataset.value;
    _cbActiveInput.dispatchEvent(new Event('change', { bubbles: true }));
    _cbClose();
  });
  document.addEventListener('mousedown', e => {
    if (_cbDropdown && !_cbDropdown.contains(e.target) && e.target !== _cbActiveInput) _cbClose();
  });
  document.addEventListener('scroll', () => _cbClose(), true);
}

function _cbOpen(input, getOpts) { _cbActiveInput = input; _cbGetOpts = getOpts; _cbRender(); }
function _cbRender() {
  if (!_cbActiveInput || !_cbDropdown) return;
  const q    = (_cbActiveInput.value || '').toLowerCase();
  const opts = (_cbGetOpts ? _cbGetOpts() : []).filter(o => !q || o.toLowerCase().includes(q)).slice(0, 28);
  if (!opts.length) { _cbClose(); return; }
  _cbDropdown.innerHTML = opts.map(o => {
    const i  = q ? o.toLowerCase().indexOf(q) : -1;
    const hl = i >= 0
      ? escH(o.slice(0, i)) + '<strong>' + escH(o.slice(i, i + q.length)) + '</strong>' + escH(o.slice(i + q.length))
      : escH(o);
    return '<div class="oe-cb-item" data-value="' + escH(o) + '">' + hl + '</div>';
  }).join('');
  const r = _cbActiveInput.getBoundingClientRect();
  Object.assign(_cbDropdown.style, {
    display: 'block',
    left:    r.left + 'px',
    top:     r.bottom + 4 + 'px',
    width:   Math.max(r.width, 200) + 'px',
  });
}
function _cbClose() { if (_cbDropdown) _cbDropdown.style.display = 'none'; _cbActiveInput = null; }
function attachCombobox(input, getOpts) {
  input.addEventListener('focus',   () => _cbOpen(input, getOpts));
  input.addEventListener('input',   () => _cbActiveInput === input ? _cbRender() : _cbOpen(input, getOpts));
  input.addEventListener('blur',    () => setTimeout(() => { if (_cbActiveInput === input) _cbClose(); }, 160));
  input.addEventListener('keydown', e => { if (e.key === 'Escape' || e.key === 'Tab') _cbClose(); });
}

// ── Submit flow ──────────────────────────────────────────
document.getElementById('submit-btn').addEventListener('click', submitOrders);

async function submitOrders() {
  const toSubmit = _rows.filter(r => r.customer.trim() && r.item.trim() && String(r.quantity).trim());
  if (!toSubmit.length) { showToast('Fill in at least one complete row', 'error'); return; }
  const btn = document.getElementById('submit-btn');
  btn.disabled = true; btn.textContent = 'Checking…';
  try { await checkPhonesThenSubmit(toSubmit); } finally { btn.disabled = false; btn.textContent = 'Submit →'; }
}

async function checkPhonesThenSubmit(toSubmit) {
  const uniqueCustomers = [...new Set(toSubmit.map(r => r.customer.trim()))];
  const { data: phoneData } = await sb.from('customer_phones').select('customer_name').in('customer_name', uniqueCustomers);
  const hasPhone  = new Set((phoneData || []).map(r => r.customer_name.toLowerCase()));
  const needPhone = uniqueCustomers.filter(c => !hasPhone.has(c.toLowerCase()));
  if (needPhone.length > 0) { _pendingSubmitRows = toSubmit; showPhonePrompt(needPhone); return; }
  await doSubmit(toSubmit);
}

function showPhonePrompt(customers) {
  const tbody = document.getElementById('phone-table-body');
  tbody.innerHTML = '';
  customers.forEach(name => {
    const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const tr   = document.createElement('tr');
    tr.innerHTML =
      '<td class="oe-phone-name">' + escH(name) + '</td>' +
      '<td><input class="oe-phone-input" type="tel" id="ph-' + escH(slug) + '" data-customer="' + escH(name) + '" placeholder="+91 XXXXX XXXXX" autocomplete="tel"></td>' +
      '<td><button class="btn-sm-mic" data-mic-for="ph-' + escH(slug) + '">● Speak</button></td>';
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('[data-mic-for]').forEach(btn =>
    btn.addEventListener('click', () => speakPhone(btn.dataset.micFor, btn))
  );
  const prompt = document.getElementById('phone-prompt');
  prompt.style.display = 'block';
  prompt.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  tbody.querySelector('input')?.focus();
}

function speakPhone(inputId, btn) {
  const input = document.getElementById(inputId); if (!input) return;
  const SR    = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { showToast('Speech not supported', 'error'); return; }
  const r = new SR(); r.lang = 'en-IN'; r.continuous = false; r.interimResults = false;
  btn.textContent = '■ Stop'; btn.classList.add('recording');
  r.onresult = e => { input.value = _normalizePhone(e.results[0][0].transcript); };
  r.onerror  = () => { btn.textContent = '● Speak'; btn.classList.remove('recording'); };
  r.onend    = () => { btn.textContent = '● Speak'; btn.classList.remove('recording'); };
  r.start();
}

function _normalizePhone(raw) {
  const words = { zero:'0',one:'1',two:'2',three:'3',four:'4',five:'5',six:'6',seven:'7',eight:'8',nine:'9' };
  let s = raw.toLowerCase();
  Object.entries(words).forEach(([w, d]) => { s = s.replace(new RegExp('\\b' + w + '\\b', 'g'), d); });
  s = s.replace(/[^\d+]/g, '');
  if (/^\d{10}$/.test(s)) s = '+91' + s;
  return s;
}

async function submitWithPhones() {
  const inputs    = document.querySelectorAll('#phone-table-body .oe-phone-input');
  const phoneRows = [];
  inputs.forEach(input => {
    const customer_name = input.dataset.customer;
    const phone_number  = _normalizePhone(input.value.trim());
    if (phone_number.length >= 10) phoneRows.push({ customer_name, phone_number, label: 'primary' });
  });
  if (phoneRows.length > 0) {
    const { error } = await sb.from('customer_phones').upsert(phoneRows, { onConflict: 'customer_name,phone_number' });
    if (error) { showToast('Could not save phones: ' + error.message, 'error'); return; }
    showToast(phoneRows.length + ' phone' + (phoneRows.length !== 1 ? 's' : '') + ' saved');
  }
  document.getElementById('phone-prompt').style.display = 'none';
  await doSubmit(_pendingSubmitRows);
  _pendingSubmitRows = null;
}

async function skipPhones() {
  document.getElementById('phone-prompt').style.display = 'none';
  await doSubmit(_pendingSubmitRows, true);
  _pendingSubmitRows = null;
}

async function doSubmit(toSubmit, allowMissingPhones = false) {
  const btn = document.getElementById('submit-btn');
  btn.disabled = true; btn.textContent = 'Submitting…';
  try {
    const records = toSubmit.map(row => {
      const cat = _items.find(i => i.name.toLowerCase() === row.item.trim().toLowerCase());
      return {
        customer_name:      row.customer.trim(),
        invoice_date:       row.orderDate,
        item_name:          cat ? cat.name : row.item.trim(),
        description:        row.description || null,
        requested_quantity: parseFloat(row.quantity) || 0,
        unit_price:         cat ? cat.unit_price : null,
      };
    });

    const res = await fetch(SUPABASE_URL + '/functions/v1/add-orders', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON },
      body:    JSON.stringify({ records, allowMissingPhones }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Submit failed');

    const n       = data.inserted || 0;
    const heldMsg = data.held > 0 ? ' (' + data.held + ' held as duplicate)' : '';
    showToast(n + ' item' + (n !== 1 ? 's' : '') + ' submitted' + heldMsg + ' ✓');

    toSubmit.forEach(row => {
      const c = row.customer.trim();
      if (c && !_customers.some(x => x.toLowerCase() === c.toLowerCase())) _customers.push(c);
    });

    // Reset to one blank row
    _rows = [];
    addBlankRow();
    document.getElementById('raw-input').value = '';
  } catch (e) {
    showToast(e.message, 'error'); console.error(e);
  } finally {
    btn.disabled = false; btn.textContent = 'Submit →';
  }
}
