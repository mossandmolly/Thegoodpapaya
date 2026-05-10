// ── State ─────────────────────────────────────────────────────
let selectedPackerId   = localStorage.getItem('packerId')   || null;
let selectedPackerName = localStorage.getItem('packerName') || null;
let allItems = [];

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

  if (error || !data?.length) {
    container.innerHTML = '<p style="font-size:0.85rem;color:var(--text-muted)">No packers set up yet — go to Admin</p>';
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

  const fruits = assignments.map(a => a.item_name);

  const { data: items, error } = await sb
    .from('order_items')
    .select('*')
    .eq('order_date', todayIST())
    .in('item_name', fruits)
    .order('community')
    .order('customer_name');

  if (error || !items?.length) {
    container.innerHTML = '';
    empty.classList.remove('hidden');
    empty.querySelector('p').textContent = 'No items for today yet';
    return;
  }

  allItems = items;
  renderCards(items);
}

// ── Render cards ──────────────────────────────────────────────
function renderCards(items) {
  const container = document.getElementById('cards-container');
  container.innerHTML = '';
  container.classList.remove('hidden');

  // Exclude REMOVED from progress counts
  const active  = items.filter(i => i.item_status !== 'REMOVED');
  const done    = active.filter(i => ['packed', 'final', 'invoice_generated', 'ofd', 'delivered'].includes(i.status));
  const pending = active.length - done.length;

  document.getElementById('sum-total').textContent   = active.length;
  document.getElementById('sum-done').textContent    = done.length;
  document.getElementById('sum-pending').textContent = pending;
  document.getElementById('summary-bar').classList.remove('hidden');
  document.getElementById('section-header').classList.remove('hidden');
  document.getElementById('section-count').textContent =
    `${active.length} item${active.length !== 1 ? 's' : ''} assigned to you`;

  items.forEach(item => container.appendChild(buildCard(item)));
}

// ── Build a single card ───────────────────────────────────────
function buildCard(item) {
  const card = document.createElement('div');
  const isRemoved  = item.item_status === 'REMOVED';
  const isNobill   = item.item_status === 'NOBILL';
  const isPacked   = ['packed', 'final', 'invoice_generated', 'ofd', 'delivered'].includes(item.status);

  card.className = `item-card${isRemoved ? ' item-removed' : ''}`;
  card.id = `card-${item.id}`;

  const statusBadge = isRemoved
    ? `<span class="status-badge badge-removed">REMOVED</span>`
    : isNobill
      ? `<span class="status-badge badge-nobill">NOBILL</span>`
      : `<span class="status-badge badge-${item.status}">${item.status}</span>`;

  const auditHtml = item.packed_by
    ? `<div class="card-audit">Packed by ${item.packed_by}${item.packed_at ? ' · ' + fmtTime(item.packed_at) : ''}</div>`
    : '';

  let actionsHtml = '';
  if (!isRemoved) {
    if (!isPacked) {
      actionsHtml = `
        <input
          class="final-qty-input"
          id="input-${item.id}"
          type="number"
          inputmode="decimal"
          placeholder="Enter weight"
          value="${item.final_qty ?? ''}"
          step="0.1"
        >
        <div class="card-actions">
          <button class="btn btn-primary" onclick="packItem('${item.id}')">Pack ✓</button>
        </div>`;
    } else {
      actionsHtml = `
        <div class="card-actions">
          <button class="btn btn-secondary btn-sm" onclick="unpackItem('${item.id}')">Edit weight</button>
        </div>`;
    }
  }

  card.innerHTML = `
    <div class="card-header">
      <div>
        <div class="card-customer">${item.customer_name}</div>
        ${item.community ? `<div class="card-community">${item.community}</div>` : ''}
      </div>
      ${statusBadge}
    </div>

    <div class="card-item">${item.item_name}</div>

    ${item.description ? `<div class="card-desc">${item.description}</div>` : ''}

    <div class="qty-row">
      <div class="qty-box">
        <label>Requested</label>
        <div class="qty-val">${item.requested_qty ?? '—'}</div>
      </div>
      <div class="qty-arrow">→</div>
      <div class="qty-box">
        <label>Final</label>
        <div class="qty-val">${item.final_qty ?? '—'}</div>
      </div>
    </div>

    ${auditHtml}
    ${actionsHtml}
  `;

  return card;
}

// ── Pack item (save weight + mark packed) ─────────────────────
async function packItem(id) {
  const input = document.getElementById(`input-${id}`);
  const val   = parseFloat(input?.value);

  if (isNaN(val) || val < 0) {
    showToast('Enter a valid weight', 'error');
    return;
  }

  const btn = input?.nextElementSibling?.querySelector('button');
  if (btn) { btn.textContent = 'Saving…'; btn.disabled = true; }

  const { error } = await sb
    .from('order_items')
    .update({
      final_qty:  val,
      status:     'packed',
      packed_by:  selectedPackerName,
      packed_at:  new Date().toISOString(),
    })
    .eq('id', id);

  if (error) {
    showToast('Save failed', 'error');
    if (btn) { btn.textContent = 'Pack ✓'; btn.disabled = false; }
    return;
  }

  showToast('Packed ✓');
  const idx = allItems.findIndex(i => i.id === id);
  if (idx !== -1) {
    allItems[idx] = { ...allItems[idx], final_qty: val, status: 'packed', packed_by: selectedPackerName, packed_at: new Date().toISOString() };
    document.getElementById(`card-${id}`).replaceWith(buildCard(allItems[idx]));
    updateSummary();
  }
}

// ── Unpack item (revert to open for re-weighing) ──────────────
async function unpackItem(id) {
  const { error } = await sb
    .from('order_items')
    .update({ status: 'open', final_qty: null })
    .eq('id', id);

  if (error) { showToast('Failed to edit', 'error'); return; }

  const idx = allItems.findIndex(i => i.id === id);
  if (idx !== -1) {
    allItems[idx] = { ...allItems[idx], status: 'open', final_qty: null };
    document.getElementById(`card-${id}`).replaceWith(buildCard(allItems[idx]));
    updateSummary();
  }
}

function updateSummary() {
  const active  = allItems.filter(i => i.item_status !== 'REMOVED');
  const done    = active.filter(i => ['packed', 'final', 'invoice_generated', 'ofd', 'delivered'].includes(i.status));
  document.getElementById('sum-total').textContent   = active.length;
  document.getElementById('sum-done').textContent    = done.length;
  document.getElementById('sum-pending').textContent = active.length - done.length;
}

function fmtTime(isoStr) {
  try {
    return new Date(isoStr).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}
