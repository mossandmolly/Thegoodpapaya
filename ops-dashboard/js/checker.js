// ── State ─────────────────────────────────────────────────────
let allItems     = [];   // flat list of all operations rows
let allOrders    = {};   // grouped by sales_order_id (or customer+date key)
let selectedIds  = new Set();

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
  communities.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    sel.appendChild(opt);
  });

  allItems = items;
  groupAndRender();
}

// ── Group items by customer order ─────────────────────────────
function groupAndRender() {
  const communityFilter = document.getElementById('filter-community').value;
  const statusFilter    = document.getElementById('filter-status').value;
  const searchFilter    = document.getElementById('filter-search').value.trim().toLowerCase();

  // Apply filters
  let filtered = allItems.filter(i => {
    if (communityFilter && i.community !== communityFilter) return false;
    if (statusFilter    && i.status    !== statusFilter)    return false;
    if (searchFilter    && !i.customer_name.toLowerCase().includes(searchFilter)) return false;
    return true;
  });

  // Group by customer_name (within today's date — one "order" per customer)
  const groups = {};
  filtered.forEach(item => {
    const key = item.customer_name;
    if (!groups[key]) groups[key] = { customer_name: item.customer_name, community: item.community, items: [] };
    groups[key].items.push(item);
  });
  allOrders = groups;

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

  // Update summary counts from full allItems (not filtered)
  updateSummary();

  const total = filtered.length;
  document.getElementById('section-count').textContent =
    `${total} item${total !== 1 ? 's' : ''} today · ${Object.keys(groups).length} customers`;

  container.innerHTML = '';
  Object.values(groups).forEach(g => container.appendChild(buildOrderBlock(g)));
}

// ── Build order block ─────────────────────────────────────────
function buildOrderBlock(group) {
  const allFinal   = group.items.every(i => i.status === 'final');
  const noneFinal  = group.items.every(i => i.status !== 'final');
  const someFinal  = !allFinal && !noneFinal;

  const wrap = document.createElement('div');
  wrap.className = 'order-block' + (allFinal ? ' order-complete' : '');
  wrap.id = `order-${slugify(group.customer_name)}`;

  // Header
  const hdr = document.createElement('div');
  hdr.className = 'order-header';
  hdr.innerHTML = `
    <div class="order-header-left">
      <span class="order-customer">${group.customer_name}</span>
      ${group.community ? `<span class="order-community">${group.community}</span>` : ''}
    </div>
    <div class="order-header-right">
      ${someFinal ? `<span class="order-warn">⚠ ${group.items.filter(i=>i.status!=='final').length} pending</span>` : ''}
      <span class="order-progress ${allFinal ? 'progress-done' : 'progress-partial'}">
        ${group.items.filter(i=>i.status==='final').length}/${group.items.length}
      </span>
      ${allFinal
        ? `<button class="btn btn-sm btn-secondary" onclick="unfinalizeOrder('${group.customer_name}')">Edit</button>`
        : `<button class="btn btn-sm btn-success"   onclick="finalizeOrder('${group.customer_name}')">Finalize All</button>`
      }
    </div>
  `;
  wrap.appendChild(hdr);

  // Items table
  const tbl = document.createElement('table');
  tbl.className = 'order-table';
  tbl.innerHTML = `
    <thead>
      <tr>
        <th style="width:32px"><input type="checkbox" onchange="toggleOrderSelection('${group.customer_name}', this.checked)" id="chk-order-${slugify(group.customer_name)}"></th>
        <th>Item</th>
        <th style="text-align:center">Req</th>
        <th style="text-align:center">Final</th>
        <th style="text-align:center">Status</th>
        <th style="width:60px"></th>
      </tr>
    </thead>
  `;
  const tbody = document.createElement('tbody');
  group.items.forEach(item => tbody.appendChild(buildItemRow(item)));
  tbl.appendChild(tbody);
  wrap.appendChild(tbl);

  return wrap;
}

