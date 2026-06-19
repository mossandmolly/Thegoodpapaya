// ── State ──────────────────────────────────────────────────────
let _items     = [];   // [{ name, unit, unit_price }]
let _customers = [];   // string[]
let _rows      = [];   // parsed/manual rows
let _pendingSubmitRows = null;   // held while phone prompt is open

// ── Init ───────────────────────────────────────────────────────
(async function init() {
  document.getElementById('order-date').value = todayIST();
  setupCombobox();

  try {
    const [catRes, custRes] = await Promise.all([
      sb.from('catalog').select('item_name, unit, unit_price').eq('active', true).order('item_name'),
      sb.from('orders').select('customer_name').order('customer_name'),
    ]);

    _items = (catRes.data || []).map(r => ({
      name: r.item_name, unit: r.unit || 'kg', unit_price: r.unit_price,
    }));

    const seen = new Set();
    _customers = (custRes.data || [])
      .map(r => r.customer_name)
      .filter(c => {
        if (!c) return false;
        const k = c.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

    document.getElementById('status-line').textContent =
      `${_customers.length} customers · ${_items.length} catalog items loaded`;
  } catch (e) {
    document.getElementById('status-line').textContent = 'Failed to load — check Supabase connection';
    console.error(e);
  }

  setupSpeech();
})();

// ── Speech recognition (main textarea) ──────────────────────────────────
let _recognition = null;
let _isRecording = false;

function setupSpeech() {
  const SR     = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micBtn = document.getElementById('mic-btn');

  if (!SR) {
    document.getElementById('mic-status').textContent =
      'Speech input not supported on this browser — paste text instead.';
    micBtn.disabled = true;
    return;
  }

  _recognition = new SR();
  _recognition.continuous     = true;
  _recognition.interimResults = true;
  _recognition.lang           = 'en-IN';

  let finalTranscript = '';

  _recognition.onstart = () => {
    _isRecording     = true;
    finalTranscript  = document.getElementById('raw-input').value;
    if (finalTranscript && !finalTranscript.endsWith('\n') && !finalTranscript.endsWith(' '))
      finalTranscript += ' ';
    micBtn.classList.add('recording');
    micBtn.textContent = '■ Stop';
    document.getElementById('mic-status').textContent = 'Listening…';
  };

  _recognition.onresult = e => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalTranscript += t + ' ';
      else interim += t;
    }
    document.getElementById('raw-input').value = finalTranscript + interim;
  };

  _recognition.onerror = e => {
    document.getElementById('mic-status').textContent =
      `Mic error: ${e.error} — try again or paste text instead.`;
    _stopRecording();
  };

  _recognition.onend = () => {
    if (_isRecording) {
      try { _recognition.start(); } catch (err) { _stopRecording(); }
    }
  };

  micBtn.addEventListener('click', () => {
    if (_isRecording) _stopRecording();
    else { try { _recognition.start(); } catch (e) {} }
  });
}

function _stopRecording() {
  _isRecording = false;
  if (_recognition) { try { _recognition.stop(); } catch (e) {} }
  const micBtn = document.getElementById('mic-btn');
  micBtn.classList.remove('recording');
  micBtn.textContent = '● Speak';
  document.getElementById('mic-status').textContent = '';
}

// ── Parse ──────────────────────────────────────────────────────
document.getElementById('parse-btn').addEventListener('click', () => {
  const raw = document.getElementById('raw-input').value.trim();
  if (!raw) { showToast('Nothing to parse — speak or paste text first.', 'error'); return; }
  if (_isRecording) _stopRecording();

  const orderDate = document.getElementById('order-date').value || todayIST();
  const itemPairs = _items.map(i => [i.name, i.unit]);
  const newRows   = parseOrders(raw, _customers, itemPairs, orderDate);
  _rows           = _rows.concat(newRows);
  renderRows();
  showToast(`Parsed ${newRows.length} row${newRows.length !== 1 ? 's' : ''}`);
});

document.getElementById('clear-input-btn').addEventListener('click', () => {
  document.getElementById('raw-input').value = '';
});

