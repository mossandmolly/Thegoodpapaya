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

  // Get fruits assigned to this packer
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

  // Get today's order_items for those fruits
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

  const total   = items.length;
  const done    = items.filter(i => i.status === 'packed').length;
  const pending = total - done;
  document.getElementById('sum-total').textContent   = total;
  document.getElementById('sum-done').textContent    = done;
  document.getElementById('sum-pending').textContent = pending;
  document.getElementById('summary-bar').classList.remove('hidden');
  document.getElementById('section-header').classList.remove('hidden');
  document.getElementById('section-count').textContent = `${total} item${total !== 1 ? 's' : ''} assigned to you`;

  items.forEach(item => container.appendChild(buildCard(item)));
}

// ── Build a single card ───────────────────────────────────────
function buildCard(item) {
  const card = document.createElement('div');
  card.className = `item-card status-${item.status}`;
  card.id = `card-${item.id}`;

  const isPacked = item.status === 'packed';

  card.innerHTML = `
    <div class="card-header">
      <div>
        <div class="card-customer">${item.customer_name}</div>
        ${item.community ? `<div class="card-community">${item.community}</div>` : ''}
      </div>
      <span class="status-badge badge-${item.status}">${item.status}</span>
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

    ${!isPacked ? `
      <input
        class="final-qty-input"
        id="input-${item.id}"
        type="number"
        inputmode="decimal"
        placeholder="Enter final qty"
        value="${item.final_qty ?? ''}"
        step="0.1"
      >
      <div class="card-actions">
        <button class="btn btn-primary" onclick="packItem('${item.id}')">Pack ✓</button>
      </div>
    ` : `
      <div class="card-actions">
        <button class="btn btn-secondary btn-sm" onclick="unpackItem('${item.id}')">Edit</button>
      </div>
    `}
  `;

  return card;
}

// ── Pack item (save final qty + mark packed) ──────────────────
async function packItem(id) {
  const input = document.getElementById(`input-${id}`);
  const val   = parseFloat(input?.value);

  if (isNaN(val) || val < 0) {
    showToast('Enter a valid quantity', 'error');
    return;
  }

  const btn = input?.nextElementSibling?.querySelector('button');
  if (btn) { btn.textContent = 'Saving…'; btn.disabled = true; }

  const { error } = await sb
    .from('order_items')
    .update({ final_qty: val, status: 'packed' })
    .eq('id', id);

  if (error) {
    showToast('Save failed', 'error');
    if (btn) { btn.textContent = 'Pack ✓'; btn.disabled = false; }
    return;
  }

  showToast('Packed ✓');
  const idx = allItems.findIndex(i => i.id === id);
  if (idx !== -1) {
    allItems[idx].final_qty = val;
    allItems[idx].status = 'packed';
    document.getElementById(`card-${id}`).replaceWith(buildCard(allItems[idx]));
    updateSummary();
  }
}

// ── Unpack item ───────────────────────────────────────────────
async function unpackItem(id) {
  const { error } = await sb
    .from('order_items')
    .update({ status: 'pending' })
    .eq('id', id);

  if (error) { showToast('Failed to edit', 'error'); return; }

  const idx = allItems.findIndex(i => i.id === id);
  if (idx !== -1) {
    allItems[idx].status = 'pending';
    document.getElementById(`card-${id}`).replaceWith(buildCard(allItems[idx]));
    updateSummary();
  }
}

function updateSummary() {
  const total = allItems.length;
  const done  = allItems.filter(i => i.status === 'packed').length;
  document.getElementById('sum-total').textContent   = total;
  document.getElementById('sum-done').textContent    = done;
  document.getElementById('sum-pending').textContent = total - done;
}
