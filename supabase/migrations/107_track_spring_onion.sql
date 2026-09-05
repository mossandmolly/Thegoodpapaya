-- Adds Spring onion to stock tracking, same pattern as migrations
-- 078/085/093/095/096/098/099/105/106 — item_name must match the catalog
-- row exactly for the Stock tab to actually display it. Confirm first if
-- it doesn't show up:
--   select item_name from catalog where item_name ilike '%spring onion%';
insert into stock_tracked_fruits (item_name)
values
  ('Spring onion')
on conflict (item_name) do nothing;