// ── Row management ─────────────────────────────────────────────
function addBlankRow() {
  const orderDate = document.getElementById('order-date').value || todayIST();
  _rows.push({
    orderDate, customer: '', item: '', description: '', quantity: '',
    salesOrderId: '', warn: false, warnReason: null, isNewCustomer: false,
  });
  renderRows();
}

document.getElementById('add-row-btn').addEventListener('click', addBlankRow);

document.getElementById('clear-all-btn').addEventListener('click', () => {
  if (_rows.length && !confirm(`Clear all ${_rows.length} row${_rows.length !== 1 ? 's' : ''}?`)) return;
  _rows = [];
  renderRows();
});

function updateRow(idx, field, value) {
  if (!_rows[idx]) return;
  _rows[idx][field] = value;
  if (field === 'customer') {
    _rows[idx].salesOrderId  = _rows[idx].orderDate + value.replace(/\s+/g, '');
    _rows[idx].isNewCustomer = !_customers.some(c => c.toLowerCase() === value.toLowerCase());
  }
}

function deleteRow(idx) {
  _rows.splice(idx, 1);
  renderRows();
}

function escH(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderRows() {
  const container   = document.getElementById('rows-container');
  const resultsWrap = document.getElementById('results-section');
  const emptyState  = document.getElementById('empty-state');

  if (!_rows.length) {
    resultsWrap.style.display = 'none';
    emptyState.style.display  = 'block';
    return;
  }
  resultsWrap.style.display = 'block';
  emptyState.style.display  = 'none';
  document.getElementById('phone-prompt').style.display = 'none';

  const warnCount = _rows.filter(r => r.warn).length;
  document.getElementById('summary-text').textContent =
    `${_rows.length} row${_rows.length !== 1 ? 's' : ''}${warnCount ? ` · ${warnCount} flagged` : ''}`;

  container.innerHTML = '';

  _rows.forEach((r, idx) => {
    const div     = document.createElement('div');
    div.className = `oe-row-card${r.warn ? ' is-warn' : ''}${r.isNewCustomer ? ' is-new-customer' : ''}`;
    div.id        = `oe-row-${idx}`;

    const tags = [
      r.isNewCustomer ? '<span class="oe-tag oe-tag-new">New customer</span>' : '',
      r.warn && !r.isNewCustomer ? '<span class="oe-tag oe-tag-warn">Review</span>' : '',
    ].filter(Boolean).join('');

    const cat       = _items.find(i => i.name.toLowerCase() === (r.item || '').toLowerCase());
    const priceHint = cat
      ? `<div class="oe-price-hint">₹${parseFloat(cat.unit_price || 0).toFixed(0)} / ${cat.unit}</div>`
      : '';

    div.innerHTML = `
      <div class="oe-row-meta">
        <div class="oe-row-tags">${tags}</div>
        <button class="oe-row-delete" data-del="${idx}" aria-label="Delete row">✕</button>
      </div>
      <div class="oe-field-grid">
        <div>
          <span class="oe-field-label">Customer</span>
          <input class="oe-field-input" type="text" value="${escH(r.customer)}"
            data-idx="${idx}" data-field="customer" autocomplete="off">
        </div>
        <div>
          <span class="oe-field-label">Item</span>
          <input class="oe-field-input" type="text" value="${escH(r.item)}"
            data-idx="${idx}" data-field="item" autocomplete="off">
          ${priceHint}
        </div>
      </div>
      <div class="oe-field-grid">
        <div>
          <span class="oe-field-label">Quantity</span>
          <input class="oe-field-input" type="text" value="${escH(r.quantity)}"
            data-idx="${idx}" data-field="quantity" placeholder="e.g. 1.5">
        </div>
        <div>
          <span class="oe-field-label">Date</span>
          <input class="oe-field-input" type="date" value="${escH(r.orderDate)}"
            data-idx="${idx}" data-field="orderDate">
        </div>
      </div>
      <div class="oe-field-grid full">
        <div>
          <span class="oe-field-label">Description / notes</span>
          <input class="oe-field-input" type="text" value="${escH(r.description)}"
            data-idx="${idx}" data-field="description" placeholder="Optional">
        </div>
      </div>
      ${r.warnReason ? `<div class="oe-warn-reason">⚠ ${escH(r.warnReason)}</div>` : ''}
    `;
    container.appendChild(div);
  });

  container.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', () => deleteRow(parseInt(btn.dataset.del)));
  });

  container.querySelectorAll('.oe-field-input').forEach(input => {
    input.addEventListener('change', e => {
      updateRow(parseInt(e.target.dataset.idx), e.target.dataset.field, e.target.value);
      _refreshRowCard(parseInt(e.target.dataset.idx));
    });
    const field = input.dataset.field;
    if (field === 'customer') attachCombobox(input, () => _customers);
    if (field === 'item')     attachCombobox(input, () => _items.map(i => i.name));
  });
}

