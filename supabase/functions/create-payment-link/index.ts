// Supabase Edge Function — create Razorpay payment link for shop orders
// Called by checkout.js with: { items, customer_name, phone, address, notes }
// Returns: { payment_url }

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
    const { items, customer_name, phone, address, notes } = await req.json();

    if (!items?.length)    throw new Error('No items in cart');
    if (!customer_name)    throw new Error('Missing customer name');
    if (!phone)            throw new Error('Missing phone');

    // Calculate total in paise
    const totalRupees = items.reduce(
      (sum: number, i: { price: string; quantity: number }) =>
        sum + parseFloat(i.price) * i.quantity,
      0
    );
    const amountPaise = Math.round(totalRupees * 100);

    if (amountPaise < 100) throw new Error('Minimum order is ₹1');

    // Build description
    const description = items
      .map((i: { title: string; quantity: number }) => `${i.title} ×${i.quantity}`)
      .join(', ');

    const keyId     = env('RAZORPAY_KEY_ID');
    const keySecret = env('RAZORPAY_KEY_SECRET');
    const auth      = btoa(`${keyId}:${keySecret}`);

    const callbackUrl = 'https://thegoodpapaya.com/pages/order-confirmed';

    const rzpRes = await fetch('https://api.razorpay.com/v1/payment_links', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        amount:          amountPaise,
        currency:        'INR',
        description:     `The Good Papaya — ${description}`,
        customer: {
          name:    customer_name,
          contact: `+91${phone.replace(/^\+91/, '')}`,
        },
        notify:          { sms: true, whatsapp: true, email: false },
        reminder_enable: false,
        notes: {
          address: address || '',
          notes:   notes   || '',
          source:  'website',
        },
        callback_url:    callbackUrl,
        callback_method: 'get',
      }),
    });

    const rzpData = await rzpRes.json();

    if (!rzpRes.ok) {
      throw new Error(rzpData?.error?.description || 'Razorpay error');
    }

    return new Response(
      JSON.stringify({ payment_url: rzpData.short_url }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }
});
