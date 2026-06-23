// ── State ──────────────────────────────────────────────────────────────────
let activeFruit = null;
let fruits = [];          // distinct fruit names from inventory + lots
let inventory = [];       // fruit_inventory rows
let lots = [];            // packing_lots rows
let activeDate = todayIST();

// ── Boot ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('active-date').value = activeDate;
  await loadAll();
});

async function loadAll() {
  const [invRes, lotRes] = await Promise.all([
    sb.from('fruit_inventory').select('*').order('entry_date').order('created_at'),
    sb.from('packing_lots').select('*').order('lot_date').order('lot_number'),
  ]);
  if (invRes.error) { showToast('Error loading inventory: ' + invRes.error.message, 'error'); return; }
  if (lotRes.error) { showToast('Error loading lots: ' + lotRes.error.message, 'error'); return; }

  inventory = invRes.data || [];
  lots      = lotRes.data || [];

  const names = new Set([
    ...inventory.map(r => r.fruit_name),
    ...lots.map(r => r.fruit_name),
  ]);
  fruits = [...names].sort();

  if (!activeFruit && fruits.length) activeFruit = fruits[0];
  renderFruitTabs();
  renderAll();
}

function setDate(val) {
  activeDate = val;
  renderAll();
}

function selectFruit(name) {
  activeFruit = name;
  renderFruitTabs();
  renderAll();
}

function renderFruitTabs() {
  const container = document.getElementById('fruit-tabs');
  container.innerHTML = fruits.map(f =>
    `<button class="chip${f === activeFruit ? ' selected' : ''}" onclick="selectFruit('${esc(f)}')">${esc(f)}</button>`
  ).join('');
}

// ── Render all panels for activeFruit ────────────────────────────────────
function renderAll() {
  if (!activeFruit) {
    document.getElementById('main-panel').innerHTML =
      '<p style="padding:24px;color:var(--text-muted)">Add a fruit below to get started.</p>';
    return;
  }
  renderStockPanel();
  renderLotsPanel();
  renderSummary();
}

// ── Stock Ledger ──────────────────────────────────────────────────────────
function renderStockPanel() {
  const rows = inventory.filter(r => r.fruit_name === activeFruit);
  const byType = (t) => rows.filter(r => r.entry_type === t).reduce((s, r) => s + +r.quantity, 0);

  const opening  = byType('opening');
  const purchased = byType('purchase');
  const writeoff  = byType('writeoff');

  const tableRows = rows.map(r => `
    <tr>
      <td>${esc(r.entry_date)}</td>
      <td><span class="badge badge-${r.entry_type}">${r.entry_type}</span></td>
      <td class="num">${r.quantity} kg</td>
      <td>${esc(r.notes || '—')}</td>
      <td><button class="btn-icon" onclick="deleteInventory('${r.id}')" title="Delete">✕</button></td>
    </tr>`).join('');

  document.getElementById('stock-panel').innerHTML = `
    <div class="panel-header">Stock Ledger — ${esc(activeFruit)}</div>
    <div class="totals-row">
      <span class="total-chip opening">Opening <strong>${opening} kg</strong></span>
      <span class="total-chip purchase">Purchased <strong>${purchased} kg</strong></span>
      <span class="total-chip writeoff">Write-off <strong>${writeoff} kg</strong></span>
    </div>
    <table class="data-table">
      <thead><tr><th>Date</th><th>Type</th><th>Qty</th><th>Notes</th><th></th></tr></thead>
      <tbody>${tableRows || '<tr><td colspan="5" class="empty">No entries yet</td></tr>'}</tbody>
    </table>
    <div class="add-form" id="inv-form">
      <select id="inv-type">
        <option value="opening">Opening Stock</option>
        <option value="purchase">New Purchase</option>
        <option value="writeoff">Write-off</option>
      </select>
      <input type="number" id="inv-qty" placeholder="Qty (kg)" step="0.1" min="0">
      <input type="date" id="inv-date" value="${activeDate}">
      <input type="text" id="inv-notes" placeholder="Notes (optional)">
      <button class="btn-primary" onclick="addInventory()">Add Entry</button>
    </div>`;
}

