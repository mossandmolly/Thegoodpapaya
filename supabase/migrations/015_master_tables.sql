-- Item master table for order-entry autocomplete
-- customer_master is NOT needed — customers table already holds all customers (with phone)
-- item_master: local cache of Zoho active items

create table if not exists item_master (
  id         bigserial primary key,
  name       text unique not null,
  unit       text not null default '',
  source     text not null default 'zoho',  -- 'zoho' | 'manual'
  created_at timestamptz default now()
);

alter table item_master enable row level security;

create policy "auth users read item_master"
  on item_master for select to authenticated using (true);
