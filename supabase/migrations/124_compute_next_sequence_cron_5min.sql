-- Widens compute-next-sequence's cron interval from 3 to 5 minutes — 3 was
-- too tight. cron.schedule() with the SAME job name updates that job's
-- schedule in place rather than creating a duplicate, so this just
-- replaces migration 121's schedule; nothing else about the job changes.
--
-- Replace <CRON_SECRET_HERE> and <SERVICE_ROLE_KEY_HERE> below with the
-- same values already used in migration 121 before running this.

select cron.schedule(
  'compute-next-sequence',
  '*/5 * * * *', -- every 5 minutes (was every 3)
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
-- To confirm the new schedule stuck: select jobname, schedule from cron.job where jobname = 'compute-next-sequence';
