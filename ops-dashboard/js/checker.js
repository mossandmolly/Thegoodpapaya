// ── State ──────────────────────────────────────────────────────────────────
let allItems    = [];   // flat list of order_items rows (with nested order data)
let allGroups   = {};   // keyed by order_id
let selectedIds = new Set();

// ── Init ───────────────────────────────────────────────────────────────────
(async function init() {
  document.getElementById('section-date').textContent = formatDate(todayIST());
  await loadItems();
  setupFilters();
})();

// ── Load items ─────────────────────────────────────────────────────────────
async function loadItems() {
  const empty = document.getElementById('empty-state');
  empty.querySelector('p').textContent = 'Loading today\'s items…';
  empty.classList.remove('hidden');
  document.getElementById('orders-container').innerHTML = '';
  document.getElementById('summary-bar').classList.add('hidden');
  document.getElementById('section-header').classList.add('hidden');

  const { data: items, error } = await sb
    .from('order_items')
    .select('*, order:orders(sales_id, contact_name, payment_method, status)')
    .eq('order_date', todayIST())
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
  sel.innerHTML = '<option value="">All communities</option>';
  communities.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c;
    sel.appendChild(opt);
  });

  allItems = items;
  groupAndRender();
}

// ── Group items by order_id and render ─────────────────────────────────────
function groupAndRender() {
  const communityFilter = document.getElementById('filter-community').value;
  const statusFilter    = document.getElementById('filter-status').value;
  const searchFilter    = document.getElementById('filter-search').value.trim().toLowerCase();

  const filtered = allItems.filter(i => {
    if (communityFilter && i.community    !== communityFilter) return false;
    if (statusFilter    && i.status       !== statusFilter)    return false;
    if (searchFilter    && !i.customer_name.toLowerCase().includes(searchFilter)) return false;
    return true;
  });

  // Group by order_id
  const groups = {};
  filtered.forEach(item => {
    if (!groups[item.order_id]) {
      groups[item.order_id] = {
        order_id:     item.order_id,
        customer_name: item.customer_name,
        community:    item.community,
        contact_name: item.order?.contact_name || null,
        items: [],
      };
    }
    groups[item.order_id].items.push(item);
  });
  allGroups = groups;

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
    `${total} item${total !== 1 ? 's' : ''} today · ${Object.keys(groups).length} orders`;

  container.innerHTML = '';
  Object.values(groups).forEach(g => container.appendChild(buildOrderBlock(g)));
}

