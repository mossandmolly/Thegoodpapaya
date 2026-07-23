-- Closing stock — the physical count entered at day's end, mirroring
-- stock_opening (one row per fruit per day). The NEXT working day's
-- opening auto-populates from whichever is the most recent prior closing
-- entry — the frontend just looks for the latest stock_closing row before
-- the viewed date, so Sundays (or any other gap with nothing entered) are
-- skipped automatically without any day-of-week logic.
create table if not exists stock_closing (
  id          uuid primary key default gen_random_uuid(),
  item_name   text not null,
  date        date not null,
  closing_qty numeric not null,
  updated_at  timestamptz not null default now(),
  unique (item_name, date)
);

create index if not exists idx_stock_closing_date      on stock_closing(date);
create index if not exists idx_stock_closing_item_date  on stock_closing(item_name, date desc);

-- drop-then-create rather than IF NOT EXISTS — Postgres doesn't support
-- that clause for triggers/policies, and this file needs to be safely
-- re-runnable if an earlier attempt got partway through.
drop trigger if exists stock_closing_updated_at on stock_closing;
create trigger stock_closing_updated_at
  before update on stock_closing
  for each row execute function update_updated_at();

alter table stock_closing enable row level security;
drop policy if exists "stock_closing_read"  on stock_closing;
drop policy if exists "stock_closing_write" on stock_closing;
create policy "stock_closing_read"  on stock_closing for select using (true);
create policy "stock_closing_write" on stock_closing for all    using (true);

-- Audit trail for opening-stock edits only — that's the value that gets
-- auto-populated each morning from the previous day's closing and then
-- possibly adjusted by hand (overnight spoilage etc.) before packing
-- starts, so it's the one number worth a "who changed what from what"
-- record. Append-only: no update/delete policy, so the trail itself can't
-- be edited after the fact.
create table if not exists stock_opening_history (
  id          uuid primary key default gen_random_uuid(),
  item_name   text not null,
  date        date not null,
  old_qty     numeric,
  new_qty     numeric not null,
  changed_by  text,
  changed_at  timestamptz not null default now()
);

create index if not exists idx_stock_opening_history_lookup on stock_opening_history(item_name, date, changed_at desc);

alter table stock_opening_history enable row level security;
drop policy if exists "stock_opening_history_read"   on stock_opening_history;
drop policy if exists "stock_opening_history_insert" on stock_opening_history;
create policy "stock_opening_history_read"   on stock_opening_history for select using (true);
create policy "stock_opening_history_insert" on stock_opening_history for insert with check (true);
