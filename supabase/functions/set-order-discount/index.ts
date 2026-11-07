// Supabase Edge Function — set-order-discount
//
// Sets or clears a per-order discount from Order Overview — migration 140
// (orders.discount_type/discount_value). Only saves the columns; does NOT
// regenerate the Zoho invoice itself. If the order is already invoiced
// (orders.zoho_invoice_id set), the frontend is responsible for calling
// generate-invoice again right after this succeeds — that's the existing,
// already-tested regeneration path (see generate-invoice's own comment: any
// repeat call on an order with a zoho_invoice_id already unapplies/deletes/
// recreates), not something this function needs to duplicate or trigger
// itself.
//
// Input:  { sales_order_id: string, discount_type: 'flat'|'percent'|null, discount_value: number|null }
//         Pass both null to clear an existing discount.
// Output: { sales_order_id, discount_type, discount_value }
//
// Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function env(key: string) {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Missing env: ${key}`);
  return val;
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Same pattern every other orders-mutating function in this app uses —
// service role bypasses RLS, so this check is what actually restricts the
// function to signed-in ops staff.
async function requireAuth(req: Request): Promise<void> {
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) throw new Error('Not authenticated');
  const res = await fetch(`${env('SUPABASE_URL')}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${jwt}`, apikey: env('SUPABASE_SERVICE_ROLE_KEY') },
  });
  if (!res.ok) throw new Error('Not authenticated');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    await requireAuth(req);
    const { sales_order_id, discount_type, discount_value } = await req.json();
    if (!sales_order_id) throw new Error('Missing sales_order_id');

    const clearing = discount_type == null && discount_value == null;
    if (!clearing) {
      if (discount_type !== 'flat' && discount_type !== 'percent') {
        throw new Error("discount_type must be 'flat' or 'percent'");
      }
      const value = Number(discount_value);
      if (!Number.isFinite(value) || value < 0) throw new Error('discount_value must be a non-negative number');
      // A typo'd 4-digit percentage (e.g. "1000" instead of "10") would
      // silently zero out — or go negative past — an invoice total; a flat
      // rupee amount has no such natural ceiling to sanity-check against.
      if (discount_type === 'percent' && value > 100) throw new Error('Percentage discount cannot exceed 100');
    }

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    const { error } = await supabase.from('orders').update({
      discount_type:  clearing ? null : discount_type,
      discount_value: clearing ? null : Number(discount_value),
    }).eq('sales_order_id', sales_order_id);
    if (error) throw new Error(error.message);

    return new Response(
      JSON.stringify({
        sales_order_id,
        discount_type: clearing ? null : discount_type,
        discount_value: clearing ? null : Number(discount_value),
      }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
