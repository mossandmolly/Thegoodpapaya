// Shared Supabase client + cart helpers for every storefront page.
// Same project/anon key the ops-dashboard uses — anon keys are meant to be
// public, RLS on each table is what actually restricts what it can do.
const SUPABASE_URL  = 'https://fykqprogzqcfzrgwlrem.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ5a3Fwcm9nenFjZnpyZ3dscmVtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2NDkzMzEsImV4cCI6MjA5MTIyNTMzMX0.FseaaYNbN-QLhzdQF5rcImLvvoWRHOiGcZcbiFaIplQ';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

const CART_KEY = 'gp_cart_v1';

function getCart() {
  try { return JSON.parse(localStorage.getItem(CART_KEY) || '[]'); }
  catch { return []; }
}

function saveCart(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
  updateCartBadge();
}

function cartCount(cart) {
  return (cart || getCart()).reduce((s, i) => s + 1, 0);
}

function updateCartBadge() {
  const badge = document.getElementById('cart-badge');
  if (badge) {
    const n = cartCount();
    badge.textContent = n;
    badge.classList.toggle('hidden', n === 0);
  }
  // Pages with a live cart column (index.html) define this themselves —
  // shared config.js can't assume every page has one (checkout.html,
  // invoices.html don't), so it's called only if present.
  if (typeof renderLiveCart === 'function') renderLiveCart();
}

function addToCart(item_name, quantity, unit) {
  const cart = getCart();
  const existing = cart.find(i => i.item_name === item_name);
  if (existing) existing.quantity = +(existing.quantity + quantity).toFixed(2);
  else cart.push({ item_name, quantity, unit });
  saveCart(cart);
}

// mode: 'kg' (default) or 'piece' — piece-mode items are priced/weighed
// by staff at packing time, never at checkout (see place-order).
function setCartQty(item_name, quantity, mode) {
  let cart = getCart();
  if (quantity <= 0) cart = cart.filter(i => i.item_name !== item_name);
  else {
    const existing = cart.find(i => i.item_name === item_name);
    if (existing) { existing.quantity = quantity; if (mode) existing.mode = mode; }
    else cart.push({ item_name, quantity, mode: mode || 'kg' });
  }
  saveCart(cart);
}

// Per-item special-request text (e.g. "papaya long", "banana semi-ripe") —
// place-order already accepts this per cart line and writes it into
// order_items.description. Deliberately does NOT go through saveCart (no
// re-render): the live-cart note input calls this on every keystroke, and
// a full re-render mid-typing would blow away focus/cursor position. The
// note is still persisted to localStorage immediately either way, so it's
// never lost — just not reflected back into the open text field each time.
function setCartNote(item_name, note) {
  const cart = getCart();
  const item = cart.find(i => i.item_name === item_name);
  if (item) { item.note = note; localStorage.setItem(CART_KEY, JSON.stringify(cart)); }
}

function clearCart() { saveCart([]); }

document.addEventListener('DOMContentLoaded', updateCartBadge);
