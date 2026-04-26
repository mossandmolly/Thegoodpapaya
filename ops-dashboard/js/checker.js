// ── State ─────────────────────────────────────────────────────
let allItems    = [];
let allOrders   = {}; // { customer_name: items[] }
let selectedIds = new Set();

// ── Init ──────────────────────────────────────────────────────
(async function init() {
  document.getElementById('section-date').textContent = formatDate(todayIST());
  await loadItems();
  setupFilters();
})();

// ── Load items ────────────────────────────────────────────────
async function loadItems() {
  const empty = document.getElementById('empty-state');
  empty.querySelector('p').textContent = 'Loading today's items…';
  empty.classList.remove('hidden');
  document.getElementById('orders-container').innerHTML = '';
  document.getElementById('summary-bar').classList.add('hidden');
  document.getElementById('section-header').classList.add('hidden');

  const { data: items, error } = await sb
    .from('operations')
    .select('*')
    .eq('invoice_date', todayIST())
    .order('community')
    .order('customer_name')
    .order('item_name');

  if (error || !items?.length) {
    empty.querySelector('p').textContent = 'No items for today yet';
    return;
  }

  // Populate community filter
  const communities = [...new Set(items.map(i => i.community).filter(Boolean))].sort();
  const sel = document.getElementById('filter-community');
  sel.querySelectorAll('option:not([value=""])').forEach(o => o.remove());
  communities.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c;
    sel.appendChild(opt);
  });

  allItems = items;
  groupAndRender();
}

// ── Helpers ───────────────────────────────────────────────────
function itemDisplayStatus(item) {
  if (item.status === 'final')         return 'final';
  if (item.final_quantity != null)     return 'packed';
  return 'draft';
}

function displayQty(item) {
  const qty = item.final_quantity != null ? item.final_quantity : item.requested_quantity;
  return qty != null ? qty : '—';
}

// ── Group and render ──────────────────────────────────────────
function groupAndRender() {
  const communityFilter = document.getElementById('filter-community').value;
  const statusFilter    = document.getElementById('filter-status').value;
  const searchFilter    = document.getElementById('filter-search').value.trim().toLowerCase();

  let filtered = allItems.filter(i => {
    if (communityFilter && i.community !== communityFilter) return false;
    if (searchFilter && !i.customer_name.toLowerCase().includes(searchFilter)) return false;
    if (statusFilter) {
      const ds = itemDisplayStatus(i);
      if (statusFilter === 'packed' && ds !== 'packed') return false;
      if (statusFilter === 'draft'  && ds !== 'draft')  return false;
      if (statusFilter === 'final'  && ds !== 'final')  return false;
    }
    return true;
  });

  // Build allOrders flat map for finalize functions
  allOrders = {};
  filtered.forEach(item => {
    if (!allOrders[item.customer_name]) allOrders[item.customer_name] = [];
    allOrders[item.customer_name].push(item);
  });

  const container = document.getElementById('orders-container');
  const empty     = document.getElementById('empty-state');

  if (!filtered.length) {
    container.innerHTML = '';
    empty.querySelector('p').textContent = 'No items match the current filters';
    empty.classList.remove('hidden');
    document.getElementById('summary-bar').classList.add('hidden');
    document.getElementById('section-header').classList.add('hidden');
    return;
  }

  empty.classList.add('hidden');
  document.getElementById('summary-bar').classList.remove('hidden');
  document.getElementById('section-header').classList.remove('hidden');
  updateSummary();

  const total = filtered.length;
  document.getElementById('section-count').textContent =
    `${total} item${total !== 1 ? 's' : ''} today · ${Object.keys(allOrders).length} customers`;

  // Group by society
  const societies = {};
  filtered.forEach(item => {
    const s = item.community || '—';
    if (!societies[s]) societies[s] = {};
    if (!societies[s][item.customer_name]) societies[s][item.customer_name] = [];
    societies[s][item.customer_name].push(item);
  });

  container.innerHTML = '';
  Object.entries(societies)
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([society, customers]) => {
      container.appendChild(buildSocietyBlock(society, customers));
    });
}

