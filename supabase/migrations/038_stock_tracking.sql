-- Stock/inventory tracking for the new Stock tab: opening stock entered
-- once a day per fruit, plus however many purchase tranches come in
-- through the day (different sources arrive at different times, so this
-- is a running list, not a single number). Today's order demand is NOT
-- stored here — it's aggregated live from order_items (same source of
-- truth every other tab already reads), so there's nothing to keep in
-- sync.
--
-- "Need to order" rule (computed client-side, not stored): let pool =
-- opening_qty + sum(today's purchases), remaining = pool - today's order
-- demand, remaining_pct = remaining / pool. remaining_pct < 20% = Need to
-- Order; 20-35% = Trending Low; otherwise OK.

create table if not exists stock_opening (
  id          uuid primary key default gen_random_uuid(),
  item_name   text not null,
  date        date not null,
  opening_qty numeric not null default 0,
  updated_at  timestamptz not null default now(),
  unique (item_name, date)
);

create table if not exists stock_purchases (
  id          uuid primary key default gen_random_uuid(),
  item_name   text not null,
  date        date not null,
  qty         numeric not null,
  source      text,
  created_at  timestamptz not null default now()
);

create index idx_stock_opening_date on stock_opening(date);
create index idx_stock_purchases_date on stock_purchases(date);
create index idx_stock_purchases_date_item on stock_purchases(date, item_name);

create trigger stock_opening_updated_at
  before update on stock_opening
  for each row execute function update_updated_at();

-- Same open-access pattern as packers/communities (migration 006/008) —
-- this data carries no payment/invoice sensitivity, so any authenticated
-- ops session reads/writes it directly with the anon key, no edge
-- function needed.
alter table stock_opening   enable row level security;
alter table stock_purchases enable row level security;

create policy "stock_opening_read"    on stock_opening   for select using (true);
create policy "stock_opening_write"   on stock_opening   for all    using (true);
create policy "stock_purchases_read"  on stock_purchases for select using (true);
create policy "stock_purchases_write" on stock_purchases for all    using (true);
