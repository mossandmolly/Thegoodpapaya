const SUPABASE_URL    = 'https://fykqprogzqcfzrgwlrem.supabase.co';
const PAYMENT_EDGE_FN = SUPABASE_URL + '/functions/v1/create-payment-link';
const ORDER_EDGE_FN   = SUPABASE_URL + '/functions/v1/place-order';

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
    const line = parseFloat(item.price) * parseFloat(item.quantity);
    const pills = item.pills && item.pills.length ? ` · ${item.pills.join(', ')}` : '';
    const row = document.createElement('div');
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
    note.textContent = "We'll send a WhatsApp confirmation. Pay when your fruits arrive.";
  } else {
    btn.textContent  = 'Pay with Razorpay';
    note.textContent = "You'll be redirected to Razorpay's secure payment page.";
  }
}

// ── Validation ─────────────────────────────────────────────────────────────
function validate() {
  const cart    = getCart();
  const name    = document.getElementById('co-name').value.trim();
  const phone   = document.getElementById('co-phone').value.trim();
  const address = document.getElementById('co-address').value.trim();
  const errEl   = document.getElementById('co-error');

  errEl.textContent = '';

  if (!cart.length)              { errEl.textContent = 'Your cart is empty.'; return null; }
  if (!name)                     { errEl.textContent = 'Please enter your name.'; return null; }
  if (!/^\d{10}$/.test(phone))  { errEl.textContent = 'Enter a valid 10-digit mobile number.'; return null; }
  if (!address)                  { errEl.textContent = 'Please enter your delivery address.'; return null; }

  return {
    cart,
    name,
    phone,
    address,
    notes: document.getElementById('co-notes').value.trim(),
  };
}

// ── Main submit ────────────────────────────────────────────────────────────
async function submitOrder() {
  const fields = validate();
  if (!fields) return;

  document.getElementById('pay-btn').disabled = true;

  if (_payMethod === 'cod') {
    await placeCOD(fields);
  } else {
    await payOnline(fields);
  }
}

// ── Cash on Delivery ───────────────────────────────────────────────────────
async function placeCOD({ cart, name, phone, address, notes }) {
  const btn   = document.getElementById('pay-btn');
  const errEl = document.getElementById('co-error');

  btn.textContent = 'Placing order…';

  try {
    const res = await fetch(ORDER_EDGE_FN, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ cart, customer_name: name, phone, address, notes }),
    });

    const data = await res.json();

    if (!res.ok || !data.ref) {
      throw new Error(data.error || 'Could not place order');
    }

    localStorage.setItem('gp_last_order', JSON.stringify({
      ref: data.ref, name, phone, address, notes,
      cart, total: cartTotal(cart), method: 'cod', ts: Date.now(),
    }));

    localStorage.removeItem('gp_cart');
    window.location.href = '/pages/order-confirmed';

  } catch (err) {
    errEl.textContent = err.message || 'Something went wrong. Please try again.';
    btn.textContent   = 'Place Order (Cash on Delivery)';
    btn.disabled      = false;
  }
}

// ── Razorpay online payment ────────────────────────────────────────────────
async function payOnline({ cart, name, phone, address, notes }) {
  const btn   = document.getElementById('pay-btn');
  const errEl = document.getElementById('co-error');

  btn.textContent = 'Creating order…';

  try {
    const res = await fetch(PAYMENT_EDGE_FN, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ items: cart, customer_name: name, phone, address, notes }),
    });

    const data = await res.json();

    if (!res.ok || !data.payment_url) {
      throw new Error(data.error || 'Failed to create payment link');
    }

    const total    = cartTotal(cart);
    const orderRef = 'GP' + Date.now().toString(36).toUpperCase();
    localStorage.setItem('gp_last_order', JSON.stringify({
      ref: orderRef, name, phone, address, notes,
      cart, total, method: 'online', ts: Date.now(),
    }));

    localStorage.removeItem('gp_cart');
    window.location.href = data.payment_url;

  } catch (err) {
    errEl.textContent = err.message || 'Something went wrong. Please try again.';
    btn.textContent   = 'Pay with Razorpay';
    btn.disabled      = false;
  }
}

// ── Init ───────────────────────────────────────────────────────────────────
renderCart();
