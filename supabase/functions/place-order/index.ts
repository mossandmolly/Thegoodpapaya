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
};

function getQty(item: CartItem): number {
  const q = parseFloat(String(item.quantity));
  return isNaN(q) || q <= 0 ? 1 : q;
}

// Same rule as canonicalCustomerKey() in ops-dashboard/parser.html and
// sales_order_id generation everywhere else in this app — keep in sync.
function canonicalCustomerKey(name: string): string {
  return (name || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function nextSplitSuffix(supabase: ReturnType<typeof createClient>, baseId: string): Promise<number> {
  const { data, error } = await supabase
    .from('order_items').select('sales_order_id').like('sales_order_id', `${baseId}-%`);
  if (error) throw new Error(error.message);
  const re = new RegExp(`^${baseId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`);
  let max = 0;
  for (const row of data ?? []) {
    const m = re.exec(row.sales_order_id as string);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
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
    const { cart, society, door_number, phone, notes, payment_method } = await req.json();

    if (!cart?.length)  throw new Error('No items in cart');
    if (!society)       throw new Error('Missing society name');
    if (!door_number)   throw new Error('Missing door/flat number');
    if (!phone)         throw new Error('Missing phone number');

    const normalPhone = String(phone).replace(/^\+91/, '').replace(/\D/g, '');
    if (!/^\d{10}$/.test(normalPhone)) throw new Error('Invalid phone number — enter a 10-digit number');

    const method       = payment_method === 'online' ? 'online' : 'cod';
    const customerName = `${String(society).trim()} ${String(door_number).trim()}`;
    const today         = new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10); // IST

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    // Same-day repeat orders from the same customer combine onto the same
    // sales_order_id (deterministic date+customer key) — UNLESS that
    // order's already out for delivery, in which case split into a fresh
    // "-N" id instead of silently joining one that's already left. Same
    // rule pushRows/whatsapp-create-order apply.
    const baseId = `${today}-${canonicalCustomerKey(customerName)}`;
    let sales_order_id = baseId;
    const { data: dispatched } = await supabase
      .from('order_customer_lookup').select('delivery_status').eq('sales_order_id', baseId).maybeSingle();
    if (dispatched && (dispatched.delivery_status ?? 'not_dispatched') !== 'not_dispatched') {
      const n = await nextSplitSuffix(supabase, baseId);
      sales_order_id = `${baseId}-${n}`;
    }

    // Catalog price lookup — authoritative price is always what's in
    // `catalog`, never whatever the browser sent (defense against a
    // tampered/stale client price).
    const itemNames = [...new Set((cart as CartItem[]).map(i => i.item_name))];
    const { data: catalogRows } = await supabase
      .from('catalog').select('item_name, unit_price, active').in('item_name', itemNames);
    const priceMap: Record<string, number> = {};
    const activeSet = new Set<string>();
    (catalogRows ?? []).forEach((r: any) => {
      priceMap[r.item_name] = r.unit_price;
      if (r.active) activeSet.add(r.item_name);
    });
    const unavailable = itemNames.filter(n => !activeSet.has(n));
    if (unavailable.length) throw new Error(`No longer available: ${unavailable.join(', ')}`);

    const orderTotal = (cart as CartItem[])
      .reduce((s, i) => s + (priceMap[i.item_name] ?? 0) * getQty(i), 0);

    // Header — via create-order (server-to-server, CRON_SECRET never
    // reaches the browser), same as whatsapp-create-order. Handles the
    // create-or-reopen-if-cancelled logic and communities upsert.
    const createOrderRes = await fetch(`${env('SUPABASE_URL')}/functions/v1/create-order`, {
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
    });
    if (!createOrderRes.ok) throw new Error('orders: ' + (await createOrderRes.text()));

    // Line items — held if this exact (sales_order_id, item_name, qty)
    // already exists, same dedup rule pushRows/whatsapp-create-order use.
    const { data: existing } = await supabase
      .from('order_items').select('item_name, requested_quantity').eq('sales_order_id', sales_order_id);
    const existingKeys = new Set((existing ?? []).map((o: any) => `${o.item_name}|${o.requested_quantity}`));

    const toInsert = (cart as CartItem[]).map(item => {
      const qty = getQty(item);
      const key = `${item.item_name}|${qty}`;
      const status = existingKeys.has(key) ? 'held' : 'open';
      existingKeys.add(key);
      return {
        sales_order_id,
        item_name:   item.item_name,
        description: item.notes?.trim() || null,
        requested_quantity: qty,
        status,
      };
    });

    const { error: insertErr } = await supabase.from('order_items').insert(toInsert);
    if (insertErr) throw new Error(insertErr.message);

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