// ── Build item row ─────────────────────────────────────────────
function buildItemRow(item) {
  const tr = document.createElement('tr');
  tr.id = `row-${item.id}`;
  tr.className = item.status === 'final' ? 'final' : '';

  const isFinal = item.status === 'final';
  tr.innerHTML = `
    <td><input type="checkbox" class="row-check" data-id="${item.id}"
      ${selectedIds.has(item.id) ? 'checked' : ''}
      onchange="toggleItem('${item.id}', this.checked)"></td>
    <td>
      <div style="font-weight:500">${item.item_name}</div>
      ${item.description ? `<div style="font-size:0.75rem;color:var(--text-muted)">${item.description}</div>` : ''}
    </td>
    <td style="text-align:center;font-size:0.9rem">${item.requested_quantity ?? '—'}</td>
    <td style="text-align:center">
      ${isFinal
        ? `<span style="font-weight:600">${item.final_quantity ?? '—'}</span>`
        : `<input type="number" class="inline-qty-input" id="inline-${item.id}"
             value="${item.final_quantity ?? ''}" placeholder="—"
             inputmode="decimal" step="0.1"
             onblur="inlineSave('${item.id}')"
             onkeydown="if(event.key==='Enter') inlineSave('${item.id}')">`
      }
    </td>
    <td style="text-align:center">
      <span class="status-badge badge-${item.status}">${item.status}</span>
    </td>
    <td>
      ${isFinal
        ? `<button class="btn btn-sm btn-secondary" onclick="unfinalizeItem('${item.id}')">Edit</button>`
        : `<button class="btn btn-sm btn-success"   onclick="finalizeItem('${item.id}')">✓</button>`
      }
    </td>
  `;
  return tr;
}

// ── Filters ───────────────────────────────────────────────────
function setupFilters() {
  document.getElementById('filter-community').addEventListener('change', groupAndRender);
  document.getElementById('filter-status').addEventListener('change', groupAndRender);
  document.getElementById('filter-search').addEventListener('input', groupAndRender);
}

// ── Selection ─────────────────────────────────────────────────
function toggleItem(id, checked) {
  if (checked) selectedIds.add(id);
  else         selectedIds.delete(id);
  updateBulkBar();
}

function toggleOrderSelection(customerName, checked) {
  const group = allOrders[customerName];
  if (!group) return;
  group.items.forEach(i => {
    if (checked) selectedIds.add(i.id);
    else         selectedIds.delete(i.id);
    const chk = document.querySelector(`input.row-check[data-id="${i.id}"]`);
    if (chk) chk.checked = checked;
  });
  updateBulkBar();
}

let allSelected = false;
function toggleSelectAll() {
  allSelected = !allSelected;
  document.getElementById('btn-select-all').textContent = allSelected ? 'Deselect All' : 'Select All';
  Object.values(allOrders).forEach(g => {
    g.items.forEach(i => {
      if (allSelected) selectedIds.add(i.id);
      else             selectedIds.delete(i.id);
      const chk = document.querySelector(`input.row-check[data-id="${i.id}"]`);
      if (chk) chk.checked = allSelected;
    });
    const orderChk = document.getElementById(`chk-order-${slugify(g.customer_name)}`);
    if (orderChk) orderChk.checked = allSelected;
  });
  updateBulkBar();
}

function clearSelection() {
  selectedIds.clear();
  allSelected = false;
  document.getElementById('btn-select-all').textContent = 'Select All';
  document.querySelectorAll('input[type=checkbox]').forEach(c => c.checked = false);
  updateBulkBar();
}

function updateBulkBar() {
  const bar = document.getElementById('bulk-bar');
  if (selectedIds.size > 0) {
    bar.classList.remove('hidden');
    document.getElementById('bulk-count').textContent = `${selectedIds.size} selected`;
  } else {
    bar.classList.add('hidden');
  }
}

