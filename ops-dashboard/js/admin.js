// ── Password gate ──────────────────────────────────────────────
let adminPassword = null;

// Auto-unlock if a verified password exists and is less than 24 hours old
(async function tryAutoUnlock() {
  const stored    = localStorage.getItem('adminPw');
  const storedAt  = parseInt(localStorage.getItem('adminPwAt') || '0', 10);
  const age       = Date.now() - storedAt;
  if (!stored || age > 24 * 60 * 60 * 1000) {
    localStorage.removeItem('adminPw');
    localStorage.removeItem('adminPwAt');
    return;
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/upload-orders`, {
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
  } catch (_) { /* network error — fall through to manual gate */ }
})();

async function checkPassword() {
  const input  = document.getElementById('admin-password');
  const btn    = document.querySelector('#password-screen button');
  const errEl  = document.getElementById('pw-error');
  const pw     = input.value;
  if (!pw) return;

  btn.disabled = true;
  btn.textContent = 'Checking…';
  errEl.style.display = 'none';

  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/upload-orders`, {
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

// ── Load everything ────────────────────────────────────────────
async function loadAll() {
  const dateInput = document.getElementById('voice-order-date');
  if (dateInput && !dateInput.value) dateInput.value = todayIST();
  await Promise.all([loadPackers(), loadAssignments(), loadNotes(), loadSnapshots()]);
}

// ── Upload tab switching ───────────────────────────────────────
function switchUploadTab(tab) {
  document.getElementById('upload-panel-csv').classList.toggle('hidden', tab !== 'csv');
  document.getElementById('upload-panel-voice').classList.toggle('hidden', tab !== 'voice');
  document.getElementById('tab-csv').classList.toggle('active', tab === 'csv');
  document.getElementById('tab-voice').classList.toggle('active', tab === 'voice');
}

// ── Daily orders CSV upload — now shows preview ───────────────
async function uploadOrders() {
  const fileInput = document.getElementById('orders-csv');
  const statusEl  = document.getElementById('orders-upload-status');

  if (!fileInput.files.length) { showToast('Select a CSV file first', 'error'); return; }

  const text = await fileInput.files[0].text();
  const rows  = parseCSV(text);

  if (!rows.length) { showToast('CSV appears empty', 'error'); return; }

  const headers = Object.keys(rows[0]).map(h => h.trim().toLowerCase());
  const missing = ['sales_order', 'order_date', 'customer_name', 'item_name', 'quantity'].filter(c => !headers.includes(c));
  if (missing.length) { showToast(`Missing columns: ${missing.join(', ')}`, 'error'); return; }

  const records = rows.map(r => ({
    sales_order_id:     (r['sales_order']   || '').trim(),
    invoice_date:       (r['order_date']     || '').trim(),
    customer_name:      (r['customer_name']  || '').trim(),
    item_name:          (r['item_name']      || '').trim(),
    description:        (r['description']    || '').trim() || null,
    requested_quantity: parseFloat(r['quantity']) || 0,
    status:             'draft',
  })).filter(r => r.sales_order_id && r.customer_name && r.item_name);

  if (!records.length) { showToast('No valid rows found in CSV', 'error'); return; }

  statusEl.innerHTML = '';
  showPreview(records, 'csv');
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
  _recognition.continuous    = true;
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

// ── Parse voice/text orders ────────────────────────────────────
async function parseVoiceOrders() {
  if (_isRecording) stopVoiceInput();

  const text     = document.getElementById('voice-order-text').value.trim();
  const date     = document.getElementById('voice-order-date').value || todayIST();
  const statusEl = document.getElementById('voice-parse-status');
  const btn      = document.getElementById('voice-parse-btn');

  if (!text) { showToast('Enter or speak some orders first', 'error'); return; }

  btn.disabled    = true;
  btn.textContent = 'Parsing…';
  statusEl.innerHTML = `<p style="font-size:0.82rem;color:var(--text-muted);margin-top:8px">Fetching Zoho catalog and parsing with AI…</p>`;

  try {
    const res    = await fetch(`${SUPABASE_URL}/functions/v1/parse-orders`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON },
      body:    JSON.stringify({ text, date }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Parse failed');
    if (!result.orders?.length) throw new Error('No orders could be extracted from that text');

    const catalogNote = result.zohoItemCount
      ? `Matched against ${result.zohoItemCount} Zoho items`
      : 'No Zoho catalog — item names may need review';
    statusEl.innerHTML = `<p style="font-size:0.82rem;color:var(--text-muted);margin-top:8px">${catalogNote}</p>`;

    showPreview(result.orders, 'voice');
  } catch (e) {
    statusEl.innerHTML = `<p style="font-size:0.82rem;color:var(--red);margin-top:8px">Error: ${e.message}</p>`;
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
  const hasMed = source === 'voice' && orders.some(o => o._confidence === 'medium');

  let statsText = `${orders.length} row${orders.length !== 1 ? 's' : ''}`;
  if (source === 'voice') {
    if (hasLow)       statsText += ' · ⚠️ review red rows (low confidence)';
    else if (hasMed)  statsText += ' · review amber rows';
  }
  document.getElementById('preview-stats').textContent = statsText;

  document.getElementById('preview-modal-body').innerHTML = buildPreviewTable(orders, source);
  updatePreviewCount();
  document.getElementById('orders-preview-modal').classList.remove('hidden');
}

function buildPreviewTable(orders, source) {
  const showConf = source === 'voice';
  const rows = orders.map((o, idx) => {
    const conf     = o._confidence || 'high';
    const rowClass = conf === 'low' ? 'conf-low' : conf === 'medium' ? 'conf-medium' : '';
    const badge    = showConf
      ? `<span class="conf-badge conf-${conf}">${conf}</span>`
      : '';
    const note     = showConf && o._match_note
      ? `<div style="font-size:0.72rem;color:var(--text-muted);margin-top:2px">${escapeHtml(o._match_note)}</div>`
      : '';
    const descText = o.description || '';
    const descCell = descText
      ? `<span style="font-size:0.75rem;color:var(--text-muted)" title="${escapeHtml(descText)}">${escapeHtml(descText.substring(0, 48))}${descText.length > 48 ? '…' : ''}</span>`
      : '—';

    return `
      <tr class="${rowClass}" id="preview-row-${idx}">
        <td style="text-align:center;width:36px">
          <button class="btn btn-sm btn-danger" onclick="deletePreviewRow(${idx})" title="Remove">×</button>
        </td>
        <td style="font-weight:500;white-space:nowrap">${escapeHtml(o.customer_name)}</td>
        <td>${escapeHtml(o.item_name)}${badge}${note}</td>
        <td>
          <input type="number" class="preview-qty-input" value="${o.requested_quantity}"
            min="0" step="0.01" onchange="updatePreviewQty(${idx}, this.value)">
        </td>
        <td style="color:var(--text-muted);white-space:nowrap;font-size:0.8rem">${o.invoice_date || ''}</td>
        <td style="max-width:180px">${descCell}</td>
      </tr>`;
  }).join('');

  return `
    <table class="preview-table">
      <thead>
        <tr>
          <th></th>
          <th>Customer</th>
          <th>Item</th>
          <th>Qty</th>
          <th>Date</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function deletePreviewRow(idx) {
  _previewDeleted.add(idx);
  const row = document.getElementById(`preview-row-${idx}`);
  if (row) row.classList.add('preview-deleted');
  updatePreviewCount();
}

function updatePreviewQty(idx, val) {
  _previewOrders[idx].requested_quantity = parseFloat(val) || 0;
}

function updatePreviewCount() {
  const active = _previewOrders.length - _previewDeleted.size;
  document.getElementById('preview-row-count').textContent =
    `${active} of ${_previewOrders.length} rows will be uploaded`;
}

function closePreview() {
  document.getElementById('orders-preview-modal').classList.add('hidden');
}

// ── Confirm upload from preview ────────────────────────────────
async function confirmUpload() {
  const records = _previewOrders
    .filter((_, idx) => !_previewDeleted.has(idx))
    .map(({ _confidence, _match_note, ...r }) => r)
    .filter(r => r.sales_order_id && r.customer_name && r.item_name && r.requested_quantity > 0);

  if (!records.length) { showToast('No rows to upload', 'error'); return; }

  const btn = document.getElementById('preview-confirm-btn');
  btn.disabled    = true;
  btn.textContent = 'Uploading…';

  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/upload-orders`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON },
      body:    JSON.stringify({ password: adminPassword, records }),
    });
    const result = await res.json();

    if (!res.ok) {
      showToast(`Upload failed: ${result.error}`, 'error');
      return;
    }

    closePreview();
    const uploadDate = records[0]?.invoice_date;
    document.getElementById('orders-upload-status').innerHTML =
      `<p style="font-size:0.82rem;color:var(--green);margin-top:8px">✓ ${result.inserted} orders uploaded${uploadDate ? ' for ' + formatDate(uploadDate) : ''}</p>`;
    showToast(`${result.inserted} orders uploaded ✓`);
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
    row.id = `packer-row-${p.id}`;
    row.innerHTML = `
      <span>${p.name}</span>
      <div style="display:flex;gap:8px;align-items:center">
        <label style="font-size:0.82rem;display:flex;align-items:center;gap:4px;cursor:pointer">
          <input type="checkbox" ${p.active ? 'checked' : ''}
            onchange="togglePackerActive('${p.id}', this.checked)">
          Active
        </label>
        <button class="btn btn-sm btn-danger" onclick="deletePacker('${p.id}', '${escapeAttr(p.name)}')">Remove</button>
      </div>
    `;
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
  showToast(`${name} added ✓`);
  await loadPackers();
}

async function togglePackerActive(id, active) {
  const { error } = await sb.from('packers').update({ active }).eq('id', id);
  if (error) showToast('Update failed', 'error');
}

async function deletePacker(id, name) {
  if (!confirm(`Remove packer "${name}"? Their assignments will also be removed.`)) return;
  await sb.from('packer_assignments').delete().eq('packer_id', id);
  const { error } = await sb.from('packers').delete().eq('id', id);
  if (error) { showToast('Delete failed', 'error'); return; }
  showToast(`${name} removed`);
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
    row.innerHTML = `
      <div>
        <span style="font-weight:500">${a.item_name}</span>
        <span style="font-size:0.8rem;color:var(--text-muted);margin-left:8px">→ ${a.packers?.name ?? '?'}</span>
      </div>
      <button class="btn btn-sm btn-danger" onclick="deleteAssignment('${a.id}', '${escapeAttr(a.item_name)}')">Remove</button>
    `;
    list.appendChild(row);
  });
}

async function addAssignment() {
  const packerId   = document.getElementById('assign-packer').value;
  const fruitInput = document.getElementById('assign-fruit');
  const itemName   = fruitInput.value.trim();

  if (!packerId) { showToast('Select a packer', 'error'); return; }
  if (!itemName) { showToast('Enter a fruit name', 'error'); return; }

  const { error } = await sb.from('packer_assignments').insert({ packer_id: packerId, item_name: itemName });
  if (error) {
    showToast(error.code === '23505' ? 'Already assigned' : 'Failed to assign', 'error');
    return;
  }

  fruitInput.value = '';
  showToast(`${itemName} assigned ✓`);
  await loadAssignments();
}

async function deleteAssignment(id, itemName) {
  const { error } = await sb.from('packer_assignments').delete().eq('id', id);
  if (error) { showToast('Delete failed', 'error'); return; }
  showToast(`${itemName} unassigned`);
  await loadAssignments();
}

// ── Customer Notes & History ───────────────────────────────────
let _allNotes = [];

async function loadNotes() {
  const { data, error } = await sb
    .from('customer_notes')
    .select('id, customer_name, note, last_complaint_date')
    .order('updated_at', { ascending: false });

  if (error) {
    document.getElementById('notes-preview').innerHTML =
      `<p style="font-size:0.82rem;color:var(--red);padding:10px">Error loading notes: ${error.message}</p>`;
    return;
  }

  _allNotes = data || [];
  renderNotesPreview(_allNotes.slice(0, 10));
  renderNotesTable(_allNotes);
}

function renderNotesPreview(notes) {
  const wrap = document.getElementById('notes-preview');
  if (!notes.length) {
    wrap.innerHTML = '<p style="font-size:0.85rem;color:var(--text-muted);padding:12px">No notes yet</p>';
    return;
  }
  wrap.innerHTML = `
    <table class="notes-table">
      <thead><tr><th>Customer</th><th>Note</th><th>Last complaint</th></tr></thead>
      <tbody>${notes.map(n => `
        <tr>
          <td style="font-weight:500;white-space:nowrap">${escapeHtml(n.customer_name)}</td>
          <td style="max-width:260px;word-break:break-word">${escapeHtml(n.note)}</td>
          <td style="color:var(--text-muted);white-space:nowrap;font-size:0.8rem">${n.last_complaint_date || '—'}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

function renderNotesTable(notes) {
  const wrap = document.getElementById('notes-table-wrap');
  if (!wrap) return;
  if (!notes.length) {
    wrap.innerHTML = '<p style="font-size:0.85rem;color:var(--text-muted);padding:12px">No notes yet</p>';
    return;
  }
  wrap.innerHTML = `
    <table class="notes-table">
      <thead><tr><th>Customer</th><th>Note</th><th>Last complaint</th><th></th></tr></thead>
      <tbody>${notes.map(n => noteRow(n)).join('')}</tbody>
    </table>`;
}

function noteRow(n) {
  return `
    <tr id="note-row-${n.id}">
      <td style="font-weight:500;white-space:nowrap">${escapeHtml(n.customer_name)}</td>
      <td style="max-width:240px;word-break:break-word">${escapeHtml(n.note)}</td>
      <td style="color:var(--text-muted);white-space:nowrap;font-size:0.8rem">${n.last_complaint_date || '—'}</td>
      <td style="white-space:nowrap;display:flex;gap:4px">
        <button class="btn btn-sm btn-secondary" onclick="startEditNote('${n.id}')">Edit</button>
        <button class="btn btn-sm btn-danger" onclick="deleteNote('${n.id}')">×</button>
      </td>
    </tr>`;
}

function startEditNote(id) {
  const n = _allNotes.find(n => n.id === id);
  if (!n) return;
  const row = document.getElementById(`note-row-${id}`);
  row.innerHTML = `
    <td style="font-weight:500;white-space:nowrap">${escapeHtml(n.customer_name)}</td>
    <td><input type="text" value="${escapeHtml(n.note)}" id="edit-note-${id}"
      style="width:100%;padding:5px 8px;border:1.5px solid var(--brand);border-radius:6px;font-size:0.85rem;font-family:'DM Sans',sans-serif"></td>
    <td><input type="date" value="${n.last_complaint_date || ''}" id="edit-date-${id}"
      style="padding:5px 8px;border:1.5px solid var(--border);border-radius:6px;font-size:0.82rem;font-family:'DM Sans',sans-serif"></td>
    <td style="white-space:nowrap;display:flex;gap:4px">
      <button class="btn btn-sm btn-primary" onclick="commitEditNote('${id}')">Save</button>
      <button class="btn btn-sm btn-secondary" onclick="renderNotesTable(_allNotes)">Cancel</button>
    </td>`;
  document.getElementById(`edit-note-${id}`).focus();
}

async function commitEditNote(id) {
  const note = document.getElementById(`edit-note-${id}`)?.value.trim();
  const date = document.getElementById(`edit-date-${id}`)?.value || null;
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
    statusEl.innerHTML = `<p style="font-size:0.82rem;color:var(--red)">${error.message}</p>`;
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

  statusEl.innerHTML = `<p style="font-size:0.82rem;color:var(--text-muted);margin-top:6px">Importing ${records.length} rows…</p>`;

  const { error } = await sb.from('customer_notes').upsert(records, { onConflict: 'customer_name' });
  if (error) {
    statusEl.innerHTML = `<p style="font-size:0.82rem;color:var(--red);margin-top:6px">Import failed: ${error.message}</p>`;
    return;
  }

  fileInput.value = '';
  statusEl.innerHTML = `<p style="font-size:0.82rem;color:var(--green);margin-top:6px">✓ ${records.length} notes imported</p>`;
  showToast(`${records.length} notes imported ✓`);
  await loadNotes();
}

function exportNotes() {
  if (!_allNotes.length) { showToast('No notes to export', 'error'); return; }

  const headers = ['customer_name', 'note', 'last_complaint_date'];
  const csv = [
    headers.join(','),
    ..._allNotes.map(n => headers.map(h => JSON.stringify(n[h] ?? '')).join(',')),
  ].join('\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = `customer-notes-${todayIST()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Snapshots ──────────────────────────────────────────────────
async function loadSnapshots() {
  const sel = document.getElementById('snapshot-select');

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
    const label = d.toLocaleString('en-IN', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true,
    });
    return `<option value="${ts}">${label}</option>`;
  }).join('');
}

async function restoreSnapshot() {
  const sel      = document.getElementById('snapshot-select');
  const statusEl = document.getElementById('restore-status');
  const ts       = sel.value;

  if (!ts) { showToast('Select a snapshot first', 'error'); return; }

  const label = sel.options[sel.selectedIndex].text;
  if (!confirm(`Restore final quantities and statuses to snapshot from ${label}?\n\nThis only affects packer-entered data — orders are untouched.`)) return;

  statusEl.innerHTML = `<p style="font-size:0.82rem;color:var(--text-muted);margin-top:8px">Restoring…</p>`;

  const { data: snapRows, error: fetchErr } = await sb
    .from('operations_snapshots')
    .select('operation_id, final_quantity, status')
    .eq('snapshot_at', ts);

  if (fetchErr || !snapRows?.length) {
    statusEl.innerHTML = `<p style="font-size:0.82rem;color:var(--red);margin-top:8px">Failed to load snapshot</p>`;
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
    statusEl.innerHTML = `<p style="font-size:0.82rem;color:var(--red);margin-top:8px">Restored with ${failed} errors</p>`;
  } else {
    statusEl.innerHTML = `<p style="font-size:0.82rem;color:var(--green);margin-top:8px">✓ Restored ${snapRows.length} rows to ${label}</p>`;
    showToast(`Restored to ${label} ✓`);
  }
}

// ── Danger zone ────────────────────────────────────────────────
async function resetTodayStatus() {
  const today = todayIST();
  if (!confirm(`Reset ALL items for ${formatDate(today)} back to draft?`)) return;

  const { error } = await sb
    .from('operations')
    .update({ status: 'draft' })
    .eq('invoice_date', today);

  if (error) { showToast('Reset failed', 'error'); return; }
  showToast('All items reset to draft ✓');
}

// ── CSV parser ─────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    const obj  = {};
    headers.forEach((h, i) => { obj[h] = vals[i] ?? ''; });
    return obj;
  });
}

// ── Utility ────────────────────────────────────────────────────
function escapeAttr(s) {
  return (s || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
