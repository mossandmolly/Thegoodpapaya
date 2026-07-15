// Supabase Edge Function — purge-delivery-photos
//
// Deletes delivery photos older than 7 days from the private
// delivery-photos Storage bucket, then clears orders.delivery_photo_paths
// for those orders so tomorrow's run doesn't keep rescanning them forever.
// Orders/order_items data itself (and the hourly CSV exports) are kept
// indefinitely — only these photos have a retention window, since they're
// by far the heaviest thing this app puts in Storage.
//
// Triggered on a daily schedule via pg_cron/pg_net (see migration
// 030_daily_delivery_photo_purge.sql) — same shared-secret auth pattern as
// export-csv, since pg_cron has no user session to send.
//
// Optional JSON body (cron always sends '{}', so these default to the
// normal live-purge behaviour):
//   dry_run:        true  -> report what would be removed/cleared, but
//                             don't touch Storage or orders at all.
//   retention_days: N     -> override RETENTION_DAYS for this call only
//                             (e.g. 0 to see every delivered order with
//                             photos, regardless of age) — for testing;
//                             the schedule itself always calls with
//                             defaults, so this never affects the real
//                             daily purge.
//
// Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function env(key: string) {
  const val = Deno.env.get(key);
  if (!val) throw new Error(`Missing env: ${key}`);
  return val;
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-cron-secret',
};

const RETENTION_DAYS = 7;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const secret = req.headers.get('x-cron-secret') || '';
    if (secret !== env('CRON_SECRET')) throw new Error('Not authorized');

    const body = await req.json().catch(() => ({}));
    const dryRun = body?.dry_run === true;
    const retentionDays = typeof body?.retention_days === 'number' ? body.retention_days : RETENTION_DAYS;

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

    // delivered_at is indexed (migration 030) so this stays cheap even as
    // the table grows — only orders delivered more than retentionDays days
    // ago are candidates, and clearing delivery_photo_paths after
    // processing means an order only ever gets picked up here once.
    const { data: rows, error } = await supabase
      .from('orders')
      .select('sales_order_id, delivered_at, delivery_photo_paths')
      .lt('delivered_at', cutoff);
    if (error) throw new Error(error.message);

    let removedFiles = 0;
    let clearedOrders = 0;
    const candidates: Array<{ sales_order_id: string; delivered_at: string; photo_count: number }> = [];

    for (const row of rows ?? []) {
      const paths = (row as any).delivery_photo_paths as string[] | null;
      if (!paths || !paths.length) continue;

      if (dryRun) {
        candidates.push({
          sales_order_id: (row as any).sales_order_id,
          delivered_at:   (row as any).delivered_at,
          photo_count:    paths.length,
        });
        continue;
      }

      const { error: rmErr } = await supabase.storage.from('delivery-photos').remove(paths);
      if (!rmErr) removedFiles += paths.length;
      // Clear regardless of whether remove() fully succeeded — a photo
      // that's already gone (or errors out) isn't worth retrying forever;
      // best-effort matches this app's existing purge philosophy.
      const { error: updErr } = await supabase
        .from('orders')
        .update({ delivery_photo_paths: [] })
        .eq('sales_order_id', (row as any).sales_order_id);
      if (!updErr) clearedOrders++;
    }

    if (dryRun) {
      return new Response(
        JSON.stringify({
          ok: true, dry_run: true, retention_days: retentionDays, cutoff,
          scanned: rows?.length ?? 0,
          would_purge_orders: candidates.length,
          would_remove_files: candidates.reduce((sum, c) => sum + c.photo_count, 0),
          candidates,
        }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({ ok: true, scanned: rows?.length ?? 0, clearedOrders, removedFiles }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
