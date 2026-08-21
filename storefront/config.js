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
  if (!badge) return;
  const n = cartCount();
  badge.textContent = n;
  badge.classList.toggle('hidden', n === 0);
}

function addToCart(item_name, quantity, unit) {
  const cart = getCart();
  const existing = cart.find(i => i.item_name === item_name);
  if (existing) existing.quantity = +(existing.quantity + quantity).toFixed(2);
  else cart.push({ item_name, quantity, unit });
  saveCart(cart);
}

function setCartQty(item_name, quantity) {
  let cart = getCart();
  if (quantity <= 0) cart = cart.filter(i => i.item_name !== item_name);
  else {
    const existing = cart.find(i => i.item_name === item_name);
    if (existing) existing.quantity = quantity;
    else cart.push({ item_name, quantity });
  }
  saveCart(cart);
}

function clearCart() { saveCart([]); }

document.addEventListener('DOMContentLoaded', updateCartBadge);
