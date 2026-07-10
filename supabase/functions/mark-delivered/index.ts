// Supabase Edge Function — mark-delivered
//
// Toggles an order's delivery status, with an optional remark and photo
// path captured at the same time. orders' RLS locks writes to
// service-role only, so this is the write path for the Delivery tab —
// same pattern as every other orders mutation in this app.
//
// The photo itself is uploaded directly from the frontend to the
// "delivery-photos" Storage bucket using the caller's own authenticated
// session (that bucket's policies allow any signed-in session to do so);
// this function only records the resulting path against the order.
//
// Input:  { sales_order_id: string, delivered: boolean, notes?: string, photo_path?: string,
//           payment_collected?: boolean, payment_collected_method?: 'cash'|'online'|null }
// Output: { sales_order_id, delivery_status, delivered_at }
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function env(key: string) {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Missing env: ${key}`);
  return val;
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
    const { sales_order_id, delivered, notes, photo_path, payment_collected, payment_collected_method } = await req.json();
    if (!sales_order_id) throw new Error('Missing sales_order_id');
    if (typeof delivered !== 'boolean') throw new Error('Missing delivered (boolean)');

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    // payment_collected/_method/_at travel with delivered_at, not with
    // notes/photo — un-marking a delivery means the payment the rider
    // claimed to have collected at that (now-undone) delivery is undone
    // too, whereas a remark/photo already attached stays as history.
    const update: Record<string, unknown> = {
      delivery_status:           delivered ? 'delivered' : 'pending',
      delivered_at:              delivered ? new Date().toISOString() : null,
      payment_collected:         delivered ? !!payment_collected : false,
      payment_collected_method:  delivered && payment_collected ? (payment_collected_method || null) : null,
      payment_collected_at:      delivered && payment_collected ? new Date().toISOString() : null,
    };
    // Only touch notes/photo when actually provided, so un-marking a
    // delivery (delivered: false) doesn't wipe out a remark/photo that was
    // already attached — those stay as history until explicitly replaced.
    if (notes !== undefined)      update.delivery_notes = notes || null;
    if (photo_path !== undefined) update.delivery_photo_path = photo_path || null;

    const { data, error } = await supabase
      .from('orders')
      .update(update)
      .eq('sales_order_id', sales_order_id)
      .select('sales_order_id, delivery_status, delivered_at, payment_collected, payment_collected_method')
      .single();
    if (error) throw new Error(error.message);
    if (!data) throw new Error(`Order ${sales_order_id} not found`);

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
