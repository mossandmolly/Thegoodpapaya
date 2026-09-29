-- Switch for where generate-invoice gets item rates from:
--   'catalog' (default) — the local catalog table, mirrored from Zoho by
--                         sync-catalog (hourly cron + 💰 Catalog button).
--   'zoho'              — fetch Zoho Books' /items live on every invoice.
--                         Fallback for when the catalog is known to be in a
--                         bad state. Costs extra Zoho API calls per invoice
--                         (the reason catalog became the default), so flip
--                         it back once the catalog is fixed.
-- Flipped from the "Invoice prices" toggle on Order Overview. Single row,
-- id = 1. generate-invoice treats a missing row / read error as 'catalog'.
create table if not exists public.invoice_pricing_settings (
  id         integer primary key default 1 check (id = 1),
  source     text not null default 'catalog' check (source in ('catalog', 'zoho')),
  updated_at timestamptz not null default now(),
  updated_by text
);

insert into public.invoice_pricing_settings (id, source) values (1, 'catalog')
on conflict (id) do nothing;

alter table public.invoice_pricing_settings enable row level security;
drop policy if exists "invoice_pricing_settings_read" on public.invoice_pricing_settings;
create policy "invoice_pricing_settings_read" on public.invoice_pricing_settings
  for select to authenticated using (true);
drop policy if exists "invoice_pricing_settings_update" on public.invoice_pricing_settings;
create policy "invoice_pricing_settings_update" on public.invoice_pricing_settings
  for update to authenticated using (true) with check (true);
