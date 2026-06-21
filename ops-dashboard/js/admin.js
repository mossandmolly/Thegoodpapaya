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

// ── Invoice Status Panel ───────────────────────────────────────
let _invPendingIds = [];

async function loadInvoiceStatus() {
  const dateEl = document.getElementById('inv-date');
  const date   = dateEl ? dateEl.value : todayIST();
  if (!date) return;

  const wrap = document.getElementById('inv-table-wrap');
  const sumEl = document.getElementById('inv-summary');
  if (!wrap) return;

  // Query orders for this date, embed invoice_queue row via FK relationship
  const { data: orders, error } = await sb
    .from('orders')
    .select('sales_order_id, customer_name, invoice_status, invoice_number, zoho_invoice_id, invoice_total, order_date, invoice_queue(status, error_message, retry_count, updated_at)')
    .eq('order_date', date)
    .order('customer_name');

  if (error) {
    wrap.innerHTML = '<p style="font-size:.82rem;color:var(--red)">' + error.message + '</p>';
    return;
  }

  if (!orders || !orders.length) {
    wrap.innerHTML = '<p style="font-size:.85rem;color:var(--text-muted)">No orders for ' + date + '</p>';
    if (sumEl) sumEl.innerHTML = '';
    const queueBtn = document.getElementById('inv-queue-all-btn');
    if (queueBtn) queueBtn.style.display = 'none';
    return;
  }

  // Count statuses
  const counts = { pending: 0, queued: 0, processing: 0, done: 0, failed: 0 };
  _invPendingIds = [];
  orders.forEach(o => {
    const s = o.invoice_status || 'pending';
    counts[s] = (counts[s] || 0) + 1;
    if (s === 'pending' || s === 'failed') _invPendingIds.push(o.sales_order_id);
  });

  // Summary chips
  if (sumEl) {
    const chipDef = [
      { key: 'done',       label: 'done',       cls: 'inv-done' },
      { key: 'processing', label: 'processing',  cls: 'inv-processing' },
      { key: 'queued',     label: 'queued',      cls: 'inv-queued' },
      { key: 'failed',     label: 'failed',      cls: 'inv-failed' },
      { key: 'pending',    label: 'pending',     cls: 'inv-pending' },
    ];
    sumEl.innerHTML = chipDef
      .filter(c => counts[c.key] > 0)
      .map(c => '<span class="sum-chip inv-badge ' + c.cls + '"><span class="inv-dot"></span>' + counts[c.key] + ' ' + c.label + '</span>')
      .join('');
  }

  // Queue button: show if any pending or failed
  const queueBtn = document.getElementById('inv-queue-all-btn');
  if (queueBtn) {
    const actionable = _invPendingIds.length;
    queueBtn.style.display = actionable ? 'inline-flex' : 'none';
    queueBtn.textContent   = 'Queue ' + actionable + ' pending';
  }

  // Table
  let rows = '';
  orders.forEach(o => {
    const status   = o.invoice_status || 'pending';
    const qRow     = Array.isArray(o.invoice_queue) ? o.invoice_queue[0] : o.invoice_queue;
    const retries  = qRow ? qRow.retry_count : 0;
    const errMsg   = qRow ? qRow.error_message : null;
    const updatedAt = qRow ? new Date(qRow.updated_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—';

    const badgeLabel = { pending: 'pending', queued: 'queued', processing: 'processing…', done: '✓ done', failed: '✗ failed' }[status] || status;
    const badge = '<span class="inv-badge inv-' + status + '"><span class="inv-dot"></span>' + badgeLabel + '</span>';

    const invoiceCell = o.zoho_invoice_id
      ? '<a href="https://books.zoho.in/app#/invoices/' + o.zoho_invoice_id + '" target="_blank" rel="noopener" style="color:var(--brand);font-size:.82rem">' + escapeHtml(o.invoice_number || o.zoho_invoice_id) + ' ↗</a>'
      : '<span style="color:var(--text-muted)">—</span>';

    const totalCell = o.invoice_total != null
      ? '₹' + Number(o.invoice_total).toLocaleString('en-IN')
      : '—';

    const errorCell = errMsg
      ? '<span style="font-size:.72rem;color:var(--red)" title="' + escapeAttr(errMsg) + '">' + escapeHtml(errMsg.substring(0, 50)) + (errMsg.length > 50 ? '…' : '') + '</span>'
      : '—';

    const retryBadge = retries > 0
      ? '<span style="font-size:.7rem;color:var(--text-muted);margin-left:4px">' + retries + '/3</span>'
      : '';

    const actionCell = (status === 'failed' || status === 'pending')
      ? '<button class="btn btn-sm btn-secondary" onclick="retryInvoice(\'' + escapeAttr(o.sales_order_id) + '\')">Retry</button>'
      : '';

    rows += '<tr>' +
      '<td style="font-weight:500;white-space:nowrap">' + escapeHtml(o.customer_name) + '</td>' +
      '<td>' + badge + retryBadge + '</td>' +
      '<td>' + invoiceCell + '</td>' +
      '<td style="font-size:.82rem;color:var(--text-muted)">' + totalCell + '</td>' +
      '<td>' + errorCell + '</td>' +
      '<td style="font-size:.72rem;color:var(--text-muted);white-space:nowrap">' + updatedAt + '</td>' +
      '<td>' + actionCell + '</td>' +
      '</tr>';
  });

  wrap.innerHTML =
    '<table class="diff-table" style="min-width:560px">' +
    '<thead><tr><th>Customer</th><th>Status</th><th>Invoice</th><th>Total</th><th>Error</th><th>Updated</th><th></th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>';
}

async function queueAllPending() {
  if (!_invPendingIds.length) return;
  const btn = document.getElementById('inv-queue-all-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Queuing…'; }

  try {
    const res = await fetch(SUPABASE_URL + '/functions/v1/queue-invoices', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON },
      body:    JSON.stringify({ sales_order_ids: _invPendingIds }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Queue failed');
    showToast(data.queued + ' orders queued — processing started');
    await loadInvoiceStatus();
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; }
  }
}

async function retryInvoice(salesOrderId) {
  try {
    const res = await fetch(SUPABASE_URL + '/functions/v1/queue-invoices', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON },
      body:    JSON.stringify({ sales_order_ids: [salesOrderId] }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Retry failed');
    showToast('Retrying ' + salesOrderId);
    await loadInvoiceStatus();
  } catch (e) {
    showToast(e.message, 'error');
  }
}


// ── Held Items ─────────────────────────────────────────────────
async function loadHeldItems() {
  const listEl = document.getElementById('held-items-list');
  if (!listEl) return;
  listEl.innerHTML = '<div class="skeleton" style="height:40px"></div>';

  const { data, error } = await sb
    .from('operations')
    .select('id, sales_order_id, invoice_date, customer_name, item_name, requested_quantity')
    .eq('status', 'held')
    .order('invoice_date', { ascending: false })
    .order('customer_name');

  if (error) {
    listEl.innerHTML = '<p style="font-size:.82rem;color:var(--red)">' + error.message + '</p>';
    return;
  }

  if (!data || !data.length) {
    listEl.innerHTML = '<p style="font-size:.85rem;color:var(--text-muted)">No held items ✓</p>';
    return;
  }

  let rows = '';
  data.forEach(item => {
    rows +=
      '<tr>' +
      '<td style="color:var(--text-muted);font-size:.82rem;white-space:nowrap">' + item.invoice_date + '</td>' +
      '<td style="font-weight:500;white-space:nowrap">' + escapeHtml(item.customer_name) + '</td>' +
      '<td>' + escapeHtml(item.item_name) + '</td>' +
      '<td style="text-align:right">' + item.requested_quantity + '</td>' +
      '<td style="white-space:nowrap">' +
        '<button class="btn btn-sm btn-success" style="margin-right:4px" onclick="approveHeld(\'' + escapeAttr(item.id) + '\')">Approve</button>' +
        '<button class="btn btn-sm btn-danger" onclick="dismissHeld(\'' + escapeAttr(item.id) + '\')">Dismiss</button>' +
      '</td>' +
      '</tr>';
  });

  listEl.innerHTML =
    '<table class="diff-table">' +
    '<thead><tr><th>Date</th><th>Customer</th><th>Item</th><th>Qty</th><th>Actions</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>';
}

async function approveHeld(id) {
  const { error } = await sb.from('operations').update({ status: 'draft' }).eq('id', id);
  if (error) { showToast('Failed to approve', 'error'); return; }
  showToast('Item approved ✓');
  await loadHeldItems();
}

async function dismissHeld(id) {
  const { error } = await sb.from('operations').delete().eq('id', id);
  if (error) { showToast('Failed to dismiss', 'error'); return; }
  showToast('Item dismissed');
  await loadHeldItems();
}

// ── Today's Orders ─────────────────────────────────────────────
async function loadTodayOrders() {
  const dateEl = document.getElementById('orders-date');
  const date   = dateEl ? dateEl.value : todayIST();
  if (!date) return;

  const listEl = document.getElementById('orders-list');
  if (!listEl) return;
  listEl.innerHTML = '<div class="skeleton" style="height:40px"></div>';

  const { data: orders, error } = await sb
    .from('orders')
    .select('sales_order_id, customer_name, source, invoice_status, zoho_invoice_id, invoice_number, invoice_total, razorpay_link_id')
    .eq('order_date', date)
    .order('customer_name');

  if (error) {
    listEl.innerHTML = '<p style="font-size:.82rem;color:var(--red)">' + error.message + '</p>';
    return;
  }

  if (!orders || !orders.length) {
    listEl.innerHTML = '<p style="font-size:.85rem;color:var(--text-muted)">No orders for ' + date + '</p>';
    return;
  }

  let rows = '';
  orders.forEach(o => {
    const status = o.invoice_status || 'pending';
    const badgeLabel = { pending: 'pending', queued: 'queued', processing: 'processing…', done: '✓ done', failed: '✗ failed' }[status] || status;
    const badge = '<span class="inv-badge inv-' + status + '"><span class="inv-dot"></span>' + badgeLabel + '</span>';

    const invoiceCell = o.zoho_invoice_id
      ? '<a href="https://books.zoho.in/app#/invoices/' + o.zoho_invoice_id + '" target="_blank" rel="noopener" style="color:var(--brand);font-size:.82rem">' + escapeHtml(o.invoice_number || o.zoho_invoice_id) + ' ↗</a>'
      : '<span style="color:var(--text-muted)">—</span>';

    const totalCell = o.invoice_total != null
      ? '₹' + Number(o.invoice_total).toLocaleString('en-IN')
      : '—';

    rows +=
      '<tr>' +
      '<td style="font-weight:500;white-space:nowrap">' + escapeHtml(o.customer_name) + '</td>' +
      '<td style="color:var(--text-muted);font-size:.8rem">' + escapeHtml(o.source || '') + '</td>' +
      '<td>' + badge + '</td>' +
      '<td>' + invoiceCell + '</td>' +
      '<td style="font-size:.82rem">' + totalCell + '</td>' +
      '<td><button class="btn btn-sm btn-danger" onclick="cancelOrder(\'' + escapeAttr(o.sales_order_id) + '\')">Cancel</button></td>' +
      '</tr>';
  });

  listEl.innerHTML =
    '<div style="overflow-x:auto"><table class="diff-table" style="min-width:520px">' +
    '<thead><tr><th>Customer</th><th>Source</th><th>Invoice</th><th>Inv #</th><th>Total</th><th></th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div>';
}

async function cancelOrder(salesOrderId) {
  if (!confirm('Cancel order for ' + salesOrderId + '?\n\nThis will delete the Zoho invoice, cancel the Razorpay link, and remove all operations and order records.\n\nThis cannot be undone.')) return;

  try {
    const res = await fetch(SUPABASE_URL + '/functions/v1/cancel-order', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON },
      body:    JSON.stringify({ sales_order_id: salesOrderId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Cancel failed');
    showToast('Order cancelled ✓');
    await loadTodayOrders();
  } catch (e) {
    showToast(e.message, 'error');
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
