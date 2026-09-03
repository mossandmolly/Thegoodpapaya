-- Adds Radish, Pumpkin, and Baby corn to stock tracking, same pattern as
-- migrations 078/085/093/095/096/098/099 — item_name must match the
-- catalog row exactly for the Stock tab to actually display it. Confirm
-- the exact catalog spelling first if these aren't showing up:
--   select item_name from catalog where item_name ilike '%radish%'
--     or item_name ilike '%pumpkin%' or item_name ilike '%baby corn%';
insert into stock_tracked_fruits (item_name)
values
  ('Radish'),
  ('Pumpkin'),
  ('Baby corn')
on conflict (item_name) do nothing;
