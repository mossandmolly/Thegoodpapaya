// ── State ─────────────────────────────────────────────────────
let selectedPackerId   = localStorage.getItem('packerId')   || null;
let selectedPackerName = localStorage.getItem('packerName') || null;
let allItems = [];
let noteMap  = {}; // { customer_name: { '__all__': note, item_name: note } }

// ── Init ──────────────────────────────────────────────────────
(async function init() {
  document.getElementById('section-date').textContent = formatDate(todayIST());
  await loadPackers();
  if (selectedPackerId) await loadItems();
})();

// ── Load packers ──────────────────────────────────────────────
async function loadPackers() {
  const { data, error } = await sb
    .from('packers')
    .select('id, name')
    .eq('active', true)
    .order('name');

  const container = document.getElementById('packer-chips');
  container.innerHTML = '';

  const allChip = document.createElement('button');
  allChip.className = 'chip' + (selectedPackerId === 'all' ? ' selected' : '');
  allChip.textContent = 'All';
  allChip.onclick = () => selectPacker('all', 'All');
  container.appendChild(allChip);

  if (error || !data?.length) {
    container.insertAdjacentHTML('beforeend', '<p style="font-size:0.85rem;color:var(--text-muted);margin-left:8px">No packers set up yet — go to Admin</p>');
    return;
  }

  data.forEach(p => {
    const chip = document.createElement('button');
    chip.className = 'chip' + (p.id === selectedPackerId ? ' selected' : '');
    chip.textContent = p.name;
    chip.onclick = () => selectPacker(p.id, p.name);
    container.appendChild(chip);
  });
}

// ── Select packer ─────────────────────────────────────────────
async function selectPacker(id, name) {
  selectedPackerId   = id;
  selectedPackerName = name;
  localStorage.setItem('packerId',   id);
  localStorage.setItem('packerName', name);

  document.querySelectorAll('.chip').forEach(c => {
    c.classList.toggle('selected', c.textContent === name);
  });

  await loadItems();
}

// ── Load items ────────────────────────────────────────────────
async function loadItems() {
  const container = document.getElementById('cards-container');
  const empty     = document.getElementById('empty-state');
  container.innerHTML = '<div class="cards-container"><div class="skeleton" style="height:120px"></div><div class="skeleton" style="height:120px"></div></div>';
  container.classList.remove('hidden');
  empty.classList.add('hidden');

  let query = sb
    .from('operations')
    .select('*')
    .eq('invoice_date', todayIST())
    .order('community')
    .order('customer_name');

  if (selectedPackerId !== 'all') {
    const { data: assignments } = await sb
      .from('packer_assignments')
      .select('item_name')
      .eq('packer_id', selectedPackerId);

    if (!assignments?.length) {
      container.innerHTML = '';
      empty.classList.remove('hidden');
      empty.querySelector('p').textContent = `No fruits assigned to ${selectedPackerName} yet — go to Admin`;
      return;
    }

    query = query.in('item_name', assignments.map(a => a.item_name));
  }

  const { data: items, error } = await query;

  if (error || !items?.length) {
    container.innerHTML = '';
    empty.classList.remove('hidden');
    empty.querySelector('p').textContent = 'No items for today yet';
    return;
  }

  // Load notes for all customers in this batch
  const customerNames = [...new Set(items.map(i => i.customer_name))];
  const { data: notes } = await sb
    .from('customer_notes')
    .select('customer_name, note')
    .in('customer_name', customerNames);

  noteMap = {};
  (notes || []).forEach(n => { noteMap[n.customer_name] = n.note; });

  allItems = items;
  renderCards(items);
}

// ── Render cards ──────────────────────────────────────────────
function renderCards(items) {
  const container = document.getElementById('cards-container');
  container.innerHTML = '';
  container.classList.remove('hidden');

  const total = items.length;
  const done  = items.filter(i => i.status === 'final').length;
  document.getElementById('sum-total').textContent   = total;
  document.getElementById('sum-done').textContent    = done;
  document.getElementById('sum-pending').textContent = total - done;
  document.getElementById('summary-bar').classList.remove('hidden');
  document.getElementById('section-header').classList.remove('hidden');
  document.getElementById('section-count').textContent = selectedPackerId === 'all'
    ? `${total} item${total !== 1 ? 's' : ''} today (all packers)`
    : `${total} item${total !== 1 ? 's' : ''} assigned to you`;

  items.forEach(item => container.appendChild(buildCard(item)));
}

// ── Helpers ───────────────────────────────────────────────────
function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

function noteFor(item) {
  return noteMap[item.customer_name] || null;
}

