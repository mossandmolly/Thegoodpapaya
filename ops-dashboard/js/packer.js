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
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function shortUser(email) {
  return (email || '').split('@')[0];
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
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px;flex-shrink:0;max-width:55%;min-width:0">
        <span class="status-badge badge-${item.status}">${item.status}</span>
        ${item.last_updated_by ? `<div class="card-meta" style="text-align:right;white-space:nowrap">✏️ ${fmtTime(item.last_updated_at)} · ${shortUser(item.last_updated_by)}</div>` : ''}
        ${item.finalized_by   ? `<div class="card-meta card-meta-final" style="text-align:right;white-space:nowrap">✓ ${fmtTime(item.finalized_at)} · ${shortUser(item.finalized_by)}</div>` : ''}
      </div>
    </div>

    <div class="card-item">${item.item_name}</div>

    ${item.description ? `<div class="card-desc">${item.description}</div>` : ''}

    ${note ? `<div class="card-note"><strong>📋 Packer Note</strong><span style="color:var(--red)">${note}</span></div>` : ''}

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

// ── Deviation confirmation modal ───────────────────────────────
function checkDeviation(item, enteredQty, onConfirm) {
  const requested = parseFloat(item.requested_quantity);
  if (!requested || isNaN(enteredQty) || Math.abs(enteredQty - requested) / requested <= 0.25) {
    onConfirm();
    return;
  }

  const pct       = Math.round(Math.abs(enteredQty - requested) / requested * 100);
  const direction = enteredQty > requested ? 'above' : 'below';
  const modal     = document.createElement('div');
  modal.id        = 'dev-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px';
  modal.innerHTML = `
    <div style="background:white;border-radius:16px;padding:24px;max-width:320px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,0.2)">
      <div style="font-size:1.4rem;margin-bottom:6px">⚠️</div>
      <h3 style="font-size:1rem;margin-bottom:6px;color:var(--red)">${pct}% ${direction} requested</h3>
      ${item.description ? `<p style="font-size:0.82rem;color:var(--text-muted);margin-bottom:10px;font-style:italic">${item.description}</p>` : ''}
      <div style="background:var(--bg);border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:0.88rem;display:flex;justify-content:space-between;gap:16px">
        <span>Requested: <strong>${requested}</strong></span>
        <span>Entered: <strong style="color:var(--red)">${enteredQty}</strong></span>
      </div>
      <p style="font-size:0.82rem;margin-bottom:8px">Re-enter <strong>${enteredQty}</strong> to confirm:</p>
      <input type="number" id="dev-input" inputmode="decimal" step="0.1" placeholder="Re-enter qty"
        style="width:100%;padding:10px;border:1.5px solid var(--border);border-radius:8px;font-size:1rem;font-family:'DM Sans',sans-serif;text-align:center;margin-bottom:12px;box-sizing:border-box">
      <div style="display:flex;gap:8px">
        <button onclick="document.getElementById('dev-modal').remove()"
          style="flex:1;padding:10px;border:1.5px solid var(--border);border-radius:8px;background:white;font-family:'DM Sans',sans-serif;font-size:0.9rem;cursor:pointer">Cancel</button>
        <button id="dev-confirm"
          style="flex:1;padding:10px;background:var(--red);color:white;border:none;border-radius:8px;font-family:'DM Sans',sans-serif;font-weight:600;font-size:0.9rem;cursor:pointer">Confirm</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const inp = document.getElementById('dev-input');
  inp.focus();

  function tryConfirm() {
    if (parseFloat(inp.value) === enteredQty) {
      modal.remove();
      onConfirm();
    } else {
      inp.style.borderColor = 'var(--red)';
      inp.value = '';
      inp.placeholder = `Must be ${enteredQty}`;
      inp.focus();
    }
  }

  document.getElementById('dev-confirm').onclick = tryConfirm;
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') tryConfirm(); });
}

// ── Save final quantity ───────────────────────────────────────
async function saveItem(id) {
  const input = document.getElementById(`input-${id}`);
  const val   = parseFloat(input.value);
  if (isNaN(val) || val < 0) { showToast('Enter a valid quantity', 'error'); return; }

  const item = allItems.find(i => i.id === id);
  checkDeviation(item, val, () => doSave(id, val));
}

async function doSave(id, val) {
  const actions = document.getElementById(`input-${id}`)?.nextElementSibling;
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
  const inputVal = parseFloat(document.getElementById(`input-${id}`)?.value);
  const item     = allItems.find(i => i.id === id);

  const proceed = () => doFinalize(id, inputVal);
  if (!isNaN(inputVal) && inputVal >= 0) {
    checkDeviation(item, inputVal, proceed);
  } else {
    proceed();
  }
}

async function doFinalize(id, inputVal) {
  const { data: { user } } = await sb.auth.getUser();
  const email = user?.email ?? 'unknown';
  const now   = new Date().toISOString();

  const update = { status: 'final', finalized_by: email, finalized_at: now };
  if (!isNaN(inputVal) && inputVal >= 0) {
    update.final_quantity  = inputVal;
    update.last_updated_by = email;
    update.last_updated_at = now;
  }

  const { error } = await sb.from('operations').update(update).eq('id', id);
  if (error) { showToast('Failed to mark final', 'error'); return; }

  const idx = allItems.findIndex(i => i.id === id);
  if (idx !== -1) {
    Object.assign(allItems[idx], update);
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
