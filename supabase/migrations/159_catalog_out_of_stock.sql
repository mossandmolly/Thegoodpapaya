-- Out-of-stock is distinct from active: an inactive item is hidden from
-- the storefront catalog entirely, while an out-of-stock item still shows
-- (greyed out, with a badge) so customers know it exists but can't add it
-- to cart right now. See storefront/index.html's cardHtml/bumpItem.
alter table public.catalog
  add column if not exists out_of_stock boolean not null default false;
