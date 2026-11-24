-- Which unit a cart row starts in when a customer first taps an item on
-- the catalog grid. Only meaningful for a piece-eligible item (box is
-- already forced/exclusive regardless — see migration 167 — and a
-- weight-only item has no other unit to default to anyway), letting a
-- leafy green default straight to "bunch" instead of making every
-- customer manually switch off kg every time. Null = no preference set,
-- falls back to the same kg-first behavior as before this existed.
alter table public.catalog
  add column if not exists default_unit text
    check (default_unit in ('kg', 'piece', 'box'));
