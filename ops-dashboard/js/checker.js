// ── State ─────────────────────────────────────────────────────
let allItems    = [];
let allOrders   = {}; // { customer_name: items[] }
let selectedIds = new Set();

// Invoice generation state
let _invStatusMap  = {};  // { sales_order_id: { customer_name, status, invoice_number, error } }
let _realtimeChannel = null;

// ── Init ──────────────────────────────────────────────────────
(async function init() {
  document.getElementById('section-date').textContent = formatDate(todayIST());
  await loadItems();
  setupFilters();
})();

// ── Load items ────────────────────────────────────────────────
async function loadItems() {
  const empty = document.getElementById('empty-state');
  empty.querySelector('p').textContent = 'Loading today’s items…';
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
  updateInvoiceBar();
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

// ── Invoice bar ───────────────────────────────────────────────
// Shows how many orders have all items finalized and haven't been invoiced yet.
function updateInvoiceBar() {
  const bar = document.getElementById('invoice-bar');
  if (!bar) return;

  // Group allItems by sales_order_id
  const byOrder = {};
  allItems.forEach(i => {
    if (!i.sales_order_id) return;
    if (!byOrder[i.sales_order_id]) byOrder[i.sales_order_id] = [];
    byOrder[i.sales_order_id].push(i);
  });

  // An order is "ready" if every item is final AND it isn't already invoiced
  const readyIds = Object.entries(byOrder)
    .filter(([soid, items]) => {
      const allFinal = items.every(i => i.status === 'final');
      const alreadyDone = _invStatusMap[soid] &&
        ['queued','processing','done'].includes(_invStatusMap[soid].status);
      return allFinal && !alreadyDone;
    })
    .map(([soid]) => soid);

  if (readyIds.length === 0) {
    bar.classList.add('hidden');
    return;
  }

  bar.classList.remove('hidden');
  document.getElementById('inv-ready-label').innerHTML =
    '<strong>' + readyIds.length + '</strong> order' + (readyIds.length !== 1 ? 's' : '') + ' ready to invoice';
}

// ── Generate invoices ─────────────────────────────────────────
async function generateInvoices() {
  const btn = document.getElementById('btn-generate');
  btn.disabled = true;
  btn.textContent = 'Queuing…';

  try {
    // Collect sales_order_ids where all items are final
    const byOrder = {};
    allItems.forEach(i => {
      if (!i.sales_order_id) return;
      if (!byOrder[i.sales_order_id]) byOrder[i.sales_order_id] = { items: [], customer_name: i.customer_name };
      byOrder[i.sales_order_id].items.push(i);
    });

    const readyOrders = Object.entries(byOrder).filter(([, o]) => o.items.every(i => i.status === 'final'));
    if (!readyOrders.length) { showToast('No fully-finalized orders to invoice', 'error'); return; }

    const salesOrderIds = readyOrders.map(([soid]) => soid);

    // Seed local status map so the panel shows immediately
    readyOrders.forEach(([soid, o]) => {
      _invStatusMap[soid] = { customer_name: o.customer_name, status: 'queued', invoice_number: null, error: null };
    });
    showInvoiceStatusPanel();

    // Call queue-invoices (which also fires process-invoice-queue in background)
    const res  = await fetch(SUPABASE_URL + '/functions/v1/queue-invoices', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON },
      body:    JSON.stringify({ sales_order_ids: salesOrderIds }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Queue failed');

    showToast(data.queued + ' invoices queued — generating…');
    subscribeRealtimeInvoiceQueue(salesOrderIds);

  } catch (e) {
    showToast(e.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Generate Invoices';
  }
}

// ── Invoice status panel ──────────────────────────────────────
function showInvoiceStatusPanel() {
  const wrap = document.getElementById('invoice-status-wrap');
  if (wrap) wrap.classList.add('visible');
  renderInvoiceStatusList();
}

function renderInvoiceStatusList() {
  const list = document.getElementById('invoice-status-list');
  if (!list) return;

  const entries = Object.values(_invStatusMap);
  if (!entries.length) { list.innerHTML = ''; return; }

  const counts = { queued: 0, processing: 0, done: 0, failed: 0 };
  entries.forEach(e => { if (counts[e.status] !== undefined) counts[e.status]++; });

  const sumEl = document.getElementById('inv-status-summary');
  if (sumEl) {
    const parts = [];
    if (counts.done)       parts.push(counts.done + ' done');
    if (counts.processing) parts.push(counts.processing + ' processing');
    if (counts.queued)     parts.push(counts.queued + ' queued');
    if (counts.failed)     parts.push(counts.failed + ' failed');
    sumEl.textContent = parts.join(' · ');
  }

  const sorted = [...entries].sort((a, b) => a.customer_name.localeCompare(b.customer_name));

  list.innerHTML = sorted.map(e => {
    const labels = { queued: 'queued', processing: 'processing…', done: '✓ done', failed: '✗ failed' };
    const badge  = '<span class="inv-badge inv-' + e.status + '"><span class="inv-dot"></span>' + (labels[e.status] || e.status) + '</span>';
    const extra  = e.status === 'done' && e.invoice_number
      ? '<a class="inv-link" href="https://books.zoho.in/app#/invoices/' + (e.zoho_invoice_id || '') + '" target="_blank" rel="noopener">' + e.invoice_number + ' ↗</a>'
      : e.status === 'failed' && e.error
        ? '<span class="inv-err" title="' + e.error + '">' + e.error.substring(0, 60) + '</span>'
        : '';
    return '<div class="inv-row"><span class="inv-cust">' + e.customer_name + '</span>' + badge + extra + '</div>';
  }).join('');
}

// ── Supabase Realtime subscription on invoice_queue ───────────
function subscribeRealtimeInvoiceQueue(salesOrderIds) {
  if (_realtimeChannel) { sb.removeChannel(_realtimeChannel); _realtimeChannel = null; }

  _realtimeChannel = sb.channel('invoice-queue-watch')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'invoice_queue' }, async (payload) => {
      const row = payload.new || {};
      if (!row.sales_order_id || !_invStatusMap[row.sales_order_id]) return;

      // Fetch matching order for invoice_number / zoho_invoice_id
      const { data: order } = await sb
        .from('orders')
        .select('invoice_number, zoho_invoice_id')
        .eq('sales_order_id', row.sales_order_id)
        .maybeSingle();

      _invStatusMap[row.sales_order_id] = {
        ..._invStatusMap[row.sales_order_id],
        status:         row.status,
        error:          row.error_message || null,
        invoice_number: order?.invoice_number || null,
        zoho_invoice_id: order?.zoho_invoice_id || null,
      };

      renderInvoiceStatusList();
      updateInvoiceBar();

      // Re-enable the button once all are done/failed
      const allSettled = Object.values(_invStatusMap).every(e => e.status === 'done' || e.status === 'failed');
      if (allSettled) {
        const btn = document.getElementById('btn-generate');
        if (btn) { btn.disabled = false; btn.textContent = 'Generate Invoices'; }
      }
    })
    .subscribe();
}
