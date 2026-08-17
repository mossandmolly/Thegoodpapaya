// Supabase Edge Function — whatsapp-create-order
//
// Machine-to-machine endpoint the WhatsApp listener calls directly (with
// CRON_SECRET — no user session to send, same shared-secret pattern
// auto-invoice-final-orders already uses) to push parsed WhatsApp rows
// straight into real orders/order_items, tagged pending_review so ops can
// verify the AI got them right before they're treated as normal orders.
// This is additional to, not a replacement for, whatsapp_parsed_orders /
// the Live tab — that flow is untouched, both run in parallel.
//
// Mirrors ops-dashboard/parser.html's pushRows(): same dispatch-check +
// split-suffix redirect (an order already OFD/delivered gets a fresh "-N"
// sales_order_id instead of silently joining one that's already left),
// same header create-or-merge (delegated to create-order, called here with
// CRON_SECRET), same item-level held-duplicate detection. Diverges only in
// marking every inserted item pending_review=true and writing
// whatsapp_raw_text/whatsapp_group_name onto the header (migration 077).
//
// Input:  { rows: [{ sales_order_id, customer_name, phone?, item_name?, description?, delivery_instructions?, deliver_by?, deliver_after?, quantity, is_pickup? }], raw_text?, group_name? }
// Output: { opened, held, splitCount, sales_order_ids: string[] }
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function env(key: string) {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Missing env: ${key}`);
  return val;
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-cron-secret',
};

async function requireCronSecret(req: Request): Promise<void> {
  const secret = req.headers.get('x-cron-secret') || '';
  if (secret !== env('CRON_SECRET')) throw new Error('Not authorized');
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

type Row = {
  sales_order_id: string; customer_name: string; phone?: string | null;
  item_name?: string | null; description?: string | null; delivery_instructions?: string | null;
  deliver_by?: string | null; deliver_after?: string | null; quantity: number; is_pickup?: boolean;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    await requireCronSecret(req);
    const { rows, raw_text, group_name } = await req.json();
    if (!rows?.length) throw new Error('No rows provided');

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    // 0. Dispatch-check + split-suffix redirect — same rule pushRows applies
    // client-side, so an order that's already OFD/delivered gets a fresh
    // "-N" id instead of silently joining one that's already left.
    const rawSoids = [...new Set((rows as Row[]).map(r => r.sales_order_id))];
    const remap = new Map<string, string>();
    if (rawSoids.length) {
      const { data: dispatched } = await supabase
        .from('order_customer_lookup').select('sales_order_id,delivery_status').in('sales_order_id', rawSoids);
      const dispatchedIds = new Set(
        (dispatched ?? [])
          .filter((o: any) => (o.delivery_status ?? 'not_dispatched') !== 'not_dispatched')
          .map((o: any) => o.sales_order_id as string),
      );
      for (const soid of dispatchedIds) {
        const n = await nextSplitSuffix(supabase, soid);
        remap.set(soid, `${soid}-${n}`);
      }
    }
    const soidFor = (r: Row) => remap.get(r.sales_order_id) ?? r.sales_order_id;
    const splitCount = remap.size;

    // 1. Header row per unique customer — create-order handles the actual
    // create-or-merge (including reopening a cancelled order), called here
    // with CRON_SECRET since there's no user session to send.
    const headers = new Map<string, any>();
    for (const r of rows as Row[]) {
      const soid = soidFor(r);
      if (!headers.has(soid)) {
        headers.set(soid, {
          sales_order_id: soid,
          customer_name:  r.customer_name,
          source:         'whatsapp',
          payment_method: 'cod',
          invoice_status: 'pending',
          deliver_by:     r.deliver_by ?? null,
          deliver_after:  r.deliver_after ?? null,
          is_pickup:      !!r.is_pickup,
          phone:               r.phone ?? null,
          whatsapp_raw_text:   raw_text ?? null,
          whatsapp_group_name: group_name ?? null,
        });
      } else {
        const h = headers.get(soid);
        if (r.deliver_by && !h.deliver_by) h.deliver_by = r.deliver_by;
        if (r.deliver_after && !h.deliver_after) h.deliver_after = r.deliver_after;
        if (r.phone && !h.phone) h.phone = r.phone;
        if (r.is_pickup) h.is_pickup = true;
      }
    }

    const createOrderRes = await fetch(`${env('SUPABASE_URL')}/functions/v1/create-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cron-secret': env('CRON_SECRET') },
      body: JSON.stringify({ headers: [...headers.values()] }),
    });
    if (!createOrderRes.ok) throw new Error('orders: ' + (await createOrderRes.text()));

    // 2. Line items — held if (sales_order_id, item_name, requested_quantity)
    // already exists, same dedup rule pushRows uses. Every newly-inserted
    // item starts pending_review=true — approving it (Order Overview) just
    // clears the flag, same as the frontend's own item-status flow.
    const soids = [...new Set((rows as Row[]).map(soidFor))];
    const { data: existing } = await supabase
      .from('order_items').select('sales_order_id,item_name,requested_quantity').in('sales_order_id', soids);
    const existingKeys = new Set((existing ?? []).map((o: any) => `${o.sales_order_id}|${o.item_name}|${o.requested_quantity}`));

    let opened = 0, held = 0;
    const toInsert = (rows as Row[]).map(r => {
      const soid = soidFor(r);
      const qty = Number(r.quantity) || 0;
      const itemName = r.item_name || 'Pickup';
      const key = `${soid}|${itemName}|${qty}`;
      const status = existingKeys.has(key) ? 'held' : 'open';
      existingKeys.add(key);
      status === 'held' ? held++ : opened++;
      return {
        sales_order_id: soid,
        item_name: itemName,
        description: r.description ?? null,
        delivery_instructions: r.delivery_instructions ?? null,
        requested_quantity: qty,
        status,
        pending_review: true,
      };
    });

    const { error: insertErr } = await supabase.from('order_items').insert(toInsert);
    if (insertErr) throw new Error(insertErr.message);

    return new Response(
      JSON.stringify({ opened, held, splitCount, sales_order_ids: [...new Set(toInsert.map(i => i.sales_order_id))] }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
