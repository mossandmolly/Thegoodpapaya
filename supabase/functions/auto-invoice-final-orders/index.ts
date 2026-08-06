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
// repurposed here for two things per sales_order_id:
//   'processing' row = an in-flight claim, so two overlapping cron runs
//     (e.g. a slow run still going when the next minute fires) can't both
//     pick the same order and create two Zoho invoices back to back. A row
//     stuck 'processing' from a crashed run is treated as stale after 5
//     minutes and reclaimed rather than blocking that order forever.
//   'failed' row = a cooldown. Retrying a failing order every single
//     minute forever (e.g. one that always hits a Zoho error) is exactly
//     the kind of retry storm that can trip/extend Zoho's own OAuth rate
//     limit ("too many requests continuously") — so a failure parks that
//     order for BACKOFF_MS before it's eligible to be picked up again,
//     instead of hammering Zoho every minute.
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
const BACKOFF_MS     = 10 * 60 * 1000;

type ClaimResult = 'claimed' | 'locked' | 'cooldown';

// Claims sales_order_id for this run. Any existing row blocks the claim
// unless it's a 'processing' lock stale for > STALE_LOCK_MS (crashed prior
// run) or a 'failed' cooldown older than BACKOFF_MS (backoff has expired)
// — in either case the stale row is replaced with a fresh 'processing' one.
async function claim(supabase: any, salesOrderId: string): Promise<ClaimResult> {
  const { data: existing } = await supabase
    .from('invoice_queue').select('status,updated_at').eq('sales_order_id', salesOrderId).maybeSingle();

  if (existing) {
    const ageMs = Date.now() - new Date(existing.updated_at as string).getTime();
    if (existing.status === 'processing' && ageMs < STALE_LOCK_MS) return 'locked';
    if (existing.status === 'failed' && ageMs < BACKOFF_MS) return 'cooldown';
    await supabase.from('invoice_queue').delete().eq('sales_order_id', salesOrderId);
  }

  const { error: insErr } = await supabase
    .from('invoice_queue').insert({ sales_order_id: salesOrderId, status: 'processing' });
  return insErr ? 'locked' : 'claimed'; // lost a race to another concurrent run
}

async function markSucceeded(supabase: any, salesOrderId: string): Promise<void> {
  await supabase.from('invoice_queue').delete().eq('sales_order_id', salesOrderId);
}

async function markFailed(supabase: any, salesOrderId: string, message: string): Promise<void> {
  await supabase.from('invoice_queue')
    .update({ status: 'failed', error_message: message.slice(0, 500) })
    .eq('sales_order_id', salesOrderId);
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
      const claimResult = await claim(supabase, salesOrderId);
      if (claimResult !== 'claimed') { skipped.push(salesOrderId); continue; }

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
          // Ambiguous item name — needs a human to pick a rate override via
          // the manual flow; parking it in cooldown too so this doesn't
          // burn a Zoho items-list fetch every minute for no reason.
          await markFailed(supabase, salesOrderId, 'needs_resolution: ' + JSON.stringify(data.unresolved));
          skipped.push(salesOrderId);
        } else {
          await markSucceeded(supabase, salesOrderId);
          invoiced.push(salesOrderId);
        }
      } catch (e: any) {
        await markFailed(supabase, salesOrderId, e.message);
        errors.push({ sales_order_id: salesOrderId, error: e.message });
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
