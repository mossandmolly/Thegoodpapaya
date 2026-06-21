-- Migration 002: phone-number lookup RPC (no-auth mode)
--
-- Allows the frontend (anon key) to fetch invoices for a given phone number
-- WITHOUT requiring Supabase Auth / OTP.
-- The phone number itself acts as the access credential for now.
-- Once OTP is live, this function stays but the frontend will also gate
-- behind a verified Supabase session.
--
-- Run in Supabase SQL Editor AFTER 001_initial_schema.sql

create or replace function get_invoices_by_phone(p_phone text)
returns table (
  id                uuid,
  customer_name     text,
  phone_number      text,
  invoice_date      date,
  invoice_number    text,
  zoho_invoice_id   text,
  item_name         text,
  requested_quantity numeric,
  final_quantity    numeric,
  item_price        numeric,
  invoice_total     numeric,
  payment_link      text,
  payment_link_id   text,
  payment_status    text,
  pdf_url           text,
  created_at        timestamptz,
  updated_at        timestamptz
)
language sql
security definer   -- runs as postgres, bypasses RLS
stable
as $$
  select *
  from invoice_line_items
  where phone_number = p_phone
  order by invoice_date desc, invoice_number desc;
$$;

-- Also allow lookup by customer name (house number) in case user types that instead
create or replace function get_invoices_by_customer(p_name text)
returns table (
  id                uuid,
  customer_name     text,
  phone_number      text,
  invoice_date      date,
  invoice_number    text,
  zoho_invoice_id   text,
  item_name         text,
  requested_quantity numeric,
  final_quantity    numeric,
  item_price        numeric,
  invoice_total     numeric,
  payment_link      text,
  payment_link_id   text,
  payment_status    text,
  pdf_url           text,
  created_at        timestamptz,
  updated_at        timestamptz
)
language sql
security definer
stable
as $$
  select *
  from invoice_line_items
  where lower(customer_name) = lower(p_name)
  order by invoice_date desc, invoice_number desc;
$$;

-- Grant execute to anon role (used by Supabase JS client with anon key)
grant execute on function get_invoices_by_phone(text)     to anon;
grant execute on function get_invoices_by_customer(text)  to anon;
