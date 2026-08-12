// Supabase Edge Function — mark-delivered
//
// Toggles an order's delivery status, with an optional remark and one or
// more photos captured at the same time. orders' RLS locks writes to
// service-role only, so this is the write path for the Delivery tab —
// same pattern as every other orders mutation in this app.
//
// `delivered` is optional — omit it to use this purely as an "attach more
// evidence" call (add a remark and/or photos to an order) without touching
// its delivery status at all. This is what lets a rider add a photo or a
// note to an order that's already delivered (or has a returned item),
// something that previously only happened inside the one-shot "mark
// delivered" flow.
//
// The photos themselves are uploaded directly from the frontend to the
// "delivery-photos" Storage bucket using the caller's own authenticated
// session (that bucket's policies allow any signed-in session to do so);
// this function only records the resulting paths against the order.
// photo_paths is always merged with whatever's already on the order, never
// a wholesale replace — a rider attaching one more photo later should
// never risk wiping out earlier ones.
//
// Input:  { sales_order_id: string, delivered?: boolean, notes?: string, photo_paths?: string[],
//           payment_collected?: boolean, payment_collected_method?: 'cash'|'online'|null, rider?: string,
//           sync_partial_status?: boolean }
// Output: { sales_order_id, delivery_status, delivered_at }
//
// sync_partial_status (used instead of `delivered`) re-checks an already-
// 'delivered' order for cancelled items and flips it to
// 'partially_delivered' if any exist — for when an item gets rejected via
// the Delivery tab's "not delivered" *after* the order was already marked
// fully delivered, which would otherwise leave it reading 'delivered'
// forever. Touches delivery_status only, never delivered_at/payment —
// unlike `delivered: true`, this isn't re-confirming a delivery just
// happened.
//
// `rider` (only meaningful when delivered: true) records who actually
// marked this delivered — attribution for performance tracking, distinct
// from assigned_rider (who the order was assigned to; the same "All
// orders" pattern that lets any packer finish someone else's item lets any
// rider deliver an order they weren't personally assigned).
//
// A rider marking an order delivered-but-not-paid means whatever dynamic QR
// was showing (see dispatch-order/refresh-delivery-qr) is now the wrong
// mechanism — the delivery moment it was meant for has passed. This closes
// that QR and, in its place, generates a Razorpay payment link (notified to
// the customer over SMS/WhatsApp) so collection can continue after the
// rider's left. Best-effort: failures here never fail the delivered-status
// update itself, which has already succeeded by the time this runs.
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function env(key: string) {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Missing env: ${key}`);
  return val;
}

async function closeQrCode(qrCodeId: string, auth: string): Promise<void> {
  try {
    await fetch(`https://api.razorpay.com/v1/payments/qr_codes/${qrCodeId}/close`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}` },
    });
  } catch (_e) {} // best effort
}

async function cancelPaymentLink(linkId: string, auth: string): Promise<void> {
  try {
    await fetch(`https://api.razorpay.com/v1/payment_links/${linkId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}` },
    });
  } catch (_e) {} // best effort
}

async function createNotPaidPaymentLink(
  amountPaise: number, customerName: string, phone: string, salesOrderId: string, auth: string,
): Promise<{ id: string; short_url: string } | null> {
  const res = await fetch('https://api.razorpay.com/v1/payment_links', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: amountPaise, currency: 'INR',
      description: `The Good Papaya — order ${salesOrderId}`,
      customer: { name: customerName, contact: `+91${phone.replace(/^\+91/, '')}` },
      notify: { sms: true, whatsapp: true, email: false },
      reminder_enable: true,
      notes: { sales_order_id: salesOrderId, source: 'not-paid-delivery' },
    }),
  });
  const data = await res.json();
  if (!res.ok) { console.error(`[mark-delivered] Payment link creation failed for ${salesOrderId}:`, data?.error?.description); return null; }
  return { id: data.id, short_url: data.short_url };
}

async function switchToPaymentLink(supabase: any, salesOrderId: string): Promise<void> {
  const { data: order } = await supabase
    .from('orders')
    .select('customer_name, phone, invoice_total, invoice_status, qr_code_id, razorpay_link_id')
    .eq('sales_order_id', salesOrderId)
    .maybeSingle();
  if (!order) return;

  const auth = btoa(`${env('RAZORPAY_KEY_ID')}:${env('RAZORPAY_KEY_SECRET')}`);
  const updates: Record<string, unknown> = {};

  if (order.qr_code_id) {
    await closeQrCode(order.qr_code_id, auth);
    updates.qr_code_id = null;
    updates.qr_image_url = null;
  }
  if (order.invoice_status === 'done' && order.invoice_total > 0 && order.phone) {
    if (order.razorpay_link_id) await cancelPaymentLink(order.razorpay_link_id, auth);
    const link = await createNotPaidPaymentLink(
      Math.round(order.invoice_total * 100), order.customer_name, order.phone, salesOrderId, auth,
    );
    if (link) { updates.razorpay_link_id = link.id; updates.razorpay_url = link.short_url; }
  }

  if (Object.keys(updates).length) {
    await supabase.from('orders').update(updates).eq('sales_order_id', salesOrderId);
  }
}

