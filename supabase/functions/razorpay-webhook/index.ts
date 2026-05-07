// Supabase Edge Function — Razorpay payment webhook
//
// Razorpay → POST /razorpay-webhook  with X-Razorpay-Signature header
// Verifies HMAC-SHA256 signature, then updates order status to 'paid'.
//
// Required secret: RAZORPAY_WEBHOOK_SECRET
// Set in Razorpay dashboard → Settings → Webhooks → Secret

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function env(key: string) {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Missing env: ${key}`);
  return val;
}

async function verifySignature(body: string, signature: string, secret: string): Promise<boolean> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign'],
  );
  const raw = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  const hex = Array.from(new Uint8Array(raw))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return hex === signature;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const body      = await req.text();
  const signature = req.headers.get('x-razorpay-signature') ?? '';

  const valid = await verifySignature(body, signature, env('RAZORPAY_WEBHOOK_SECRET'));
  if (!valid) {
    return new Response(JSON.stringify({ error: 'Invalid signature' }), { status: 401 });
  }

  let payload: any;
  try { payload = JSON.parse(body); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  // Only act on payment_link.paid — ignore everything else silently
  if (payload.event !== 'payment_link.paid') {
    return new Response(JSON.stringify({ ok: true, ignored: true }), { status: 200 });
  }

  const linkEntity = payload.payload?.payment_link?.entity;
  const salesId    = linkEntity?.notes?.sales_id as string | undefined;
  const linkId     = linkEntity?.id               as string | undefined;

  if (!salesId && !linkId) {
    return new Response(JSON.stringify({ ok: true, msg: 'no identifier' }), { status: 200 });
  }

  const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

  const filter = salesId
    ? supabase.from('orders').update({ status: 'paid' }).eq('sales_id', salesId)
    : supabase.from('orders').update({ status: 'paid' }).eq('razorpay_link_id', linkId!);

  const { error } = await filter;
  if (error) console.error('order update failed:', error.message);

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
