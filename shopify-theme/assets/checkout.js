const PLACE_ORDER_FN = 'https://fykqprogzqcfzrgwlrem.supabase.co/functions/v1/place-order';

// ── Cart ───────────────────────────────────────────────────────────────────
function getCart() {
  try { return JSON.parse(localStorage.getItem('gp_cart') || '[]'); } catch { return []; }
}

function fmtQty(item) {
  if (item.mode === 'weight') {
    const w = parseFloat(item.quantity);
    return w >= 1 ? `${w} kg` : `${Math.round(w * 1000)}g`;
  }
  return String(item.quantity);
}

function cartTotal(cart) {
  return cart.reduce((s, i) => s + parseFloat(i.price) * parseFloat(i.quantity), 0);
}

// ── Render cart summary ────────────────────────────────────────────────────
function renderCart() {
  const cart      = getCart();
  const container = document.getElementById('checkout-items');
  const totalEl   = document.getElementById('checkout-total');
  const btn       = document.getElementById('pay-btn');

  if (!cart.length) {
    container.innerHTML =
      '<p style="color:var(--muted);font-size:.9rem">Your cart is empty. ' +
      '<a href="/pages/shop" style="color:var(--green)">Browse products</a></p>';
    totalEl.textContent = '₹0';
    btn.disabled = true;
    return;
  }

  container.innerHTML = '';
  cart.forEach(item => {
    const line  = parseFloat(item.price) * parseFloat(item.quantity);
    const pills = item.pills && item.pills.length ? ` · ${item.pills.join(', ')}` : '';
    const row   = document.createElement('div');
    row.className = 'checkout-item-row';
    row.innerHTML =
      `<span>${item.title} × ${fmtQty(item)}${pills}</span>` +
      `<span>₹${line.toFixed(0)}</span>`;
    container.appendChild(row);
  });
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
    note.textContent = 'Your order will be saved and confirmed before dispatch. Pay when delivered.';
  } else {
    btn.textContent  = 'Pay with Razorpay';
    note.textContent = "You'll be redirected to Razorpay's secure payment page.";
  }
}

// ── Submit ─────────────────────────────────────────────────────────────────
async function submitOrder() {
  const cart      = getCart();
  const name      = document.getElementById('co-name').value.trim();
  const phone     = document.getElementById('co-phone').value.trim();
  const community = document.getElementById('co-community').value.trim();
  const door      = document.getElementById('co-door').value.trim();
  const notes     = document.getElementById('co-notes').value.trim();
  const errEl     = document.getElementById('co-error');
  const btn       = document.getElementById('pay-btn');

  errEl.textContent = '';

  if (!cart.length)             { errEl.textContent = 'Your cart is empty.'; return; }
  if (!name)                    { errEl.textContent = 'Please enter your name.'; return; }
  if (!/^\d{10}$/.test(phone)) { errEl.textContent = 'Enter a valid 10-digit mobile number.'; return; }
  if (!community)               { errEl.textContent = 'Please enter your community name.'; return; }
  if (!door)                    { errEl.textContent = 'Please enter your door / flat number.'; return; }

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
        contact_name:   name,
        notes,
        payment_method: _payMethod,
      }),
    });

    const data = await res.json();
    if (!res.ok || !data.sales_id) throw new Error(data.error || 'Could not place order');

    // Save summary for the confirmation page
    localStorage.setItem('gp_last_order', JSON.stringify({
      ref:       data.sales_id,
      name,
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

    // Online: redirect to Razorpay; COD: go straight to confirmation
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
