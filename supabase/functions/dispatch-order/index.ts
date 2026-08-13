// Supabase Edge Function — dispatch-order
//
// Advances an order from 'not_dispatched' to 'ofd' (out for delivery) once
// every one of its non-cancelled items has been checked off as physically
// collected into the rider's bag — the frontend calls this the moment that
// condition becomes true, right after the last item's collected checkbox
// is ticked. orders' RLS locks writes to service-role only, so this is the
// write path (order_items.collected itself is a direct, unrestricted write
// from the frontend since order_items isn't locked the same way).
//
// Idempotent/guarded: only actually updates if the order is currently
// 'not_dispatched' — calling it again on an already-dispatched (or
// delivered) order is a harmless no-op rather than clobbering later state.
//
// An order should never end up OFD without a named rider attached — if
// `rider` is passed and the order isn't already assigned to someone, this
// claims it for that rider as part of the same dispatch, same "no
// unassigned deliveries" rule assign-rider enforces on its own path.
// Never overwrites an existing assignment.
//
// Also generates a Razorpay Dynamic QR Code (a real Razorpay product,
// separate from payment links) for the delivery rider's app to display —
// scan-and-pay for the exact invoice total, auto-closes itself once paid
// (usage: single_use). This is independent of razorpay_link_id/
// razorpay_url, which stay untouched here — those are only ever set by the
// separate manual "Generate Payment Link" flow (create-order-payment-link)
// and are no longer what the Delivery panel displays. Best-effort: a QR
// creation failure (e.g. Razorpay outage, order not yet invoiced) never
// blocks the dispatch itself — the rider still needs to leave with the
// order even if the QR isn't ready yet.
//
// Input:  { sales_order_id: string, rider?: string }
// Output: { sales_order_id, delivery_status, dispatched: boolean }
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

async function createDeliveryQr(
  amountPaise: number, salesOrderId: string, customerName: string,
): Promise<{ id: string; image_url: string }> {
  const keyId     = env('RAZORPAY_KEY_ID');
  const keySecret = env('RAZORPAY_KEY_SECRET');
  const auth      = btoa(`${keyId}:${keySecret}`);

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
  if (!res.ok) throw new Error(data?.error?.description || 'Razorpay QR creation failed');
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
    const { sales_order_id, rider } = await req.json();
    if (!sales_order_id) throw new Error('Missing sales_order_id');

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    const update: Record<string, unknown> = { delivery_status: 'ofd', dispatched_at: new Date().toISOString() };
    if (rider) {
      const { data: existing } = await supabase
        .from('orders').select('assigned_rider').eq('sales_order_id', sales_order_id).maybeSingle();
      if (!existing?.assigned_rider) update.assigned_rider = rider;
    }

    const { data, error } = await supabase
      .from('orders')
      .update(update)
      .eq('sales_order_id', sales_order_id)
      .eq('delivery_status', 'not_dispatched')
      .select('sales_order_id, delivery_status')
      .maybeSingle();
    if (error) throw new Error(error.message);

    if (data) {
      let qrImageUrl: string | null = null;
      try {
        const { data: order } = await supabase
          .from('orders')
          .select('customer_name, invoice_total, invoice_status, payment_collected')
          .eq('sales_order_id', sales_order_id)
          .maybeSingle();
        if (order && order.invoice_status === 'done' && order.invoice_total > 0 && !order.payment_collected) {
          const qr = await createDeliveryQr(
            Math.round(order.invoice_total * 100), sales_order_id, order.customer_name,
          );
          await supabase.from('orders')
            .update({ qr_code_id: qr.id, qr_image_url: qr.image_url, qr_created_at: new Date().toISOString() })
            .eq('sales_order_id', sales_order_id);
          qrImageUrl = qr.image_url;
        }
      } catch (qrErr: any) {
        // Best-effort — dispatch already succeeded, don't fail the rider's
        // action just because the QR couldn't be created.
        console.error('Delivery QR creation failed:', qrErr.message);
      }
      return new Response(
        JSON.stringify({ ...data, dispatched: true, qr_image_url: qrImageUrl }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }
    // Already past not_dispatched (or the row doesn't exist) — report the
    // current state rather than erroring, since a caller racing another
    // rider's checkbox tap shouldn't see this as a failure.
    const { data: current } = await supabase
      .from('orders').select('sales_order_id, delivery_status')
      .eq('sales_order_id', sales_order_id).maybeSingle();
    return new Response(
      JSON.stringify({ ...(current || { sales_order_id, delivery_status: null }), dispatched: false }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