function _refreshRowCard(idx) {
  const r   = _rows[idx];
  if (!r) return;
  const div = document.getElementById(`oe-row-${idx}`);
  if (!div) return;

  div.className = `oe-row-card${r.warn ? ' is-warn' : ''}${r.isNewCustomer ? ' is-new-customer' : ''}`;

  const tagsDiv = div.querySelector('.oe-row-tags');
  if (tagsDiv) tagsDiv.innerHTML = [
    r.isNewCustomer ? '<span class="oe-tag oe-tag-new">New customer</span>' : '',
    r.warn && !r.isNewCustomer ? '<span class="oe-tag oe-tag-warn">Review</span>' : '',
  ].filter(Boolean).join('');

  const itemInput = div.querySelector('[data-field="item"]');
  if (itemInput) {
    const cat  = _items.find(i => i.name.toLowerCase() === (r.item || '').toLowerCase());
    let   hint = itemInput.nextElementSibling;
    if (cat) {
      if (!hint || !hint.classList.contains('oe-price-hint')) {
        hint = document.createElement('div');
        hint.className = 'oe-price-hint';
        itemInput.insertAdjacentElement('afterend', hint);
      }
      hint.textContent = `₹${parseFloat(cat.unit_price || 0).toFixed(0)} / ${cat.unit}`;
    } else if (hint && hint.classList.contains('oe-price-hint')) {
      hint.remove();
    }
  }

  let warnDiv = div.querySelector('.oe-warn-reason');
  if (r.warnReason) {
    if (!warnDiv) { warnDiv = document.createElement('div'); warnDiv.className = 'oe-warn-reason'; div.appendChild(warnDiv); }
    warnDiv.textContent = `⚠ ${r.warnReason}`;
  } else if (warnDiv) {
    warnDiv.remove();
  }

  const warnCount = _rows.filter(x => x.warn).length;
  document.getElementById('summary-text').textContent =
    `${_rows.length} row${_rows.length !== 1 ? 's' : ''}${warnCount ? ` · ${warnCount} flagged` : ''}`;
}

// ── Combobox ────────────────────────────────────────────────────
let _cbDropdown    = null;
let _cbActiveInput = null;
let _cbGetOpts     = null;

function setupCombobox() {
  _cbDropdown = document.getElementById('oe-cb-dropdown');
  _cbDropdown.addEventListener('mousedown', e => {
    e.preventDefault();
    const item = e.target.closest('.oe-cb-item');
    if (!item || !_cbActiveInput) return;
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
    return `<div class="oe-cb-item" data-value="${escH(o)}">${hl}</div>`;
  }).join('');
  const r = _cbActiveInput.getBoundingClientRect();
  Object.assign(_cbDropdown.style, {
    display: 'block',
    left:    r.left + window.scrollX + 'px',
    top:     r.bottom + window.scrollY + 2 + 'px',
    width:   Math.max(r.width, 200) + 'px',
  });
}

function _cbClose() {
  if (_cbDropdown) _cbDropdown.style.display = 'none';
  _cbActiveInput = null;
}

function attachCombobox(input, getOpts) {
  input.addEventListener('focus',   ()  => _cbOpen(input, getOpts));
  input.addEventListener('input',   ()  => _cbActiveInput === input ? _cbRender() : _cbOpen(input, getOpts));
  input.addEventListener('blur',    ()  => setTimeout(() => { if (_cbActiveInput === input) _cbClose(); }, 160));
  input.addEventListener('keydown', e   => { if (e.key === 'Escape' || e.key === 'Tab') _cbClose(); });
}

