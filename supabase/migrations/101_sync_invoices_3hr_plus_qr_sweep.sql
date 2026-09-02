-- Two changes while the sync-invoices full-reprocess bug (fixed in the
-- same commit as this migration — see sync-invoices/index.ts) is still
-- unconfirmed in production:
--
-- 1. sync-invoices itself (Zoho calls) drops from hourly to every 3 hours,
--    as an extra safety margin on top of the code fix.
-- 2. The QR-refresh sweep (Razorpay only — zero Zoho calls) is split out
--    to its own tight 15-min cron via mode=qr-sweep, so live deliveries
--    don't inherit the 3hr Zoho-sync interval and risk a QR actually
--    expiring (~2hr) before it's caught. This runs completely
--    independently of Zoho API consumption.
--
-- Once the fix above is confirmed (check the "X invoice(s) today, Y
-- actually changed" log line stays small on a quiet run), bump job #1
-- back down — e.g. hourly, or whatever cadence makes sense — with:
--   select cron.alter_job(
--     (select jobid from cron.job where jobname = 'sync-invoices-3hr'),
--     schedule := '0 * * * *'
--   );

select cron.unschedule('sync-invoices-hourly');

select cron.schedule(
  'sync-invoices-3hr',
  '0 */3 * * *', -- every 3 hours, on the hour
  $$
  select net.http_post(
    url     := 'https://fykqprogzqcfzrgwlrem.supabase.co/functions/v1/sync-invoices',
    headers := jsonb_build_object('Authorization', 'Bearer <ANON_KEY_HERE>')
  );
  $$
);

select cron.schedule(
  'sync-invoices-qr-sweep',
  '*/15 * * * *', -- every 15 minutes — Razorpay-only, no Zoho calls
  $$
  select net.http_post(
    url     := 'https://fykqprogzqcfzrgwlrem.supabase.co/functions/v1/sync-invoices?mode=qr-sweep',
    headers := jsonb_build_object('Authorization', 'Bearer <ANON_KEY_HERE>')
  );
  $$
);

-- To check both are running:
--   select jobname, schedule, active from cron.job where jobname like 'sync-invoices%';
-- To stop either entirely:
--   select cron.unschedule('sync-invoices-3hr');
--   select cron.unschedule('sync-invoices-qr-sweep');
