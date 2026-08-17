// Supabase Edge Function — uncancel-order
//
// Manually undoes a cancellation — either an entire order or a single item
// — as a recovery tool for whenever cancel-order (or the item-level
// "remove item"/"not delivered" flows, which auto-cancel the whole order
// once every item's gone — see autoRegenerateInvoiceIfReady in
// parser.html) fired when it shouldn't have.
//
// Restores to the exact prior status (pre_cancel_status/
// pre_cancel_invoice_status — see migration 074), not a blanket reset to
// 'open'/'pending': an item that was 'invoiced' before being cancelled
// comes back 'invoiced', an order that was invoice_status 'done' comes
// back 'done'. Falls back to 'open'/'pending' for a historical cancelled
// row from before that column existed (pre_cancel_status/
// pre_cancel_invoice_status null).
//
// Does NOT touch Zoho/Razorpay — cancel-order's invoice deletion and
// Razorpay link/QR cancellation are real external actions already taken
// and aren't reversible from here. An item/order restored to 'invoiced'
// status has no actual Zoho invoice behind it anymore (zoho_invoice_id
// stays null) until generate-invoice is run again normally.
//
// Input:  { sales_order_id: string, item_id?: string }
//   No item_id → uncancel the whole order (order + every cancelled item on it)
//   item_id    → uncancel just that one item (and the order too, if it was
//                also cancelled — an active item can't sit under one)
// Output: { sales_order_id, item_id?: string, uncancelled: true }
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function env(key: string) {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Missing env: ${key}`);
  return val;
}

// orders'/order_items' RLS locks writes to service-role only, so this goes
// through an edge function like every other mutation. Requiring a real
// logged-in user session is what actually restricts this to signed-in ops
// staff.
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
    const { sales_order_id, item_id } = await req.json();
    if (!sales_order_id) throw new Error('Missing sales_order_id');

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    const { data: order, error: orderErr } = await supabase
      .from('orders').select('status,pre_cancel_invoice_status').eq('sales_order_id', sales_order_id).single();
    if (orderErr || !order) throw new Error(`Order ${sales_order_id} not found`);

    if (item_id) {
      // Single item — restore its own prior status, and reopen the order
      // too only if the whole order was also cancelled (an active item
      // can't sensibly sit under a cancelled order).
      const { data: item, error: itemFetchErr } = await supabase
        .from('order_items').select('pre_cancel_status').eq('id', item_id).eq('sales_order_id', sales_order_id).single();
      if (itemFetchErr || !item) throw new Error(`Item not found on order ${sales_order_id}`);

      const { error: itemErr } = await supabase
        .from('order_items').update({ status: item.pre_cancel_status ?? 'open', pre_cancel_status: null })
        .eq('id', item_id);
      if (itemErr) throw new Error(itemErr.message);

      if (order.status === 'cancelled') {
        const { error: reopenErr } = await supabase.from('orders').update({
          status:                    'active',
          invoice_status:            order.pre_cancel_invoice_status ?? 'pending',
          pre_cancel_invoice_status: null,
        }).eq('sales_order_id', sales_order_id);
        if (reopenErr) throw new Error(reopenErr.message);
      }

      return new Response(
        JSON.stringify({ sales_order_id, item_id, uncancelled: true }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    // Whole order — restore every cancelled item to its own prior status,
    // then the order itself to its prior invoice_status.
    const { data: items, error: itemsFetchErr } = await supabase
      .from('order_items').select('id,pre_cancel_status').eq('sales_order_id', sales_order_id).eq('status', 'cancelled');
    if (itemsFetchErr) throw new Error(itemsFetchErr.message);
    for (const it of items ?? []) {
      const { error: itemErr } = await supabase
        .from('order_items').update({ status: it.pre_cancel_status ?? 'open', pre_cancel_status: null })
        .eq('id', it.id);
      if (itemErr) throw new Error(itemErr.message);
    }

    const { error: orderUpdErr } = await supabase.from('orders').update({
      status:                    'active',
      invoice_status:            order.pre_cancel_invoice_status ?? 'pending',
      pre_cancel_invoice_status: null,
    }).eq('sales_order_id', sales_order_id);
    if (orderUpdErr) throw new Error(orderUpdErr.message);

    return new Response(
      JSON.stringify({ sales_order_id, uncancelled: true }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
