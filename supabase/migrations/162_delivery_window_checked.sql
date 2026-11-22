-- extract-delivery-windows (cron, every 20 min) needs a marker so an
-- order with a note that genuinely has no deadline in it ("no onions
-- please") doesn't get re-sent to Claude every single run forever —
-- this is set the moment a Claude call for that order succeeds, whether
-- or not it actually found a time.
alter table public.orders
  add column if not exists delivery_window_checked_at timestamptz;
