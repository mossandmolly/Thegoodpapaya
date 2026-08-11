// Supabase Edge Function — purge-delivery-photos
//
// Deletes individual delivery photos older than RETENTION_DAYS from the
// private delivery-photos Storage bucket, based on each photo's OWN
// upload age — independent of the order's delivery_status/delivered_at.
// A photo attached to an order that's still "not dispatched" is purged
// on the same clock as one on a delivered order; delivery status is
// irrelevant here. Orders/order_items data itself (and the hourly CSV
// exports) are kept indefinitely — only these photos have a retention
// window, since they're by far the heaviest thing this app puts in
// Storage.
//
// Photo age comes from the path itself rather than a Storage metadata
// lookup: the ops-dashboard always uploads to
// `${sales_order_id}/${Date.now()}-${i}.jpg` (see parser.html), so the
// leading number in the filename IS the upload timestamp in ms. Paths
// that don't match this shape are left alone rather than guessed at.
//
// After removing an order's stale paths from Storage, orders.
// delivery_photo_paths is updated to keep only the paths that are still
// within the retention window (not cleared wholesale) — a photo added
// yesterday must survive even if an older photo on the same order gets
// purged today.
//
// Triggered on a daily schedule via pg_cron/pg_net (see migration
// 030_daily_delivery_photo_purge.sql) — same shared-secret auth pattern as
// export-csv, since pg_cron has no user session to send.
//
// Optional JSON body (cron always sends '{}', so these default to the
// normal live-purge behaviour):
//   dry_run:        true  -> report what would be removed, but don't
//                             touch Storage or orders at all.
//   retention_days: N     -> override RETENTION_DAYS for this call only
//                             (e.g. 0 to see every photo regardless of
//                             age) — for testing; the schedule itself
//                             always calls with defaults, so this never
//                             affects the real daily purge.
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

// Path shape: "<sales_order_id>/<millis>-<index>.jpg" — pull the millis
// back out of the filename. Returns null for anything that doesn't match
// (leave it alone rather than risk deleting something unexpectedly).
function uploadedAtMs(path: string): number | null {
  const filename = path.split('/').pop() ?? '';
  const millis = parseInt(filename.split('-')[0], 10);
  return Number.isFinite(millis) ? millis : null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const secret = req.headers.get('x-cron-secret') || '';
    if (secret !== env('CRON_SECRET')) throw new Error('Not authorized');

    const body = await req.json().catch(() => ({}));
    const dryRun = body?.dry_run === true;
    const retentionDays = typeof body?.retention_days === 'number' ? body.retention_days : RETENTION_DAYS;
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    // No delivered_at / delivery_status filter — every order with photos
    // is a candidate, regardless of where it is in the delivery lifecycle.
    const { data: rows, error } = await supabase
      .from('orders')
      .select('sales_order_id, delivery_photo_paths')
      .not('delivery_photo_paths', 'is', null);
    if (error) throw new Error(error.message);

    let removedFiles = 0;
    let updatedOrders = 0;
    const allStalePaths: string[] = [];
    const candidates: Array<{ sales_order_id: string; stale_paths: string[]; kept_paths: string[] }> = [];

    for (const row of rows ?? []) {
      const paths = (row as any).delivery_photo_paths as string[] | null;
      if (!paths || !paths.length) continue;

      const stale: string[] = [];
      const kept: string[] = [];
      for (const p of paths) {
        const ms = uploadedAtMs(p);
        if (ms !== null && ms < cutoffMs) stale.push(p);
        else kept.push(p);
      }
      if (!stale.length) continue;

      if (dryRun) {
        candidates.push({ sales_order_id: (row as any).sales_order_id, stale_paths: stale, kept_paths: kept });
        continue;
      }

      allStalePaths.push(...stale);
      const { error: updErr } = await supabase
        .from('orders')
        .update({ delivery_photo_paths: kept })
        .eq('sales_order_id', (row as any).sales_order_id);
      if (!updErr) updatedOrders++;
    }

    if (dryRun) {
      return new Response(
        JSON.stringify({
          ok: true, dry_run: true, retention_days: retentionDays,
          scanned: rows?.length ?? 0,
          would_purge_orders: candidates.length,
          would_remove_files: candidates.reduce((sum, c) => sum + c.stale_paths.length, 0),
          candidates,
        }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }

    if (allStalePaths.length) {
      const { error: rmErr } = await supabase.storage.from('delivery-photos').remove(allStalePaths);
      // Best-effort — a photo that's already gone (or errors out) isn't
      // worth retrying forever; orders.delivery_photo_paths has already
      // been trimmed above regardless, so it won't be rescanned tomorrow.
      if (!rmErr) removedFiles = allStalePaths.length;
    }

    return new Response(
      JSON.stringify({ ok: true, scanned: rows?.length ?? 0, updatedOrders, removedFiles }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
