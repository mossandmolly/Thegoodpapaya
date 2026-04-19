// ── Password gate ──────────────────────────────────────────────
const ADMIN_PASSWORD = '1234'; // change this in config or here

function checkPassword() {
  const input = document.getElementById('admin-password');
  if (input.value === ADMIN_PASSWORD) {
    document.getElementById('password-screen').classList.add('hidden');
    document.getElementById('admin-content').classList.remove('hidden');
    loadAll();
  } else {
    document.getElementById('pw-error').style.display = 'block';
    input.value = '';
    input.focus();
  }
}

document.getElementById('admin-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') checkPassword();
});

// ── Load everything ────────────────────────────────────────────
async function loadAll() {
  await Promise.all([loadPackers(), loadAssignments(), loadNotes(), loadComplaints()]);
}

// ── Daily orders CSV upload ────────────────────────────────────
async function uploadOrders() {
  const fileInput = document.getElementById('orders-csv');
  const statusEl  = document.getElementById('orders-upload-status');

  if (!fileInput.files.length) {
    showToast('Select a CSV file first', 'error');
    return;
  }

  const text = await fileInput.files[0].text();
  const rows  = parseCSV(text);

  if (!rows.length) {
    showToast('CSV appears empty', 'error');
    return;
  }

  const headers = Object.keys(rows[0]).map(h => h.trim().toLowerCase());
  const missing = ['sales_order', 'order_date', 'customer_name', 'item_name', 'quantity'].filter(c => !headers.includes(c));
  if (missing.length) {
    showToast(`Missing columns: ${missing.join(', ')}`, 'error');
    return;
  }

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

  const { error } = await sb
    .from('operations')
    .upsert(records, { onConflict: 'sales_order_id,item_name' });

  if (error) {
    statusEl.innerHTML = `<p style="font-size:0.82rem;color:var(--red);margin-top:8px">Upload failed: ${error.message}</p>`;
    return;
  }

  fileInput.value = '';
  const uploadedDate = records[0]?.invoice_date || '';
  statusEl.innerHTML = `<p style="font-size:0.82rem;color:var(--green);margin-top:8px">✓ ${records.length} orders uploaded${uploadedDate ? ' for ' + formatDate(uploadedDate) : ''}</p>`;
  showToast(`${records.length} orders loaded ✓`);
}

