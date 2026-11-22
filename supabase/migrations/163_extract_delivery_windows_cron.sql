-- Schedules the extract-delivery-windows edge function to run every 20
-- minutes — it finds orders whose checkout delivery note hasn't been
-- looked at yet (orders.delivery_window_checked_at is null) and asks
-- Claude to pull a deliver_by/deliver_after deadline out of it.
--
-- Before running this:
--   1. Run migration 162_delivery_window_checked.sql first.
--   2. Deploy the extract-delivery-windows edge function.
--   3. ANTHROPIC_API_KEY must already be set as an edge function secret
--      (reuse the same one parse-buyer-purchase-text uses).
--   4. CRON_SECRET must already be set as an edge function secret — reuse
--      the same value configured for export-csv/auto-invoice-final-orders,
--      don't mint a new one.
--   5. Replace <CRON_SECRET_HERE> and <SERVICE_ROLE_KEY_HERE> below with
--      those same values before running this file in the SQL editor.
--
-- pg_cron/pg_net are already enabled by migration 026 — no need to
-- re-create the extensions here.

select cron.schedule(
  'extract-delivery-windows',
  '*/20 * * * *', -- every 20 minutes
  $$
  select net.http_post(
    url     := 'https://fykqprogzqcfzrgwlrem.supabase.co/functions/v1/extract-delivery-windows',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <SERVICE_ROLE_KEY_HERE>',
      'x-cron-secret', '<CRON_SECRET_HERE>'
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- To check it's running: select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'extract-delivery-windows') order by start_time desc limit 10;
-- To stop it entirely:    select cron.unschedule('extract-delivery-windows');
