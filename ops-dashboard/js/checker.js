// ── State ──────────────────────────────────────────────────────────────────
let allItems      = [];
let allGroups     = {};
let selectedOrders = new Set();   // order_ids selected for bulk action

// ── Init ───────────────────────────────────────────────────────────────────
(function init() {
  // Date picker defaults to today IST
  const dateInput = document.getElementById('view-date');
  dateInput.value = todayIST();
  dateInput.addEventListener('change', loadItems);

  // Checker name persisted in localStorage
  const nameInput = document.getElementById('checker-name');
  nameInput.value = localStorage.getItem('checkerName') || '';
  nameInput.addEventListener('change', () => {
    localStorage.setItem('checkerName', nameInput.value.trim());
  });

  document.getElementById('section-date').textContent = formatDate(todayIST());
  setupFilters();
  loadItems();
})();

function checkerName() {
  return document.getElementById('checker-name').value.trim() || 'Checker';
}
function viewDate() {
  return document.getElementById('view-date').value || todayIST();
}

// ── Load items ─────────────────────────────────────────────────────────────
async function loadItems() {
  document.getElementById('section-date').textContent = formatDate(viewDate());

  const empty = document.getElementById('empty-state');
  empty.querySelector('p').textContent = 'Loading…';
  empty.classList.remove('hidden');
  document.getElementById('orders-container').innerHTML = '';
  document.getElementById('summary-bar').classList.add('hidden');
  document.getElementById('section-header').classList.add('hidden');
  document.getElementById('bulk-bar').classList.add('hidden');
  selectedOrders.clear();

  const { data: items, error } = await sb
    .from('order_items')
    .select('*, order:orders(sales_id, contact_name, payment_method, status, payment_status, zoho_invoice_id)')
    .eq('order_date', viewDate())
    .order('community')
    .order('customer_name')
    .order('item_name');

  if (error || !items?.length) {
    empty.querySelector('p').textContent = 'No items for this date';
    return;
  }

  // Populate community filter
  const communities = [...new Set(items.map(i => i.community).filter(Boolean))].sort();
  const sel = document.getElementById('filter-community');
  sel.innerHTML = '<option value="">All Communities</option>';
  communities.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c;
    sel.appendChild(opt);
  });

  allItems = items;
  groupAndRender();
}

// ── Group + render ─────────────────────────────────────────────────────────
function groupAndRender() {
  const communityFilter = document.getElementById('filter-community').value;
  const statusFilter    = document.getElementById('filter-status').value;
  const searchFilter    = document.getElementById('filter-search').value.trim().toLowerCase();

  const filtered = allItems.filter(i => {
    if (communityFilter && i.community !== communityFilter) return false;
    if (statusFilter && i.status !== statusFilter) return false;
    if (searchFilter && !i.customer_name.toLowerCase().includes(searchFilter)) return false;
    return true;
  });

  const groups = {};
  filtered.forEach(item => {
    if (!groups[item.order_id]) {
      groups[item.order_id] = {
        order_id:      item.order_id,
        customer_name: item.customer_name,
        community:     item.community,
        contact_name:  item.order?.contact_name || null,
        zoho_invoice:  item.order?.zoho_invoice_id || null,
        payment_status: item.order?.payment_status || null,
        items:         [],
      };
    }
    groups[item.order_id].items.push(item);
  });
  allGroups = groups;

  const container = document.getElementById('orders-container');
  const empty     = document.getElementById('empty-state');

  if (!filtered.length) {
    container.innerHTML = '';
    empty.querySelector('p').textContent = 'No items match the filters';
    empty.classList.remove('hidden');
    document.getElementById('summary-bar').classList.add('hidden');
    document.getElementById('section-header').classList.add('hidden');
    return;
  }

  empty.classList.add('hidden');
  document.getElementById('summary-bar').classList.remove('hidden');
  document.getElementById('section-header').classList.remove('hidden');

  updateSummary();
  document.getElementById('section-count').textContent =
    `${filtered.length} item${filtered.length !== 1 ? 's' : ''} · ${Object.keys(groups).length} orders`;

  container.innerHTML = '';
  Object.values(groups).forEach(g => container.appendChild(buildOrderBlock(g)));
}