// ── Build society block ───────────────────────────────────────
function buildSocietyBlock(society, customers) {
  const societyItems  = Object.values(customers).flat();
  const finalCount    = societyItems.filter(i => i.status === 'final').length;
  const packedCount   = societyItems.filter(i => itemDisplayStatus(i) === 'packed').length;
  const totalCount    = societyItems.length;
  const allDone       = finalCount === totalCount;

  const block = document.createElement('div');
  block.className = 'society-block' + (allDone ? ' society-complete' : '');
  block.id = `society-${slugify(society)}`;

  const progressClass = allDone ? 'progress-done' : 'progress-partial';

  block.innerHTML = `
    <div class="society-header">
      <span class="society-name">${society}</span>
      <span class="order-progress ${progressClass}">${finalCount}/${totalCount} final</span>
      ${packedCount > 0 && !allDone ? `<span class="order-progress progress-partial" style="background:#fef3c7;color:#92400e">${packedCount} packed</span>` : ''}
    </div>
    <div id="society-customers-${slugify(society)}">
      ${Object.entries(customers).map(([cust, items]) => buildCustomerRow(cust, items)).join('')}
    </div>`;

  return block;
}

// ── Build customer row ────────────────────────────────────────
function buildCustomerRow(customerName, items) {
  const allFinal = items.every(i => i.status === 'final');

  const chips = items.map(item => {
    const ds  = itemDisplayStatus(item);
    const qty = displayQty(item);
    const clickable = ds !== 'draft';
    return `<span class="item-chip chip-${ds}"
      ${clickable ? `onclick="toggleChip('${item.id}','${ds}')" title="${ds === 'final' ? 'Click to unfinalize' : 'Click to mark final'}"` : `title="Not packed yet"`}>
      ${item.item_name} ${qty}
    </span>`;
  }).join('');

  return `
    <div class="customer-row" id="cust-${slugify(customerName)}">
      <span class="customer-name-cell">${customerName}</span>
      <div class="item-chips">${chips}</div>
      <div class="customer-actions">
        ${allFinal
          ? `<button class="btn btn-sm btn-secondary" onclick="unfinalizeOrder('${escAttr(customerName)}')">Edit</button>`
          : `<button class="btn btn-sm btn-success"   onclick="finalizeOrder('${escAttr(customerName)}')">✓ All</button>`}
      </div>
    </div>`;
}

