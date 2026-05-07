const PLACE_ORDER_FN = 'https://fykqprogzqcfzrgwlrem.supabase.co/functions/v1/place-order';

// ── Cart helpers ───────────────────────────────────────────────────────────
function getCart() {
  try { return JSON.parse(localStorage.getItem('gp_cart') || '[]'); } catch { return []; }
}

function fmtQty(item) {
  const raw = item.quantity ?? item.qty ?? item.amount;
  const qty = parseFloat(raw);
  if (isNaN(qty)) return raw != null ? String(raw) : '—';
  if (item.mode === 'weight') {
    return qty >= 1 ? `${qty} kg` : `${Math.round(qty * 1000)}g`;
  }
  // box / piece / plain integer
  const unit = item.unit || null;
  if (unit && unit !== 'kg') return qty === 1 ? `1 ${unit}` : `${qty} ${unit}s`;
  return String(qty);
}

function lineTotal(item) {
  const p = parseFloat(item.price ?? item.unit_price ?? 0);
  const raw = item.quantity ?? item.qty ?? item.amount ?? 0;
  const q = parseFloat(raw);
  return isNaN(p) || isNaN(q) ? 0 : p * q;
}

function cartTotal(cart) {
  return cart.reduce((s, i) => s + lineTotal(i), 0);
}

// ── Remove item ────────────────────────────────────────────────────────────
function removeItem(idx) {
  const cart = getCart();
  cart.splice(idx, 1);
  localStorage.setItem('gp_cart', JSON.stringify(cart));
  renderCart();
  const icon = document.getElementById('cart-nav-icon');
  const cnt  = document.getElementById('cart-nav-count');
  if (icon) icon.style.display = cart.length > 0 ? 'inline-flex' : 'none';
  if (cnt)  cnt.textContent = cart.length;
}

// ── Render cart ────────────────────────────────────────────────────────────
function renderCart() {
  const cart      = getCart();
  const container = document.getElementById('checkout-items');
  const totalEl   = document.getElementById('checkout-total');
  const btn       = document.getElementById('pay-btn');

  if (!cart.length) {
    container.innerHTML =
      '<p style="color:var(--muted);font-size:.9rem;padding:.25rem 0">Your cart is empty. ' +
      '<a href="/pages/shop" style="color:var(--green)">Browse products →</a></p>';
    totalEl.textContent = '₹0';
    if (btn) btn.disabled = true;
    return;
  }

  if (btn) btn.disabled = false;

  container.innerHTML = cart.map((item, idx) => {
    const pillsHtml = item.pills && item.pills.length
      ? `<div class="ci-pills">${item.pills.map(p =>
          `<span class="ci-pill">${p}</span>`).join('')}</div>`
      : '';
    const notesHtml = item.notes
      ? `<div class="ci-notes">&ldquo;${item.notes}&rdquo;</div>`
      : '';
    return `
      <div class="cart-item">
        <div class="ci-body">
          <div class="ci-top">
            <span class="ci-name">${item.title || '?'}</span>
            <span class="ci-qty">${fmtQty(item)}</span>
          </div>
          ${pillsHtml}${notesHtml}
        </div>
        <div class="ci-right">
          <span class="ci-total">₹${lineTotal(item).toFixed(0)}</span>
          <button class="ci-remove" onclick="removeItem(${idx})" title="Remove">✕</button>
        </div>
      </div>`;
  }).join('');

  totalEl.textContent = `₹${cartTotal(cart).toFixed(0)}`;
}

// ── Payment method toggle ──────────────────────────────────────────────────
let _payMethod = 'online';

function selectPayment(method) {
  _payMethod = method;
  document.getElementById('pm-online').classList.toggle('active', method === 'online');
  document.getElementById('pm-cod').classList.toggle('active', method === 'cod');

  const btn  = document.getElementById('pay-btn');
  const note = document.getElementById('pay-note');

  if (method === 'cod') {
    btn.textContent  = 'Place Order (Cash on Delivery)';
    note.textContent = 'Your order will be confirmed before dispatch. Pay when delivered.';
  } else {
    btn.textContent  = 'Pay with Razorpay';
    note.textContent = "You'll be redirected to Razorpay's secure payment page.";
  }
}

// ── Submit ─────────────────────────────────────────────────────────────────
async function submitOrder() {
  const cart      = getCart();
  const phone     = document.getElementById('co-phone').value.trim();
  const community = document.getElementById('co-community').value.trim();
  const door      = document.getElementById('co-door').value.trim();
  const notes     = document.getElementById('co-notes').value.trim();
  const errEl     = document.getElementById('co-error');
  const btn       = document.getElementById('pay-btn');

  errEl.textContent = '';

  if (!cart.length)              { errEl.textContent = 'Your cart is empty.'; return; }
  if (!/^\d{10}$/.test(phone))  { errEl.textContent = 'Enter a valid 10-digit mobile number.'; return; }
  if (!community)                { errEl.textContent = 'Please enter your community name.'; return; }
  if (!door)                     { errEl.textContent = 'Please enter your door / flat number.'; return; }

  btn.disabled    = true;
  btn.textContent = _payMethod === 'cod' ? 'Placing order…' : 'Creating order…';

  try {
    const res = await fetch(PLACE_ORDER_FN, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        cart,
        community,
        door_number:    door,
        phone,
        notes,
        payment_method: _payMethod,
      }),
    });

    const data = await res.json();
    if (!res.ok || !data.sales_id) throw new Error(data.error || 'Could not place order');

    localStorage.setItem('gp_last_order', JSON.stringify({
      ref:       data.sales_id,
      phone,
      community,
      door,
      cart,
      notes,
      total:     cartTotal(cart),
      method:    _payMethod,
      ts:        Date.now(),
    }));

    localStorage.removeItem('gp_cart');

    window.location.href = _payMethod === 'online'
      ? data.payment_url
      : '/pages/order-confirmed';

  } catch (err) {
    errEl.textContent = err.message || 'Something went wrong. Please try again.';
    btn.textContent   = _payMethod === 'cod' ? 'Place Order (Cash on Delivery)' : 'Pay with Razorpay';
    btn.disabled      = false;
  }
}

// ── Init ───────────────────────────────────────────────────────────────────
renderCart();