// ── Build order block ──────────────────────────────────────────────────────
function buildOrderBlock(group) {
  const activeItems = group.items.filter(i => i.item_status !== 'REMOVED');
  const finalCount  = activeItems.filter(i => i.status === 'final' || i.status === 'invoice_generated' || i.item_status === 'NOBILL').length;
  const allFinal    = activeItems.length > 0 && finalCount === activeItems.length;
  const openCount   = activeItems.filter(i => i.status === 'open').length;

  const wrap = document.createElement('div');
  wrap.className = `order-block${allFinal ? ' order-complete' : ''}`;
  wrap.id = `order-${slugify(group.order_id)}`;

  const nameDisplay = group.contact_name
    ? `${group.customer_name} <span style="font-weight:400;color:var(--text-muted);font-size:.82rem">(${group.contact_name})</span>`
    : group.customer_name;

  const isSelected = selectedOrders.has(group.order_id);

  const hdr = document.createElement('div');
  hdr.className = 'order-header';
  hdr.innerHTML = `
    <input type="checkbox" id="chk-order-${slugify(group.order_id)}"
      ${isSelected ? 'checked' : ''}
      onchange="toggleOrderSelection('${escapeJs(group.order_id)}', this.checked)"
      style="pointer-events:all">
    <div class="order-header-left">
      <span class="order-customer">${nameDisplay}</span>
      ${group.community ? `<span class="order-community">${group.community}</span>` : ''}
    </div>
    <div class="order-header-right">
      ${openCount ? `<span class="order-warn">⚠ ${openCount} open</span>` : ''}
      <span class="order-progress ${allFinal ? 'progress-done' : 'progress-partial'}">
        ${finalCount}/${activeItems.length} final
      </span>
      ${group.zoho_invoice ? `<span class="status-badge badge-invoice_generated">Invoiced</span>` : ''}
      ${group.payment_status ? `<span class="status-badge badge-pay-${group.payment_status}">${group.payment_status.replace('_',' ')}</span>` : ''}
      ${!allFinal
        ? `<button class="btn btn-sm btn-success" onclick="finalizeOrder('${escapeJs(group.order_id)}')">Final All</button>`
        : `<button class="btn btn-sm btn-secondary" onclick="unfinalizeOrder('${escapeJs(group.order_id)}')">Reopen</button>`
      }
    </div>
  `;
  wrap.appendChild(hdr);

  const tbl = document.createElement('table');
  tbl.className = 'order-table';
  tbl.innerHTML = `
    <thead>
      <tr>
        <th>Item</th>
        <th style="text-align:center">Req</th>
        <th style="text-align:center">Final qty</th>
        <th style="text-align:center">Status</th>
        <th style="width:70px"></th>
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

  const isRemoved = item.item_status === 'REMOVED';
  const isNobill  = item.item_status === 'NOBILL';
  const isFinal   = item.status === 'final' || item.status === 'invoice_generated';

  let rowClass = '';
  if (isRemoved)     rowClass = 'row-removed';
  else if (isNobill) rowClass = 'row-nobill';
  else if (isFinal)  rowClass = 'row-final';
  else if (item.status === 'packed') rowClass = 'row-packed';
  else                               rowClass = 'row-open';
  tr.className = rowClass;

  const statusBadge = isRemoved
    ? `<span class="status-badge badge-removed">REMOVED</span>`
    : isNobill
      ? `<span class="status-badge badge-nobill">NOBILL</span>`
      : `<span class="status-badge badge-${item.status}">${item.status}</span>`;

  const auditLine = item.finalized_by
    ? `<div style="font-size:.7rem;color:var(--text-muted)">✓ ${item.finalized_by}</div>`
    : item.packed_by
      ? `<div style="font-size:.7rem;color:var(--text-muted)">Packed: ${item.packed_by}</div>`
      : '';

  // Final qty cell: input if not yet final, display if final/removed/nobill
  let qtyCell;
  if (isRemoved || isFinal || isNobill) {
    qtyCell = `<td style="text-align:center;font-weight:600">${item.final_qty ?? (isNobill ? '—' : '—')}</td>`;
  } else {
    qtyCell = `
      <td style="text-align:center">
        <input type="number" class="inline-qty-input" id="inline-${item.id}"
          value="${item.final_qty ?? ''}" placeholder="—"
          inputmode="decimal" step="0.1"
          onblur="inlineSave('${item.id}')"
          onkeydown="if(event.key==='Enter') inlineSave('${item.id}')">
      </td>`;
  }

  // Action cell
  let actionCell;
  if (isRemoved) {
    actionCell = `<td></td>`;
  } else if (isFinal) {
    actionCell = `<td><button class="btn btn-sm btn-secondary" onclick="unfinalizeItem('${item.id}')">Reopen</button></td>`;
  } else {
    actionCell = `<td><button class="btn btn-sm btn-success" onclick="finalizeItem('${item.id}')">✓ Final</button></td>`;
  }

  tr.innerHTML = `
    <td>
      <div style="font-weight:500">${item.item_name}</div>
      ${item.description ? `<div style="font-size:.75rem;color:var(--text-muted)">${item.description}</div>` : ''}
      ${auditLine}
    </td>
    <td style="text-align:center;color:var(--text-muted)">${item.requested_qty ?? '—'}</td>
    ${qtyCell}
    <td style="text-align:center">${statusBadge}</td>
    ${actionCell}
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
function toggleOrderSelection(orderId, checked) {
  if (checked) selectedOrders.add(orderId);
  else selectedOrders.delete(orderId);
  updateBulkBar();
}

let allSelected = false;
function toggleSelectAll() {
  allSelected = !allSelected;
  document.getElementById('btn-select-all').textContent = allSelected ? 'Deselect All' : 'Select All';
  Object.keys(allGroups).forEach(orderId => {
    if (allSelected) selectedOrders.add(orderId);
    else selectedOrders.delete(orderId);
    const chk = document.getElementById(`chk-order-${slugify(orderId)}`);
    if (chk) chk.checked = allSelected;
  });
  updateBulkBar();
}

function clearSelection() {
  selectedOrders.clear();
  allSelected = false;
  document.getElementById('btn-select-all').textContent = 'Select All';
  document.querySelectorAll('[id^=chk-order-]').forEach(c => c.checked = false);
  updateBulkBar();
}

function updateBulkBar() {
  const bar = document.getElementById('bulk-bar');
  if (selectedOrders.size > 0) {
    bar.classList.remove('hidden');
    document.getElementById('bulk-count').textContent = `${selectedOrders.size} order${selectedOrders.size !== 1 ? 's' : ''} selected`;
  } else {
    bar.classList.add('hidden');
  }
}

// ── Inline save qty ────────────────────────────────────────────────────────
async function inlineSave(id) {
  const input = document.getElementById(`inline-${id}`);
  if (!input) return;
  const val = parseFloat(input.value);
  if (isNaN(val) || val < 0) return;

  const { error } = await sb.from('order_items').update({ final_qty: val }).eq('id', id);
  if (error) { showToast('Save failed', 'error'); return; }

  const idx = allItems.findIndex(i => i.id === id);
  if (idx !== -1) allItems[idx].final_qty = val;
  input.style.borderColor = 'var(--green)';
}

// ── Finalize single item ───────────────────────────────────────────────────
async function finalizeItem(id) {
  // Flush inline input first if present
  const input = document.getElementById(`inline-${id}`);
  const val   = input ? parseFloat(input.value) : null;
  const item  = allItems.find(i => i.id === id);

  // Must have final_qty unless NOBILL
  if (item?.item_status !== 'NOBILL' && (val == null || isNaN(val)) && !item?.final_qty) {
    showToast('Enter final quantity first', 'error');
    if (input) input.focus();
    return;
  }

  const update = {
    status:       'final',
    finalized_by: checkerName(),
    finalized_at: new Date().toISOString(),
  };
  if (val != null && !isNaN(val)) update.final_qty = val;

  const { error } = await sb.from('order_items').update(update).eq('id', id);
  if (error) { showToast('Failed', 'error'); return; }

  const idx = allItems.findIndex(i => i.id === id);
  if (idx !== -1) allItems[idx] = { ...allItems[idx], ...update };
  refreshRow(id);
  updateSummary();
  refreshOrderHeader(id);
}

async function unfinalizeItem(id) {
  const { error } = await sb
    .from('order_items')
    .update({ status: 'packed', finalized_by: null, finalized_at: null })
    .eq('id', id);
  if (error) { showToast('Failed', 'error'); return; }

  const idx = allItems.findIndex(i => i.id === id);
  if (idx !== -1) allItems[idx] = { ...allItems[idx], status: 'packed', finalized_by: null, finalized_at: null };
  refreshRow(id);
  updateSummary();
  refreshOrderHeader(id);
}

// ── Finalize all items in an order ────────────────────────────────────────
async function finalizeOrder(orderId) {
  const group = allGroups[orderId];
  if (!group) return;

  const toFinalize = group.items.filter(i =>
    i.item_status !== 'REMOVED' &&
    i.status !== 'final' && i.status !== 'invoice_generated'
  );

  // Validate all have final_qty (or are NOBILL)
  const missing = toFinalize.filter(i => i.item_status !== 'NOBILL' && !i.final_qty);
  if (missing.length) {
    // Try to save any inline inputs first
    for (const item of missing) {
      const input = document.getElementById(`inline-${item.id}`);
      if (input) {
        const v = parseFloat(input.value);
        if (!isNaN(v) && v >= 0) {
          await sb.from('order_items').update({ final_qty: v }).eq('id', item.id);
          const idx = allItems.findIndex(i => i.id === item.id);
          if (idx !== -1) allItems[idx].final_qty = v;
          item.final_qty = v;
        }
      }
    }
    const stillMissing = toFinalize.filter(i => i.item_status !== 'NOBILL' && !i.final_qty);
    if (stillMissing.length) {
      showToast(`Enter qty for: ${stillMissing.map(i => i.item_name).join(', ')}`, 'error');
      return;
    }
  }

  const ids = toFinalize.map(i => i.id);
  const { error } = await sb.from('order_items').update({
    status:       'final',
    finalized_by: checkerName(),
    finalized_at: new Date().toISOString(),
  }).in('id', ids);

  if (error) { showToast('Failed to finalize', 'error'); return; }

  ids.forEach(id => {
    const idx = allItems.findIndex(i => i.id === id);
    if (idx !== -1) allItems[idx] = { ...allItems[idx], status: 'final', finalized_by: checkerName() };
  });

  showToast(`${group.customer_name} finalized ✓`);
  const wrap = document.getElementById(`order-${slugify(orderId)}`);
  if (wrap) {
    group.items = group.items.map(i => allItems.find(a => a.id === i.id) || i);
    wrap.replaceWith(buildOrderBlock(group));
  }
  updateSummary();
}

async function unfinalizeOrder(orderId) {
  const group = allGroups[orderId];
  if (!group) return;
  const ids = group.items.filter(i => i.status === 'final').map(i => i.id);
  if (!ids.length) return;

  const { error } = await sb.from('order_items')
    .update({ status: 'packed', finalized_by: null, finalized_at: null })
    .in('id', ids);
  if (error) { showToast('Failed', 'error'); return; }

  ids.forEach(id => {
    const idx = allItems.findIndex(i => i.id === id);
    if (idx !== -1) allItems[idx] = { ...allItems[idx], status: 'packed', finalized_by: null };
  });
  group.items = group.items.map(i => allItems.find(a => a.id === i.id) || i);
  const wrap = document.getElementById(`order-${slugify(orderId)}`);
  if (wrap) wrap.replaceWith(buildOrderBlock(group));
  updateSummary();
}

// ── Bulk: mark all selected orders final ──────────────────────────────────
async function bulkFinalizeOrders() {
  if (!selectedOrders.size) return;
  for (const orderId of selectedOrders) {
    await finalizeOrder(orderId);
  }
  clearSelection();
}

// ── Generate invoices for selected orders ─────────────────────────────────
async function generateInvoices() {
  if (!selectedOrders.size) { showToast('Select orders first', 'error'); return; }

  // Validate: all active items must be final or NOBILL
  const problems = [];
  for (const orderId of selectedOrders) {
    const group = allGroups[orderId];
    if (!group) continue;
    const notReady = group.items.filter(i =>
      i.item_status !== 'REMOVED' &&
      i.item_status !== 'NOBILL' &&
      i.status !== 'final' &&
      i.status !== 'invoice_generated'
    );
    if (notReady.length) {
      problems.push(`${group.customer_name}: ${notReady.map(i => i.item_name).join(', ')} not final`);
    }
  }

  if (problems.length) {
    alert(`Cannot generate invoice — items not yet finalized:\n\n${problems.join('\n')}`);
    return;
  }

  const orderIds = [...selectedOrders];
  const btn = document.querySelector('.btn-invoice');
  if (btn) { btn.textContent = 'Generating…'; btn.disabled = true; }

  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/generate-invoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_ANON}` },
      body: JSON.stringify({ order_ids: orderIds, checker: checkerName() }),
    });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Invoice generation failed');

    showToast(`${data.invoices?.length || 0} invoice${data.invoices?.length !== 1 ? 's' : ''} generated ✓`);
    clearSelection();
    await loadItems();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (btn) { btn.textContent = 'Generate Invoice'; btn.disabled = false; }
  }
}

// ── Summary ────────────────────────────────────────────────────────────────
function updateSummary() {
  const active = allItems.filter(i => i.item_status !== 'REMOVED');
  document.getElementById('sum-total').textContent  = active.length;
  document.getElementById('sum-open').textContent   = active.filter(i => i.status === 'open').length;
  document.getElementById('sum-packed').textContent = active.filter(i => i.status === 'packed').length;
  document.getElementById('sum-final').textContent  = active.filter(i => i.status === 'final' || i.status === 'invoice_generated').length;
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

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '-');
}

function escapeJs(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