function escAttr(s) { return (s || '').replace(/'/g, "\\'"); }

// ── Chip click: toggle finalize ───────────────────────────────
async function toggleChip(id, currentStatus) {
  if (currentStatus === 'final') await unfinalizeItem(id);
  else                           await finalizeItem(id);
}

// ── Filters ───────────────────────────────────────────────────
function setupFilters() {
  document.getElementById('filter-community').addEventListener('change', groupAndRender);
  document.getElementById('filter-status').addEventListener('change', groupAndRender);
  document.getElementById('filter-search').addEventListener('input', groupAndRender);
}

// ── Inline save (for future use / programmatic) ───────────────
async function inlineSave(id, val) {
  if (isNaN(val) || val < 0) return;
  const { data: { user } } = await sb.auth.getUser();
  const email = user?.email ?? 'unknown';
  await sb.from('operations')
    .update({ final_quantity: val, status: 'draft', last_updated_by: email, last_updated_at: new Date().toISOString() })
    .eq('id', id);
  const idx = allItems.findIndex(i => i.id === id);
  if (idx !== -1) { allItems[idx].final_quantity = val; allItems[idx].status = 'draft'; }
}

// ── Finalize single item ──────────────────────────────────────
async function finalizeItem(id) {
  const { data: { user } } = await sb.auth.getUser();
  const email = user?.email ?? 'unknown';
  const now   = new Date().toISOString();

  const { error } = await sb.from('operations')
    .update({ status: 'final', finalized_by: email, finalized_at: now })
    .eq('id', id);
  if (error) { showToast('Failed', 'error'); return; }

  const idx = allItems.findIndex(i => i.id === id);
  if (idx !== -1) Object.assign(allItems[idx], { status: 'final', finalized_by: email, finalized_at: now });
  groupAndRender();
  updateSummary();
}

// ── Unfinalize single item ────────────────────────────────────
async function unfinalizeItem(id) {
  const { error } = await sb.from('operations')
    .update({ status: 'draft', finalized_by: null, finalized_at: null })
    .eq('id', id);
  if (error) { showToast('Failed', 'error'); return; }

  const idx = allItems.findIndex(i => i.id === id);
  if (idx !== -1) Object.assign(allItems[idx], { status: 'draft', finalized_by: null, finalized_at: null });
  groupAndRender();
  updateSummary();
}

// ── Finalize all items for one customer ───────────────────────
async function finalizeOrder(customerName) {
  const items      = allOrders[customerName] || [];
  const pendingIds = items.filter(i => i.status !== 'final').map(i => i.id);
  if (!pendingIds.length) return;

  const { data: { user } } = await sb.auth.getUser();
  const email = user?.email ?? 'unknown';
  const now   = new Date().toISOString();

  const { error } = await sb.from('operations')
    .update({ status: 'final', finalized_by: email, finalized_at: now })
    .in('id', pendingIds);
  if (error) { showToast('Failed to finalize', 'error'); return; }

  pendingIds.forEach(id => {
    const idx = allItems.findIndex(i => i.id === id);
    if (idx !== -1) Object.assign(allItems[idx], { status: 'final', finalized_by: email, finalized_at: now });
  });

  showToast(`${customerName} finalized ✓`);
  groupAndRender();
}

// ── Unfinalize all items for one customer ─────────────────────
async function unfinalizeOrder(customerName) {
  const items = allOrders[customerName] || [];
  const ids   = items.map(i => i.id);

  const { error } = await sb.from('operations')
    .update({ status: 'draft', finalized_by: null, finalized_at: null })
    .in('id', ids);
  if (error) { showToast('Failed', 'error'); return; }

  ids.forEach(id => {
    const idx = allItems.findIndex(i => i.id === id);
    if (idx !== -1) Object.assign(allItems[idx], { status: 'draft', finalized_by: null, finalized_at: null });
  });

  groupAndRender();
}

// ── Bulk finalize selected ────────────────────────────────────
async function bulkFinalize() {
  if (!selectedIds.size) return;
  const ids = [...selectedIds];

  const { data: { user } } = await sb.auth.getUser();
  const email = user?.email ?? 'unknown';
  const now   = new Date().toISOString();

  const { error } = await sb.from('operations')
    .update({ status: 'final', finalized_by: email, finalized_at: now })
    .in('id', ids);
  if (error) { showToast('Failed', 'error'); return; }

  ids.forEach(id => {
    const idx = allItems.findIndex(i => i.id === id);
    if (idx !== -1) Object.assign(allItems[idx], { status: 'final', finalized_by: email, finalized_at: now });
  });

  showToast(`${ids.length} item${ids.length !== 1 ? 's' : ''} finalized ✓`);
  selectedIds.clear();
  groupAndRender();
}

// ── Summary ───────────────────────────────────────────────────
function updateSummary() {
  const total = allItems.length;
  const done  = allItems.filter(i => i.status === 'final').length;
  document.getElementById('sum-total').textContent   = total;
  document.getElementById('sum-done').textContent    = done;
  document.getElementById('sum-pending').textContent = total - done;
}

// ── Selection (bulk bar) ──────────────────────────────────────
function updateBulkBar() {
  const bar = document.getElementById('bulk-bar');
  if (selectedIds.size > 0) {
    bar.classList.remove('hidden');
    document.getElementById('bulk-count').textContent = `${selectedIds.size} selected`;
  } else {
    bar.classList.add('hidden');
  }
}

function clearSelection() {
  selectedIds.clear();
  updateBulkBar();
}

let allSelected = false;
function toggleSelectAll() {
  allSelected = !allSelected;
  document.getElementById('btn-select-all').textContent = allSelected ? 'Deselect All' : 'Select All';
  allItems.forEach(i => { if (allSelected) selectedIds.add(i.id); else selectedIds.delete(i.id); });
  updateBulkBar();
}

function slugify(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '-');
}
