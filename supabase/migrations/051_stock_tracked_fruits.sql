-- Which fruits show up in the Stock tab was, until now, entirely derived
-- from that day's own data (an opening/closing entry, a purchase, or
-- order demand for that specific date) — so a fruit added via "+ Add"
-- only stayed visible on the day it was added. The next day, with no
-- fresh activity yet, it just vanished, even though the intent was to
-- keep tracking it going forward.
--
-- This table is the actual persistent "we track this fruit" list,
-- independent of any single day's numbers — once a fruit is added, it
-- shows up every day from then on until explicitly removed.
create table if not exists stock_tracked_fruits (
  item_name  text primary key,
  added_at   timestamptz not null default now()
);

alter table stock_tracked_fruits enable row level security;
drop policy if exists "stock_tracked_fruits_read"  on stock_tracked_fruits;
drop policy if exists "stock_tracked_fruits_write" on stock_tracked_fruits;
create policy "stock_tracked_fruits_read"  on stock_tracked_fruits for select using (true);
create policy "stock_tracked_fruits_write" on stock_tracked_fruits for all    using (true);

-- Backfill from whatever's already been entered so far — recovers the
-- fruits added and worked with over the past week that this table didn't
-- exist yet to remember, without needing to re-add them a third time.
insert into stock_tracked_fruits (item_name)
select item_name from stock_opening
union
select item_name from stock_closing
union
select item_name from stock_purchases
on conflict (item_name) do nothing;
