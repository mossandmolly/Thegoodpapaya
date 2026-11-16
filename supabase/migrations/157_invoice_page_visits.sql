-- Logs every real phone lookup on My Invoices (storefront/invoices.html)
-- — one row per distinct house name found for that phone (or a single
-- customer_name=null row when no invoices turned up at all) — so a report
-- can count distinct numbers/houses that used the page on a given day.
-- Public anon-insert-only, same pattern as customer_feedback: a customer
-- can log a visit but never read anyone else's visit history back through
-- the same public key.
create table if not exists public.invoice_page_visits (
  id uuid primary key default gen_random_uuid(),
  phone_number  text not null,
  customer_name text,
  created_at    timestamptz not null default now()
);

create index if not exists idx_invoice_page_visits_created_at
  on public.invoice_page_visits(created_at);

alter table public.invoice_page_visits enable row level security;

drop policy if exists "anon insert" on public.invoice_page_visits;
create policy "anon insert" on public.invoice_page_visits
  for insert to anon with check (true);

drop policy if exists "authenticated read" on public.invoice_page_visits;
create policy "authenticated read" on public.invoice_page_visits
  for select to authenticated using (true);
