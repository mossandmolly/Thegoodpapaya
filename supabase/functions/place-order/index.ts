// Supabase Edge Function — place a website order (COD or online)
//
// Called by checkout.js with:
//   { cart, customer_name, phone, address, notes, payment_method }
//
// For COD:    saves order → returns { ref }
// For online: saves order → creates Razorpay payment link → returns { ref, payment_url }

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
  id:       number;
  title:    string;
  price:    string | number;
  quantity: string | number;
  mode?:    string;
  pills?:   string[];
  notes?:   string;
};

function cartTotal(cart: CartItem[]): number {
  return cart.reduce(
    (s, i) => s + parseFloat(String(i.price)) * parseFloat(String(i.quantity)),
    0
  );
}

function fmtQty(item: CartItem): string {
  if (item.mode === 'weight') {
    const w = parseFloat(String(item.quantity));
    return w >= 1 ? `${w}kg` : `${Math.round(w * 1000)}g`;
  }
  return String(item.quantity);
}

async function createRazorpayLink(
  cart: CartItem[],
  customer_name: string,
  phone: string,
  address: string,
  notes: string,
  ref: string,
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
      notes:           { ref, address: address || '', notes: notes || '', source: 'website' },
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
    const { cart, customer_name, phone, address, notes, payment_method } = await req.json();

    if (!cart?.length)  throw new Error('No items in cart');
    if (!customer_name) throw new Error('Missing customer name');
    if (!phone)         throw new Error('Missing phone');
    if (!address)       throw new Error('Missing address');

    const method = payment_method === 'online' ? 'online' : 'cod';
    const total  = cartTotal(cart);
    const ref    = 'GP' + Date.now().toString(36).toUpperCase();

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    // Save order first — status depends on method
    const { error: insertError } = await supabase.from('orders').insert({
      ref,
      customer_name,
      phone:          phone.replace(/^\+91/, ''),
      address,
      notes:          notes || null,
      cart,
      total:          Math.round(total * 100) / 100,
      payment_method: method,
      status:         method === 'online' ? 'awaiting_payment' : 'pending',
    });

    if (insertError) throw new Error(insertError.message);

    // For online: create Razorpay payment link and store the reference
    if (method === 'online') {
      const rzp = await createRazorpayLink(cart, customer_name, phone, address, notes || '', ref);

      await supabase.from('orders')
        .update({ razorpay_link_id: rzp.id, razorpay_url: rzp.short_url })
        .eq('ref', ref);

      return new Response(
        JSON.stringify({ ref, payment_url: rzp.short_url }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    // COD — just return the ref
    return new Response(
      JSON.stringify({ ref }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }
});
