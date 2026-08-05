// Supabase Edge Function — rename-order-customer
//
// Renames the customer on an existing order from Order Overview. Because
// sales_order_id is "YYYY-MM-DD-CustomerName" (see migration 020) — derived
// from the customer name, not an independent id — renaming the customer
// means renaming the primary key too, and cascading that rename to every
// other table that duplicates sales_order_id (order_items, invoice_queue,
// ...). orders' RLS locks writes to service-role only (same as every other
// orders mutation in this app), and the actual rename+cascade needs to run
// as one transaction (see migration 047's comment for why), so it's a
// plpgsql function called via RPC rather than a plain REST update.
//
// Input:  { sales_order_id: string, new_customer_name: string }
// Output: { old_sales_order_id, new_sales_order_id, customer_name }
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

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

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Mirrors canonicalCustomerKey/formatCustomerName in ops-dashboard/parser.html
// exactly — keep both in sync if the rule ever changes (same convention
// already used for community-name canonicalization in create-order/index.ts).
function canonicalCustomerKey(name: string): string {
  return (name || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}
function formatCustomerName(name: string): string {
  const trimmed = (name || '').trim().replace(/\s+/g, ' ');
  return trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : trimmed;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    await requireAuth(req);
    const { sales_order_id, new_customer_name } = await req.json();
    if (!sales_order_id) throw new Error('Missing sales_order_id');
    const formatted = formatCustomerName(new_customer_name);
    if (!formatted) throw new Error('New customer name is required');

    const key = canonicalCustomerKey(formatted);
    if (!key) throw new Error('New customer name must contain at least one letter or digit');

    // Date prefix carries over unchanged — this is a rename, not a move to
    // a different day (that's moveToTomorrowPrompt's job).
    const datePrefix = sales_order_id.slice(0, 10);
    const newSalesOrderId = `${datePrefix}-${key}`;

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    const { error } = await supabase.rpc('rename_order_customer', {
      p_old_sales_order_id: sales_order_id,
      p_new_customer_name:  formatted,
      p_new_sales_order_id: newSalesOrderId,
    });
    if (error) throw new Error(error.message);

    return new Response(
      JSON.stringify({
        old_sales_order_id: sales_order_id,
        new_sales_order_id: newSalesOrderId,
        customer_name:       formatted,
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
