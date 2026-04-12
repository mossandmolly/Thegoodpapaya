-- Migration 003: multi-phone support per household
-- Run AFTER 001 and 002

-- ─────────────────────────────────────────────
-- New table: one row per phone number per household
-- ─────────────────────────────────────────────
create table if not exists customer_phones (
  id            uuid primary key default gen_random_uuid(),
  customer_name text not null references customers(customer_name) on update cascade on delete cascade,
  phone_number  text not null,
  label         text,              -- e.g. 'mobile', 'landline', 'spouse'
  created_at    timestamptz not null default now(),
  unique (customer_name, phone_number)  -- same phone can't appear twice for same customer
);

-- A phone number must be unique globally (can't belong to two households)
create unique index idx_customer_phones_phone on customer_phones(phone_number);

create index idx_customer_phones_customer on customer_phones(customer_name);

-- ─────────────────────────────────────────────
-- Migrate existing data from customers.phone_number
-- ─────────────────────────────────────────────
insert into customer_phones (customer_name, phone_number, label)
select customer_name, phone_number, 'primary'
from customers
where phone_number is not null
on conflict do nothing;

-- ─────────────────────────────────────────────
-- Update RPCs to look up via customer_phones
-- Any phone from the household returns ALL invoices for that household
-- ─────────────────────────────────────────────
create or replace function get_invoices_by_phone(p_phone text)
returns table (
  id uuid, customer_name text, phone_number text, invoice_date date,
  invoice_number text, zoho_invoice_id text, item_name text,
  requested_quantity numeric, final_quantity numeric, item_price numeric,
  invoice_total numeric, payment_link text, payment_link_id text,
  payment_status text, pdf_url text, created_at timestamptz, updated_at timestamptz
)
language sql security definer stable as $$
  select ili.*
  from invoice_line_items ili
  where ili.customer_name = (
    select cp.customer_name
    from customer_phones cp
    where cp.phone_number = p_phone
    limit 1
  )
  order by ili.invoice_date desc, ili.invoice_number desc;
$$;

create or replace function get_invoices_by_customer(p_name text)
returns table (
  id uuid, customer_name text, phone_number text, invoice_date date,
  invoice_number text, zoho_invoice_id text, item_name text,
  requested_quantity numeric, final_quantity numeric, item_price numeric,
  invoice_total numeric, payment_link text, payment_link_id text,
  payment_status text, pdf_url text, created_at timestamptz, updated_at timestamptz
)
language sql security definer stable as $$
  select * from invoice_line_items
  where lower(customer_name) = lower(p_name)
  order by invoice_date desc, invoice_number desc;
$$;

grant execute on function get_invoices_by_phone(text)    to anon;
grant execute on function get_invoices_by_customer(text) to anon;

-- ─────────────────────────────────────────────
-- Seed: add second phone for Villa 83 as example
-- ─────────────────────────────────────────────
insert into customer_phones (customer_name, phone_number, label) values
  ('Villa 83', '+919999000002', 'spouse')
on conflict do nothing;
