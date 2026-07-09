// Supabase Edge Function — export-csv
//
// Exports the full orders and order_items tables as CSV files into a
// private Storage bucket ("exports"), timestamped per run. Meant to be
// triggered on a schedule (see migration 026_hourly_csv_export.sql, which
// sets up a pg_cron job calling this every hour via pg_net) rather than
// from the frontend — there's no logged-in-user auth check here, just a
// shared secret, since pg_cron has no session token to send.
//
// Output: uploads two files per run —
//   orders/orders-<ISO-timestamp>.csv
//   orders/order_items-<ISO-timestamp>.csv
// then purges any export files older than 30 days, so storage usage
// doesn't grow unbounded from an hourly job running forever.
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
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-cron-secret',
};

// PostgREST caps rows per request — page through so a growing orders table
// never gets silently truncated in the export.
const PAGE_SIZE = 1000;
async function fetchAll(supabase: any, table: string, orderCol: string): Promise<any[]> {
  const rows: any[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .order(orderCol)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}

// Deletes export files whose Storage-reported created_at is older than 30
// days. Lists in one pass (paginated) before deleting anything, rather than
// deleting mid-list, so shifting offsets from removed items can't cause a
// file to be skipped.
const RETENTION_DAYS = 30;
async function purgeOldExports(supabase: any): Promise<number> {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const stalePaths: string[] = [];
  const PAGE = 1000;
  let offset = 0;
  while (true) {
    const { data, error } = await supabase.storage.from('exports').list('orders', {
      limit: PAGE,
      offset,
      sortBy: { column: 'created_at', order: 'asc' },
    });
    if (error) throw new Error(`List exports failed: ${error.message}`);
    if (!data || !data.length) break;
    for (const f of data) {
      if (f.created_at && new Date(f.created_at).getTime() < cutoff) stalePaths.push(`orders/${f.name}`);
    }
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  if (!stalePaths.length) return 0;

  // Storage's remove() also has a practical batch-size ceiling — chunk defensively.
  const CHUNK = 100;
  let removed = 0;
  for (let i = 0; i < stalePaths.length; i += CHUNK) {
    const chunk = stalePaths.slice(i, i + CHUNK);
    const { error } = await supabase.storage.from('exports').remove(chunk);
    if (error) throw new Error(`Remove exports failed: ${error.message}`);
    removed += chunk.length;
  }
  return removed;
}

function toCsv(rows: any[]): string {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape = (val: unknown): string => {
    if (val === null || val === undefined) return '';
    const s = typeof val === 'object' ? JSON.stringify(val) : String(val);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map(h => escape((row as any)[h])).join(','));
  return lines.join('\n');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const secret = req.headers.get('x-cron-secret') || '';
    if (secret !== env('CRON_SECRET')) throw new Error('Not authorized');

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    const [orders, orderItems] = await Promise.all([
      fetchAll(supabase, 'orders', 'sales_order_id'),
      fetchAll(supabase, 'order_items', 'id'),
    ]);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const ordersCsv = toCsv(orders);
    const itemsCsv  = toCsv(orderItems);

    const uploads = await Promise.all([
      supabase.storage.from('exports')
        .upload(`orders/orders-${stamp}.csv`, new Blob([ordersCsv], { type: 'text/csv' }), { upsert: true }),
      supabase.storage.from('exports')
        .upload(`orders/order_items-${stamp}.csv`, new Blob([itemsCsv], { type: 'text/csv' }), { upsert: true }),
    ]);
    const uploadErrors = uploads.filter(u => u.error).map(u => u.error?.message);
    if (uploadErrors.length) throw new Error('Storage upload failed: ' + uploadErrors.join('; '));

    // Best-effort — a purge failure shouldn't mark this run's actual export as failed.
    let purged = 0;
    try {
      purged = await purgeOldExports(supabase);
    } catch (_e) {
      // swallow — next hour's run will catch up on the purge
    }

    return new Response(
      JSON.stringify({ ok: true, stamp, orders: orders.length, order_items: orderItems.length, purged }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
