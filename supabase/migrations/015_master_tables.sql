-- Customer and item master tables for order-entry autocomplete
-- customer_master: supplements the existing customers table (no phone required)
-- item_master: stores Zoho active items + any manually added items

create table if not exists customer_master (
  id         bigserial primary key,
  name       text unique not null,
  source     text not null default 'zoho',  -- 'zoho' | 'manual'
  created_at timestamptz default now()
);

create table if not exists item_master (
  id         bigserial primary key,
  name       text unique not null,
  unit       text not null default '',
  source     text not null default 'zoho',  -- 'zoho' | 'manual'
  created_at timestamptz default now()
);

-- Ops staff can read both tables (authenticated users)
alter table customer_master enable row level security;
alter table item_master      enable row level security;

create policy "auth users read customer_master"
  on customer_master for select to authenticated using (true);

create policy "auth users read item_master"
  on item_master for select to authenticated using (true);
