-- Manual daily sales tally for the P&L dashboard's Sales tab (August
-- onward) — a per-day CSV upload of sold quantity/amount per SKU, kept
-- separate from orders/order_items since it's the P&L's own reconciled
-- figure, not necessarily identical to what's been invoiced through Zoho.
-- This table was already assumed by the dashboard's read/write code; it
-- just never existed, so August sales/expenses silently failed to persist
-- and the dashboard fell back to stale numbers.
create table if not exists daily_sales (
  id              uuid primary key default gen_random_uuid(),
  date            date not null,
  item_name       text not null,
  quantity_sold   numeric not null default 0,
  amount          numeric not null default 0,
  unit            text,
  created_at      timestamptz not null default now()
);

create index if not exists idx_daily_sales_date on daily_sales(date);

-- Same open-access pattern as stock_purchases/expenses — no payment
-- sensitivity beyond what's already visible in the P&L dashboard itself,
-- any authenticated ops session reads/writes directly with the anon key.
alter table daily_sales enable row level security;

drop policy if exists "daily_sales_read"  on daily_sales;
drop policy if exists "daily_sales_write" on daily_sales;
create policy "daily_sales_read"  on daily_sales for select using (true);
create policy "daily_sales_write" on daily_sales for all    using (true);
