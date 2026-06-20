// ── Password gate ──────────────────────────────────────────────
let adminPassword = null;

(async function tryAutoUnlock() {
  const stored   = localStorage.getItem('adminPw');
  const storedAt = parseInt(localStorage.getItem('adminPwAt') || '0', 10);
  const age      = Date.now() - storedAt;
  if (!stored || age > 24 * 60 * 60 * 1000) {
    localStorage.removeItem('adminPw');
    localStorage.removeItem('adminPwAt');
    return;
  }
  try {
    const res = await fetch(SUPABASE_URL + '/functions/v1/upload-orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON },
      body: JSON.stringify({ password: stored, records: [] }),
    });
    if (res.status !== 401) {
      adminPassword = stored;
      document.getElementById('password-screen').classList.add('hidden');
      document.getElementById('admin-content').classList.remove('hidden');
      loadAll();
    } else {
      localStorage.removeItem('adminPw');
      localStorage.removeItem('adminPwAt');
    }
  } catch (_) {}
})();

async function checkPassword() {
  const input = document.getElementById('admin-password');
  const btn   = document.querySelector('#password-screen button');
  const errEl = document.getElementById('pw-error');
  const pw    = input.value;
  if (!pw) return;

  btn.disabled = true;
  btn.textContent = 'Checking…';
  errEl.style.display = 'none';

  let res;
  try {
    res = await fetch(SUPABASE_URL + '/functions/v1/upload-orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON },
      body: JSON.stringify({ password: pw, records: [] }),
    });
  } catch (e) {
    errEl.textContent = 'Network error — try again';
    errEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Unlock';
    return;
  }

  if (res.status === 401) {
    errEl.textContent = 'Wrong password';
    errEl.style.display = 'block';
    input.value = '';
    input.focus();
    btn.disabled = false;
    btn.textContent = 'Unlock';
    return;
  }

  adminPassword = pw;
  localStorage.setItem('adminPw', pw);
  localStorage.setItem('adminPwAt', Date.now().toString());
  document.getElementById('password-screen').classList.add('hidden');
  document.getElementById('admin-content').classList.remove('hidden');
  loadAll();
}

document.getElementById('admin-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') checkPassword();
});

// ── Catalog ────────────────────────────────────────────────────
let catalogItems = [];

