// Supabase Edge Function — snapshot-catalog-prices
//
// Copies catalog.unit_price for every active item into
// catalog_price_snapshots, dated by today's IST date. Runs once daily at
// 12 noon IST via pg_cron (migration 154) — the Purchases tab's "Sales
// Rate" column reads this table instead of catalog directly, so it shows
// the price as it stood that day even after catalog later changes.
//
// POST {} — no input. Upserts on (date, item_name), so re-running the same
// day (a manual retry, or the cron firing twice) just overwrites that
// day's row rather than erroring or duplicating.
//
// Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function env(key: string) {
  const v = Deno.env.get(key);
  if (!v) throw new Error(`Missing env: ${key}`);
  return v;
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-cron-secret',
};

// Same x-cron-secret-or-user-session pattern sync-catalog/auto-invoice-
// final-orders already use for their own pg_cron triggers.
async function requireAuth(req: Request): Promise<void> {
  const cronSecret = req.headers.get('x-cron-secret');
  if (cronSecret) {
    if (cronSecret !== env('CRON_SECRET')) throw new Error('Not authorized');
    return;
  }
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
    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

    const istDate = new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);

    const { data: items, error: catalogErr } = await supabase
      .from('catalog').select('item_name,unit_price').eq('active', true);
    if (catalogErr) throw new Error(catalogErr.message);

    const rows = (items ?? []).map(i => ({
      date: istDate,
      item_name: i.item_name,
      unit_price: i.unit_price ?? 0,
    }));

    if (rows.length) {
      const { error: upsertErr } = await supabase
        .from('catalog_price_snapshots').upsert(rows, { onConflict: 'date,item_name' });
      if (upsertErr) throw new Error(upsertErr.message);
    }

    return new Response(
      JSON.stringify({ date: istDate, snapshotted: rows.length }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});
