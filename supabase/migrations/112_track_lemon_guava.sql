-- Adds Lemon and the Guava variants to stock tracking, same pattern as
-- migrations 078/085/093/095/096/098/099/105/106/107 — item_name must
-- match the catalog row exactly for the Stock tab to actually display it.
-- Confirm exact spelling first if these aren't showing up:
--   select item_name from catalog where item_name ilike '%lemon%'
--     or item_name ilike '%guava%';
insert into stock_tracked_fruits (item_name)
values
  ('Lemon'),
  ('Guava white'),
  ('Guava pink'),
  ('Nati guava')
on conflict (item_name) do nothing;
