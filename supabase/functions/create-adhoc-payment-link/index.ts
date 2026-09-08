// Supabase Edge Function — create-adhoc-payment-link
//
// Creates a standalone Razorpay payment link that isn't tied to any
// sales_order_id/invoice — e.g. an advance, or a one-off collection taken
// over the phone. Separate from create-order-payment-link (which requires
// an already-invoiced order) and create-payment-link (public shop
// checkout, cart-shaped input).
//
// Input:  { phone: string, amount: number, description?: string }
// Output: { payment_url, razorpay_link_id }
//
// Deliberately omits sales_order_id from the Razorpay notes — razorpay-webhook
// requires one to do anything with a paid event and safely no-ops without it,
// so this link's eventual payment is never auto-recorded anywhere. It's
// logged to adhoc_payment_links purely so there's a record of who created
// what, since there's no order/invoice trail for it otherwise.
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function env(key: string) {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Missing env: ${key}`);
  return val;
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

// This function uses the service role internally, so it bypasses RLS
// regardless of who calls it — the anon key alone is enough to invoke it at
// the platform level. Requiring a real logged-in user session here is what
// actually restricts this to signed-in ops staff (this one creates real
// Razorpay payment links, so it matters more than most).
async function requireAuth(req: Request): Promise<string> {
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) throw new Error('Not authenticated');
  const res = await fetch(`${env('SUPABASE_URL')}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${jwt}`, apikey: env('SUPABASE_SERVICE_ROLE_KEY') },
  });
  if (!res.ok) throw new Error('Not authenticated');
  const user = await res.json();
  return user?.email || user?.id || 'unknown';
}

async function createPaymentLink(
  amountPaise: number, phone: string, description: string, auth: string,
): Promise<{ id: string; short_url: string }> {
  const res = await fetch('https://api.razorpay.com/v1/payment_links', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount:   amountPaise,
      currency: 'INR',
      description: description || 'The Good Papaya — payment',
      customer: { contact: `+91${phone.replace(/^\+91/, '')}` },
      notify:          { sms: true, whatsapp: true, email: false },
      reminder_enable: false,
      notes: { source: 'ops-dashboard-adhoc' },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.description || 'Razorpay error');
  return { id: data.id, short_url: data.short_url };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const createdBy = await requireAuth(req);
    const { phone, amount, description } = await req.json();

    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 14) throw new Error('Invalid phone number');
    const amountNum = Number(amount);
    if (!amountNum || amountNum <= 0) throw new Error('Invalid amount');

    const keyId     = env('RAZORPAY_KEY_ID');
    const keySecret = env('RAZORPAY_KEY_SECRET');
    const auth      = btoa(`${keyId}:${keySecret}`);

    const amountPaise = Math.round(amountNum * 100);
    const link = await createPaymentLink(amountPaise, digits, description, auth);

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));
    await supabase.from('adhoc_payment_links').insert({
      phone: digits,
      amount: amountNum,
      description: description || null,
      razorpay_link_id: link.id,
      payment_url: link.short_url,
      created_by: createdBy,
    });

    return new Response(
      JSON.stringify({ payment_url: link.short_url, razorpay_link_id: link.id }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