async function addInventory() {
  const fruit = activeFruit;
  const type  = document.getElementById('inv-type').value;
  const qty   = parseFloat(document.getElementById('inv-qty').value);
  const date  = document.getElementById('inv-date').value || activeDate;
  const notes = document.getElementById('inv-notes').value.trim();

  if (!fruit) { showToast('Select or create a fruit first', 'error'); return; }
  if (isNaN(qty) || qty < 0) { showToast('Enter a valid quantity', 'error'); return; }

  const { error } = await sb.from('fruit_inventory').insert({
    fruit_name: fruit, entry_type: type, quantity: qty, notes: notes || null, entry_date: date
  });
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast('Entry added');
  await loadAll();
}

async function deleteInventory(id) {
  if (!confirm('Delete this entry?')) return;
  const { error } = await sb.from('fruit_inventory').delete().eq('id', id);
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast('Deleted');
  await loadAll();
}

// ── Packing Lots ──────────────────────────────────────────────────────────
function renderLotsPanel() {
  const fruitLots = lots.filter(r => r.fruit_name === activeFruit);

  // Compute running total packed
  let running = 0;
  const rows = fruitLots.map(r => {
    running += +r.packed_in_lot;
    return `
    <tr>
      <td class="num">#${r.lot_number}</td>
      <td>${esc(r.lot_date)}</td>
      <td class="num">${r.lot_size} kg</td>
      <td class="num">${r.packed_in_lot} kg</td>
      <td class="num total-packed">${running.toFixed(2)} kg</td>
      <td class="num${+r.returned_qty > 0 ? ' bad' : ''}">${r.returned_qty} kg</td>
      <td>${esc(r.return_reason || '—')}</td>
      <td>
        <button class="btn-icon" onclick="editLot('${r.id}','${r.lot_size}','${r.packed_in_lot}','${r.returned_qty}','${esc(r.return_reason||'')}')">✏️</button>
        <button class="btn-icon" onclick="deleteLot('${r.id}')">✕</button>
      </td>
    </tr>`;
  });

  const nextLot = fruitLots.length
    ? Math.max(...fruitLots.map(r => r.lot_number)) + 1
    : 1;

  document.getElementById('lots-panel').innerHTML = `
    <div class="panel-header">Packing Lots — ${esc(activeFruit)}</div>
    <table class="data-table">
      <thead>
        <tr>
          <th>Lot</th><th>Date</th><th>Lot Size</th>
          <th>Packed in Lot</th><th>Total Packed</th>
          <th>Returned</th><th>Reason</th><th></th>
        </tr>
      </thead>
      <tbody>${rows.join('') || '<tr><td colspan="8" class="empty">No lots yet</td></tr>'}</tbody>
    </table>
    <div class="add-form">
      <strong style="align-self:center;white-space:nowrap">Lot #${nextLot}</strong>
      <input type="number" id="lot-size" placeholder="Lot size (kg)" step="0.1" min="0.1">
      <input type="number" id="lot-packed" placeholder="Packed in lot (kg)" step="0.1" min="0" value="0">
      <input type="number" id="lot-returned" placeholder="Returned (kg)" step="0.1" min="0" value="0">
      <input type="text"   id="lot-reason"   placeholder="Return reason">
      <input type="date"   id="lot-date"     value="${activeDate}">
      <button class="btn-primary" onclick="addLot(${nextLot})">Add Lot</button>
    </div>`;
}

async function addLot(lotNum) {
  const fruit    = activeFruit;
  const size     = parseFloat(document.getElementById('lot-size').value);
  const packed   = parseFloat(document.getElementById('lot-packed').value) || 0;
  const returned = parseFloat(document.getElementById('lot-returned').value) || 0;
  const reason   = document.getElementById('lot-reason').value.trim();
  const date     = document.getElementById('lot-date').value || activeDate;

  if (!fruit) { showToast('Select a fruit first', 'error'); return; }
  if (isNaN(size) || size <= 0) { showToast('Enter a valid lot size', 'error'); return; }

  const { error } = await sb.from('packing_lots').insert({
    fruit_name: fruit, lot_number: lotNum, lot_size: size,
    packed_in_lot: packed, returned_qty: returned,
    return_reason: reason || null, lot_date: date,
  });
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast('Lot added');
  await loadAll();
}

function editLot(id, size, packed, returned, reason) {
  const newPacked   = prompt('Packed in lot (kg):', packed);
  if (newPacked === null) return;
  const newReturned = prompt('Returned (kg):', returned);
  if (newReturned === null) return;
  const newReason   = prompt('Return reason:', reason);
  if (newReason === null) return;
  doUpdateLot(id, +size, +newPacked, +newReturned, newReason);
}

