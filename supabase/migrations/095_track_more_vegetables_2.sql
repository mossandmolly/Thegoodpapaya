-- Adds Lettuce, Beetroot, Zucchini green, Zucchini yellow, Red cabbage, and
-- Mushroom to stock tracking, same pattern as migrations 078/085/093 —
-- item_name must match the catalog row exactly for the Stock tab to
-- actually display it. (Mint was already added in migration 093.)
insert into stock_tracked_fruits (item_name)
values
  ('Lettuce'), ('Beetroot'), ('Zucchini green'), ('Zucchini yellow'), ('Red cabbage'), ('Mushroom')
on conflict (item_name) do nothing;