// This function uses the service role internally, so it bypasses RLS
// regardless of who calls it — the anon key alone is enough to invoke it at
// the platform level. Requiring a real logged-in user session here is what
// actually restricts this to signed-in ops staff (any authenticated
// session — admin, packer, or the shared delivery login — can mark an
// order delivered; the Delivery tab's own UI, not this function, is what
// keeps a delivery session confined to its one tab).
async function requireAuth(req: Request): Promise<void> {
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) throw new Error('Not authenticated');
  const res = await fetch(`${env('SUPABASE_URL')}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${jwt}`, apikey: env('SUPABASE_SERVICE_ROLE_KEY') },
  });
  if (!res.ok) throw new Error('Not authenticated');
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
    const { sales_order_id, delivered, notes, photo_paths, payment_collected, payment_collected_method, rider, sync_partial_status } = await req.json();
    if (!sales_order_id) throw new Error('Missing sales_order_id');
    if (delivered !== undefined && typeof delivered !== 'boolean') throw new Error('delivered must be a boolean if provided');

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    const update: Record<string, unknown> = {};

    // Only touch delivery_status/delivered_at/payment fields when `delivered`
    // is actually provided — an "attach more evidence" call (photos/notes
    // only, delivered omitted) must leave the order's current status alone.
    if (delivered !== undefined) {
      // A rider confirming delivery doesn't mean every originally-requested
      // item made it — one or more may have been rejected/not-delivered
      // along the way (order_items already marked 'cancelled', either just
      // now via the Delivery tab or earlier in Today's Orders). If any
      // survive as cancelled alongside at least one still-active item, this
      // was only a partial delivery, not a full one — distinct from
      // 'delivered' so ops can spot it. (An order with ZERO active items
      // left is cancelled outright at the order level instead — see
      // autoRegenerateInvoiceIfReady/cancel-order on the frontend — so this
      // check never needs to consider that case.)
      let deliveryStatus = 'ofd';
      if (delivered) {
        const { data: cancelledItems } = await supabase
          .from('order_items')
          .select('id')
          .eq('sales_order_id', sales_order_id)
          .eq('status', 'cancelled')
          .limit(1);
        deliveryStatus = (cancelledItems && cancelledItems.length) ? 'partially_delivered' : 'delivered';
      }
      // payment_collected/_method/_at travel with delivered_at, not with
      // notes/photos — un-marking a delivery means the payment the rider
      // claimed to have collected at that (now-undone) delivery is undone
      // too, whereas remarks/photos already attached stay as history.
      // Undoing a delivered (or partially-delivered) order reverts to 'ofd',
      // not all the way back to 'not_dispatched' — the items were already
      // collected into the bag (that's how it reached this state in the
      // first place), it just hasn't actually been handed over, so it's
      // still out with the rider.
      update.delivery_status          = deliveryStatus;
      update.delivered_at             = delivered ? new Date().toISOString() : null;
      update.delivered_by             = delivered ? (rider || null) : null;
      update.payment_collected        = delivered ? !!payment_collected : false;
      update.payment_collected_method = delivered && payment_collected ? (payment_collected_method || null) : null;
      update.payment_collected_at     = delivered && payment_collected ? new Date().toISOString() : null;
    } else if (sync_partial_status) {
      const { data: current } = await supabase
        .from('orders')
        .select('delivery_status')
        .eq('sales_order_id', sales_order_id)
        .single();
      if (current?.delivery_status === 'delivered') {
        const { data: cancelledItems } = await supabase
          .from('order_items')
          .select('id')
          .eq('sales_order_id', sales_order_id)
          .eq('status', 'cancelled')
          .limit(1);
        if (cancelledItems && cancelledItems.length) update.delivery_status = 'partially_delivered';
      }
    }
    // Only touch notes when actually provided, so un-marking a delivery
    // (delivered: false) doesn't wipe out a remark that was already
    // attached — those stay as history until explicitly replaced.
    if (notes !== undefined) update.delivery_notes = notes || null;

    if (photo_paths !== undefined && photo_paths.length) {
      const { data: existing, error: fetchErr } = await supabase
        .from('orders').select('delivery_photo_paths')
        .eq('sales_order_id', sales_order_id).single();
      if (fetchErr) throw new Error(fetchErr.message);
      const current: string[] = existing?.delivery_photo_paths ?? [];
      update.delivery_photo_paths = [...new Set([...current, ...photo_paths])];
    }

    if (!Object.keys(update).length) {
      // sync_partial_status is a routine no-op whenever the order wasn't
      // already 'delivered' (still ofd, or nothing was actually rejected) —
      // that's success, not an error, so the frontend's not-delivered flow
      // doesn't need to special-case it.
      if (sync_partial_status) {
        const { data, error } = await supabase
          .from('orders')
          .select('sales_order_id, delivery_status, delivered_at, delivered_by, payment_collected, payment_collected_method')
          .eq('sales_order_id', sales_order_id)
          .single();
        if (error) throw new Error(error.message);
        return new Response(JSON.stringify(data), { headers: { ...CORS, 'Content-Type': 'application/json' } });
      }
      throw new Error('Nothing to update');
    }

    const { data, error } = await supabase
      .from('orders')
      .update(update)
      .eq('sales_order_id', sales_order_id)
      .select('sales_order_id, delivery_status, delivered_at, delivered_by, payment_collected, payment_collected_method')
      .single();
    if (error) throw new Error(error.message);
    if (!data) throw new Error(`Order ${sales_order_id} not found`);

    if (delivered === true && !payment_collected) {
      try { await switchToPaymentLink(supabase, sales_order_id); }
      catch (e: any) { console.error(`[mark-delivered] switchToPaymentLink failed for ${sales_order_id}:`, e.message); }
    }

    return new Response(
      JSON.stringify(data),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
