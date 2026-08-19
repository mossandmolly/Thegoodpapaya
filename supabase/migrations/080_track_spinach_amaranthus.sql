-- Adds Spinach and Amaranthus to stock tracking, same as migration 078 did
-- for the earlier batch of vegetables/leaves — see that migration for the
-- exact-casing caveat (item_name must match the catalog row exactly).
insert into stock_tracked_fruits (item_name)
values
  ('Spinach'), ('Amaranthus')
on conflict (item_name) do nothing;
