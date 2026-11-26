-- Free-text caption shown next to an item's name on the storefront catalog
-- card (e.g. "New!", "Price drop!") — empty by default, set per item from
-- the ops dashboard's Images tab.
alter table public.catalog
  add column if not exists special_caption text;
