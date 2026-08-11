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
--   4. Replace <CRON_SECRET_HERE> below with that same value, and
--      <SERVICE_ROLE_KEY_HERE> with your project's service_role key
--      (Settings → API → service_role secret), before running this file
--      in the SQL editor.
--
-- The Authorization header below is required — every Edge Function sits
-- behind Supabase's own JWT verification gate regardless of any custom
-- auth check inside the function itself, so a call with no Authorization
-- header at all gets rejected as 401 UNAUTHORIZED_NO_AUTH_HEADER before it
-- ever reaches export-csv's own CRON_SECRET check.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net  with schema extensions;

-- cron.schedule() upserts by job name, so re-running this migration (e.g.
-- after changing a secret) safely replaces the existing schedule rather
-- than creating a duplicate.
select cron.schedule(
  'hourly-csv-export',
  '0 * * * *', -- top of every hour
  $$
  select net.http_post(
    url     := 'https://fykqprogzqcfzrgwlrem.supabase.co/functions/v1/export-csv',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <SERVICE_ROLE_KEY_HERE>',
      'x-cron-secret', '<CRON_SECRET_HERE>'
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- To check it's running: select * from cron.job_run_details order by start_time desc limit 10;
-- To stop it entirely:    select cron.unschedule('hourly-csv-export');