// ── Submit flow ─────────────────────────────────────────────────────
document.getElementById('submit-btn').addEventListener('click', submitOrders);

async function submitOrders() {
  const toSubmit = _rows.filter(r => r.customer.trim() && r.item.trim() && String(r.quantity).trim());
  if (!toSubmit.length) {
    showToast('Each row needs a customer, item, and quantity', 'error');
    return;
  }

  const btn = document.getElementById('submit-btn');
  btn.disabled    = true;
  btn.textContent = 'Checking…';

  try {
    await checkPhonesThenSubmit(toSubmit);
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Submit to ops →';
  }
}

async function checkPhonesThenSubmit(toSubmit) {
  // Get unique customer names in this batch
  const uniqueCustomers = [...new Set(toSubmit.map(r => r.customer.trim()))];

  // Which of these already have a phone on file?
  const { data: phoneData } = await sb
    .from('customer_phones')
    .select('customer_name')
    .in('customer_name', uniqueCustomers);

  const hasPhone = new Set((phoneData || []).map(r => r.customer_name.toLowerCase()));
  const needPhone = uniqueCustomers.filter(c => !hasPhone.has(c.toLowerCase()));

  if (needPhone.length > 0) {
    // Show phone prompt and pause — resume in submitWithPhones() or skipPhones()
    _pendingSubmitRows = toSubmit;
    showPhonePrompt(needPhone);
    return;
  }

  await doSubmit(toSubmit);
}

// ── Phone prompt ────────────────────────────────────────────────────

