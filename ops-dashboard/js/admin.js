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
