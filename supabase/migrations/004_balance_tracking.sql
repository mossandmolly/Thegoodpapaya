-- Migration 004: track outstanding balance and amount paid per invoice
-- Supports partial payment scenarios

alter table invoice_line_items
  add column if not exists balance      numeric,   -- outstanding amount (total - paid)
  add column if not exists amount_paid  numeric;   -- cumulative payments received

-- Update get_invoices_by_phone to return new columns
create or replace function get_invoices_by_phone(p_phone text)
returns table (
  id uuid, customer_name text, phone_number text, invoice_date date,
  invoice_number text, zoho_invoice_id text, item_name text,
  requested_quantity numeric, final_quantity numeric, item_price numeric,
  invoice_total numeric, balance numeric, amount_paid numeric,
  payment_link text, payment_link_id text,
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
  invoice_total numeric, balance numeric, amount_paid numeric,
  payment_link text, payment_link_id text,
  payment_status text, pdf_url text, created_at timestamptz, updated_at timestamptz
)
language sql security definer stable as $$
  select * from invoice_line_items
  where lower(customer_name) = lower(p_name)
  order by invoice_date desc, invoice_number desc;
$$;

grant execute on function get_invoices_by_phone(text)    to anon;
grant execute on function get_invoices_by_customer(text) to anon;
