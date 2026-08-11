-- Expense tracking for the buyer role's Purchases tab — day-to-day running
-- costs (packaging, housekeeping, transport, rent/electricity, etc.) that
-- aren't tied to a specific fruit purchase tranche, so they don't belong in
-- stock_purchases. One row per expense entered, scoped to a date like every
-- other Stock/Purchases table (stock_opening, stock_purchases).
create table if not exists expenses (
  id          uuid primary key default gen_random_uuid(),
  date        date not null,
  category    text not null check (category in ('Packaging','Housekeeping','Transport','Rent & Electricity','Other')),
  description text,
  amount      numeric not null check (amount > 0),
  created_at  timestamptz not null default now()
);

create index if not exists idx_expenses_date on expenses(date);

-- Same open-access pattern as stock_purchases (migration 048) — no
-- payment/invoice sensitivity, any authenticated ops session reads/writes
-- directly with the anon key, no edge function needed.
alter table expenses enable row level security;

drop policy if exists "expenses_read"  on expenses;
drop policy if exists "expenses_write" on expenses;
create policy "expenses_read"  on expenses for select using (true);
create policy "expenses_write" on expenses for all    using (true);
