-- Schedules reconcile-zoho-payments to run hourly — catches a payment
-- entered directly in Zoho's own web UI (bank transfer, cheque, cash)
-- that neither razorpay-webhook nor mark-order-paid ever saw, and syncs
-- orders/invoice_line_items to match once Zoho shows that invoice's
-- balance at zero. Never writes anything back to Zoho.
--
-- Before running this:
--   1. Deploy the reconcile-zoho-payments edge function.
--   2. CRON_SECRET must already be set as an edge function secret — reuse
--      the same value configured for auto-invoice-final-orders/export-csv
--      (Settings -> Edge Functions -> Secrets), don't mint a new one.
--   3. Replace <CRON_SECRET_HERE> and <SERVICE_ROLE_KEY_HERE> below with
--      those same values before running this file in the SQL editor.
--
-- pg_cron/pg_net are already enabled by migration 026 — no need to
-- re-create the extensions here.

select cron.schedule(
  'reconcile-zoho-payments',
  '0 * * * *', -- hourly, on the hour
  $$
  select net.http_post(
    url     := 'https://fykqprogzqcfzrgwlrem.supabase.co/functions/v1/reconcile-zoho-payments',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <SERVICE_ROLE_KEY_HERE>',
      'x-cron-secret', '<CRON_SECRET_HERE>'
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- To check it's running: select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'reconcile-zoho-payments') order by start_time desc limit 10;
-- To stop it entirely:    select cron.unschedule('reconcile-zoho-payments');
