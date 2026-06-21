-- Migration 007: Website orders table (revised)
-- Note: replaces the earlier draft of this migration

drop table if exists orders cascade;

create table orders (
  sales_id         text primary key,
  -- sales_id format: YYYY-MM-DD-CustomerName  e.g. 2026-05-07-APR-Villas-83

  customer_name    text not null,   -- community + door number  e.g. "APR Villas 83"
  community        text not null,   -- "APR Villas" — explicit from website, derived for CSV
  phone            text,            -- mandatory for website orders, optional for CSV
  payment_method   text not null default 'cod',   -- 'cod' | 'online'
  status           text not null default 'placed'
                   check (status in ('placed', 'delivered', 'cancelled')),
  cart             jsonb not null default '[]',   -- raw cart snapshot
  total            numeric(10,2) not null default 0,
  notes            text,
  razorpay_link_id text,
  razorpay_url     text,
  created_at       timestamptz not null default now()
);

create index idx_orders_community  on orders(community);
create index idx_orders_status     on orders(status);
create index idx_orders_date       on orders(created_at desc);

alter table orders enable row level security;
-- service role key (edge functions) bypasses RLS — no public access
