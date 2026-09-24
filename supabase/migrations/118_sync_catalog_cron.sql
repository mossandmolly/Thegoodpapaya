-- Schedules sync-catalog to run every hour, pulling active items/rates from
-- Zoho Books into the local `catalog` table. generate-invoice now prices
-- every invoice off that table instead of fetching Zoho live each time (see
-- its own updated comment) — this hourly run is what keeps that pricing
-- current, bounding the staleness window to at most ~1 hour instead of
-- "indefinitely" (the old failure mode this whole design used to avoid by
-- fetching live). Still worth a manual "Sync Catalog" click right after
-- adding a brand-new item or correcting a price you need live immediately —
-- there is deliberately no live-Zoho fallback for an item this table
-- doesn't recognize yet.
--
-- Before running this:
--   1. Deploy the updated sync-catalog edge function (it now accepts the
--      same x-cron-secret pattern generate-invoice/auto-invoice-final-orders
--      already use, in addition to a normal user session).
--   2. Re-deploy generate-invoice (it now reads catalog instead of Zoho).
--   3. CRON_SECRET must already be set as an edge function secret — reuse
--      the same value configured for auto-invoice-final-orders/export-csv/
--      purge-delivery-photos, don't mint a new one.
--   4. Replace <CRON_SECRET_HERE> and <SERVICE_ROLE_KEY_HERE> below with
--      those same values before running this file in the SQL editor.
--
-- pg_cron/pg_net are already enabled by migration 026 — no need to
-- re-create the extensions here.

select cron.schedule(
  'sync-catalog-hourly',
  '0 * * * *', -- top of every hour
  $$
  select net.http_post(
    url     := 'https://fykqprogzqcfzrgwlrem.supabase.co/functions/v1/sync-catalog',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <SERVICE_ROLE_KEY_HERE>',
      'x-cron-secret', '<CRON_SECRET_HERE>'
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- To check it's running: select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'sync-catalog-hourly') order by start_time desc limit 10;
-- To stop it entirely:    select cron.unschedule('sync-catalog-hourly');
