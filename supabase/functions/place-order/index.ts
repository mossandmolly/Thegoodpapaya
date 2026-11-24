// Supabase Edge Function — place-order
//
// Public order-creation endpoint for the customer storefront (storefront/).
// No auth at all — this is called straight from a public checkout page with
// no logged-in session, same as this function always was. Runs server-side
// though, so it CAN safely hold CRON_SECRET and call create-order
// internally (never exposed to the browser) — same pattern
// whatsapp-create-order uses, rather than re-deriving society/community and
// re-implementing the ignore-duplicates upsert a third time.
//
// REWRITE NOTE: the previous version of this function predated the
// order_items-based schema (migration 030) and wrote into `operations`, a
// table nothing else in this app reads any more — orders placed through it
// were invisible to staff. This version targets the current schema
// (orders + order_items), verified against create-order/index.ts and
// whatsapp-create-order/index.ts, both actively used today.
//
// Input:  { cart: [{ item_name, quantity, unit? }], society, door_number,
//            phone, notes?, payment_method }
// Output: { sales_order_id }                    (cod)
//         { sales_order_id, payment_url }        (online)
//
// notes is saved verbatim onto order_items.delivery_instructions,
// synchronously, with zero added parsing/latency. Turning that free text
// into a structured orders.deliver_by/deliver_after deadline is done
// entirely off this request's lifetime, by the extract-delivery-windows
// edge function on its own pg_cron schedule (every 20 min) — see that
// function's header for why a cron beats a per-request background task.
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET
//   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET  (online orders only)

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
  item_name: string;
  quantity:  string | number;
  unit?:     string;
  notes?:    string;
  mode?:     string; // 'kg' (default), 'piece', or 'box' — see isPieceMode/isBoxMode
};

function isPieceMode(item: CartItem): boolean {
  return item.mode === 'piece';
}

function isBoxMode(item: CartItem): boolean {
  return item.mode === 'box';
}

// Neither has a confirmed price until staff weigh/count it at packing —
// shared by every place this app needs "does this item have no firm
// price yet" rather than specifically "is it piece mode".
function hasNoConfirmedPrice(item: CartItem): boolean {
  return isPieceMode(item) || isBoxMode(item);
}

function getQty(item: CartItem): number {
  const q = parseFloat(String(item.quantity));
  return isNaN(q) || q <= 0 ? 1 : q;
}