async function loadCatalog() {
  const { data, error } = await sb
    .from('catalog')
    .select('id, item_name, unit_price, unit, active, zoho_item_id, synced_at')
    .order('item_name');

  const list = document.getElementById('catalog-list');
  if (!list) return;

  if (error || !data?.length) {
    list.innerHTML = '<p style="font-size:0.85rem;color:var(--text-muted)">No catalog items yet — click Sync from Zoho</p>';
    catalogItems = [];
    populateFruitDropdown();
    return;
  }

  catalogItems = data;
  populateFruitDropdown();

  list.innerHTML = '';
  const tbl = document.createElement('table');
  tbl.className = 'diff-table';
  tbl.innerHTML = '<thead><tr><th>Item name</th><th>Price</th><th>Unit</th><th>Zoho linked</th><th>Last synced</th><th></th></tr></thead>';
  const tbody = document.createElement('tbody');
  data.forEach(item => {
    const tr = document.createElement('tr');
    if (!item.active) tr.style.opacity = '0.45';
    const syncedAgo = item.synced_at
      ? new Date(item.synced_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
      : '—';
    const zohoCell = item.zoho_item_id
      ? '<span style="color:var(--green);font-size:.75rem">✓ ' + escapeHtml(item.zoho_item_id) + '</span>'
      : '<span style="color:var(--text-muted);font-size:.75rem">—</span>';
    tr.innerHTML =
      '<td style="font-weight:500">' + escapeHtml(item.item_name) + '</td>' +
      '<td>₹' + parseFloat(item.unit_price).toFixed(0) + '</td>' +
      '<td style="color:var(--text-muted)">' + escapeHtml(item.unit) + '</td>' +
      '<td>' + zohoCell + '</td>' +
      '<td style="font-size:.75rem;color:var(--text-muted)">' + syncedAgo + '</td>' +
      '<td><button class="btn btn-sm btn-danger" onclick="deleteCatalogItem(\'' + item.id + '\',\'' + escapeAttr(item.item_name) + '\')">✕</button></td>';
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody);
  list.appendChild(tbl);
}

function populateFruitDropdown() {
  const sel = document.getElementById('assign-fruit');
  if (!sel) return;
  sel.innerHTML = '<option value="">Select fruit…</option>';
  catalogItems.filter(i => i.active).forEach(i => {
    const opt = document.createElement('option');
    opt.value = i.item_name;
    opt.textContent = i.item_name + '  (₹' + parseFloat(i.unit_price).toFixed(0) + '/' + i.unit + ')';
    sel.appendChild(opt);
  });
}

async function syncCatalog() {
  const btn = document.getElementById('sync-btn');
  btn.textContent = 'Syncing…'; btn.disabled = true;
  try {
    const res = await fetch(SUPABASE_URL + '/functions/v1/sync-catalog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Sync failed');
    showToast(data.synced + ' items synced ✓');
    await loadCatalog();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.textContent = '↻ Sync from Zoho'; btn.disabled = false;
  }
}

async function syncCustomers() {
  const btn = document.getElementById('sync-customers-btn');
  if (btn) { btn.textContent = 'Syncing…'; btn.disabled = true; }
  try {
    const res = await fetch(SUPABASE_URL + '/functions/v1/sync-customers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Sync failed');
    showToast(data.synced + ' customers synced ✓');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (btn) { btn.textContent = '↻ Sync customers'; btn.disabled = false; }
  }
}

async function deleteCatalogItem(id, name) {
  if (!confirm('Remove "' + name + '" from catalog?')) return;
  const { error } = await sb.from('catalog').delete().eq('id', id);
  if (error) { showToast('Delete failed', 'error'); return; }
  showToast(name + ' removed');
  await loadCatalog();
}

// ── Load everything ────────────────────────────────────────────
async function loadAll() {
  const d1 = document.getElementById('voice-order-date');
  if (d1 && !d1.value) d1.value = todayIST();
  const d2 = document.getElementById('csv-default-date');
  if (d2 && !d2.value) d2.value = todayIST();
  await Promise.all([loadCatalog(), loadSocieties(), loadPackers(), loadAssignments(), loadNotes(), loadSnapshots(), loadMissingLinks()]);
}

async function loadSocieties() {
  const { data } = await sb.from('societies').select('canonical_name, aliases').eq('active', true);
  if (data && data.length) {
    const canonicals = data.map(s => s.canonical_name);
    const aliasMap = {};
    data.forEach(s => (s.aliases || []).forEach(a => { aliasMap[a] = s.canonical_name; }));
    if (typeof setSocieties === 'function') setSocieties(canonicals, aliasMap);
  }
}

// ── Missing payment links ──────────────────────────────────────
async function loadMissingLinks() {
  const listEl = document.getElementById('missing-links-list');
  if (!listEl) return;
  listEl.innerHTML = '<div class="skeleton" style="height:40px"></div>';
  try {
    const res = await fetch(SUPABASE_URL + '/functions/v1/admin-missing-links', {
      headers: { 'Authorization': 'Bearer ' + SUPABASE_ANON, 'apikey': SUPABASE_ANON },
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to load');
    const invoices = result.invoices || [];
    if (!invoices.length) {
      listEl.innerHTML = '<p style="font-size:0.85rem;color:var(--text-muted);padding:4px 0">None in the last 7 days ✓</p>';
      return;
    }
    let rows = '';
    invoices.forEach(inv => {
      rows += '<tr>' +
        '<td style="font-weight:500">' + escapeHtml(inv.customer_name) + '</td>' +
        '<td style="color:var(--text-muted);font-size:0.82rem">' + escapeHtml(inv.invoice_number) + '</td>' +
        '<td style="color:var(--text-muted);font-size:0.82rem;white-space:nowrap">' + (inv.invoice_date || '—') + '</td>' +
        '<td style="font-size:0.85rem">₹' + (inv.invoice_total != null ? Number(inv.invoice_total).toLocaleString('en-IN') : '—') + '</td>' +
        '</tr>';
    });
    listEl.innerHTML = '<table class="notes-table" style="width:100%"><thead><tr><th>Customer</th><th>Invoice</th><th>Date</th><th>Total</th></tr></thead><tbody>' + rows + '</tbody></table>';
  } catch (e) {
    listEl.innerHTML = '<p style="font-size:0.82rem;color:var(--red)">' + e.message + '</p>';
  }
}

// ── Voice input ────────────────────────────────────────────────
let _recognition = null;
let _isRecording  = false;

function toggleVoiceInput() {
  if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
    showToast('Voice input not supported — use Chrome on Android', 'error');
    return;
  }
  _isRecording ? stopVoiceInput() : startVoiceInput();
}

function startVoiceInput() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  _recognition = new SR();
  _recognition.continuous     = true;
  _recognition.interimResults = true;
  _recognition.lang           = 'en-IN';

  const textarea = document.getElementById('voice-order-text');
  const btn      = document.getElementById('voice-mic-btn');
  let base       = textarea.value;

  _recognition.onstart = () => {
    _isRecording = true;
    btn.textContent = '⏹ Stop';
    btn.classList.add('btn-recording');
  };

  _recognition.onresult = e => {
    let final = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) final += e.results[i][0].transcript;
    }
    if (final) {
      base += (base.trim() ? ' ' : '') + final.trim();
      textarea.value = base;
    }
  };

  _recognition.onend = () => {
    _isRecording = false;
    btn.textContent = '🎤 Speak';
    btn.classList.remove('btn-recording');
    _recognition = null;
  };

  _recognition.start();
}

function stopVoiceInput() {
  if (_recognition) { _recognition.stop(); _recognition = null; }
  _isRecording = false;
}

// ── Parse & preview voice/text orders (client-side) ───────────
async function parseVoiceOrders() {
  if (_isRecording) stopVoiceInput();

  const text     = document.getElementById('voice-order-text').value.trim();
  const date     = document.getElementById('voice-order-date').value || todayIST();
  const statusEl = document.getElementById('voice-parse-status');
  const btn      = document.getElementById('voice-parse-btn');

  if (!text) { showToast('Enter or speak some orders first', 'error'); return; }

  btn.disabled    = true;
  btn.textContent = 'Parsing…';
  statusEl.innerHTML = '<p style="font-size:0.82rem;color:var(--text-muted);margin-top:8px">Parsing…</p>';

  try {
    // Load from customers master table (populated by sync-customers)
    const { data: contactData } = await sb
      .from('customers')
      .select('customer_name')
      .eq('active', true)
      .limit(1000);
    const contacts = (contactData || []).map(r => r.customer_name).filter(Boolean);
    const items    = catalogItems.map(i => i.item_name);

    const parsed = parseOrders(text, contacts, items, date);
    if (!parsed.length) throw new Error('No orders could be extracted from that text');

    const orders = parsed.map(r => ({
      customer_name:      r.customer,
      item_name:          r.item,
      description:        r.description || null,
      requested_quantity: r.quantity,
      invoice_date:       r.orderDate || date,
      _confidence:        r.warn ? 'low' : 'high',
      _match_note:        r.warnReason || null,
    }));

    statusEl.innerHTML = '<p style="font-size:0.82rem;color:var(--text-muted);margin-top:8px">Parsed ' + orders.length + ' order' + (orders.length !== 1 ? 's' : '') + ' — review and confirm</p>';
    showPreview(orders, 'voice');
  } catch (e) {
    statusEl.innerHTML = '<p style="font-size:0.82rem;color:var(--red);margin-top:8px">Error: ' + e.message + '</p>';
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Parse & Preview';
  }
}

