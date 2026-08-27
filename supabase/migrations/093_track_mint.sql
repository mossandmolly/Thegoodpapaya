-- Adds Mint (pudina) to stock tracking, same pattern as migration 078/085 —
-- item_name must match the catalog row exactly for the Stock tab to
-- actually display it.
insert into stock_tracked_fruits (item_name)
values
  ('Mint')
on conflict (item_name) do nothing;