// ── Build a single card ───────────────────────────────────────
function buildCard(item) {
  const card = document.createElement('div');
  card.className = `item-card status-${item.status}`;
  card.id = `card-${item.id}`;

  const isFinal    = item.status === 'final';
  const hasFinalQty = item.final_quantity != null;
  const note        = noteFor(item);

  card.innerHTML = `
    <div class="card-header">
      <div>
        <div class="card-customer">${item.customer_name}</div>
        ${item.community ? `<div class="card-community">${item.community}</div>` : ''}
      </div>
      <div style="text-align:right;flex-shrink:0">
        <span class="status-badge badge-${item.status}">${item.status}</span>
        ${item.last_updated_by ? `<div class="card-meta" style="margin-top:4px">✏️ ${fmtTime(item.last_updated_at)}<br>${item.last_updated_by}</div>` : ''}
        ${item.finalized_by   ? `<div class="card-meta card-meta-final" style="margin-top:2px">✓ ${fmtTime(item.finalized_at)}<br>${item.finalized_by}</div>` : ''}
      </div>
    </div>

    <div class="card-item">${item.item_name}</div>

    ${item.description ? `<div class="card-desc">${item.description}</div>` : ''}

    ${note ? `<div class="card-note"><strong>📋 Note</strong>${note}</div>` : ''}

    <div class="qty-row">
      <div class="qty-box">
        <label>Requested</label>
        <div class="qty-val">${item.requested_quantity ?? '—'}</div>
      </div>
      <div class="qty-arrow">→</div>
      <div class="qty-box">
        <label>Final</label>
        <div class="qty-val">${item.final_quantity ?? '—'}</div>
      </div>
    </div>

    ${!isFinal ? `
      <input
        class="final-qty-input"
        id="input-${item.id}"
        type="number"
        inputmode="decimal"
        placeholder="Enter final qty"
        value="${item.final_quantity ?? ''}"
        step="0.1"
      >
      <div class="card-actions">
        <button class="btn btn-primary" onclick="saveItem('${item.id}')">Save</button>
        ${hasFinalQty ? `<button class="btn btn-success" onclick="finalizeItem('${item.id}')">Mark Final</button>` : ''}
      </div>
    ` : `
      <div class="card-actions">
        <button class="btn btn-secondary btn-sm" onclick="unfinalize('${item.id}')">Edit</button>
      </div>
    `}
  `;

  return card;
}

// ── Save final quantity ───────────────────────────────────────
async function saveItem(id) {
  const input = document.getElementById(`input-${id}`);
  const val   = parseFloat(input.value);

  if (isNaN(val) || val < 0) {
    showToast('Enter a valid quantity', 'error');
    return;
  }

  const actions = input.nextElementSibling;
  const saveBtn = actions?.querySelector('.btn-primary');
  if (saveBtn) { saveBtn.textContent = 'Saving…'; saveBtn.disabled = true; }

  const { data: { user } } = await sb.auth.getUser();
  const email = user?.email ?? 'unknown';
  const now   = new Date().toISOString();

  const { error } = await sb
    .from('operations')
    .update({ final_quantity: val, status: 'draft', last_updated_by: email, last_updated_at: now })
    .eq('id', id);

  if (error) {
    showToast('Save failed', 'error');
    if (saveBtn) { saveBtn.textContent = 'Save'; saveBtn.disabled = false; }
    return;
  }

  showToast('Saved ✓');
  const idx = allItems.findIndex(i => i.id === id);
  if (idx !== -1) {
    Object.assign(allItems[idx], { final_quantity: val, status: 'draft', last_updated_by: email, last_updated_at: now });
    document.getElementById(`card-${id}`).replaceWith(buildCard(allItems[idx]));
    const newInput = document.getElementById(`input-${id}`);
    if (newInput) newInput.value = '';
    updateSummary();
  }
}

// ── Mark as final ─────────────────────────────────────────────
async function finalizeItem(id) {
  const { data: { user } } = await sb.auth.getUser();
  const email = user?.email ?? 'unknown';
  const now   = new Date().toISOString();

  const { error } = await sb
    .from('operations')
    .update({ status: 'final', finalized_by: email, finalized_at: now })
    .eq('id', id);

  if (error) { showToast('Failed to mark final', 'error'); return; }

  const idx = allItems.findIndex(i => i.id === id);
  if (idx !== -1) {
    Object.assign(allItems[idx], { status: 'final', finalized_by: email, finalized_at: now });
    document.getElementById(`card-${id}`).replaceWith(buildCard(allItems[idx]));
    updateSummary();
  }
  showToast('Marked as final ✓');
}

// ── Unfinalize ────────────────────────────────────────────────
async function unfinalize(id) {
  const { error } = await sb
    .from('operations')
    .update({ status: 'draft', finalized_by: null, finalized_at: null })
    .eq('id', id);

  if (error) { showToast('Failed to edit', 'error'); return; }

  const idx = allItems.findIndex(i => i.id === id);
  if (idx !== -1) {
    Object.assign(allItems[idx], { status: 'draft', finalized_by: null, finalized_at: null });
    document.getElementById(`card-${id}`).replaceWith(buildCard(allItems[idx]));
    updateSummary();
  }
}

function updateSummary() {
  const total = allItems.length;
  const done  = allItems.filter(i => i.status === 'final').length;
  document.getElementById('sum-total').textContent   = total;
  document.getElementById('sum-done').textContent    = done;
  document.getElementById('sum-pending').textContent = total - done;
}
