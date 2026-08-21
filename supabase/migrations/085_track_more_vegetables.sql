-- Adds Fenugreek, Mangalore cucumber, Drumstick, Chilli bhaji, and Coccinia
-- to stock tracking, same as migration 078 did for the original vegetable
-- batch — see that migration for the exact-casing caveat (item_name must
-- match the catalog row exactly for the Stock tab to actually display them).
insert into stock_tracked_fruits (item_name)
values
  ('Fenugreek'), ('Mangalore cucumber'), ('Drumstick'), ('Chilli bhaji'), ('Coccinia')
on conflict (item_name) do nothing;
