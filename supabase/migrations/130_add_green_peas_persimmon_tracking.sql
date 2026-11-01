-- Migration 130: add Green peas and Persimmon to stock tracking, same
-- reasoning as migration 129's Cape gooseberry — the Stock tab only
-- renders catalog rows, so both a catalog entry and a stock_tracked_fruits
-- entry are needed for either to actually show up.
insert into public.catalog (item_name, unit_price, unit, active)
values
  ('Green peas', 0, 'kg', true),
  ('Persimmon',  0, 'kg', true)
on conflict (item_name) do nothing;

insert into public.stock_tracked_fruits (item_name)
values
  ('Green peas'),
  ('Persimmon')
on conflict (item_name) do nothing;
