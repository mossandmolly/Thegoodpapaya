-- Migration 008: Order items + drop legacy operations table

-- ── Order items ───────────────────────────────────────────────────────────
-- One row per line item, expanded from orders.cart at the time of ordering.
-- This is what the packing dashboard reads.

create table order_items (
  id               uuid primary key default gen_random_uuid(),
  order_id         text not null references orders(sales_id) on delete cascade,
  order_date       date not null,
  customer_name    text not null,      -- denormalised from orders for easy querying
  community        text not null,      -- denormalised from orders
  item_name        text not null,
  description      text,              -- customer special requests: pills + per-item notes
  requested_qty    numeric(10,3) not null,
  final_qty        numeric(10,3),     -- filled by packer; null until packed
  status           text not null default 'pending'
                   check (status in ('pending', 'packed', 'adjusted', 'cancelled')),
  created_at       timestamptz not null default now()
);

create index idx_order_items_order_id  on order_items(order_id);
create index idx_order_items_date      on order_items(order_date);
create index idx_order_items_community on order_items(community);
create index idx_order_items_status    on order_items(status);

alter table order_items enable row level security;

-- ── Auto-derive community when not supplied (CSV import path) ─────────────
-- Reuses extract_community() defined in migration 005.
create or replace function orders_set_community()
returns trigger language plpgsql as $$
begin
  if new.community is null or trim(new.community) = '' then
    new.community := extract_community(new.customer_name);
  end if;
  return new;
end;
$$;

create trigger orders_set_community
  before insert or update of customer_name on orders
  for each row execute function orders_set_community();

-- ── Keep communities table in sync from orders ────────────────────────────
create or replace function orders_sync_communities()
returns trigger language plpgsql as $$
begin
  if new.community is not null then
    insert into communities(name) values (new.community)
    on conflict (name) do nothing;
  end if;
  return new;
end;
$$;

create trigger orders_sync_communities
  after insert or update of community on orders
  for each row execute function orders_sync_communities();

-- ── Drop legacy operations table ──────────────────────────────────────────
drop trigger  if exists operations_set_community    on operations;
drop trigger  if exists operations_sync_communities on operations;
drop trigger  if exists operations_updated_at       on operations;
drop table    if exists operations cascade;
drop function if exists set_community()  cascade;
-- extract_community() and update_updated_at() are kept (still used)
