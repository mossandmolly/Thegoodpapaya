// Supabase Edge Function — queue-invoices
//
// Input:  { sales_order_ids: string[] }
// Output: { queued: number }
//
// Inserts into invoice_queue and marks orders.invoice_status = 'queued'.
// Returns immediately — actual generation is done by process-invoice-queue.
// Idempotent: re-queueing a failed order resets it to 'queued'.
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const { sales_order_ids } = await req.json();
    if (!Array.isArray(sales_order_ids) || !sales_order_ids.length) {
      throw new Error('sales_order_ids must be a non-empty array');
    }

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    // Upsert into invoice_queue (idempotent — reset failed orders to queued)
    const queueRows = sales_order_ids.map(id => ({
      sales_order_id: id,
      status:         'queued',
      error_message:  null,
    }));
    const { error: qErr } = await supabase
      .from('invoice_queue')
      .upsert(queueRows, { onConflict: 'sales_order_id' });
    if (qErr) throw new Error(`Queue insert failed: ${qErr.message}`);

    // Mark orders as queued (only update pending/failed — don't interrupt processing ones)
    await supabase
      .from('orders')
      .update({ invoice_status: 'queued' })
      .in('sales_order_id', sales_order_ids)
      .in('invoice_status', ['pending', 'failed']);

    return new Response(
      JSON.stringify({ queued: sales_order_ids.length }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
