-- Adds Cherry tomato and Pink lady apple to stock tracking, same pattern as
-- migrations 078/085/093/095/096/098/099/105/106/107/112/113 — item_name
-- must match the catalog row exactly for the Stock tab to actually display
-- it. Pink lady apple already exists in the FRUITS master list (parser.html/
-- whatsapp-listener/parse-orders) — only Cherry tomato needed adding there
-- too (see accompanying parser.html/whatsapp-listener/parse-orders changes).
-- Confirm exact spelling first if either doesn't show up:
--   select item_name from catalog where item_name ilike '%cherry tomato%'
--     or item_name ilike '%pink lady%';
insert into stock_tracked_fruits (item_name)
values
  ('Cherry tomato'),
  ('Pink lady apple')
on conflict (item_name) do nothing;