async function doUpdateLot(id, size, packed, returned, reason) {
  const { error } = await sb.from('packing_lots').update({
    lot_size: size, packed_in_lot: packed, returned_qty: returned,
    return_reason: reason || null,
  }).eq('id', id);
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast('Lot updated');
  await loadAll();
}

async function deleteLot(id) {
  if (!confirm('Delete this lot?')) return;
  const { error } = await sb.from('packing_lots').delete().eq('id', id);
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  showToast('Deleted');
  await loadAll();
}

// ── Summary ───────────────────────────────────────────────────────────────
function renderSummary() {
  // Per-fruit summary across ALL fruits
  const allFruits = fruits.length ? fruits : (activeFruit ? [activeFruit] : []);

  const rows = allFruits.map(fruit => {
    const inv  = inventory.filter(r => r.fruit_name === fruit);
    const fl   = lots.filter(r => r.fruit_name === fruit);

    const opening   = inv.filter(r => r.entry_type === 'opening') .reduce((s,r) => s + +r.quantity, 0);
    const purchased = inv.filter(r => r.entry_type === 'purchase').reduce((s,r) => s + +r.quantity, 0);
    const writeoff  = inv.filter(r => r.entry_type === 'writeoff').reduce((s,r) => s + +r.quantity, 0);

    const totalLotSize = fl.reduce((s,r) => s + +r.lot_size,      0);
    const totalPacked  = fl.reduce((s,r) => s + +r.packed_in_lot, 0);
    const totalReturned= fl.reduce((s,r) => s + +r.returned_qty,  0);

    const available = opening + purchased;
    const leftover  = available - totalPacked - writeoff - totalReturned;
    const missing   = Math.max(0, totalLotSize - totalPacked - totalReturned);

    const leftoverClass = leftover < 0 ? ' bad' : '';
    const missingClass  = missing  > 0 ? ' bad' : '';

    return `
    <tr class="${fruit === activeFruit ? 'active-fruit-row' : ''}">
      <td><strong>${esc(fruit)}</strong></td>
      <td class="num">${opening.toFixed(2)}</td>
      <td class="num">${purchased.toFixed(2)}</td>
      <td class="num">${writeoff.toFixed(2)}</td>
      <td class="num">${fl.length}</td>
      <td class="num">${totalLotSize.toFixed(2)}</td>
      <td class="num">${totalPacked.toFixed(2)}</td>
      <td class="num">${totalReturned.toFixed(2)}</td>
      <td class="num${leftoverClass}">${leftover.toFixed(2)}</td>
      <td class="num${missingClass}">${missing > 0 ? missing.toFixed(2) : '✓'}</td>
    </tr>`;
  });

  document.getElementById('summary-panel').innerHTML = `
    <div class="panel-header">Summary — All Fruits</div>
    <div style="overflow-x:auto">
    <table class="data-table summary-table">
      <thead>
        <tr>
          <th>Fruit</th>
          <th>Opening</th><th>Purchased</th><th>Write-off</th>
          <th>Lots</th><th>Total Rationed</th>
          <th>Total Packed</th><th>Total Returned</th>
          <th>Leftover</th><th>Missing</th>
        </tr>
      </thead>
      <tbody>${rows.join('') || '<tr><td colspan="10" class="empty">No data yet</td></tr>'}</tbody>
    </table>
    </div>
    <p class="hint">Leftover = Opening + Purchased − Packed − Write-off − Returned &nbsp;|&nbsp; Missing = Total Rationed − Packed − Returned (unaccounted within lots)</p>`;
}

// ── Add new fruit ─────────────────────────────────────────────────────────
async function addNewFruit() {
  const name = document.getElementById('new-fruit-name').value.trim();
  if (!name) { showToast('Enter a fruit name', 'error'); return; }
  if (fruits.map(f=>f.toLowerCase()).includes(name.toLowerCase())) {
    showToast('Fruit already exists', 'error'); return;
  }
  // Add a placeholder opening stock entry of 0 to register the fruit
  const { error } = await sb.from('fruit_inventory').insert({
    fruit_name: name, entry_type: 'opening', quantity: 0,
    notes: 'Fruit registered', entry_date: activeDate,
  });
  if (error) { showToast('Error: ' + error.message, 'error'); return; }
  document.getElementById('new-fruit-name').value = '';
  activeFruit = name;
  showToast(`${name} added`);
  await loadAll();
}

// ── Helpers ───────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
