-- Consolidating on daily_expenses (the P&L dashboard's original name,
-- matching daily_sales) as the one shared table for both the ops-dashboard
-- buyer role's Expenses section and the P&L dashboard's Expenses tab —
-- rather than the expenses name migration 066 introduced. A rename
-- preserves any rows already entered instead of a destructive drop/recreate.
alter table if exists expenses rename to daily_expenses;

drop policy if exists "expenses_read"  on daily_expenses;
drop policy if exists "expenses_write" on daily_expenses;
drop policy if exists "daily_expenses_read"  on daily_expenses;
drop policy if exists "daily_expenses_write" on daily_expenses;
create policy "daily_expenses_read"  on daily_expenses for select using (true);
create policy "daily_expenses_write" on daily_expenses for all    using (true);
