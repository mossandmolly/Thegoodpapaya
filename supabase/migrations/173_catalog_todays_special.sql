-- "Today's Special" — a per-item config flag (Config tab, same pattern
-- as sold_by_box/sold_by_piece) so staff can flag items for the ops
-- dashboard's Catalog Images tab to filter on, same as the existing
-- sold-by-box filter there.
alter table public.catalog
  add column if not exists todays_special boolean not null default false;
