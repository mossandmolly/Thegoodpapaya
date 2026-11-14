-- One row per (date, item) — catalog.unit_price as it stood at the daily
-- noon-IST snapshot (snapshot-catalog-prices, migration 154's cron). Not a
-- live join against catalog: the Purchases tab's "Sales Rate" column needs
-- to show what the price actually WAS that day, which a live read would
-- silently rewrite for past dates every time catalog changes.
create table if not exists public.catalog_price_snapshots (
  date        date not null,
  item_name   text not null,
  unit_price  numeric not null,
  snapshotted_at timestamptz not null default now(),
  primary key (date, item_name)
);

alter table public.catalog_price_snapshots enable row level security;
drop policy if exists "authenticated read" on public.catalog_price_snapshots;
create policy "authenticated read" on public.catalog_price_snapshots
  for select to authenticated using (true);
-- No authenticated insert/update/delete policy — only snapshot-catalog-
-- prices (service role) ever writes here.
