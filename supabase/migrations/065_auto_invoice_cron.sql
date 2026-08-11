-- Schedules the auto-invoice-final-orders edge function to run every
-- minute — it finds orders where every item is packed & final (ready to
-- bill, pickup orders excluded) and generates the Zoho invoice
-- automatically, same as clicking "Generate Invoice" would.
--
-- Before running this:
--   1. Deploy the auto-invoice-final-orders edge function.
--   2. Re-deploy generate-invoice (it now accepts the same x-cron-secret
--      this job sends, in addition to a normal user session).
--   3. CRON_SECRET must already be set as an edge function secret — reuse
--      the same value configured for export-csv/purge-delivery-photos
--      (Settings → Edge Functions → Secrets), don't mint a new one.
--   4. Replace <CRON_SECRET_HERE> and <SERVICE_ROLE_KEY_HERE> below with
--      those same values before running this file in the SQL editor.
--
-- pg_cron/pg_net are already enabled by migration 026 — no need to
-- re-create the extensions here.

select cron.schedule(
  'auto-invoice-final-orders',
  '* * * * *', -- every minute
  $$
  select net.http_post(
    url     := 'https://fykqprogzqcfzrgwlrem.supabase.co/functions/v1/auto-invoice-final-orders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <SERVICE_ROLE_KEY_HERE>',
      'x-cron-secret', '<CRON_SECRET_HERE>'
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- To check it's running: select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'auto-invoice-final-orders') order by start_time desc limit 10;
-- To stop it entirely:    select cron.unschedule('auto-invoice-final-orders');
