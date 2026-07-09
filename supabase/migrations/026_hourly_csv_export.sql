-- Schedules the export-csv edge function to run every hour, dumping the
-- full orders + order_items tables to CSV in the "exports" Storage bucket.
--
-- Before running this:
--   1. Create a private Storage bucket named "exports" in the dashboard
--      (Storage → New bucket → name "exports", leave "Public bucket" OFF).
--   2. Deploy the export-csv edge function (paste its code into the
--      dashboard as usual).
--   3. Set a CRON_SECRET env var on that edge function (any random string
--      you generate yourself) — Settings → Edge Functions → export-csv →
--      Secrets.
--   4. Replace the two <CRON_SECRET_HERE> placeholders below with that same
--      value before running this file in the SQL editor.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net  with schema extensions;

-- cron.schedule() upserts by job name, so re-running this migration (e.g.
-- after changing the secret) safely replaces the existing schedule rather
-- than creating a duplicate.
select cron.schedule(
  'hourly-csv-export',
  '0 * * * *', -- top of every hour
  $$
  select net.http_post(
    url     := 'https://fykqprogzqcfzrgwlrem.supabase.co/functions/v1/export-csv',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', '<CRON_SECRET_HERE>'
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- To check it's running: select * from cron.job_run_details order by start_time desc limit 10;
-- To stop it entirely:    select cron.unschedule('hourly-csv-export');
