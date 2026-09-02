-- Adds Brinjal long and Sweet potato to stock tracking, same pattern as
-- migrations 078/085/093/095/096/098 — item_name must match the catalog
-- row exactly for the Stock tab to actually display it. Confirm the exact
-- catalog spelling (select item_name from catalog where item_name ilike
-- '%brinjal%' or item_name ilike '%sweet potato%') before relying on this;
-- if the catalog uses different casing/wording, update these values to match.
insert into stock_tracked_fruits (item_name)
values
  ('Brinjal long'),
  ('Sweet potato')
on conflict (item_name) do nothing;
