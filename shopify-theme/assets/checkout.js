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

  const rows = cart.map((item, idx) => {
    const rate  = parseFloat(item.price ?? item.unit_price ?? 0);
    const total = lineTotal(item);
    const pillsHtml = item.pills?.length
      ? `<div class="co-item-pills">${item.pills.join(', ')}</div>` : '';
    const notesHtml = item.notes
      ? `<div class="co-item-notes">&ldquo;${item.notes}&rdquo;</div>` : '';
    return `<tr>
      <td>
        <div class="co-item-name">${item.title || '?'}</div>
        ${pillsHtml}${notesHtml}
      </td>
      <td class="co-num co-qty">${fmtQty(item)}</td>
      <td class="co-num">₹${isNaN(rate) ? '—' : rate.toFixed(0)}</td>
      <td class="co-num">₹${total.toFixed(0)}</td>
      <td><button class="ci-remove" onclick="removeItem(${idx})" title="Remove">✕</button></td>
    </tr>`;
  }).join('');

  container.innerHTML = `
    <table class="checkout-table">
      <thead><tr>
        <th>Item</th>
        <th class="co-num">Qty</th>
        <th class="co-num">Rate</th>
        <th class="co-num">Amount</th>
        <th style="width:24px"></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  totalEl.textContent = `₹${cart.reduce((s, i) => s + lineTotal(i), 0).toFixed(0)}`;
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
    if (!res.ok || !data.sales_id) throw new Error(data.error || data.message || 'Could not place order — is the order function deployed?');

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