// ── Preview modal ──────────────────────────────────────────────
let _previewOrders  = [];
let _previewDeleted = new Set();

function showPreview(orders, source) {
  _previewOrders  = orders;
  _previewDeleted = new Set();

  const hasLow = source === 'voice' && orders.some(o => o._confidence === 'low');
  let statsText = orders.length + ' row' + (orders.length !== 1 ? 's' : '');
  if (hasLow) statsText += ' · ⚠️ review red rows';
  document.getElementById('preview-stats').textContent = statsText;

  document.getElementById('preview-modal-body').innerHTML = buildPreviewTable(orders, source);
  updatePreviewCount();
  document.getElementById('orders-preview-modal').classList.remove('hidden');
}

function buildPreviewTable(orders, source) {
  const showConf = source === 'voice';
  let rows = '';
  orders.forEach((o, idx) => {
    const conf     = o._confidence || 'high';
    const rowClass = conf === 'low' ? 'conf-low' : conf === 'medium' ? 'conf-medium' : '';
    const badge    = showConf ? '<span class="conf-badge conf-' + conf + '">' + conf + '</span>' : '';
    const note     = showConf && o._match_note
      ? '<div style="font-size:0.72rem;color:var(--text-muted);margin-top:2px">' + escapeHtml(o._match_note) + '</div>'
      : '';
    const descText = o.description || '';
    const descCell = descText
      ? '<span style="font-size:0.75rem;color:var(--text-muted)">' + escapeHtml(descText.substring(0, 48)) + (descText.length > 48 ? '…' : '') + '</span>'
      : '—';
    rows +=
      '<tr class="' + rowClass + '" id="preview-row-' + idx + '">' +
      '<td style="text-align:center;width:36px"><button class="btn btn-sm btn-danger" onclick="deletePreviewRow(' + idx + ')" title="Remove">×</button></td>' +
      '<td style="font-weight:500;white-space:nowrap">' + escapeHtml(o.customer_name) + '</td>' +
      '<td>' + escapeHtml(o.item_name) + badge + note + '</td>' +
      '<td><input type="number" class="preview-qty-input" value="' + o.requested_quantity + '" min="0" step="0.01" onchange="updatePreviewQty(' + idx + ', this.value)"></td>' +
      '<td style="color:var(--text-muted);white-space:nowrap;font-size:0.8rem">' + (o.invoice_date || '') + '</td>' +
      '<td style="max-width:180px">' + descCell + '</td>' +
      '</tr>';
  });
  return '<table class="preview-table"><thead><tr><th></th><th>Customer</th><th>Item</th><th>Qty</th><th>Date</th><th>Description</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function deletePreviewRow(idx) {
  _previewDeleted.add(idx);
  const row = document.getElementById('preview-row-' + idx);
  if (row) row.classList.add('preview-deleted');
  updatePreviewCount();
}

function updatePreviewQty(idx, val) {
  _previewOrders[idx].requested_quantity = parseFloat(val) || 0;
}

function updatePreviewCount() {
  const active = _previewOrders.length - _previewDeleted.size;
  document.getElementById('preview-row-count').textContent =
    active + ' of ' + _previewOrders.length + ' rows will be saved';
}

function closePreview() {
  document.getElementById('orders-preview-modal').classList.add('hidden');
}

// ── Confirm save from preview (direct DB write) ────────────────
async function confirmUpload() {
  const toUpload = _previewOrders
    .filter((_, idx) => !_previewDeleted.has(idx))
    .filter(o => o.customer_name && o.item_name && o.requested_quantity > 0);

  if (!toUpload.length) { showToast('No rows to save', 'error'); return; }

  const btn = document.getElementById('preview-confirm-btn');
  btn.disabled    = true;
  btn.textContent = 'Saving…';

  try {
    const byCustomer = {};
    toUpload.forEach(row => {
      const key = row.customer_name + '|' + row.invoice_date;
      if (!byCustomer[key]) byCustomer[key] = { customer_name: row.customer_name, date: row.invoice_date, items: [] };
      byCustomer[key].items.push(row);
    });

    let inserted = 0;
    for (const { customer_name, date: orderDate, items } of Object.values(byCustomer)) {
      let orderId;
      const { data: existingOrder } = await sb
        .from('orders').select('sales_id')
        .eq('order_date', orderDate).eq('customer_name', customer_name).maybeSingle();

      if (existingOrder) {
        orderId = existingOrder.sales_id;
      } else {
        const safeName = customer_name.split(' ').join('-');
        let salesId = orderDate + '-' + safeName;
        let suffix  = 1;
        while (true) {
          const { data: hit } = await sb.from('orders').select('sales_id').eq('sales_id', salesId).maybeSingle();
          if (!hit) break;
          salesId = orderDate + '-' + safeName + '-' + (++suffix);
        }
        const parts   = customer_name.split(' ');
        const community = parts.length > 1 ? parts.slice(0, -1).join(' ') : customer_name;
        await sb.from('orders').insert({
          sales_id: salesId, customer_name, community,
          payment_method: 'cod', status: 'placed',
          order_date: orderDate, cart: [], total: 0,
        });
        orderId = salesId;
      }

      const newItems = items.map(row => {
        const cat = catalogItems.find(c => c.item_name === row.item_name);
        const parts = row.customer_name.split(' ');
        return {
          order_id:      orderId,
          order_date:    orderDate,
          customer_name: row.customer_name,
          community:     parts.length > 1 ? parts.slice(0, -1).join(' ') : row.customer_name,
          item_name:     row.item_name,
          description:   row.description || null,
          requested_qty: row.requested_quantity,
          unit_price:    cat ? cat.unit_price : null,
          final_qty:     null,
          status:        'open',
        };
      });

      const { error } = await sb.from('order_items').insert(newItems);
      if (error) throw new Error(error.message);
      inserted += newItems.length;
    }

    closePreview();
    const statusEl = document.getElementById('voice-parse-status');
    if (statusEl) statusEl.innerHTML = '<p style="font-size:0.82rem;color:var(--green);margin-top:8px">✓ ' + inserted + ' item' + (inserted !== 1 ? 's' : '') + ' saved</p>';
    showToast(inserted + ' items saved ✓');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Confirm Upload';
  }
}

