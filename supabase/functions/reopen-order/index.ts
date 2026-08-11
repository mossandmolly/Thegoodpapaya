// Supabase Edge Function — reopen-order
//
// Adding a new item to a cancelled order reopens it: the order itself goes
// back to 'active' so it behaves normally again (shows up for packing,
// invoicing, etc.), while the items that were cancelled before stay
// 'cancelled' as a historical record — only the order-level flag moves,
// nothing about existing order_items rows changes here.
//
// invoice_status also resets to 'pending' — cancel-order sets it to
// 'cancelled' alongside status, so reopening needs to undo that too or the
// order would sit there reading as invoice_status 'cancelled' while active.
//
// Input:  { sales_order_id: string }
// Output: { sales_order_id, reopened: true }
//
// Required env vars (auto-provided by the Supabase Edge Function runtime):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function env(key: string) {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Missing env: ${key}`);
  return val;
}

// orders' RLS locks writes to service-role only, so this goes through an
// edge function like every other orders mutation. Requiring a real
// logged-in user session is what actually restricts this to signed-in ops
// staff, since the anon key alone is otherwise enough to invoke any
// service-role-backed function.
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
    const { sales_order_id } = await req.json();
    if (!sales_order_id) throw new Error('Missing sales_order_id');

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));
    const { error } = await supabase
      .from('orders').update({ status: 'active', invoice_status: 'pending' }).eq('sales_order_id', sales_order_id);
    if (error) throw new Error(error.message);

    return new Response(
      JSON.stringify({ sales_order_id, reopened: true }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
