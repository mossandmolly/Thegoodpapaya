-- The Good Papaya — initial schema
-- Run this in Supabase SQL Editor

-- Enable phone auth in Supabase Dashboard → Authentication → Providers → Phone

-- ─────────────────────────────────────────────
-- Core invoice line-items table
-- ─────────────────────────────────────────────
create table if not exists invoice_line_items (
  id                uuid primary key default gen_random_uuid(),

  -- Customer identity
  customer_name     text not null,          -- house number / display name  e.g. "Villa 83"
  phone_number      text not null,          -- +91XXXXXXXXXX  (E.164)

  -- Invoice header (same value repeated for every line of the same invoice)
  invoice_date      date not null,
  invoice_number    text not null,          -- human-readable Zoho invoice #
  zoho_invoice_id   text not null,          -- Zoho's internal UUID/ID

  -- Line item
  item_name         text not null,
  item_quantity     numeric(10,3) not null,
  item_price        numeric(12,2) not null, -- per-unit price

  -- Invoice footer (repeated per line for query convenience)
  invoice_total     numeric(12,2) not null,

  -- Payment
  payment_link      text,                   -- Razorpay short URL
  payment_link_id   text,                   -- Razorpay payment_link id
  payment_status    text not null default 'pending',  -- pending | paid | cancelled
  pdf_url           text,                   -- Zoho PDF link (optional)

  -- Audit
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- Prevent duplicate syncs
  unique (zoho_invoice_id, item_name)
);

-- Auto-update updated_at
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger invoice_line_items_updated_at
  before update on invoice_line_items
  for each row execute procedure set_updated_at();

-- ─────────────────────────────────────────────
-- Customer → phone mapping (separate for lookups)
-- ─────────────────────────────────────────────
create table if not exists customers (
  id              uuid primary key default gen_random_uuid(),
  customer_name   text not null unique,   -- "Villa 83"
  phone_number    text not null unique,   -- +91XXXXXXXXXX
  created_at      timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────
create index idx_line_items_phone        on invoice_line_items(phone_number);
create index idx_line_items_customer     on invoice_line_items(customer_name);
create index idx_line_items_invoice_num  on invoice_line_items(invoice_number);
create index idx_line_items_date         on invoice_line_items(invoice_date desc);
create index idx_line_items_zoho_id      on invoice_line_items(zoho_invoice_id);

-- ─────────────────────────────────────────────
-- Row Level Security
-- Customers can only see their own invoices.
-- The sync-service uses the service-role key (bypasses RLS).
-- ─────────────────────────────────────────────
alter table invoice_line_items enable row level security;
alter table customers           enable row level security;

-- Phone number stored in Supabase auth.users → phone
create policy "customer sees own invoices"
  on invoice_line_items for select
  using (phone_number = (select phone from auth.users where id = auth.uid()));

create policy "customer sees own profile"
  on customers for select
  using (phone_number = (select phone from auth.users where id = auth.uid()));

-- ─────────────────────────────────────────────
-- Seed data — Villa 83, 3 invoices × 3 line items
-- Replace with real data once sync service is running
-- ─────────────────────────────────────────────
insert into customers (customer_name, phone_number) values
  ('Villa 83', '+919999000001')
on conflict do nothing;

insert into invoice_line_items
  (customer_name, phone_number, invoice_date, invoice_number, zoho_invoice_id,
   item_name, item_quantity, item_price, invoice_total, payment_status)
values
  -- Invoice INV-001  total ₹1,500
  ('Villa 83','+919999000001','2026-04-01','INV-001','zoho-inv-001','Alphonso Mangoes',  2,  350.00, 1500.00, 'paid'),
  ('Villa 83','+919999000001','2026-04-01','INV-001','zoho-inv-001','Dragon Fruit',      1,  600.00, 1500.00, 'paid'),
  ('Villa 83','+919999000001','2026-04-01','INV-001','zoho-inv-001','Papaya (1 kg)',     2,  250.00, 1500.00, 'paid'),

  -- Invoice INV-002  total ₹920
  ('Villa 83','+919999000001','2026-04-03','INV-002','zoho-inv-002','Strawberries',      2,  280.00,  920.00, 'pending'),
  ('Villa 83','+919999000001','2026-04-03','INV-002','zoho-inv-002','Kiwi (pack)',       2,  180.00,  920.00, 'pending'),
  ('Villa 83','+919999000001','2026-04-03','INV-002','zoho-inv-002','Lychee (500 g)',    2,  180.00,  920.00, 'pending'),

  -- Invoice INV-003  total ₹1,150
  ('Villa 83','+919999000001','2026-04-06','INV-003','zoho-inv-003','Watermelon (whole)',1,  400.00, 1150.00, 'pending'),
  ('Villa 83','+919999000001','2026-04-06','INV-003','zoho-inv-003','Muskmelon',         1,  350.00, 1150.00, 'pending'),
  ('Villa 83','+919999000001','2026-04-06','INV-003','zoho-inv-003','Chikoo (1 kg)',     2,  200.00, 1150.00, 'pending')
on conflict do nothing;
