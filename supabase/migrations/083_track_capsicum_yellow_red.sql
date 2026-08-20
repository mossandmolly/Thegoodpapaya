-- Adds Capsicum yellow and Capsicum red to stock tracking, same as
-- migration 078 did for the original vegetable batch — see that migration
-- for the exact-casing caveat (item_name must match the catalog row
-- exactly for the Stock tab to actually display them).
insert into stock_tracked_fruits (item_name)
values
  ('Capsicum yellow'), ('Capsicum red')
on conflict (item_name) do nothing;
