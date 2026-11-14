-- Schedules snapshot-catalog-prices to run once daily at 12:00 noon IST
-- (06:30 UTC) — pg_cron runs in UTC, so this is written in UTC, not IST.
--
-- Before running this:
--   1. Deploy the snapshot-catalog-prices edge function.
--   2. CRON_SECRET must already be set as an edge function secret — reuse
--      the same value configured for sync-catalog/auto-invoice-final-
--      orders/export-csv, don't mint a new one.
--   3. Replace <CRON_SECRET_HERE> and <SERVICE_ROLE_KEY_HERE> below with
--      those same values before running this file in the SQL editor.
--
-- pg_cron/pg_net are already enabled by migration 026.

select cron.schedule(
  'snapshot-catalog-prices-noon-ist',
  '30 6 * * *', -- 06:30 UTC = 12:00 noon IST
  $$
  select net.http_post(
    url     := 'https://fykqprogzqcfzrgwlrem.supabase.co/functions/v1/snapshot-catalog-prices',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <SERVICE_ROLE_KEY_HERE>',
      'x-cron-secret', '<CRON_SECRET_HERE>'
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- To check it's running: select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'snapshot-catalog-prices-noon-ist') order by start_time desc limit 10;
-- To stop it entirely:    select cron.unschedule('snapshot-catalog-prices-noon-ist');
