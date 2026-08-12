// Supabase Edge Function — refresh-delivery-qr
//
// Dynamic QR Codes only stay active for a couple of hours (close_by), so a
// rider's QR for a society they won't reach for a while can expire before
// they get there. Called by the frontend right after a rider finishes the
// last house in a society — for every sales_order_id passed in, closes the
// existing QR (if any) and creates a fresh one with a new ~2hr close_by,
// resetting the clock. Silently skips any order that isn't actually
// eligible anymore (already paid, no QR ever created, not invoiced) rather
// than erroring the whole batch over one stale entry.
//
// Input:  { sales_order_ids: string[] }
// Output: { results: { sales_order_id, qr_image_url }[] }
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function env(key: string) {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Missing env: ${key}`);
  return val;
}

async function requireAuth(req: Request): Promise<void> {
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) throw new Error('Not authenticated');
  const res = await fetch(`${env('SUPABASE_URL')}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${jwt}`, apikey: env('SUPABASE_SERVICE_ROLE_KEY') },
  });
  if (!res.ok) throw new Error('Not authenticated');
}

async function closeQrCode(qrCodeId: string, auth: string): Promise<void> {
  try {
    await fetch(`https://api.razorpay.com/v1/payments/qr_codes/${qrCodeId}/close`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}` },
    });
  } catch (_e) {} // best effort
}

async function createDeliveryQr(
  amountPaise: number, salesOrderId: string, customerName: string, auth: string,
): Promise<{ id: string; image_url: string } | null> {
  const res = await fetch('https://api.razorpay.com/v1/payments/qr_codes', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type:           'upi_qr',
      name:            `Order ${salesOrderId}`,
      usage:          'single_use',
      fixed_amount:    true,
      payment_amount:  amountPaise,
      description:    `The Good Papaya — order ${salesOrderId}`,
      close_by:        Math.floor(Date.now() / 1000) + 24 * 60 * 60,
      notes:          { sales_order_id: salesOrderId, customer_name: customerName, source: 'delivery-qr' },
    }),
  });
  const data = await res.json();
  if (!res.ok) { console.error(`[refresh-qr] Creation failed for ${salesOrderId}:`, data?.error?.description); return null; }
  return { id: data.id, image_url: data.image_url };
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    await requireAuth(req);
    const { sales_order_ids } = await req.json();
    if (!Array.isArray(sales_order_ids) || !sales_order_ids.length) {
      throw new Error('Missing sales_order_ids');
    }

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));
    const auth = btoa(`${env('RAZORPAY_KEY_ID')}:${env('RAZORPAY_KEY_SECRET')}`);

    const { data: orders } = await supabase
      .from('orders')
      .select('sales_order_id, customer_name, invoice_total, invoice_status, payment_collected, delivery_status, qr_code_id')
      .in('sales_order_id', sales_order_ids);

    const results: { sales_order_id: string; qr_image_url: string | null }[] = [];

    for (const order of orders ?? []) {
      // Only refresh orders that are still genuinely awaiting a QR payment —
      // skip anything delivered, already paid, or never invoiced.
      if (order.delivery_status !== 'ofd' || order.payment_collected ||
          order.invoice_status !== 'done' || !(order.invoice_total > 0)) {
        continue;
      }
      if (order.qr_code_id) await closeQrCode(order.qr_code_id, auth);

      const qr = await createDeliveryQr(
        Math.round(order.invoice_total * 100), order.sales_order_id, order.customer_name, auth,
      );
      if (!qr) continue;

      await supabase.from('orders')
        .update({ qr_code_id: qr.id, qr_image_url: qr.image_url })
        .eq('sales_order_id', order.sales_order_id);
      results.push({ sales_order_id: order.sales_order_id, qr_image_url: qr.image_url });
    }

    return new Response(
      JSON.stringify({ results }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