// ── Packers ────────────────────────────────────────────────────
async function loadPackers() {
  const { data, error } = await sb.from('packers').select('id, name, active').order('name');

  const list      = document.getElementById('packers-list');
  const assignSel = document.getElementById('assign-packer');
  assignSel.innerHTML = '<option value="">Select packer…</option>';

  if (error || !data?.length) {
    list.innerHTML = '<p style="font-size:0.85rem;color:var(--text-muted)">No packers yet</p>';
    return;
  }

  list.innerHTML = '';
  data.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id; opt.textContent = p.name;
    assignSel.appendChild(opt);

    const row = document.createElement('div');
    row.className = 'list-item';
    row.id = 'packer-row-' + p.id;
    row.innerHTML =
      '<span>' + escapeHtml(p.name) + '</span>' +
      '<div style="display:flex;gap:8px;align-items:center">' +
      '<label style="font-size:0.82rem;display:flex;align-items:center;gap:4px;cursor:pointer">' +
      '<input type="checkbox" ' + (p.active ? 'checked' : '') + ' onchange="togglePackerActive(\'' + p.id + '\', this.checked)"> Active</label>' +
      '<button class="btn btn-sm btn-danger" onclick="deletePacker(\'' + p.id + '\', \'' + escapeAttr(p.name) + '\')">Remove</button>' +
      '</div>';
    list.appendChild(row);
  });
}

async function addPacker() {
  const input = document.getElementById('new-packer-name');
  const name  = input.value.trim();
  if (!name) { showToast('Enter a name', 'error'); return; }
  const { error } = await sb.from('packers').insert({ name, active: true });
  if (error) { showToast('Failed to add', 'error'); return; }
  input.value = '';
  showToast(name + ' added ✓');
  await loadPackers();
}

async function togglePackerActive(id, active) {
  const { error } = await sb.from('packers').update({ active }).eq('id', id);
  if (error) showToast('Update failed', 'error');
}

async function deletePacker(id, name) {
  if (!confirm('Remove packer "' + name + '"? Their assignments will also be removed.')) return;
  await sb.from('packer_assignments').delete().eq('packer_id', id);
  const { error } = await sb.from('packers').delete().eq('id', id);
  if (error) { showToast('Delete failed', 'error'); return; }
  showToast(name + ' removed');
  await loadPackers();
  await loadAssignments();
}

// ── Packer assignments ─────────────────────────────────────────
async function loadAssignments() {
  const { data, error } = await sb
    .from('packer_assignments')
    .select('id, packer_id, item_name, packers(name)')
    .order('item_name');

  const list = document.getElementById('assignments-list');

  if (error || !data?.length) {
    list.innerHTML = '<p style="font-size:0.85rem;color:var(--text-muted)">No assignments yet</p>';
    return;
  }

  list.innerHTML = '';
  data.forEach(a => {
    const row = document.createElement('div');
    row.className = 'list-item';
    row.innerHTML =
      '<div><span style="font-weight:500">' + escapeHtml(a.item_name) + '</span>' +
      '<span style="font-size:0.8rem;color:var(--text-muted);margin-left:8px">→ ' + escapeHtml(a.packers ? a.packers.name : '?') + '</span></div>' +
      '<button class="btn btn-sm btn-danger" onclick="deleteAssignment(\'' + a.id + '\', \'' + escapeAttr(a.item_name) + '\')">Remove</button>';
    list.appendChild(row);
  });
}

async function addAssignment() {
  const packerId = document.getElementById('assign-packer').value;
  const fruitEl  = document.getElementById('assign-fruit');
  const itemName = fruitEl.value;

  if (!packerId) { showToast('Select a packer', 'error'); return; }
  if (!itemName) { showToast('Select a fruit', 'error'); return; }

  const { error } = await sb.from('packer_assignments').insert({ packer_id: packerId, item_name: itemName });
  if (error) {
    showToast(error.code === '23505' ? 'Already assigned' : 'Failed to assign', 'error');
    return;
  }
  fruitEl.value = '';
  showToast(itemName + ' assigned ✓');
  await loadAssignments();
}

async function deleteAssignment(id, itemName) {
  const { error } = await sb.from('packer_assignments').delete().eq('id', id);
  if (error) { showToast('Delete failed', 'error'); return; }
  showToast(itemName + ' unassigned');
  await loadAssignments();
}

// ── Customer Notes ─────────────────────────────────────────────
let _allNotes = [];

async function loadNotes() {
  const { data, error } = await sb
    .from('customer_notes')
    .select('id, customer_name, note, last_complaint_date')
    .order('updated_at', { ascending: false });

  if (error) {
    const el = document.getElementById('notes-preview');
    if (el) el.innerHTML = '<p style="font-size:0.82rem;color:var(--red);padding:10px">Error loading notes: ' + error.message + '</p>';
    return;
  }

  _allNotes = data || [];
  renderNotesPreview(_allNotes.slice(0, 10));
  renderNotesTable(_allNotes);
}