// ── Inline save (blur / Enter) ────────────────────────────────
async function inlineSave(id) {
  const input = document.getElementById(`inline-${id}`);
  if (!input) return;
  const val = parseFloat(input.value);
  if (isNaN(val) || val < 0) return;

  const { data: { user } } = await sb.auth.getUser();
  const email = user?.email ?? 'unknown';

  const { error } = await sb
    .from('operations')
    .update({ final_quantity: val, status: 'draft', last_updated_by: email, last_updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) { showToast('Save failed', 'error'); return; }

  const idx = allItems.findIndex(i => i.id === id);
  if (idx !== -1) { allItems[idx].final_quantity = val; allItems[idx].status = 'draft'; }
  input.style.borderColor = 'var(--green)';
}

// ── Finalize single item ───────────────────────────────────────
async function finalizeItem(id) {
  const input = document.getElementById(`inline-${id}`);
  const val   = input ? parseFloat(input.value) : null;

  const { data: { user } } = await sb.auth.getUser();
  const email = user?.email ?? 'unknown';
  const now   = new Date().toISOString();

  const update = { status: 'final', finalized_by: email, finalized_at: now };
  if (input && !isNaN(val) && val >= 0) update.final_quantity = val;

  const { error } = await sb.from('operations').update(update).eq('id', id);
  if (error) { showToast('Failed', 'error'); return; }

  const idx = allItems.findIndex(i => i.id === id);
  if (idx !== -1) {
    Object.assign(allItems[idx], { status: 'final', finalized_by: email, finalized_at: now });
    if (update.final_quantity !== undefined) allItems[idx].final_quantity = update.final_quantity;
  }
  refreshRow(id);
  updateSummary();
  refreshOrderHeader(id);
}

// ── Unfinalize single item ────────────────────────────────────
async function unfinalizeItem(id) {
  const { error } = await sb.from('operations').update({ status: 'draft', finalized_by: null, finalized_at: null }).eq('id', id);
  if (error) { showToast('Failed', 'error'); return; }
  const idx = allItems.findIndex(i => i.id === id);
  if (idx !== -1) Object.assign(allItems[idx], { status: 'draft', finalized_by: null, finalized_at: null });
  refreshRow(id);
  updateSummary();
  refreshOrderHeader(id);
}

// ── Finalize all items for one customer ───────────────────────
async function finalizeOrder(customerName) {
  const group = allOrders[customerName];
  if (!group) return;

  const pendingIds = group.items.filter(i => i.status !== 'final').map(i => i.id);
  if (!pendingIds.length) return;

  const { data: { user } } = await sb.auth.getUser();
  const email = user?.email ?? 'unknown';
  const now   = new Date().toISOString();

  // Save any inline values first
  for (const id of pendingIds) {
    const input = document.getElementById(`inline-${id}`);
    if (input) {
      const val = parseFloat(input.value);
      if (!isNaN(val) && val >= 0) {
        const idx = allItems.findIndex(i => i.id === id);
        if (idx !== -1) allItems[idx].final_quantity = val;
        await sb.from('operations').update({ final_quantity: val, last_updated_by: email, last_updated_at: now }).eq('id', id);
      }
    }
  }

  const { error } = await sb
    .from('operations')
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
  const group = allOrders[customerName];
  if (!group) return;

  const ids = group.items.map(i => i.id);
  const { error } = await sb.from('operations').update({ status: 'draft', finalized_by: null, finalized_at: null }).in('id', ids);
  if (error) { showToast('Failed', 'error'); return; }

  ids.forEach(id => {
    const idx = allItems.findIndex(i => i.id === id);
    if (idx !== -1) Object.assign(allItems[idx], { status: 'draft', finalized_by: null, finalized_at: null });
  });

  groupAndRender();
}

// ── Bulk finalize selected items ──────────────────────────────
async function bulkFinalize() {
  if (!selectedIds.size) return;
  const ids = [...selectedIds];

  const { data: { user } } = await sb.auth.getUser();
  const email = user?.email ?? 'unknown';
  const now   = new Date().toISOString();

  const { error } = await sb.from('operations').update({ status: 'final', finalized_by: email, finalized_at: now }).in('id', ids);
  if (error) { showToast('Failed', 'error'); return; }

  ids.forEach(id => {
    const idx = allItems.findIndex(i => i.id === id);
    if (idx !== -1) Object.assign(allItems[idx], { status: 'final', finalized_by: email, finalized_at: now });
  });

  showToast(`${ids.length} item${ids.length !== 1 ? 's' : ''} finalized ✓`);
  clearSelection();
  groupAndRender();
}

// ── DOM helpers ───────────────────────────────────────────────
function refreshRow(id) {
  const item = allItems.find(i => i.id === id);
  if (!item) return;
  const oldRow = document.getElementById(`row-${id}`);
  if (oldRow) oldRow.replaceWith(buildItemRow(item));
}

function refreshOrderHeader(id) {
  const item = allItems.find(i => i.id === id);
  if (!item) return;
  const group = allOrders[item.customer_name];
  if (!group) return;
  // Sync group items state
  group.items = group.items.map(i => allItems.find(a => a.id === i.id) || i);

  const wrap = document.getElementById(`order-${slugify(item.customer_name)}`);
  if (!wrap) return;
  const newBlock = buildOrderBlock(group);
  wrap.replaceWith(newBlock);
}

function updateSummary() {
  const total   = allItems.length;
  const done    = allItems.filter(i => i.status === 'final').length;
  document.getElementById('sum-total').textContent   = total;
  document.getElementById('sum-done').textContent    = done;
  document.getElementById('sum-pending').textContent = total - done;
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '-');
}
