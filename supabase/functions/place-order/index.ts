// Supabase Edge Function — save a COD order to the orders table
// Called by checkout.js with: { cart, customer_name, phone, address, notes }
// Returns: { ref } on success

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const { cart, customer_name, phone, address, notes } = await req.json();

    if (!cart?.length)  throw new Error('No items in cart');
    if (!customer_name) throw new Error('Missing customer name');
    if (!phone)         throw new Error('Missing phone');
    if (!address)       throw new Error('Missing address');

    const total = cart.reduce(
      (sum: number, i: { price: string | number; quantity: string | number }) =>
        sum + parseFloat(String(i.price)) * parseFloat(String(i.quantity)),
      0
    );

    const ref = 'GP' + Date.now().toString(36).toUpperCase();

    const supabase = createClient(
      env('SUPABASE_URL'),
      env('SUPABASE_SERVICE_ROLE_KEY'),
    );

    const { error } = await supabase.from('orders').insert({
      ref,
      customer_name,
      phone: phone.replace(/^\+91/, ''),
      address,
      notes:          notes || null,
      cart,
      total:          Math.round(total * 100) / 100,
      payment_method: 'cod',
      status:         'pending',
    });

    if (error) throw new Error(error.message);

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