function renderNotesPreview(notes) {
  const wrap = document.getElementById('notes-preview');
  if (!wrap) return;
  if (!notes.length) {
    wrap.innerHTML = '<p style="font-size:0.85rem;color:var(--text-muted);padding:12px">No notes yet</p>';
    return;
  }
  let rows = '';
  notes.forEach(n => {
    rows += '<tr>' +
      '<td style="font-weight:500;white-space:nowrap">' + escapeHtml(n.customer_name) + '</td>' +
      '<td style="max-width:260px;word-break:break-word">' + escapeHtml(n.note) + '</td>' +
      '<td style="color:var(--text-muted);white-space:nowrap;font-size:0.8rem">' + (n.last_complaint_date || '—') + '</td>' +
      '</tr>';
  });
  wrap.innerHTML = '<table class="notes-table"><thead><tr><th>Customer</th><th>Note</th><th>Last complaint</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function renderNotesTable(notes) {
  const wrap = document.getElementById('notes-table-wrap');
  if (!wrap) return;
  if (!notes.length) {
    wrap.innerHTML = '<p style="font-size:0.85rem;color:var(--text-muted);padding:12px">No notes yet</p>';
    return;
  }
  wrap.innerHTML = '<table class="notes-table"><thead><tr><th>Customer</th><th>Note</th><th>Last complaint</th><th></th></tr></thead><tbody>' +
    notes.map(n => noteRow(n)).join('') + '</tbody></table>';
}

function noteRow(n) {
  return '<tr id="note-row-' + n.id + '">' +
    '<td style="font-weight:500;white-space:nowrap">' + escapeHtml(n.customer_name) + '</td>' +
    '<td style="max-width:240px;word-break:break-word">' + escapeHtml(n.note) + '</td>' +
    '<td style="color:var(--text-muted);white-space:nowrap;font-size:0.8rem">' + (n.last_complaint_date || '—') + '</td>' +
    '<td style="white-space:nowrap;display:flex;gap:4px">' +
    '<button class="btn btn-sm btn-secondary" onclick="startEditNote(\'' + n.id + '\')">Edit</button>' +
    '<button class="btn btn-sm btn-danger" onclick="deleteNote(\'' + n.id + '\')">×</button>' +
    '</td></tr>';
}

function startEditNote(id) {
  const n = _allNotes.find(n => n.id === id);
  if (!n) return;
  const row = document.getElementById('note-row-' + id);
  row.innerHTML =
    '<td style="font-weight:500;white-space:nowrap">' + escapeHtml(n.customer_name) + '</td>' +
    '<td><input type="text" value="' + escapeHtml(n.note) + '" id="edit-note-' + id + '" style="width:100%;padding:5px 8px;border:1.5px solid var(--brand);border-radius:6px;font-size:0.85rem;font-family:\'DM Sans\',sans-serif"></td>' +
    '<td><input type="date" value="' + (n.last_complaint_date || '') + '" id="edit-date-' + id + '" style="padding:5px 8px;border:1.5px solid var(--border);border-radius:6px;font-size:0.82rem;font-family:\'DM Sans\',sans-serif"></td>' +
    '<td style="white-space:nowrap;display:flex;gap:4px">' +
    '<button class="btn btn-sm btn-primary" onclick="commitEditNote(\'' + id + '\')">Save</button>' +
    '<button class="btn btn-sm btn-secondary" onclick="renderNotesTable(_allNotes)">Cancel</button>' +
    '</td>';
  document.getElementById('edit-note-' + id).focus();
}

async function commitEditNote(id) {
  const noteEl = document.getElementById('edit-note-' + id);
  const dateEl = document.getElementById('edit-date-' + id);
  const note = noteEl ? noteEl.value.trim() : '';
  const date = dateEl ? dateEl.value || null : null;
  if (!note) { showToast('Note cannot be empty', 'error'); return; }

  const { error } = await sb.from('customer_notes')
    .update({ note, last_complaint_date: date })
    .eq('id', id);

  if (error) { showToast(error.message, 'error'); return; }

  const idx = _allNotes.findIndex(n => n.id === id);
  if (idx !== -1) { _allNotes[idx].note = note; _allNotes[idx].last_complaint_date = date; }
  renderNotesPreview(_allNotes.slice(0, 10));
  renderNotesTable(_allNotes);
  showToast('Note updated ✓');
}

async function saveNote() {
  const customer      = document.getElementById('note-customer').value.trim();
  const note          = document.getElementById('note-text').value.trim();
  const complaintDate = document.getElementById('note-complaint-date').value || null;
  const statusEl      = document.getElementById('note-save-status');

  if (!customer || !note) { showToast('Customer and note are required', 'error'); return; }

  statusEl.innerHTML = '';
  const { error } = await sb.from('customer_notes').upsert(
    { customer_name: customer, note, last_complaint_date: complaintDate },
    { onConflict: 'customer_name' }
  );

  if (error) {
    statusEl.innerHTML = '<p style="font-size:0.82rem;color:var(--red)">' + error.message + '</p>';
    return;
  }

  document.getElementById('note-customer').value       = '';
  document.getElementById('note-text').value           = '';
  document.getElementById('note-complaint-date').value = '';
  showToast('Note saved ✓');
  await loadNotes();
}

async function deleteNote(id) {
  const { error } = await sb.from('customer_notes').delete().eq('id', id);
  if (error) { showToast('Delete failed', 'error'); return; }
  showToast('Deleted');
  await loadNotes();
}