function showPhonePrompt(customers) {
  const tbody = document.getElementById('phone-table-body');
  tbody.innerHTML = '';

  customers.forEach(name => {
    const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const tr   = document.createElement('tr');
    tr.innerHTML = `
      <td class="oe-phone-name">${escH(name)}</td>
      <td>
        <input class="oe-field-input oe-phone-input" type="tel"
          id="ph-${escH(slug)}" data-customer="${escH(name)}"
          placeholder="+91 XXXXX XXXXX" autocomplete="tel">
      </td>
      <td>
        <button class="btn-sm-mic" data-mic-for="ph-${escH(slug)}">● Speak</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  // Wire up per-row mic buttons
  tbody.querySelectorAll('[data-mic-for]').forEach(btn => {
    btn.addEventListener('click', () => speakPhone(btn.dataset.micFor, btn));
  });

  const prompt = document.getElementById('phone-prompt');
  prompt.style.display = 'block';
  prompt.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  tbody.querySelector('input')?.focus();
}

// Activate speech recognition for a single phone input
function speakPhone(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { showToast('Speech not supported — type the number', 'error'); return; }

  const r   = new SR();
  r.lang           = 'en-IN';
  r.continuous     = false;
  r.interimResults = false;

  btn.textContent = '■ Stop';
  btn.classList.add('recording');

  r.onresult = e => {
    input.value = _normalizePhone(e.results[0][0].transcript);
  };
  r.onerror = () => {
    btn.textContent = '● Speak';
    btn.classList.remove('recording');
  };
  r.onend = () => {
    btn.textContent = '● Speak';
    btn.classList.remove('recording');
  };

  r.start();
}

// Convert spoken phone ("nine eight seven six...") to +91XXXXXXXXXX
function _normalizePhone(raw) {
  const words = { zero:'0',one:'1',two:'2',three:'3',four:'4',
                  five:'5',six:'6',seven:'7',eight:'8',nine:'9' };
  let s = raw.toLowerCase();
  Object.entries(words).forEach(([w, d]) => {
    s = s.replace(new RegExp('\\b' + w + '\\b', 'g'), d);
  });
  s = s.replace(/[^\d+]/g, '');
  if (/^\d{10}$/.test(s)) s = '+91' + s;
  return s;
}

async function submitWithPhones() {
  // Collect entered phone numbers
  const inputs    = document.querySelectorAll('#phone-table-body .oe-phone-input');
  const phoneRows = [];

  inputs.forEach(input => {
    const customer_name = input.dataset.customer;
    const phone_number  = _normalizePhone(input.value.trim());
    if (phone_number.length >= 10) {
      phoneRows.push({ customer_name, phone_number, label: 'primary' });
    }
  });

  if (phoneRows.length > 0) {
    const { error } = await sb.from('customer_phones').insert(phoneRows);
    if (error) {
      // Ignore duplicate-phone errors (someone already on file under another name)
      if (error.code !== '23505') {
        showToast('Could not save phone numbers: ' + error.message, 'error');
        return;
      }
    }
    showToast(`${phoneRows.length} phone${phoneRows.length !== 1 ? 's' : ''} saved`);
  }

  document.getElementById('phone-prompt').style.display = 'none';
  await doSubmit(_pendingSubmitRows);
  _pendingSubmitRows = null;
}

async function skipPhones() {
  document.getElementById('phone-prompt').style.display = 'none';
  await doSubmit(_pendingSubmitRows);
  _pendingSubmitRows = null;
}

// ── Core insert ─────────────────────────────────────────────────────
async function doSubmit(toSubmit) {
  const btn = document.getElementById('submit-btn');
  btn.disabled    = true;
  btn.textContent = 'Submitting…';

  try {
    const groups = {};
    for (const row of toSubmit) {
      const key = `${row.customer.trim()}|${row.orderDate}`;
      if (!groups[key]) groups[key] = { customer: row.customer.trim(), date: row.orderDate, items: [] };
      groups[key].items.push(row);
    }

    let totalInserted = 0;

    for (const { customer, date, items } of Object.values(groups)) {
      let orderId;
      const { data: existingOrder } = await sb
        .from('orders')
        .select('sales_id')
        .eq('order_date', date)
        .eq('customer_name', customer)
        .maybeSingle();

      if (existingOrder) {
        orderId = existingOrder.sales_id;
      } else {
        const safeName = customer.replace(/\s+/g, '-');
        let salesId = `${date}-${safeName}`;
        let suffix  = 1;
        while (true) {
          const { data: hit } = await sb.from('orders').select('sales_id').eq('sales_id', salesId).maybeSingle();
          if (!hit) break;
          salesId = `${date}-${safeName}-${++suffix}`;
        }

        const communityMatch = customer.match(/^(.+?)\s+[\w-]+$/);
        const community      = communityMatch ? communityMatch[1] : customer;

        const { error: orderErr } = await sb.from('orders').insert({
          sales_id:       salesId,
          customer_name:  customer,
          community,
          payment_method: 'cod',
          status:         'open',
          payment_status: 'due_today',
          order_date:     date,
          cart:           [],
          total:          0,
        });
        if (orderErr) throw new Error(`Failed to create order: ${orderErr.message}`);
        orderId = salesId;

        if (!_customers.some(c => c.toLowerCase() === customer.toLowerCase())) {
          _customers.push(customer);
        }
      }

      const newItems = items.map(row => {
        const cat = _items.find(i => i.name.toLowerCase() === row.item.trim().toLowerCase());
        return {
          order_id:      orderId,
          order_date:    date,
          customer_name: customer,
          community:     customer.match(/^(.+?)\s+[\w-]+$/)?.[1] || customer,
          item_name:     cat ? cat.name : row.item.trim(),
          description:   row.description || null,
          requested_qty: parseFloat(row.quantity) || 0,
          unit_price:    cat?.unit_price ?? null,
          final_qty:     null,
          status:        'open',
        };
      });

      const { error: itemErr } = await sb.from('order_items').insert(newItems);
      if (itemErr) throw new Error(`Failed to insert items: ${itemErr.message}`);
      totalInserted += newItems.length;
    }

    showToast(`${totalInserted} item${totalInserted !== 1 ? 's' : ''} submitted to ops ✓`);
    _rows = [];
    renderRows();
    document.getElementById('raw-input').value = '';

  } catch (e) {
    showToast(e.message, 'error');
    console.error(e);
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Submit to ops →';
  }
}
