// Edge function URL — update after deploying create-payment-link
const PAYMENT_EDGE_FN = 'https://fykqprogzqcfzrgwlrem.supabase.co/functions/v1/create-payment-link';

// ── Load cart ─────────────────────────────────────────────────
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

function renderCart() {
  const cart = getCart();
  const container = document.getElementById('checkout-items');
  const totalEl   = document.getElementById('checkout-total');

  if (!cart.length) {
    container.innerHTML = '<p style="color:var(--muted);font-size:.9rem">Your cart is empty. <a href="/pages/shop">Browse products</a></p>';
    totalEl.textContent = '₹0';
    document.getElementById('pay-btn').disabled = true;
    return;
  }

  let total = 0;
  container.innerHTML = '';
  cart.forEach(item => {
    const lineTotal = parseFloat(item.price) * parseFloat(item.quantity);
    total += lineTotal;
    const row = document.createElement('div');
    row.className = 'checkout-item-row';
    row.innerHTML = `
      <span>${item.title} × ${fmtQty(item)}</span>
      <span>₹${lineTotal.toFixed(0)}</span>
    `;
    container.appendChild(row);
  });
  totalEl.textContent = `₹${total.toFixed(0)}`;
}

// ── Submit order ──────────────────────────────────────────────
async function submitOrder() {
  const cart    = getCart();
  const name    = document.getElementById('co-name').value.trim();
  const phone   = document.getElementById('co-phone').value.trim();
  const address = document.getElementById('co-address').value.trim();
  const notes   = document.getElementById('co-notes').value.trim();
  const errEl   = document.getElementById('co-error');
  const btn     = document.getElementById('pay-btn');

  errEl.textContent = '';

  if (!cart.length)       { errEl.textContent = 'Your cart is empty.'; return; }
  if (!name)              { errEl.textContent = 'Please enter your name.'; return; }
  if (!/^\d{10}$/.test(phone)) { errEl.textContent = 'Enter a valid 10-digit mobile number.'; return; }
  if (!address)           { errEl.textContent = 'Please enter your delivery address.'; return; }

  btn.textContent = 'Creating order…';
  btn.disabled    = true;

  try {
    const res = await fetch(PAYMENT_EDGE_FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: cart, customer_name: name, phone, address, notes }),
    });

    const data = await res.json();

    if (!res.ok || !data.payment_url) {
      throw new Error(data.error || 'Failed to create payment link');
    }

    // Clear cart and redirect to Razorpay
    localStorage.removeItem('gp_cart');
    window.location.href = data.payment_url;

  } catch (err) {
    errEl.textContent = err.message || 'Something went wrong. Please try again.';
    btn.textContent   = 'Pay with Razorpay';
    btn.disabled      = false;
  }
}

renderCart();
