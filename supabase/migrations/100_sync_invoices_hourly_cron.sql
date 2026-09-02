-- Re-enables the sync-invoices cron job, at 1 hour instead of the previous
-- ~3-5 min cadence — that frequency was hammering Zoho's API rate limit
-- (see the earlier sync-invoices rate-limit incident this session). It was
-- previously scheduled ad hoc from the SQL editor (per the commented
-- example at the bottom of supabase/functions/sync-invoices/index.ts),
-- never as a tracked migration — this makes it a real, versioned, visible
-- job instead.
--
-- WHAT RUNS EACH HOUR (mode=sync, the default):
--   1. One Zoho call: list today's invoices (paginated, 200/page — a
--      normal day is 1 page).
--   2. One Zoho "detail" call PER invoice that actually changed since the
--      last sync (unchanged invoices are skipped — see commit 2c2619f).
--   3. One more Zoho list call to check for today's deletions.
--   4. Razorpay QR/link sweep for stale codes (not a Zoho call).
--   So: ~2 Zoho calls + 1 per changed invoice, once per hour. On a quiet
--   hour with 0 changed invoices that's 2 calls; a busy hour with 20
--   changed invoices is ~22 calls — nowhere near Zoho's per-minute cap
--   even during a burst of orders.
--
-- NOT scheduled here: mode=reconcile (the D-1..D-7 daily catch-up, a
-- heavier call). Add it separately, once a day, if/when needed:
--   select cron.schedule('sync-invoices-reconcile-daily', '0 6 * * *', $$
--     select net.http_post(
--       url := 'https://fykqprogzqcfzrgwlrem.supabase.co/functions/v1/sync-invoices?mode=reconcile',
--       headers := jsonb_build_object('Authorization', 'Bearer <ANON_KEY_HERE>')
--     );
--   $$);
--
-- Before running this in the SQL editor:
--   Replace <ANON_KEY_HERE> with the project's anon key (same one already
--   hardcoded in pnl.html / ops-dashboard — not a secret, RLS-scoped).
--   pg_cron/pg_net are already enabled (migration 026).
--
-- If an old ad hoc job is still sitting there from before (e.g. named
-- 'sync-invoices-every-5-min' or similar), drop it first so you don't end
-- up running both:
--   select cron.unschedule(jobname) from cron.job where jobname like 'sync-invoices%' and jobname <> 'sync-invoices-hourly';

select cron.schedule(
  'sync-invoices-hourly',
  '0 * * * *', -- once every hour, on the hour
  $$
  select net.http_post(
    url     := 'https://fykqprogzqcfzrgwlrem.supabase.co/functions/v1/sync-invoices',
    headers := jsonb_build_object('Authorization', 'Bearer <ANON_KEY_HERE>')
  );
  $$
);

-- To check it's running: select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'sync-invoices-hourly') order by start_time desc limit 10;
-- To stop it entirely:    select cron.unschedule('sync-invoices-hourly');
