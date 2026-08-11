-- 018_catalog_customers_sync.sql
-- Ensures catalog has the columns sync-catalog needs,
-- and extends the existing customers table (001_initial_schema) for sync-customers.

-- ── Catalog ────────────────────────────────────────────────────
-- Table may already exist in the DB; all alterations are safe to re-run.
create table if not exists public.catalog (
  id           uuid          primary key default gen_random_uuid(),
  item_name    text          not null unique,
  unit_price   numeric(10,2) not null default 0,
  unit         text          not null default 'kg',
  active       boolean       not null default true,
  zoho_item_id text,
  synced_at    timestamptz,
  created_at   timestamptz   not null default now()
);

alter table public.catalog add column if not exists zoho_item_id text;
alter table public.catalog add column if not exists synced_at    timestamptz;

-- Partial unique index: only enforce uniqueness when zoho_item_id is set
create unique index if not exists catalog_zoho_item_id_idx
  on public.catalog (zoho_item_id) where zoho_item_id is not null;

alter table public.catalog enable row level security;

drop policy if exists "public read"  on public.catalog;
drop policy if exists "anon insert"  on public.catalog;
drop policy if exists "anon update"  on public.catalog;
drop policy if exists "anon delete"  on public.catalog;

create policy "public read"  on public.catalog for select using (true);
create policy "anon insert"  on public.catalog for insert with check (true);
create policy "anon update"  on public.catalog for update using (true);
create policy "anon delete"  on public.catalog for delete using (true);

-- ── Customers ──────────────────────────────────────────────────
-- The original table (001) had phone_number NOT NULL UNIQUE.
-- Zoho contacts rarely have phones here; phones live in customer_phones.
-- We loosen the constraint so the sync can work without a phone number.

alter table public.customers alter column phone_number drop not null;
alter table public.customers drop constraint if exists customers_phone_number_key;

alter table public.customers add column if not exists zoho_contact_id text;
alter table public.customers add column if not exists active           boolean     not null default true;
alter table public.customers add column if not exists synced_at        timestamptz;

create unique index if not exists customers_zoho_contact_id_idx
  on public.customers (zoho_contact_id) where zoho_contact_id is not null;

-- The original RLS only let each user see their own record.
-- The ops dashboard (anon key) needs to read all customers for autocomplete.
drop policy if exists "customer sees own profile" on public.customers;

create policy "public read"  on public.customers for select using (true);
create policy "anon insert"  on public.customers for insert with check (true);
create policy "anon update"  on public.customers for update using (true);
