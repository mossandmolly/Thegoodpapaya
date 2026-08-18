-- Adds the newly-supported vegetables/leaves (see FRUITS in
-- ops-dashboard/parser.html and whatsapp-listener/index.js) to stock
-- tracking, so they show up on the Stock tab automatically instead of
-- needing each one manually "+ Add"ed. Purchasing then works the same way
-- it already does for any tracked fruit — via that item's own "manage"
-- link on the Stock tab, no separate purchase-list setup needed.
--
-- These item_names must match the corresponding catalog row exactly
-- (case-sensitive) for the Stock tab to actually display them — if one
-- doesn't show up after this, check its exact casing in the catalog table
-- against what's used here.
insert into stock_tracked_fruits (item_name)
values
  ('Cauliflower'), ('Cabbage'), ('Capsicum green'), ('Carrot'), ('Tomato'),
  ('Ginger'), ('Beans'), ('Lady''s finger'), ('Cucumber'), ('Coriander'),
  ('Chilli green'), ('Potato'), ('Onion'), ('Ridge gourd'), ('Bitter gourd'),
  ('Bottle gourd'), ('Brinjal bottle'), ('Broccoli'), ('Banana leaves')
on conflict (item_name) do nothing;
