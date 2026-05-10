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
  await Promise.all([loadPackers(), loadAssignments(), loadNotes()]);
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

// ── Danger zone ────────────────────────────────────────────────
async function resetTodayStatus() {
  const today = todayIST();
  if (!confirm(`Reset ALL items for ${formatDate(today)} back to open?`)) return;

  const { error } = await sb
    .from('order_items')
    .update({ status: 'open', final_qty: null, packed_by: null, finalized_by: null })
    .eq('order_date', today)
    .not('status', 'in', '("invoice_generated","ofd","delivered")');

  if (error) { showToast('Reset failed', 'error'); return; }
  showToast('All items reset to open ✓');
}

// ── CSV Import ─────────────────────────────────────────────────────────────
// Expected CSV: customer_name, item_name, quantity[, date]
// All rows are trimmed; first row is treated as header if non-numeric quantity

let csvRows = [];    // parsed { customer_name, item_name, qty, date, _state, _existingId }

function getDefaultDate() {
  const d = document.getElementById('csv-default-date').value;
  return d || todayIST();
}

// Initialise default date input to today
document.addEventListener('DOMContentLoaded', () => {
  const dateInput = document.getElementById('csv-default-date');
  if (dateInput) dateInput.value = todayIST();
});

async function parseCsv(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const text = await file.text();
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) { showToast('Empty file', 'error'); return; }

  // Detect header: skip first row if its "quantity" column isn't a number
  let startIdx = 0;
  const firstCols = lines[0].split(',').map(c => c.trim());
  if (isNaN(parseFloat(firstCols[2]))) startIdx = 1;

  const defaultDate = getDefaultDate();
  const parsed = [];

  for (let i = startIdx; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim());
    if (cols.length < 3) continue;
    const [customer_name, item_name, qtyStr, dateStr] = cols;
    const qty  = parseFloat(qtyStr);
    const date = dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : defaultDate;
    if (!customer_name || !item_name || isNaN(qty) || qty <= 0) continue;
    parsed.push({ customer_name, item_name, qty, date });
  }

  if (!parsed.length) { showToast('No valid rows found', 'error'); return; }

  // Check against existing order_items
  const dates  = [...new Set(parsed.map(r => r.date))];
  const names  = [...new Set(parsed.map(r => r.customer_name))];

  const { data: existing } = await sb
    .from('order_items')
    .select('id, order_id, customer_name, item_name, requested_qty, status, item_status, order_date')
    .in('order_date', dates)
    .in('customer_name', names);

  const existingMap = {};
  (existing || []).forEach(e => {
    const key = `${e.customer_name}|${e.item_name}|${e.order_date}`;
    existingMap[key] = e;
  });

  // Check for OFD orders
  const { data: ofdItems } = await sb
    .from('order_items')
    .select('customer_name, order_date, order_id')
    .in('order_date', dates)
    .in('customer_name', names)
    .eq('status', 'ofd');

  const ofdKeys = new Set((ofdItems || []).map(o => `${o.customer_name}|${o.order_date}`));

  csvRows = [];
  const removedRows = [];

  for (const row of parsed) {
    const key = `${row.customer_name}|${row.item_name}|${row.date}`;
    const old = existingMap[key];
    const ofdKey = `${row.customer_name}|${row.date}`;

    if (old) {
      if (Math.abs(parseFloat(old.requested_qty) - row.qty) < 0.001) {
        // Exact duplicate — grey, ignored by default
        csvRows.push({ ...row, _state: 'dup', _existingId: old.id, _include: false });
      } else {
        // Changed qty → mark old as REMOVED, add new
        removedRows.push({ ...old, _newQty: row.qty });
        csvRows.push({ ...row, _state: 'changed', _existingId: old.id, _include: true, _oldQty: old.requested_qty, _ofd: ofdKeys.has(ofdKey) });
      }
    } else {
      csvRows.push({ ...row, _state: 'new', _include: true, _ofd: ofdKeys.has(ofdKey) });
    }
  }

  // Add removed rows to display (they come before the replacement)
  const displayRows = [];
  for (const row of csvRows) {
    if (row._state === 'changed') {
      const old = (existing || []).find(e =>
        e.customer_name === row.customer_name &&
        e.item_name === row.item_name &&
        String(e.order_date) === row.date
      );
      if (old) displayRows.push({ ...old, _state: 'removed', _include: false, date: row.date, _displayQty: old.requested_qty });
    }
    displayRows.push(row);
  }

  renderDiffTable(displayRows);

  if (ofdKeys.size > 0) {
    document.getElementById('csv-ofd-warning').style.display = 'block';
  }
  document.getElementById('csv-diff-wrap').style.display = 'block';

  // Store display rows reference for toggling
  window._csvDisplayRows = displayRows;
}

