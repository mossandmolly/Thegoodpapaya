-- Migration 007: Website orders from checkout (COD + online)

create table if not exists orders (
  id               uuid primary key default gen_random_uuid(),
  ref              text not null unique,
  customer_name    text not null,
  phone            text not null,
  address          text not null,
  notes            text,
  cart             jsonb not null default '[]',
  total            numeric(10,2) not null,
  payment_method   text not null default 'cod',           -- 'cod' | 'online'
  status           text not null default 'pending',       -- 'pending' | 'awaiting_payment' | 'paid' | 'confirmed' | 'dispatched' | 'delivered' | 'cancelled'
  razorpay_link_id text,
  razorpay_url     text,
  created_at       timestamptz not null default now()
);

alter table orders enable row level security;

-- Service-role key (used by edge functions) bypasses RLS — no public access needed
