// ── Password gate ──────────────────────────────────────────────
let adminPassword = null;

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
  document.getElementById('password-screen').classList.add('hidden');
  document.getElementById('admin-content').classList.remove('hidden');
  loadAll();
}

document.getElementById('admin-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') checkPassword();
});

// ── Load everything ────────────────────────────────────────────
async function loadAll() {
  await Promise.all([loadPackers(), loadAssignments(), loadNotes(), loadSnapshots()]);
}

// ── Daily orders CSV upload ────────────────────────────────────
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

  statusEl.innerHTML = `<p style="font-size:0.82rem;color:var(--text-muted);margin-top:8px">Uploading ${rows.length} rows…</p>`;

  const records = rows.map(r => ({
    sales_order_id:     (r['sales_order']   || '').trim(),
    invoice_date:       (r['order_date']     || '').trim(),
    customer_name:      (r['customer_name']  || '').trim(),
    item_name:          (r['item_name']      || '').trim(),
    description:        (r['description']    || '').trim() || null,
    requested_quantity: parseFloat(r['quantity']) || 0,
    status:             'draft',
  })).filter(r => r.sales_order_id && r.customer_name && r.item_name);

  const res = await fetch(`${SUPABASE_URL}/functions/v1/upload-orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON },
    body: JSON.stringify({ password: adminPassword, records }),
  });

  const result = await res.json();

  if (!res.ok) {
    statusEl.innerHTML = `<p style="font-size:0.82rem;color:var(--red);margin-top:8px">Upload failed: ${result.error}</p>`;
    return;
  }

  const uploadDate = records[0]?.invoice_date;
  fileInput.value = '';
  statusEl.innerHTML = `<p style="font-size:0.82rem;color:var(--green);margin-top:8px">✓ ${result.inserted} orders uploaded${uploadDate ? ' for ' + formatDate(uploadDate) : ''}</p>`;
  showToast(`${result.inserted} orders loaded ✓`);
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
    .select('id, customer_name, item_name, note_type, note_date, note, invoice_number')
    .order('customer_name')
    .order('created_at', { ascending: false });

  _allNotes = data || [];
  renderNotesTable(_allNotes);
}

function renderNotesTable(notes) {
  const wrap = document.getElementById('notes-table-wrap');

  if (!notes.length) {
    wrap.innerHTML = '<p style="font-size:0.85rem;color:var(--text-muted);padding:12px">No notes yet</p>';
    return;
  }

  const rows = notes.map(n => `
    <tr>
      <td>${escapeHtml(n.customer_name)}</td>
      <td style="color:var(--text-muted)">${n.item_name ? escapeHtml(n.item_name) : '<em style="opacity:0.5">All</em>'}</td>
      <td><span class="note-type-badge type-${n.note_type}">${n.note_type}</span></td>
      <td style="color:var(--text-muted);white-space:nowrap">${n.note_date || ''}</td>
      <td style="max-width:200px;word-break:break-word">${escapeHtml(n.note)}</td>
      <td><button class="btn btn-sm btn-danger" onclick="deleteNote('${n.id}')">×</button></td>
    </tr>
  `).join('');

  wrap.innerHTML = `
    <table class="notes-table">
      <thead>
        <tr>
          <th>Customer</th><th>Item</th><th>Type</th><th>Date</th><th>Note</th><th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

async function addNote() {
  const customer = document.getElementById('note-customer').value.trim();
  const item     = document.getElementById('note-item').value.trim() || null;
  const type     = document.getElementById('note-type').value;
  const note     = document.getElementById('note-text').value.trim();

  if (!customer || !note) { showToast('Customer and note are required', 'error'); return; }

  const { error } = await sb.from('customer_notes').insert({
    customer_name: customer,
    item_name:     item,
    note_type:     type,
    note:          note,
    note_date:     todayIST(),
  });

  if (error) { showToast('Failed to add note', 'error'); return; }

  document.getElementById('note-customer').value = '';
  document.getElementById('note-item').value     = '';
  document.getElementById('note-text').value     = '';
  document.getElementById('note-type').value     = 'note';
  showToast('Note added ✓');
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
    customer_name:  (r['customer_name'] || '').trim(),
    item_name:      (r['item_name'] || '').trim() || null,
    note:           (r['note'] || r['description'] || '').trim(),
    note_type:      (r['note_type'] || r['complaint_type'] || 'note').trim().toLowerCase(),
    note_date:      (r['note_date'] || r['complaint_date'] || '').trim() || null,
    invoice_number: (r['invoice_number'] || '').trim() || null,
  })).filter(r => r.customer_name && r.note);

  if (!records.length) { showToast('No valid rows found', 'error'); return; }

  statusEl.innerHTML = `<p style="font-size:0.82rem;color:var(--text-muted);margin-top:6px">Importing ${records.length} rows…</p>`;

  const { error } = await sb.from('customer_notes').insert(records);
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

  const headers = ['customer_name', 'item_name', 'note_type', 'note_date', 'note', 'invoice_number'];
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