// Same rule as canonicalCustomerKey() in ops-dashboard/parser.html and
// sales_order_id generation everywhere else in this app — keep in sync.
function canonicalCustomerKey(name: string): string {
  return (name || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

// sales_order_id suffix scheme for one household (baseId) on one day —
// place-order-specific, NOT shared with whatsapp-create-order/pushRows
// (those don't have a "second household member, different phone" case the
// same way, since each WhatsApp order already comes in under one sender).
//
//   baseId              — the first phone to order today for this house
//   baseId-N            — that SAME phone ordering again after its
//                          previous order already dispatched (N = 1,2,3…)
//                          — this is the pre-existing scheme, unchanged,
//                          so it stays compatible with every order ID
//                          already sitting in the live table.
//   baseId-{slot}-{N}    — a DIFFERENT phone ordering for this house today.
//                          slot = 1,2,3… in the order each new phone first
//                          shows up; N is THAT phone's own 1,2,3…
//                          dispatch-retry count, same rule as above. Two
//                          dashes, not digits jammed together — "-1-1" vs
//                          "-10" must never be confused once a count
//                          reaches double digits.
//
// So "-1-1"/"-1-2" is the second phone's 1st/2nd order today, "-2-1" the
// third phone's 1st order, etc. Two phones for one house therefore get two
// distinct sales_order_ids (by design — see place-order's header comment),
// while the same phone ordering again still merges exactly as before.
function parseSuffix(salesOrderId: string, baseId: string): { slot: number; orderIndex: number } {
  const rest = salesOrderId.slice(baseId.length);
  if (!rest) return { slot: 0, orderIndex: 0 };
  const parts = rest.slice(1).split('-'); // drop the leading '-', then split the rest
  if (parts.length === 1) return { slot: 0, orderIndex: parseInt(parts[0], 10) || 0 };
  return { slot: parseInt(parts[0], 10) || 0, orderIndex: parseInt(parts[1], 10) || 0 };
}

function buildSalesOrderId(baseId: string, slot: number, orderIndex: number): string {
  if (slot === 0) return orderIndex === 0 ? baseId : `${baseId}-${orderIndex}`;
  return `${baseId}-${slot}-${orderIndex}`;
}

async function resolveSalesOrderId(
  supabase: ReturnType<typeof createClient>, baseId: string, phone: string,
): Promise<string> {
  const { data: rows, error } = await supabase
    .from('order_customer_lookup').select('sales_order_id, phone, delivery_status')
    .like('sales_order_id', `${baseId}%`);
  if (error) throw new Error(error.message);

  // The LIKE above is just a cheap, index-assisted first pass — a longer
  // household key can still start with this one's (e.g. "...flat3" is a
  // prefix of "...flat30"), so only an exact match or a real "-" boundary
  // right after baseId counts as actually today's order for THIS house.
  const todays = (rows ?? []).filter(r => {
    const id = r.sales_order_id as string;
    return id === baseId || id.startsWith(`${baseId}-`);
  });
  if (!todays.length) return baseId; // first order today for this house, first phone — unsuffixed, as always

  // For each slot seen today, keep only its most recent order (highest
  // orderIndex) — that's the one still open to merge into, or the one
  // whose dispatched status decides whether this phone needs to split.
  const latestBySlot = new Map<number, { phone: string | null; orderIndex: number; dispatched: boolean }>();
  for (const r of todays) {
    const { slot, orderIndex } = parseSuffix(r.sales_order_id as string, baseId);
    const current = latestBySlot.get(slot);
    if (!current || orderIndex > current.orderIndex) {
      const dispatched = (r.delivery_status ?? 'not_dispatched') !== 'not_dispatched';
      latestBySlot.set(slot, { phone: r.phone as string | null, orderIndex, dispatched });
    }
  }

  for (const [slot, entry] of latestBySlot) {
    if (entry.phone === phone) {
      return entry.dispatched
        ? buildSalesOrderId(baseId, slot, entry.orderIndex + 1) // same phone, already out — split, as before
        : buildSalesOrderId(baseId, slot, entry.orderIndex);    // same phone, still open — merge in, as before
    }
  }

  // A genuinely new phone for this house today — starts its own slot and
  // its own -N1/-N2/… series.
  let nextSlot = 1;
  while (latestBySlot.has(nextSlot)) nextSlot++;
  return buildSalesOrderId(baseId, nextSlot, 1);
}

async function createRazorpayLink(
  amount: number, customerName: string, phone: string, notes: string, salesOrderId: string,
): Promise<{ id: string; short_url: string }> {
  const amountPaise = Math.round(amount * 100);
  if (amountPaise < 100) throw new Error('Minimum order is ₹1');

  const auth = btoa(`${env('RAZORPAY_KEY_ID')}:${env('RAZORPAY_KEY_SECRET')}`);
  const res = await fetch('https://api.razorpay.com/v1/payment_links', {
    method:  'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount:          amountPaise,
      currency:        'INR',
      description:     `The Good Papaya — order ${salesOrderId}`,
      customer:        { name: customerName, contact: `+91${phone}` },
      notify:          { sms: true, whatsapp: true, email: false },
      reminder_enable: false,
      notes:           { sales_order_id: salesOrderId, notes: notes || '', source: 'website' },
      callback_url:    'https://thegoodpapaya.com/order-confirmed.html',
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
    const { cart, society, door_number, phone, notes, payment_method, device_id } = await req.json();

    if (!cart?.length)  throw new Error('No items in cart');
    if (!society)       throw new Error('Missing society name');
    if (!door_number)   throw new Error('Missing door/flat number');
    if (!phone)         throw new Error('Missing phone number');

    const normalPhone = String(phone).replace(/^\+91/, '').replace(/\D/g, '');
    if (!/^\d{10}$/.test(normalPhone)) throw new Error('Invalid phone number — enter a 10-digit number');

    const method = payment_method === 'online' ? 'online' : 'cod';
    // Piece/box-mode items have no confirmed price until staff weigh/count
    // them at packing — nothing to charge upfront, so prepay isn't
    // available for a basket that contains any. The checkout page already
    // disables this client-side; enforced again here since the browser
    // isn't trusted for anything that affects a real payment amount.
    if (method === 'online' && (cart as CartItem[]).some(hasNoConfirmedPrice)) {
      throw new Error('This basket has items priced at packing — choose Pay on Delivery instead.');
    }
    const customerName = `${String(society).trim()} ${String(door_number).trim()}`;
    const today         = new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10); // IST

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    // Same-day repeat orders from the same PHONE combine onto the same
    // sales_order_id (deterministic date+customer key) — UNLESS that
    // order's already out for delivery, in which case split into a fresh
    // "-N" id instead of silently joining one that's already left. A
    // DIFFERENT phone ordering for the same house gets its own separate
    // sales_order_id entirely (so each phone's My Orders/My Invoices
    // lookup only ever shows that phone's own items) — see
    // resolveSalesOrderId above for the exact suffix scheme.
    const baseId = `${today}-${canonicalCustomerKey(customerName)}`;
    const itemNames = [...new Set((cart as CartItem[]).map(i => i.item_name))];

    // resolveSalesOrderId and the catalog price lookup don't depend on
    // each other at all (one only needs baseId+phone, the other only
    // needs itemNames) — running them together instead of one after the
    // other saves a full round trip off checkout latency.
    const [sales_order_id, { data: catalogRows }] = await Promise.all([
      resolveSalesOrderId(supabase, baseId, normalPhone),
      supabase.from('catalog').select('item_name, unit_price, active').in('item_name', itemNames),
    ]);

    // Catalog price lookup — authoritative price is always what's in
    // `catalog`, never whatever the browser sent (defense against a
    // tampered/stale client price).
    const priceMap: Record<string, number> = {};
    const activeSet = new Set<string>();
    (catalogRows ?? []).forEach((r: any) => {
      priceMap[r.item_name] = r.unit_price;
      if (r.active) activeSet.add(r.item_name);
    });
    const unavailable = itemNames.filter(n => !activeSet.has(n));
    if (unavailable.length) throw new Error(`No longer available: ${unavailable.join(', ')}`);

    // Piece/box-mode items are excluded from the total entirely — there's
    // no confirmed price for them yet (see hasNoConfirmedPrice above), and
    // method is already guaranteed 'cod' whenever any are present, so this
    // only ever feeds the Razorpay amount for a cart of purely
    // weight-priced items anyway.
    const orderTotal = (cart as CartItem[])
      .filter(i => !hasNoConfirmedPrice(i))
      .reduce((s, i) => s + (priceMap[i.item_name] ?? 0) * getQty(i), 0);

    // Header — via create-order (server-to-server, CRON_SECRET never
    // reaches the browser), same as whatsapp-create-order. Handles the
    // create-or-reopen-if-cancelled logic and communities upsert.
    //
    // Run alongside the order_items existing-rows read below rather than
    // waiting for it to finish first — that read only needs sales_order_id
    // (already known), and for a genuinely new ID it'll just come back
    // empty either way, so there's no real ordering dependency on
    // create-order's write landing first.
    const [createOrderRes, { data: existing }] = await Promise.all([
      fetch(`${env('SUPABASE_URL')}/functions/v1/create-order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-cron-secret': env('CRON_SECRET') },
        body: JSON.stringify({
          headers: [{
            sales_order_id,
            customer_name:  customerName,
            source:         'website',
            payment_method: method,
            invoice_status: 'pending',
            phone:          normalPhone,
            society:        String(society).trim(),
          }],
        }),
      }),
      // Line items — held if this exact (sales_order_id, item_name, qty)
      // already exists, same dedup rule pushRows/whatsapp-create-order use.
      supabase.from('order_items').select('item_name, requested_quantity').eq('sales_order_id', sales_order_id),
    ]);
    if (!createOrderRes.ok) throw new Error('orders: ' + (await createOrderRes.text()));
    const existingKeys = new Set((existing ?? []).map((o: any) => `${o.item_name}|${o.requested_quantity}`));

    const toInsert = (cart as CartItem[]).map(item => {
      const qty = getQty(item);
      const key = `${item.item_name}|${qty}`;
      const status = existingKeys.has(key) ? 'held' : 'open';
      existingKeys.add(key);
      // "N pieces" flag matches the same convention the WhatsApp parser
      // already uses for piece-count orders (see whatsapp-listener's
      // system prompt) — staff read it the same way either path it came
      // in. "N box" is this app's own equivalent for box mode — there's no
      // WhatsApp-side convention to match since box mode is storefront-only.
      const notesPart = item.notes?.trim() || '';
      const modePrefix = isPieceMode(item) ? `${qty} pieces` : isBoxMode(item) ? `${qty} box` : null;
      const description = modePrefix
        ? [modePrefix, notesPart].filter(Boolean).join(' · ')
        : (notesPart || null);
      return {
        sales_order_id,
        item_name:   item.item_name,
        description,
        // Checkout-level delivery notes, saved verbatim — same column the
        // Delivery tab already shows for WhatsApp orders, just written
        // straight through here instead of staff-edited after the fact.
        delivery_instructions: notes?.trim() || null,
        requested_quantity: qty,
        status,
      };
    });

    const { error: insertErr } = await supabase.from('order_items').insert(toInsert);
    if (insertErr) throw new Error(insertErr.message);

    // Funnel tracking (storefront_events, migration 165) — written here,
    // server-side, rather than relying on the browser to log it after the
    // fact on order-confirmed.html: that page is one more redirect/hop
    // away (and skipped entirely on the online-payment path, which goes
    // to Razorpay first), so logging it only there would under-count real
    // completed orders. Never allowed to affect the actual order response.
    if (device_id) {
      try {
        await supabase.from('storefront_events').insert({
          device_id, event_type: 'order_placed',
          phone: normalPhone, society: String(society).trim(), door_number: String(door_number).trim(),
          sales_order_id,
        });
      } catch (_e) { /* best-effort only */ }
    }

    if (method === 'online') {
      const rzp = await createRazorpayLink(orderTotal, customerName, normalPhone, notes || '', sales_order_id);
      await supabase.from('orders')
        .update({ razorpay_link_id: rzp.id, razorpay_url: rzp.short_url })
        .eq('sales_order_id', sales_order_id);

      return new Response(
        JSON.stringify({ sales_order_id, payment_url: rzp.short_url }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({ sales_order_id }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
