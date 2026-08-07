-- Schedules the purge-delivery-photos edge function to run once a day,
-- deleting delivery photos older than 30 days (orders/order_items data and
-- the hourly CSV exports are kept forever — only these photos have a
-- retention window, since they're the heaviest thing this app stores).
--
-- Before running this:
--   1. Deploy the purge-delivery-photos edge function.
--   2. Set a CRON_SECRET env var on it — reuse the same value already set
--      on export-csv if you want one secret for both, or a different one,
--      either works since each function only checks its own.
--   3. Replace <CRON_SECRET_HERE> and <SERVICE_ROLE_KEY_HERE> below before
--      running this in the SQL editor (see migration 026 for why the
--      Authorization header is required on top of the x-cron-secret check).

create index if not exists idx_orders_delivered_at on public.orders(delivered_at);

select cron.schedule(
  'daily-delivery-photo-purge',
  '0 3 * * *', -- 3am UTC daily — low-traffic hour
  $$
  select net.http_post(
    url     := 'https://fykqprogzqcfzrgwlrem.supabase.co/functions/v1/purge-delivery-photos',
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
-- To stop it entirely:    select cron.unschedule('daily-delivery-photo-purge');
