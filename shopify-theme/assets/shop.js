// ── Constants ──────────────────────────────────────────────────────────────
const WSTEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5];
const CAT_ORDER = ['featured','citrus','berries','seasonal','tropical','juicing','staples','melons','exotic'];
const CAT_NAMES = {
  featured: "Today's Picks", citrus: 'Citrus', berries: 'Berries',
  seasonal: 'Seasonal', tropical: 'Tropical', juicing: 'For Juicing',
  staples: 'Everyday Staples', melons: 'Melons', exotic: 'Exotic', all: 'All'
};

// ── Cart ───────────────────────────────────────────────────────────────────
function getCart() {
  try { return JSON.parse(localStorage.getItem('gp_cart') || '[]'); } catch { return []; }
}
function saveCart(cart) {
  localStorage.setItem('gp_cart', JSON.stringify(cart));
  renderCartBar();
}

function renderCartBar() {
  const cart = getCart();
  const bar  = document.getElementById('cart-bar');
  if (!bar) return;
  if (!cart.length) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const total = cart.reduce((s, i) => s + parseFloat(i.price) * parseFloat(i.quantity), 0);
  document.getElementById('cart-bar-count').textContent =
    `${cart.length} item${cart.length !== 1 ? 's' : ''}`;
  document.getElementById('cart-bar-total').textContent = `₹${total.toFixed(0)}`;
}

// ── Tag helpers ────────────────────────────────────────────────────────────
function prodTags(p) {
  return (p.tags || []).map(t => t.toLowerCase());
}

function unitLabel(tags) {
  const hasW = tags.includes('mode:weight');
  const hasB = tags.includes('mode:box');
  const hasP = tags.includes('mode:piece');
  if (!hasW && hasP) {
    const sizeTag = tags.find(t => t.startsWith('box-size:'));
    return sizeTag ? `/${sizeTag.replace('box-size:', '')} piece` : '/piece';
  }
  if (!hasW && hasB) {
    const sizeTag = tags.find(t => t.startsWith('box-size:'));
    return sizeTag ? `/${sizeTag.replace('box-size:', '')} box` : '/box';
  }
  return '/kg';
}

// ── Sheet state ────────────────────────────────────────────────────────────
let _sp    = null;      // active product meta
let _sMode = 'weight';  // 'weight' | 'box'
let _sWIdx = 3;         // index into WSTEPS (default 1 kg)
let _sQty  = 1;         // box/piece count
let _sPills = [];       // selected pill labels

