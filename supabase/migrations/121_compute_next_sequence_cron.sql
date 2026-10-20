-- Schedules compute-next-sequence to run every 3 minutes, so a packer never
-- has to wait long for the next batch of work to appear — see that
-- function's own header comment for the full algorithm. Widened to every 5
-- minutes by migration 124 — this file is kept as-is for history; run 124
-- (or re-run this one with the interval changed) to apply the new schedule.
--
-- Before running this:
--   1. Deploy compute-next-sequence (it needs the same x-cron-secret
--      pattern auto-invoice-final-orders/sync-catalog already use, in
--      addition to a normal user session).
--   2. CRON_SECRET must already be set as an edge function secret — reuse
--      the same value configured for those other jobs, don't mint a new one.
--   3. Replace <CRON_SECRET_HERE> and <SERVICE_ROLE_KEY_HERE> below with
--      those same values before running this file in the SQL editor.
--
-- pg_cron/pg_net are already enabled by migration 026 — no need to
-- re-create the extensions here.

select cron.schedule(
  'compute-next-sequence',
  '*/3 * * * *', -- every 3 minutes
  $$
  select net.http_post(
    url     := 'https://fykqprogzqcfzrgwlrem.supabase.co/functions/v1/compute-next-sequence',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <SERVICE_ROLE_KEY_HERE>',
      'x-cron-secret', '<CRON_SECRET_HERE>'
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- To check it's running: select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'compute-next-sequence') order by start_time desc limit 10;
-- To stop it entirely:    select cron.unschedule('compute-next-sequence');