async function importNotesCSV() {
  const fileInput = document.getElementById('note-csv');
  const statusEl  = document.getElementById('note-import-status');
  if (!fileInput.files.length) { showToast('Select a CSV file', 'error'); return; }

  const text = await fileInput.files[0].text();
  const rows = parseCSV(text);
  if (!rows.length) { showToast('CSV appears empty', 'error'); return; }

  const records = rows.map(r => ({
    customer_name:       (r['customer_name'] || '').trim(),
    note:                (r['note'] || r['description'] || '').trim(),
    last_complaint_date: (r['last_complaint_date'] || r['complaint_date'] || r['note_date'] || '').trim() || null,
  })).filter(r => r.customer_name && r.note);

  if (!records.length) { showToast('No valid rows found', 'error'); return; }

  statusEl.innerHTML = '<p style="font-size:0.82rem;color:var(--text-muted);margin-top:6px">Importing ' + records.length + ' rows…</p>';

  const { error } = await sb.from('customer_notes').upsert(records, { onConflict: 'customer_name' });
  if (error) {
    statusEl.innerHTML = '<p style="font-size:0.82rem;color:var(--red);margin-top:6px">Import failed: ' + error.message + '</p>';
    return;
  }

  fileInput.value = '';
  statusEl.innerHTML = '<p style="font-size:0.82rem;color:var(--green);margin-top:6px">✓ ' + records.length + ' notes imported</p>';
  showToast(records.length + ' notes imported ✓');
  await loadNotes();
}