// ── Packers ────────────────────────────────────────────────────
async function loadPackers() {
  const { data, error } = await sb
    .from('packers')
    .select('id, name, active')
    .order('name');

  const list = document.getElementById('packers-list');
  const assignSel = document.getElementById('assign-packer');
  assignSel.innerHTML = '<option value="">Select packer…</option>';

  if (error || !data?.length) {
    list.innerHTML = '<p style="font-size:0.85rem;color:var(--text-muted)">No packers yet</p>';
    return;
  }

  list.innerHTML = '';
  data.forEach(p => {
    // Populate assignment dropdown
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    assignSel.appendChild(opt);

    // List item
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
  const packerId  = document.getElementById('assign-packer').value;
  const fruitInput = document.getElementById('assign-fruit');
  const itemName  = fruitInput.value.trim();

  if (!packerId) { showToast('Select a packer', 'error'); return; }
  if (!itemName) { showToast('Enter a fruit name', 'error'); return; }

  const { error } = await sb.from('packer_assignments').insert({ packer_id: packerId, item_name: itemName });
  if (error) {
    if (error.code === '23505') showToast('Already assigned', 'error');
    else showToast('Failed to assign', 'error');
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

// ── Customer notes ─────────────────────────────────────────────
async function loadNotes() {
  const { data, error } = await sb
    .from('customer_notes')
    .select('id, customer_name, note')
    .order('customer_name');

  const list = document.getElementById('notes-list');

  if (error || !data?.length) {
    list.innerHTML = '<p style="font-size:0.85rem;color:var(--text-muted)">No notes yet</p>';
    return;
  }

  list.innerHTML = '';
  data.forEach(n => {
    const row = document.createElement('div');
    row.className = 'list-item';
    row.innerHTML = `
      <div>
        <div style="font-weight:500">${n.customer_name}</div>
        <div style="font-size:0.82rem;color:var(--text-muted)">${n.note}</div>
      </div>
      <button class="btn btn-sm btn-danger" onclick="deleteNote('${n.id}', '${escapeAttr(n.customer_name)}')">Remove</button>
    `;
    list.appendChild(row);
  });
}

async function saveNote() {
  const customerInput = document.getElementById('note-customer');
  const noteInput     = document.getElementById('note-text');
  const customer      = customerInput.value.trim();
  const note          = noteInput.value.trim();

  if (!customer || !note) { showToast('Fill both fields', 'error'); return; }

  // Upsert: update if customer already has a note, insert otherwise
  const { error } = await sb
    .from('customer_notes')
    .upsert({ customer_name: customer, note }, { onConflict: 'customer_name' });

  if (error) { showToast('Save failed', 'error'); return; }

  customerInput.value = '';
  noteInput.value     = '';
  showToast('Note saved ✓');
  await loadNotes();
}

async function deleteNote(id, customerName) {
  const { error } = await sb.from('customer_notes').delete().eq('id', id);
  if (error) { showToast('Delete failed', 'error'); return; }
  showToast(`Note for ${customerName} removed`);
  await loadNotes();
}

// ── Complaint history ──────────────────────────────────────────
async function loadComplaints() {
  const { data, error } = await sb
    .from('complaint_history')
    .select('id, customer_name, invoice_number, complaint_date, complaint_type, description')
    .order('complaint_date', { ascending: false })
    .limit(50);

  const list = document.getElementById('complaints-list');

  if (error || !data?.length) {
    list.innerHTML = '<p style="font-size:0.85rem;color:var(--text-muted)">No complaints logged yet</p>';
    return;
  }

  list.innerHTML = '';
  data.forEach(c => {
    const row = document.createElement('div');
    row.className = 'list-item';
    row.style.flexDirection = 'column';
    row.style.alignItems = 'flex-start';
    row.style.gap = '4px';
    row.innerHTML = `
      <div style="display:flex;justify-content:space-between;width:100%;align-items:center">
        <span style="font-weight:500">${c.customer_name}</span>
        <div style="display:flex;gap:6px;align-items:center">
          <span style="font-size:0.75rem;background:var(--bg);padding:2px 8px;border-radius:8px;color:var(--text-muted)">${c.complaint_type}</span>
          <span style="font-size:0.75rem;color:var(--text-muted)">${c.complaint_date}</span>
          <button class="btn btn-sm btn-danger" onclick="deleteComplaint('${c.id}')">×</button>
        </div>
      </div>
      ${c.description ? `<div style="font-size:0.82rem;color:var(--text-muted)">${c.description}</div>` : ''}
      ${c.invoice_number ? `<div style="font-size:0.75rem;color:var(--text-muted)">Invoice: ${c.invoice_number}</div>` : ''}
    `;
    list.appendChild(row);
  });
}

async function uploadComplaints() {
  const fileInput = document.getElementById('complaint-csv');
  const statusEl  = document.getElementById('upload-status');

  if (!fileInput.files.length) {
    showToast('Select a CSV file first', 'error');
    return;
  }

  const text = await fileInput.files[0].text();
  const rows  = parseCSV(text);

  if (!rows.length) {
    showToast('CSV appears empty', 'error');
    return;
  }

  const required = ['customer_name', 'complaint_date', 'complaint_type'];
  const headers  = Object.keys(rows[0]).map(h => h.trim().toLowerCase());
  const missing  = required.filter(r => !headers.includes(r));
  if (missing.length) {
    showToast(`Missing columns: ${missing.join(', ')}`, 'error');
    return;
  }

  statusEl.innerHTML = `<p style="font-size:0.82rem;color:var(--text-muted);margin-top:8px">Uploading ${rows.length} rows…</p>`;

  const records = rows.map(r => ({
    customer_name:  (r['customer_name'] || '').trim(),
    invoice_number: (r['invoice_number'] || '').trim() || null,
    complaint_date: (r['complaint_date'] || '').trim(),
    complaint_type: (r['complaint_type'] || 'other').trim().toLowerCase(),
    description:    (r['description'] || '').trim() || null,
  })).filter(r => r.customer_name && r.complaint_date);

  const { error } = await sb.from('complaint_history').insert(records);

  if (error) {
    statusEl.innerHTML = `<p style="font-size:0.82rem;color:var(--red);margin-top:8px">Upload failed: ${error.message}</p>`;
    return;
  }

  fileInput.value = '';
  statusEl.innerHTML = `<p style="font-size:0.82rem;color:var(--green);margin-top:8px">✓ ${records.length} complaints uploaded</p>`;
  showToast(`${records.length} complaints added ✓`);
  await loadComplaints();
}

async function deleteComplaint(id) {
  const { error } = await sb.from('complaint_history').delete().eq('id', id);
  if (error) { showToast('Delete failed', 'error'); return; }
  showToast('Complaint removed');
  await loadComplaints();
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] ?? ''; });
    return obj;
  });
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

// ── Utility ────────────────────────────────────────────────────
function escapeAttr(s) {
  return (s || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}
