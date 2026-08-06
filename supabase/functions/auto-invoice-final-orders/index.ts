// Supabase Edge Function — auto-invoice-final-orders
//
// Meant to be triggered every minute by pg_cron (see migration
// 055_auto_invoice_cron.sql) — no logged-in-user session, just the shared
// x-cron-secret, same pattern as export-csv/purge-delivery-photos.
//
// Finds every order where all of its non-cancelled items are 'final' or
// 'invoiced' (i.e. fully packed and ready to bill — the same rule the
// frontend's isReadyToInvoice() uses), with at least one still 'final' (so
// an already-fully-invoiced order is never re-picked), skips pickup orders
// (nothing to invoice — see migration 045) and cancelled orders, then calls
// generate-invoice for each one exactly as the manual "Generate Invoice"
// button would.
//
// invoice_queue (migration 020) — otherwise unused, see its own header
// comment for the abandoned async-batch design it was built for — is
// repurposed here as a claim/lock per sales_order_id: a run only calls
// generate-invoice for an order after successfully inserting a 'processing'
// row, and always deletes it afterwards (success or failure). That closes
// the one real race this design has: two overlapping cron runs (e.g. a
// slow run still going when the next minute fires) both picking the same
// order and creating two Zoho invoices back to back. A row stuck from a
// crashed run (never reached the cleanup) is treated as stale after 5
// minutes and reclaimed rather than blocking that order forever.
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

const STALE_LOCK_MS = 5 * 60 * 1000;

// Claims sales_order_id for this run by inserting a 'processing' row.
// Returns false (do not process) if another run already holds a fresh
// claim; reclaims and returns true if the existing claim is stale.
async function claim(supabase: any, salesOrderId: string): Promise<boolean> {
  const { error: insErr } = await supabase
    .from('invoice_queue')
    .insert({ sales_order_id: salesOrderId, status: 'processing' });
  if (!insErr) return true;

  const { data: existing } = await supabase
    .from('invoice_queue').select('created_at').eq('sales_order_id', salesOrderId).maybeSingle();
  if (!existing || Date.now() - new Date(existing.created_at as string).getTime() < STALE_LOCK_MS) {
    return false; // held by a live (or recent-enough-to-assume-live) run
  }
  await supabase.from('invoice_queue').delete().eq('sales_order_id', salesOrderId);
  const { error: retryErr } = await supabase
    .from('invoice_queue')
    .insert({ sales_order_id: salesOrderId, status: 'processing' });
  return !retryErr;
}

async function release(supabase: any, salesOrderId: string): Promise<void> {
  await supabase.from('invoice_queue').delete().eq('sales_order_id', salesOrderId);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const secret = req.headers.get('x-cron-secret') || '';
    if (secret !== env('CRON_SECRET')) throw new Error('Not authorized');

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    const { data: finalRows, error: finalErr } = await supabase
      .from('order_items').select('sales_order_id').eq('status', 'final');
    if (finalErr) throw new Error(finalErr.message);

    const candidateIds = [...new Set((finalRows ?? []).map(r => r.sales_order_id as string))];
    if (!candidateIds.length) {
      return new Response(JSON.stringify({ checked: 0, invoiced: [], skipped: [], errors: [] }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    const [{ data: activeItems, error: itemsErr }, { data: orders, error: ordersErr }] = await Promise.all([
      supabase.from('order_items').select('sales_order_id,status')
        .in('sales_order_id', candidateIds).neq('status', 'cancelled'),
      supabase.from('orders').select('sales_order_id,status,is_pickup')
        .in('sales_order_id', candidateIds),
    ]);
    if (itemsErr) throw new Error(itemsErr.message);
    if (ordersErr) throw new Error(ordersErr.message);

    const ordersById = new Map((orders ?? []).map(o => [o.sales_order_id as string, o]));
    const statusesById = new Map<string, string[]>();
    for (const row of activeItems ?? []) {
      const list = statusesById.get(row.sales_order_id as string) ?? [];
      list.push(row.status as string);
      statusesById.set(row.sales_order_id as string, list);
    }

    const eligible = candidateIds.filter(id => {
      const order = ordersById.get(id);
      if (!order || order.status === 'cancelled' || order.is_pickup) return false;
      const statuses = statusesById.get(id) ?? [];
      return statuses.length > 0 && statuses.every(s => s === 'final' || s === 'invoiced');
    });

    const invoiced: string[] = [];
    const skipped: string[] = [];
    const errors: Array<{ sales_order_id: string; error: string }> = [];

    for (const salesOrderId of eligible) {
      const claimed = await claim(supabase, salesOrderId);
      if (!claimed) { skipped.push(salesOrderId); continue; }

      try {
        const res = await fetch(`${env('SUPABASE_URL')}/functions/v1/generate-invoice`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${env('SUPABASE_SERVICE_ROLE_KEY')}`,
            'x-cron-secret': env('CRON_SECRET'),
          },
          body: JSON.stringify({ sales_order_id: salesOrderId }),
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
        if (data.needs_resolution) {
          skipped.push(salesOrderId); // ambiguous item name — needs a human to pick a rate override
        } else {
          invoiced.push(salesOrderId);
        }
      } catch (e: any) {
        errors.push({ sales_order_id: salesOrderId, error: e.message });
      } finally {
        await release(supabase, salesOrderId);
      }
    }

    return new Response(
      JSON.stringify({ checked: eligible.length, invoiced, skipped, errors }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