function exportNotes() {
  if (!_allNotes.length) { showToast('No notes to export', 'error'); return; }
  const headers = ['customer_name', 'note', 'last_complaint_date'];
  const csv = [headers.join(','), ..._allNotes.map(n => headers.map(h => JSON.stringify(n[h] || '')).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = 'customer-notes-' + todayIST() + '.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Snapshots ──────────────────────────────────────────────────
async function loadSnapshots() {
  const sel = document.getElementById('snapshot-select');
  if (!sel) return;

  const { data, error } = await sb
    .from('operations_snapshots')
    .select('snapshot_at')
    .order('snapshot_at', { ascending: false })
    .limit(200);

  if (error || !data?.length) {
    sel.innerHTML = '<option value="">No snapshots yet</option>';
    return;
  }

  const timestamps = [...new Set(data.map(r => r.snapshot_at))];
  sel.innerHTML = timestamps.map(ts => {
    const d = new Date(ts);
    const label = d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
    return '<option value="' + ts + '">' + label + '</option>';
  }).join('');
}

async function restoreSnapshot() {
  const sel      = document.getElementById('snapshot-select');
  const statusEl = document.getElementById('restore-status');
  const ts       = sel.value;
  if (!ts) { showToast('Select a snapshot first', 'error'); return; }

  const label = sel.options[sel.selectedIndex].text;
  if (!confirm('Restore final quantities and statuses to snapshot from ' + label + '?\n\nThis only affects packer-entered data — orders are untouched.')) return;

  statusEl.innerHTML = '<p style="font-size:0.82rem;color:var(--text-muted);margin-top:8px">Restoring…</p>';

  const { data: snapRows, error: fetchErr } = await sb
    .from('operations_snapshots')
    .select('operation_id, final_quantity, status')
    .eq('snapshot_at', ts);

  if (fetchErr || !snapRows?.length) {
    statusEl.innerHTML = '<p style="font-size:0.82rem;color:var(--red);margin-top:8px">Failed to load snapshot</p>';
    return;
  }

  let failed = 0;
  await Promise.all(snapRows.map(async row => {
    const { error } = await sb
      .from('operations')
      .update({ final_quantity: row.final_quantity, status: row.status })
      .eq('id', row.operation_id);
    if (error) failed++;
  }));

  if (failed > 0) {
    statusEl.innerHTML = '<p style="font-size:0.82rem;color:var(--red);margin-top:8px">Restored with ' + failed + ' errors</p>';
  } else {
    statusEl.innerHTML = '<p style="font-size:0.82rem;color:var(--green);margin-top:8px">✓ Restored ' + snapRows.length + ' rows to ' + label + '</p>';
    showToast('Restored to ' + label + ' ✓');
  }
}

// ── Danger zone ────────────────────────────────────────────────
async function resetTodayStatus() {
  const today = todayIST();
  if (!confirm('Reset ALL items for ' + formatDate(today) + ' back to draft?')) return;
  const { error } = await sb.from('operations').update({ status: 'draft' }).eq('invoice_date', today);
  if (error) { showToast('Reset failed', 'error'); return; }
  showToast('All items reset to draft ✓');
}

// ── Fuzzy matching helpers ─────────────────────────────────────
function normalise(s) {
  return (s || '').toLowerCase().replace(/ +/g, ' ').trim();
}

function findCatalogMatch(csvName) {
  const n = normalise(csvName);
  const exact = catalogItems.find(i => normalise(i.item_name) === n);
  if (exact) return { catalogName: exact.item_name, confidence: 'exact' };
  const partial = catalogItems.find(i => {
    const cn = normalise(i.item_name);
    return cn.includes(n) || n.includes(cn);
  });
  if (partial) return { catalogName: partial.item_name, confidence: 'fuzzy' };
  return { catalogName: '', confidence: 'none' };
}

// ── CSV Import (direct DB write) ───────────────────────────────
let csvRows        = [];
let csvNameMapping = {};
let _parsedCsvRows = [];

function getDefaultDate() {
  const d = document.getElementById('csv-default-date');
  return (d && d.value) ? d.value : todayIST();
}

async function parseCsv(event) {
  const file = event.target.files ? event.target.files[0] : null;
  if (!file) return;

  const text  = await file.text();
  const lines = text.split('\n').map(l => l.endsWith('\r') ? l.slice(0, -1) : l).filter(l => l.trim());
  if (!lines.length) { showToast('Empty file', 'error'); return; }

  let startIdx = 0;
  const firstCols = lines[0].split(',').map(c => c.trim());
  if (isNaN(parseFloat(firstCols[2]))) startIdx = 1;

  const defaultDate = getDefaultDate();
  const parsed = [];
  const dateRe = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

  for (let i = startIdx; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim());
    if (cols.length < 3) continue;
    const customer_name = cols[0];
    const item_name     = cols[1];
    const qtyStr        = cols[2];
    const dateStr       = cols[3] || '';
    const qty  = parseFloat(qtyStr);
    const date = dateStr && dateRe.test(dateStr) ? dateStr : defaultDate;
    if (!customer_name || !item_name || isNaN(qty) || qty <= 0) continue;
    parsed.push({ customer_name, item_name, qty, date });
  }

  if (!parsed.length) { showToast('No valid rows found', 'error'); return; }

  _parsedCsvRows = parsed;
  const uniqueCsvNames = [...new Set(parsed.map(r => r.item_name))];
  csvNameMapping = {};
  uniqueCsvNames.forEach(name => { csvNameMapping[name] = findCatalogMatch(name).catalogName; });
  showMappingStep(uniqueCsvNames);
}

function showMappingStep(uniqueCsvNames) {
  const tbody = document.getElementById('csv-mapping-body');
  tbody.innerHTML = '';

  uniqueCsvNames.forEach(csvName => {
    const match      = findCatalogMatch(csvName);
    const confidence = match.confidence;
    const tr         = document.createElement('tr');

    const confLabel = confidence === 'exact'
      ? '<span style="color:var(--green);font-size:.75rem">✓ exact</span>'
      : confidence === 'fuzzy'
        ? '<span style="color:#d97706;font-size:.75rem">~ fuzzy</span>'
        : '<span style="color:var(--red);font-size:.75rem">✗ no match</span>';

    const sel = document.createElement('select');
    sel.style.cssText = 'width:100%;padding:5px 8px;border:1.5px solid var(--border);border-radius:6px;font-family:inherit;font-size:.85rem';
    sel.innerHTML = '<option value="">— not in catalog —</option>';
    catalogItems.filter(i => i.active).forEach(ci => {
      const opt = document.createElement('option');
      opt.value = ci.item_name;
      opt.textContent = ci.item_name + '  (₹' + parseFloat(ci.unit_price).toFixed(0) + '/' + ci.unit + ')';
      if (ci.item_name === match.catalogName) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => { csvNameMapping[csvName] = sel.value; });

    tr.innerHTML = '<td style="font-weight:500">' + escapeHtml(csvName) + '</td><td></td><td>' + confLabel + '</td>';
    tr.cells[1].appendChild(sel);
    tbody.appendChild(tr);
  });

  document.getElementById('csv-mapping-wrap').style.display = 'block';
  document.getElementById('csv-diff-wrap').style.display    = 'none';
}

async function confirmMapping() {
  const unmapped = Object.keys(csvNameMapping).filter(k => !csvNameMapping[k]);
  if (unmapped.length) {
    if (!confirm('These items have no catalog match and will be skipped:\n\n' + unmapped.join('\n') + '\n\nContinue?')) return;
  }

  const parsed = _parsedCsvRows
    .map(r => Object.assign({}, r, { item_name: csvNameMapping[r.item_name] || r.item_name }))
    .filter(r => csvNameMapping[r.item_name] !== '');

  document.getElementById('csv-mapping-wrap').style.display = 'none';

  const dates = [...new Set(parsed.map(r => r.date))];
  const names = [...new Set(parsed.map(r => r.customer_name))];

  const { data: existing } = await sb
    .from('order_items')
    .select('id, order_id, customer_name, item_name, requested_qty, status, item_status, order_date')
    .in('order_date', dates)
    .in('customer_name', names);

  const existingMap = {};
  (existing || []).forEach(e => {
    existingMap[e.customer_name + '|' + e.item_name + '|' + e.order_date] = e;
  });

  const { data: ofdItems } = await sb
    .from('order_items')
    .select('customer_name, order_date')
    .in('order_date', dates)
    .in('customer_name', names)
    .eq('status', 'ofd');

  const ofdKeys = new Set((ofdItems || []).map(o => o.customer_name + '|' + o.order_date));

  csvRows = [];
  parsed.forEach(row => {
    const key    = row.customer_name + '|' + row.item_name + '|' + row.date;
    const old    = existingMap[key];
    const ofdKey = row.customer_name + '|' + row.date;
    if (old) {
      if (Math.abs(parseFloat(old.requested_qty) - row.qty) < 0.001) {
        csvRows.push(Object.assign({}, row, { _state: 'dup', _existingId: old.id, _include: false }));
      } else {
        csvRows.push(Object.assign({}, row, { _state: 'changed', _existingId: old.id, _include: true, _oldQty: old.requested_qty, _ofd: ofdKeys.has(ofdKey) }));
      }
    } else {
      csvRows.push(Object.assign({}, row, { _state: 'new', _include: true, _ofd: ofdKeys.has(ofdKey) }));
    }
  });

  const displayRows = [];
  csvRows.forEach(row => {
    if (row._state === 'changed') {
      const old = (existing || []).find(e =>
        e.customer_name === row.customer_name && e.item_name === row.item_name && String(e.order_date) === row.date
      );
      if (old) displayRows.push(Object.assign({}, old, { _state: 'removed', _include: false, date: row.date, _displayQty: old.requested_qty }));
    }
    displayRows.push(row);
  });

  renderDiffTable(displayRows);
  if (ofdKeys.size > 0) document.getElementById('csv-ofd-warning').style.display = 'block';
  document.getElementById('csv-diff-wrap').style.display = 'block';
  window._csvDisplayRows = displayRows;
}

function renderDiffTable(displayRows) {
  const tbody = document.getElementById('csv-diff-body');
  tbody.innerHTML = '';
  displayRows.forEach((row, idx) => {
    const tr = document.createElement('tr');
    tr.className = row._state === 'new' || row._state === 'changed' ? 'diff-row-new'
      : row._state === 'removed' ? 'diff-row-removed' : 'diff-row-dup';

    const canToggle  = row._state !== 'removed';
    const isIncluded = row._include !== false;
    const qtyDisplay = row._displayQty !== undefined ? row._displayQty : (row.qty !== undefined ? row.qty : (row.requested_qty !== undefined ? row.requested_qty : '—'));
    const labels = { new: '+ New', removed: '× Replaced', dup: '= Duplicate' };
    const statusLabel = row._state === 'changed'
      ? '↳ ' + (row._oldQty || '?') + ' → ' + row.qty
      : (labels[row._state] || row._state);

    tr.innerHTML =
      '<td>' + (canToggle ? '<input type="checkbox" ' + (isIncluded ? 'checked' : '') + ' onchange="toggleCsvRow(' + idx + ', this.checked)">' : '') + '</td>' +
      '<td>' + escapeHtml(row.customer_name) + '</td>' +
      '<td>' + escapeHtml(row.item_name) + '</td>' +
      '<td>' + qtyDisplay + '</td>' +
      '<td>' + (row.date || row.order_date || '') + '</td>' +
      '<td style="font-size:0.78rem;white-space:nowrap">' + statusLabel + (row._ofd ? ' <span style="color:#1d4ed8">· OFD!</span>' : '') + '</td>';
    tbody.appendChild(tr);
  });
}

function toggleCsvRow(idx, checked) {
  if (window._csvDisplayRows && window._csvDisplayRows[idx]) window._csvDisplayRows[idx]._include = checked;
}

function clearCsvImport() {
  csvRows = []; _parsedCsvRows = []; csvNameMapping = {}; window._csvDisplayRows = [];
  document.getElementById('csv-mapping-wrap').style.display = 'none';
  document.getElementById('csv-diff-wrap').style.display    = 'none';
  document.getElementById('csv-ofd-warning').style.display  = 'none';
  document.getElementById('csv-diff-body').innerHTML        = '';
  document.getElementById('csv-mapping-body').innerHTML     = '';
  const f = document.getElementById('csv-file');
  if (f) f.value = '';
}

async function saveCsvImport() {
  const toSave = (window._csvDisplayRows || []).filter(r => r._include && r._state !== 'removed');
  if (!toSave.length) { showToast('Nothing to save', 'error'); return; }

  const ofdRows = toSave.filter(r => r._ofd);
  if (ofdRows.length) {
    if (!confirm('⚠️ ' + ofdRows.length + ' customer(s) have OFD orders on the same date. Save anyway?\n\n' +
      ofdRows.map(r => r.customer_name + ' - ' + r.item_name).join('\n'))) return;
  }

  const btn = document.getElementById('csv-save-btn');
  btn.textContent = 'Saving…'; btn.disabled = true;

  try {
    for (const row of toSave.filter(r => r._state === 'changed' && r._existingId)) {
      await sb.from('order_items').update({
        item_status: 'REMOVED',
        description: 'Replaced: weight changed from ' + row._oldQty + ' to ' + row.qty,
      }).eq('id', row._existingId);
    }

    const byCustomer = {};
    toSave.forEach(row => {
      const key = row.customer_name + '|' + row.date;
      if (!byCustomer[key]) byCustomer[key] = { customer_name: row.customer_name, date: row.date, items: [] };
      byCustomer[key].items.push(row);
    });

    for (const { customer_name, date, items } of Object.values(byCustomer)) {
      let orderId;
      const { data: existingOrder } = await sb
        .from('orders').select('sales_id')
        .eq('order_date', date).eq('customer_name', customer_name).maybeSingle();

      if (existingOrder) {
        orderId = existingOrder.sales_id;
      } else {
        const safeName = customer_name.split(' ').join('-');
        let salesId = date + '-' + safeName;
        let suffix  = 1;
        while (true) {
          const { data: hit } = await sb.from('orders').select('sales_id').eq('sales_id', salesId).maybeSingle();
          if (!hit) break;
          salesId = date + '-' + safeName + '-' + (++suffix);
        }
        const parts = customer_name.split(' ');
        await sb.from('orders').insert({
          sales_id: salesId, customer_name,
          community: parts.length > 1 ? parts.slice(0, -1).join(' ') : customer_name,
          payment_method: 'cod', status: 'placed',
          order_date: date, cart: [], total: 0,
        });
        orderId = salesId;
      }

      const newItems = items.map(row => {
        const cat   = catalogItems.find(c => c.item_name === row.item_name);
        const parts = row.customer_name.split(' ');
        return {
          order_id:      orderId,
          order_date:    date,
          customer_name,
          community:     parts.length > 1 ? parts.slice(0, -1).join(' ') : customer_name,
          item_name:     row.item_name,
          description:   row._state === 'changed' ? 'Weight changed from ' + row._oldQty + ' to ' + row.qty : null,
          requested_qty: row.qty,
          unit_price:    cat ? cat.unit_price : null,
          final_qty:     null,
          status:        'open',
        };
      });

      const { error } = await sb.from('order_items').insert(newItems);
      if (error) throw new Error(error.message);
    }

    showToast(toSave.length + ' item' + (toSave.length !== 1 ? 's' : '') + ' imported ✓');
    clearCsvImport();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.textContent = 'Save Import'; btn.disabled = false;
  }
}

// ── CSV parser utility ─────────────────────────────────────────
function parseCSV(text) {
  const lines = text.split('\n').map(l => l.endsWith('\r') ? l.slice(0, -1) : l);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/^"|"$/g, ''));
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    const obj  = {};
    headers.forEach((h, i) => { obj[h] = vals[i] !== undefined ? vals[i] : ''; });
    return obj;
  });
}

// ── Utility ────────────────────────────────────────────────────
function escapeAttr(s) {
  return (s || '').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
