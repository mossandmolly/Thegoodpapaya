// Supabase Edge Function — place a website order
//
// Input:  { cart, community, door_number, phone, notes, payment_method }
// Output: { sales_id }                          for COD
//         { sales_id, payment_url }             for online
//
// Saves to: orders (header) + order_items (one row per cart item)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function env(key: string) {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Missing env: ${key}`);
  return val;
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

type CartItem = {
  title:     string;
  price:     string | number;
  quantity?: string | number;
  qty?:      string | number;
  amount?:   string | number;
  mode?:     string;
  pills?:    string[];
  notes?:    string;
};

function getQty(item: CartItem): number {
  const raw = item.quantity ?? item.qty ?? item.amount ?? 1;
  const q   = parseFloat(String(raw));
  return isNaN(q) || q <= 0 ? 1 : q;
}

function cartTotal(cart: CartItem[]): number {
  return cart.reduce((s, i) => {
    const p = parseFloat(String(i.price));
    const q = getQty(i);
    return s + (isNaN(p) ? 0 : p * q);
  }, 0);
}

function fmtQty(item: CartItem): string {
  const q = getQty(item);
  if (item.mode === 'weight') {
    return q >= 1 ? `${q}kg` : `${Math.round(q * 1000)}g`;
  }
  return String(q);
}

// description = quality pills + customer's special instructions for that item
function buildDescription(item: CartItem): string | null {
  const parts: string[] = [];
  if (item.pills?.length)        parts.push(item.pills.join(', '));
  if (item.notes?.trim())        parts.push(item.notes.trim());
  return parts.length ? parts.join(' · ') : null;
}

async function createRazorpayLink(
  cart: CartItem[],
  customer_name: string,
  phone: string,
  notes: string,
  sales_id: string,
): Promise<{ id: string; short_url: string }> {
  const amountPaise = Math.round(cartTotal(cart) * 100);
  if (amountPaise < 100) throw new Error('Minimum order is ₹1');

  const description = cart.map(i => `${i.title} ×${fmtQty(i)}`).join(', ');
  const auth = btoa(`${env('RAZORPAY_KEY_ID')}:${env('RAZORPAY_KEY_SECRET')}`);

  const res = await fetch('https://api.razorpay.com/v1/payment_links', {
    method:  'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount:          amountPaise,
      currency:        'INR',
      description:     `The Good Papaya — ${description}`,
      customer: {
        name:    customer_name,
        contact: `+91${phone.replace(/^\+91/, '')}`,
      },
      notify:          { sms: true, email: false },
      reminder_enable: false,
      notes:           { sales_id, notes: notes || '', source: 'website' },
      callback_url:    'https://thegoodpapaya.com/pages/order-confirmed',
      callback_method: 'get',
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.description || 'Razorpay error');
  return { id: data.id, short_url: data.short_url };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const { cart, community, door_number, phone, contact_name, notes, payment_method } = await req.json();

    // Validate
    if (!cart?.length)  throw new Error('No items in cart');
    if (!community)     throw new Error('Missing community name');
    if (!door_number)   throw new Error('Missing door number');
    if (!phone)         throw new Error('Missing phone number');
    if (!/^\d{10}$/.test(phone.replace(/^\+91/, ''))) {
      throw new Error('Invalid phone number');
    }

    const method        = payment_method === 'online' ? 'online' : 'cod';
    const customer_name = `${community.trim()} ${String(door_number).trim()}`;
    const total         = cartTotal(cart);

    const today    = new Date().toISOString().split('T')[0];
    const safeName = customer_name.replace(/\s+/g, '-');
    const baseId   = `${today}-${safeName}`;

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    // Find a free sales_id (loop in case of multiple same-day orders or prior failures)
    let sales_id = baseId;
    let suffix   = 1;
    while (true) {
      const { data: hit } = await supabase
        .from('orders').select('sales_id').eq('sales_id', sales_id).maybeSingle();
      if (!hit) break;
      suffix++;
      sales_id = `${baseId}-${suffix}`;
    }

    // Insert order header
    const { error: orderErr } = await supabase.from('orders').insert({
      sales_id,
      customer_name,
      community:      community.trim(),
      contact_name:   contact_name || null,
      phone:          phone.replace(/^\+91/, ''),
      payment_method: method,
      status:         'open',
      payment_status: method === 'online' ? 'due_today' : 'due_today',
      cart,
      total:          Math.round((isNaN(total) ? 0 : total) * 100) / 100,
      notes:          notes || null,
    });
    if (orderErr) throw new Error(orderErr.message);

    // Look up unit prices from catalog (match by normalised name)
    const itemNames = [...new Set(cart.map((i: CartItem) => i.title))];
    const { data: catalogRows } = await supabase
      .from('catalog')
      .select('item_name, unit_price')
      .in('item_name', itemNames);
    const priceMap: Record<string, number> = {};
    (catalogRows || []).forEach((r: any) => { priceMap[r.item_name] = r.unit_price; });

    // Expand cart into order_items — one row per item
    const orderItems = cart.map((item: CartItem) => ({
      order_id:      sales_id,
      order_date:    today,
      customer_name,
      community:     community.trim(),
      item_name:     item.title,
      description:   buildDescription(item),
      requested_qty: getQty(item),
      unit_price:    priceMap[item.title] ?? parseFloat(String(item.price)) ?? null,
      final_qty:     null,
      status:        'open',
    }));

    const { error: itemsErr } = await supabase.from('order_items').insert(orderItems);
    if (itemsErr) {
      await supabase.from('orders').delete().eq('sales_id', sales_id);
      throw new Error(itemsErr.message);
    }

    // For online: create Razorpay link and store it
    if (method === 'online') {
      const rzp = await createRazorpayLink(cart, customer_name, phone, notes || '', sales_id);

      await supabase.from('orders')
        .update({ razorpay_link_id: rzp.id, razorpay_url: rzp.short_url })
        .eq('sales_id', sales_id);

      return new Response(
        JSON.stringify({ sales_id, payment_url: rzp.short_url }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ sales_id }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }
});