function openSheet(productId) {
  const p = (window.allProducts || []).find(x => x.id === productId);
  if (!p) return;

  const tags    = prodTags(p);
  const hasW    = tags.includes('mode:weight');
  const hasB    = tags.includes('mode:box') || tags.includes('mode:piece');
  const isPiece = tags.includes('mode:piece');

  _sp = {
    id:       p.id,
    title:    p.title,
    price:    parseFloat(p.variants[0].price),
    hasW,
    hasB,
    boxLabel: isPiece ? 'By Piece' : 'By Box',
    boxUnit:  isPiece ? 'piece'    : 'box',
    pills:    tags
      .filter(t => t.startsWith('pill:'))
      .map(t => { const s = t.replace('pill:', ''); return s.charAt(0).toUpperCase() + s.slice(1); }),
  };

  // Default mode: weight if available, else box
  _sMode  = hasW ? 'weight' : 'box';
  _sWIdx  = 3;
  _sQty   = 1;
  _sPills = [];

  // Pre-fill from existing cart item
  const existing = getCart().find(i => i.id === productId);
  if (existing) {
    _sMode = existing.mode || _sMode;
    if (_sMode === 'weight') {
      const idx = WSTEPS.indexOf(parseFloat(existing.quantity));
      if (idx !== -1) _sWIdx = idx;
    } else {
      _sQty = parseInt(existing.quantity) || 1;
    }
    _sPills = existing.pills ? [...existing.pills] : [];
    document.getElementById('sheet-notes').value = existing.notes || '';
  } else {
    document.getElementById('sheet-notes').value = '';
  }

  _renderSheet();
  document.getElementById('sheet').classList.add('open');
  document.getElementById('sheet-overlay').classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closeSheet() {
  document.getElementById('sheet').classList.remove('open');
  document.getElementById('sheet-overlay').classList.remove('show');
  document.body.style.overflow = '';
}

function selectMode(mode) {
  _sMode = mode;
  _renderSheet();
}

function sheetStep(dir) {
  if (_sMode === 'weight') {
    _sWIdx = Math.max(0, Math.min(WSTEPS.length - 1, _sWIdx + dir));
  } else {
    _sQty = Math.max(1, _sQty + dir);
  }
  _updateStepVal();
  _updateSubtotal();
}

function togglePill(label) {
  const idx = _sPills.indexOf(label);
  if (idx !== -1) _sPills.splice(idx, 1);
  else _sPills.push(label);
  document.querySelectorAll('.pill-btn').forEach(btn => {
    btn.classList.toggle('active', _sPills.includes(btn.dataset.pill));
  });
}

function addFromSheet() {
  const notes = document.getElementById('sheet-notes').value.trim();
  const qty   = _sMode === 'weight' ? WSTEPS[_sWIdx] : _sQty;
  const cart  = getCart();
  const idx   = cart.findIndex(i => i.id === _sp.id);
  const item  = {
    id:       _sp.id,
    title:    _sp.title,
    price:    _sp.price,
    mode:     _sMode,
    unit:     _sMode === 'box' ? _sp.boxUnit : 'kg',
    quantity: qty,
    pills:    [..._sPills],
    notes,
  };

  if (idx !== -1) cart[idx] = item;
  else cart.push(item);

  saveCart(cart);
  closeSheet();
  renderCardSummary(_sp.id);
}

// ── Sheet rendering helpers ────────────────────────────────────────────────
function _renderSheet() {
  document.getElementById('sheet-title').textContent = _sp.title;

  // Mode row
  const modeRow = document.getElementById('sheet-mode-row');
  if (_sp.hasW && _sp.hasB) {
    modeRow.style.display = 'flex';
    document.getElementById('mode-weight').classList.toggle('active', _sMode === 'weight');
    const modeBoxBtn = document.getElementById('mode-box');
    modeBoxBtn.textContent = _sp.boxLabel;
    modeBoxBtn.classList.toggle('active', _sMode === 'box');
  } else {
    modeRow.style.display = 'none';
    _sMode = _sp.hasW ? 'weight' : 'box';
  }

  _updateStepVal();

  // Pills
  const pillsRow = document.getElementById('sheet-pills-row');
  const pillsEl  = document.getElementById('sheet-pills');
  if (_sp.pills.length) {
    pillsRow.style.display = 'block';
    pillsEl.innerHTML = _sp.pills.map(pill =>
      `<button class="pill-btn${_sPills.includes(pill) ? ' active' : ''}"
        data-pill="${pill}" onclick="togglePill('${pill}')">${pill}</button>`
    ).join('');
  } else {
    pillsRow.style.display = 'none';
    pillsEl.innerHTML = '';
  }

  _updateSubtotal();

  const existing = getCart().find(i => i.id === _sp.id);
  document.getElementById('sheet-add-btn').textContent =
    existing ? 'Update Cart' : 'Add to Cart';
}

function _updateStepVal() {
  let label;
  if (_sMode === 'weight') {
    const w = WSTEPS[_sWIdx];
    label = w >= 1 ? `${w} kg` : `${Math.round(w * 1000)}g`;
  } else {
    label = String(_sQty);
  }
  document.getElementById('sheet-step-val').textContent = label;
}

function _updateSubtotal() {
  const amount = _sMode === 'weight' ? WSTEPS[_sWIdx] : _sQty;
  document.getElementById('sheet-subtotal').textContent =
    `₹${(_sp.price * amount).toFixed(0)}`;
}

// ── Card summary ───────────────────────────────────────────────────────────
function renderCardSummary(productId) {
  const actEl = document.getElementById('act-' + productId);
  if (!actEl) return;
  const cart = getCart();
  const item = cart.find(i => i.id === productId);
  if (!item) {
    actEl.innerHTML =
      `<button class="btn btn-outline btn-sm" onclick="openSheet(${productId})">Add</button>`;
    return;
  }
  const p = (window.allProducts || []).find(x => x.id === productId);
  _renderSummaryEl(actEl, item, p);
}

function _renderSummaryEl(actEl, item, p) {
  let amtText;
  if (item.mode === 'weight') {
    const w = parseFloat(item.quantity);
    amtText = w >= 1 ? `${w} kg` : `${Math.round(w * 1000)}g`;
  } else {
    const tags   = p ? prodTags(p) : [];
    const unit   = tags.includes('mode:piece') ? 'piece' : 'box';
    const plural = parseInt(item.quantity) !== 1 ? 's' : '';
    amtText = `${item.quantity} ${unit}${plural}`;
  }
  const pillText = item.pills && item.pills.length
    ? ' · ' + item.pills.join(', ')
    : '';

  actEl.innerHTML =
    `<div class="card-summary">
       <span class="card-summary-text">${amtText}${pillText}</span>
       <button class="card-edit-btn" onclick="openSheet(${item.id})">Edit</button>
     </div>`;
}

// ── Products ───────────────────────────────────────────────────────────────
async function loadProducts() {
  const grid  = document.getElementById('product-grid');
  const empty = document.getElementById('shop-empty');

  let products;
  try {
    const res = await fetch('/products.json?limit=250');
    const data = await res.json();
    products = data.products || [];
  } catch {
    grid.innerHTML = '';
    empty.style.display = 'block';
    return;
  }

  if (!products.length) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    return;
  }

  window.allProducts = products;

  // Group by category tag
  const groups = {};
  products.forEach(p => {
    const tags = prodTags(p);
    const cat  = CAT_ORDER.find(c => tags.includes(c)) || 'all';
    (groups[cat] = groups[cat] || []).push(p);
  });

  grid.innerHTML = '';

  [...CAT_ORDER.filter(c => groups[c]), groups['all'] ? 'all' : null]
    .filter(Boolean)
    .forEach(cat => {
      const h = document.createElement('div');
      h.className = 'cat-header';
      h.textContent = CAT_NAMES[cat] || cat;
      grid.appendChild(h);
      groups[cat].forEach(p => _renderCard(p, grid));
    });

  renderCartBar();
}

function _renderCard(p, grid) {
  const tags   = prodTags(p);
  const price  = parseFloat(p.variants[0].price);
  const image  = p.images[0] ? p.images[0].src : '';
  const ulabel = unitLabel(tags);

  const card = document.createElement('div');
  card.className = 'product-card';

  card.innerHTML =
    (image
      ? `<img class="product-img" src="${image}" alt="${p.title}" loading="lazy">`
      : `<div class="product-img product-img-placeholder">🍑</div>`) +
    `<div class="product-info">
       <div class="product-title">${p.title}</div>
       <div class="product-price">₹${price.toFixed(0)}<span class="product-unit">${ulabel}</span></div>
     </div>
     <div class="product-actions" id="act-${p.id}"></div>`;

  grid.appendChild(card);

  // Action area: summary if in cart, else Add button
  const actEl = card.querySelector(`#act-${p.id}`);
  const inCart = getCart().find(i => i.id === p.id);
  if (inCart) {
    _renderSummaryEl(actEl, inCart, p);
  } else {
    actEl.innerHTML =
      `<button class="btn btn-outline btn-sm" onclick="openSheet(${p.id})">Add</button>`;
  }
}

// ── Init ───────────────────────────────────────────────────────────────────
loadProducts();