// ── Build order block ──────────────────────────────────────────────────────
function buildOrderBlock(group) {
  const allPacked  = group.items.every(i => i.status === 'packed');
  const nonePacked = group.items.every(i => i.status !== 'packed');
  const somePacked = !allPacked && !nonePacked;

  const wrap = document.createElement('div');
  wrap.className = 'order-block' + (allPacked ? ' order-complete' : '');
  wrap.id = `order-${slugify(group.order_id)}`;

  const nameDisplay = group.contact_name
    ? `${group.customer_name} <span style="font-weight:400;color:var(--text-muted);font-size:.82rem">(${group.contact_name})</span>`
    : group.customer_name;

  const hdr = document.createElement('div');
  hdr.className = 'order-header';
  hdr.innerHTML = `
    <div class="order-header-left">
      <span class="order-customer">${nameDisplay}</span>
      ${group.community ? `<span class="order-community">${group.community}</span>` : ''}
    </div>
    <div class="order-header-right">
      ${somePacked ? `<span class="order-warn">⚠ ${group.items.filter(i=>i.status!=='packed').length} pending</span>` : ''}
      <span class="order-progress ${allPacked ? 'progress-done' : 'progress-partial'}">
        ${group.items.filter(i=>i.status==='packed').length}/${group.items.length}
      </span>
      ${allPacked
        ? `<button class="btn btn-sm btn-secondary" onclick="unpackOrder('${group.order_id}')">Edit</button>`
        : `<button class="btn btn-sm btn-success"   onclick="packOrder('${group.order_id}')">Pack All</button>`
      }
    </div>
  `;
  wrap.appendChild(hdr);

  const tbl = document.createElement('table');
  tbl.className = 'order-table';
  tbl.innerHTML = `
    <thead>
      <tr>
        <th style="width:32px"><input type="checkbox"
          onchange="toggleOrderSelection('${group.order_id}', this.checked)"
          id="chk-order-${slugify(group.order_id)}"></th>
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

// ── Build item row ─────────────────────────────────────────────────────────
function buildItemRow(item) {
  const tr = document.createElement('tr');
  tr.id = `row-${item.id}`;
  tr.className = item.status === 'packed' ? 'final' : '';

  const isPacked = item.status === 'packed';
  tr.innerHTML = `
    <td><input type="checkbox" class="row-check" data-id="${item.id}"
      ${selectedIds.has(item.id) ? 'checked' : ''}
      onchange="toggleItem('${item.id}', this.checked)"></td>
    <td>
      <div style="font-weight:500">${item.item_name}</div>
      ${item.description ? `<div style="font-size:.75rem;color:var(--text-muted)">${item.description}</div>` : ''}
    </td>
    <td style="text-align:center;font-size:.9rem">${item.requested_qty ?? '—'}</td>
    <td style="text-align:center">
      ${isPacked
        ? `<span style="font-weight:600">${item.final_qty ?? '—'}</span>`
        : `<input type="number" class="inline-qty-input" id="inline-${item.id}"
             value="${item.final_qty ?? ''}" placeholder="—"
             inputmode="decimal" step="0.1"
             onblur="inlineSave('${item.id}')"
             onkeydown="if(event.key==='Enter') inlineSave('${item.id}')">`
      }
    </td>
    <td style="text-align:center">
      <span class="status-badge badge-${item.status}">${item.status}</span>
    </td>
    <td>
      ${isPacked
        ? `<button class="btn btn-sm btn-secondary" onclick="unfinalizeItem('${item.id}')">Edit</button>`
        : `<button class="btn btn-sm btn-success"   onclick="finalizeItem('${item.id}')">✓</button>`
      }
    </td>
  `;
  return tr;
}

// ── Filters ────────────────────────────────────────────────────────────────
function setupFilters() {
  document.getElementById('filter-community').addEventListener('change', groupAndRender);
  document.getElementById('filter-status').addEventListener('change', groupAndRender);
  document.getElementById('filter-search').addEventListener('input', groupAndRender);
}

// ── Selection ──────────────────────────────────────────────────────────────
function toggleItem(id, checked) {
  if (checked) selectedIds.add(id); else selectedIds.delete(id);
  updateBulkBar();
}

function toggleOrderSelection(orderId, checked) {
  const group = allGroups[orderId];
  if (!group) return;
  group.items.forEach(i => {
    if (checked) selectedIds.add(i.id); else selectedIds.delete(i.id);
    const chk = document.querySelector(`input.row-check[data-id="${i.id}"]`);
    if (chk) chk.checked = checked;
  });
  updateBulkBar();
}

let allSelected = false;
function toggleSelectAll() {
  allSelected = !allSelected;
  document.getElementById('btn-select-all').textContent = allSelected ? 'Deselect All' : 'Select All';
  Object.values(allGroups).forEach(g => {
    g.items.forEach(i => {
      if (allSelected) selectedIds.add(i.id); else selectedIds.delete(i.id);
      const chk = document.querySelector(`input.row-check[data-id="${i.id}"]`);
      if (chk) chk.checked = allSelected;
    });
    const orderChk = document.getElementById(`chk-order-${slugify(g.order_id)}`);
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

// ── Inline save ────────────────────────────────────────────────────────────
async function inlineSave(id) {
  const input = document.getElementById(`inline-${id}`);
  if (!input) return;
  const val = parseFloat(input.value);
  if (isNaN(val) || val < 0) return;

  const { error } = await sb
    .from('order_items')
    .update({ final_qty: val })
    .eq('id', id);

  if (error) { showToast('Save failed', 'error'); return; }

  const idx = allItems.findIndex(i => i.id === id);
  if (idx !== -1) allItems[idx].final_qty = val;
  input.style.borderColor = 'var(--green)';
}

// ── Finalize / pack single item ────────────────────────────────────────────
async function finalizeItem(id) {
  const input = document.getElementById(`inline-${id}`);
  const val   = input ? parseFloat(input.value) : null;
  const update = { status: 'packed' };
  if (input && !isNaN(val) && val >= 0) update.final_qty = val;

  const { error } = await sb.from('order_items').update(update).eq('id', id);
  if (error) { showToast('Failed', 'error'); return; }

  const idx = allItems.findIndex(i => i.id === id);
  if (idx !== -1) {
    allItems[idx].status = 'packed';
    if (update.final_qty !== undefined) allItems[idx].final_qty = update.final_qty;
  }
  refreshRow(id);
  updateSummary();
  refreshOrderHeader(id);
}

async function unfinalizeItem(id) {
  const { error } = await sb.from('order_items').update({ status: 'pending' }).eq('id', id);
  if (error) { showToast('Failed', 'error'); return; }
  const idx = allItems.findIndex(i => i.id === id);
  if (idx !== -1) allItems[idx].status = 'pending';
  refreshRow(id);
  updateSummary();
  refreshOrderHeader(id);
}

// ── Pack / unpack all items for one order ──────────────────────────────────
async function packOrder(orderId) {
  const group = allGroups[orderId];
  if (!group) return;
  const pendingIds = group.items.filter(i => i.status !== 'packed').map(i => i.id);
  if (!pendingIds.length) return;

  for (const id of pendingIds) {
    const input = document.getElementById(`inline-${id}`);
    if (input) {
      const val = parseFloat(input.value);
      if (!isNaN(val) && val >= 0) {
        const idx = allItems.findIndex(i => i.id === id);
        if (idx !== -1) allItems[idx].final_qty = val;
        await sb.from('order_items').update({ final_qty: val }).eq('id', id);
      }
    }
  }

  const { error } = await sb.from('order_items').update({ status: 'packed' }).in('id', pendingIds);
  if (error) { showToast('Failed to pack', 'error'); return; }

  pendingIds.forEach(id => {
    const idx = allItems.findIndex(i => i.id === id);
    if (idx !== -1) allItems[idx].status = 'packed';
  });

  showToast(`${group.customer_name} packed ✓`);
  groupAndRender();
}

async function unpackOrder(orderId) {
  const group = allGroups[orderId];
  if (!group) return;
  const ids = group.items.map(i => i.id);
  const { error } = await sb.from('order_items').update({ status: 'pending' }).in('id', ids);
  if (error) { showToast('Failed', 'error'); return; }
  ids.forEach(id => {
    const idx = allItems.findIndex(i => i.id === id);
    if (idx !== -1) allItems[idx].status = 'pending';
  });
  groupAndRender();
}

// ── Bulk pack selected ─────────────────────────────────────────────────────
async function bulkFinalize() {
  if (!selectedIds.size) return;
  const ids = [...selectedIds];
  const { error } = await sb.from('order_items').update({ status: 'packed' }).in('id', ids);
  if (error) { showToast('Failed', 'error'); return; }
  ids.forEach(id => {
    const idx = allItems.findIndex(i => i.id === id);
    if (idx !== -1) allItems[idx].status = 'packed';
  });
  showToast(`${ids.length} item${ids.length !== 1 ? 's' : ''} packed ✓`);
  clearSelection();
  groupAndRender();
}

// ── DOM helpers ────────────────────────────────────────────────────────────
function refreshRow(id) {
  const item = allItems.find(i => i.id === id);
  if (!item) return;
  const oldRow = document.getElementById(`row-${id}`);
  if (oldRow) oldRow.replaceWith(buildItemRow(item));
}

function refreshOrderHeader(id) {
  const item = allItems.find(i => i.id === id);
  if (!item) return;
  const group = allGroups[item.order_id];
  if (!group) return;
  group.items = group.items.map(i => allItems.find(a => a.id === i.id) || i);
  const wrap = document.getElementById(`order-${slugify(item.order_id)}`);
  if (wrap) wrap.replaceWith(buildOrderBlock(group));
}

function updateSummary() {
  const total = allItems.length;
  const done  = allItems.filter(i => i.status === 'packed').length;
  document.getElementById('sum-total').textContent   = total;
  document.getElementById('sum-done').textContent    = done;
  document.getElementById('sum-pending').textContent = total - done;
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '-');
}
