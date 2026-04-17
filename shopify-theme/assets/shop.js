// ── Cart helpers ───────────────────────────────────────────────
function getCart() {
  try { return JSON.parse(localStorage.getItem('gp_cart') || '[]'); } catch { return []; }
}
function saveCart(cart) {
  localStorage.setItem('gp_cart', JSON.stringify(cart));
  renderCartBar(cart);
}
function cartTotal(cart) {
  return cart.reduce((s, i) => s + parseFloat(i.price) * i.quantity, 0);
}

// ── Render cart bar ────────────────────────────────────────────
function renderCartBar(cart) {
  const bar   = document.getElementById('cart-bar');
  const total = cart.reduce((s, i) => s + i.quantity, 0);
  if (!total) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  document.getElementById('cart-bar-count').textContent = `${total} item${total !== 1 ? 's' : ''}`;
  document.getElementById('cart-bar-total').textContent = `₹${cartTotal(cart).toFixed(0)}`;
}

// ── Fetch & render products ────────────────────────────────────
async function loadProducts() {
  const grid = document.getElementById('product-grid');
  const empty = document.getElementById('shop-empty');

  let products = [];
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

  const cart = getCart();
  grid.innerHTML = '';

  products.forEach(p => {
    const variant  = p.variants?.[0];
    const price    = variant?.price ?? '0';
    const image    = p.images?.[0]?.src ?? '';
    const inCart   = cart.find(i => i.id === p.id);
    const qty      = inCart?.quantity ?? 0;

    const card = document.createElement('div');
    card.className = 'product-card';
    card.id = `product-${p.id}`;
    card.innerHTML = `
      ${image
        ? `<img class="product-img" src="${image}" alt="${p.title}" loading="lazy">`
        : `<div class="product-img product-img-placeholder">🍑</div>`}
      <div class="product-info">
        <div class="product-title">${p.title}</div>
        <div class="product-price">₹${parseFloat(price).toFixed(0)}<span class="product-unit"> / kg</span></div>
      </div>
      <div class="product-actions" id="actions-${p.id}">
        ${qty > 0 ? renderQtyControl(p.id, qty) : renderAddBtn(p.id)}
      </div>
    `;
    grid.appendChild(card);
  });

  // Store product data for cart use
  window._products = products;
  renderCartBar(cart);
}

function renderAddBtn(productId) {
  return `<button class="btn btn-outline btn-sm" onclick="addToCart(${productId})">Add to cart</button>`;
}

function renderQtyControl(productId, qty) {
  return `
    <div class="qty-control">
      <button class="qty-btn" onclick="changeQty(${productId}, -1)">−</button>
      <span class="qty-val" id="qty-${productId}">${qty}</span>
      <button class="qty-btn" onclick="changeQty(${productId}, 1)">+</button>
    </div>
  `;
}

// ── Cart actions ───────────────────────────────────────────────
function addToCart(productId) {
  const p       = window._products?.find(x => x.id === productId);
  if (!p) return;
  const cart    = getCart();
  const variant = p.variants?.[0];
  const existing = cart.find(i => i.id === productId);
  if (existing) {
    existing.quantity += 1;
  } else {
    cart.push({
      id:         productId,
      variant_id: variant?.id,
      title:      p.title,
      price:      variant?.price ?? '0',
      image:      p.images?.[0]?.src ?? '',
      quantity:   1,
    });
  }
  saveCart(cart);
  const actions = document.getElementById(`actions-${productId}`);
  if (actions) actions.innerHTML = renderQtyControl(productId, cart.find(i=>i.id===productId).quantity);
}

function changeQty(productId, delta) {
  const cart = getCart();
  const idx  = cart.findIndex(i => i.id === productId);
  if (idx === -1) return;
  cart[idx].quantity += delta;
  if (cart[idx].quantity <= 0) {
    cart.splice(idx, 1);
    const actions = document.getElementById(`actions-${productId}`);
    if (actions) actions.innerHTML = renderAddBtn(productId);
  } else {
    const qtyEl = document.getElementById(`qty-${productId}`);
    if (qtyEl) qtyEl.textContent = cart[idx].quantity;
  }
  saveCart(cart);
}

// ── Init ───────────────────────────────────────────────────────
loadProducts();
