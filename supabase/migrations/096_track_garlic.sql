-- Adds Garlic to stock tracking, same pattern as migrations 078/085/093/095 —
-- item_name must match the catalog row exactly for the Stock tab to
-- actually display it.
insert into stock_tracked_fruits (item_name)
values
  ('Garlic')
on conflict (item_name) do nothing;