function renderDiffTable(displayRows) {
  const tbody = document.getElementById('csv-diff-body');
  tbody.innerHTML = '';

  displayRows.forEach((row, idx) => {
    const tr = document.createElement('tr');
    const rowClass = row._state === 'new' || row._state === 'changed'
      ? 'diff-row-new'
      : row._state === 'removed'
        ? 'diff-row-removed'
        : row._state === 'ofd'
          ? 'diff-row-ofd'
          : 'diff-row-dup';
    tr.className = rowClass;

    const canToggle = row._state !== 'removed';
    const isIncluded = row._include !== false;
    const qtyDisplay = row._displayQty ?? row.qty ?? row.requested_qty ?? '—';
    const statusLabel = {
      new:     '+ New',
      changed: `⟳ ${row._oldQty ?? '?'} → ${row.qty}`,
      removed: '× Replaced',
      dup:     '= Duplicate',
    }[row._state] || row._state;

    tr.innerHTML = `
      <td>${canToggle ? `<input type="checkbox" ${isIncluded ? 'checked' : ''} onchange="toggleCsvRow(${idx}, this.checked)">` : ''}</td>
      <td>${row.customer_name || row.customer_name}</td>
      <td>${row.item_name}</td>
      <td>${qtyDisplay}</td>
      <td>${row.date || row.order_date}</td>
      <td style="font-size:0.78rem;white-space:nowrap">${statusLabel}${row._ofd ? ' <span style="color:#1d4ed8">· OFD!</span>' : ''}</td>
    `;
    tbody.appendChild(tr);
  });
}

function toggleCsvRow(idx, checked) {
  if (window._csvDisplayRows?.[idx]) {
    window._csvDisplayRows[idx]._include = checked;
  }
}

function clearCsvImport() {
  csvRows = [];
  window._csvDisplayRows = [];
  document.getElementById('csv-diff-wrap').style.display = 'none';
  document.getElementById('csv-ofd-warning').style.display = 'none';
  document.getElementById('csv-diff-body').innerHTML = '';
  document.getElementById('csv-file').value = '';
}

async function saveCsvImport() {
  const toSave = (window._csvDisplayRows || []).filter(r => r._include && r._state !== 'removed');
  if (!toSave.length) { showToast('Nothing to save', 'error'); return; }

  const ofdRows = toSave.filter(r => r._ofd);
  if (ofdRows.length) {
    const ok = confirm(
      `⚠️ ${ofdRows.length} customer(s) have OFD orders on the same date. Save anyway?\n\n` +
      ofdRows.map(r => `${r.customer_name} - ${r.item_name}`).join('\n')
    );
    if (!ok) return;
  }

  const btn = document.getElementById('csv-save-btn');
  btn.textContent = 'Saving…';
  btn.disabled = true;

  try {
    // 1. Mark replaced items as REMOVED
    const changedRows = toSave.filter(r => r._state === 'changed' && r._existingId);
    for (const row of changedRows) {
      await sb.from('order_items').update({
        item_status:  'REMOVED',
        description:  `Replaced: weight changed from ${row._oldQty} to ${row.qty}`,
      }).eq('id', row._existingId);
    }

    // 2. Get or create order headers, then insert new order_items
    const defaultDate = getDefaultDate();
    const groupedByCustomer = {};
    for (const row of toSave) {
      const key = `${row.customer_name}|${row.date}`;
      if (!groupedByCustomer[key]) groupedByCustomer[key] = { customer_name: row.customer_name, date: row.date, items: [] };
      groupedByCustomer[key].items.push(row);
    }

    for (const { customer_name, date, items } of Object.values(groupedByCustomer)) {
      // Find existing order or create one
      let orderId;
      const { data: existingOrder } = await sb
        .from('orders')
        .select('sales_id')
        .eq('order_date', date)
        .eq('customer_name', customer_name)
        .maybeSingle();

      if (existingOrder) {
        orderId = existingOrder.sales_id;
      } else {
        // Create new order header
        const safeName = customer_name.replace(/\s+/g, '-');
        let baseId = `${date}-${safeName}`;
        let salesId = baseId;
        let suffix = 1;
        while (true) {
          const { data: hit } = await sb.from('orders').select('sales_id').eq('sales_id', salesId).maybeSingle();
          if (!hit) break;
          suffix++;
          salesId = `${baseId}-${suffix}`;
        }

        // Extract community (everything before the last space+number)
        const communityMatch = customer_name.match(/^(.+?)\s+[\w-]+$/);
        const community = communityMatch ? communityMatch[1] : customer_name;

        await sb.from('orders').insert({
          sales_id:       salesId,
          customer_name,
          community,
          payment_method: 'cod',
          status:         'placed',
          order_date:     date,
          cart:           [],
          total:          0,
        });
        orderId = salesId;
      }

      // Insert order_items
      const newItems = items.map((row) => ({
        order_id:      orderId,
        order_date:    date,
        customer_name,
        community:     customer_name.match(/^(.+?)\s+[\w-]+$/)?.[1] || customer_name,
        item_name:     row.item_name,
        description:   row._state === 'changed' ? `Weight changed from ${row._oldQty} to ${row.qty}` : null,
        requested_qty: row.qty,
        final_qty:     null,
        status:        'open',
      }));

      const { error: insertErr } = await sb.from('order_items').insert(newItems);
      if (insertErr) throw new Error(insertErr.message);
    }

    showToast(`${toSave.length} item${toSave.length !== 1 ? 's' : ''} imported ✓`);
    clearCsvImport();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.textContent = 'Save Import';
    btn.disabled = false;
  }
}

// ── Utility ────────────────────────────────────────────────────
function escapeAttr(s) {
  return (s || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}
