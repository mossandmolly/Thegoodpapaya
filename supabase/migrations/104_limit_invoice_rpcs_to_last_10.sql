-- Both get_invoices_by_phone and get_invoices_by_customer (migration 103)
-- return every invoice a customer has ever had, unbounded — fine for a new
-- customer, unwieldy for a long-time one. Capped to the 10 most RECENT
-- distinct invoices. A flat `limit 10` on the raw query would be wrong
-- here (invoice_line_items is one row PER ITEM, not per invoice — that
-- would cut an invoice off mid-item-list instead of limiting invoice
-- count), so this first picks the 10 most recent zoho_invoice_ids, then
-- returns every line item belonging to just those.
drop function if exists public.get_invoices_by_phone(text);
create or replace function public.get_invoices_by_phone(p_phone text)
returns table (
  id uuid, customer_name text, phone_number text, invoice_date date,
  invoice_number text, zoho_invoice_id text, item_name text,
  requested_quantity numeric, final_quantity numeric, item_price numeric,
  invoice_total numeric, payment_link text, payment_link_id text,
  payment_status text, pdf_url text, created_at timestamptz, updated_at timestamptz,
  balance numeric, amount_paid numeric, sales_order_id text
)
language sql
stable
security definer
as $$
  with cust as (
    select cp.customer_name from public.customer_phones cp
    where cp.phone_number = p_phone
    limit 1
  ),
  recent_invoices as (
    select ili.zoho_invoice_id
    from public.invoice_line_items ili, cust
    where ili.customer_name = cust.customer_name
    group by ili.zoho_invoice_id, ili.invoice_date, ili.invoice_number
    order by ili.invoice_date desc, ili.invoice_number desc
    limit 10
  )
  select
    id, customer_name, phone_number, invoice_date,
    invoice_number, zoho_invoice_id, item_name,
    requested_quantity, final_quantity, item_price,
    invoice_total, payment_link, payment_link_id,
    payment_status, pdf_url, created_at, updated_at,
    balance, amount_paid, sales_order_id
  from public.invoice_line_items
  where zoho_invoice_id in (select zoho_invoice_id from recent_invoices)
  order by invoice_date desc, invoice_number desc;
$$;

grant execute on function public.get_invoices_by_phone(text) to anon;

drop function if exists public.get_invoices_by_customer(text);
create or replace function public.get_invoices_by_customer(p_name text)
returns table (
  id uuid, customer_name text, phone_number text, invoice_date date,
  invoice_number text, zoho_invoice_id text, item_name text,
  requested_quantity numeric, final_quantity numeric, item_price numeric,
  invoice_total numeric, payment_link text, payment_link_id text,
  payment_status text, pdf_url text, created_at timestamptz, updated_at timestamptz,
  balance numeric, amount_paid numeric, sales_order_id text
)
language sql
stable
security definer
as $$
  with recent_invoices as (
    select ili.zoho_invoice_id
    from public.invoice_line_items ili
    where lower(ili.customer_name) = lower(p_name)
    group by ili.zoho_invoice_id, ili.invoice_date, ili.invoice_number
    order by ili.invoice_date desc, ili.invoice_number desc
    limit 10
  )
  select
    id, customer_name, phone_number, invoice_date,
    invoice_number, zoho_invoice_id, item_name,
    requested_quantity, final_quantity, item_price,
    invoice_total, payment_link, payment_link_id,
    payment_status, pdf_url, created_at, updated_at,
    balance, amount_paid, sales_order_id
  from public.invoice_line_items
  where zoho_invoice_id in (select zoho_invoice_id from recent_invoices)
  order by invoice_date desc, invoice_number desc;
$$;

grant execute on function public.get_invoices_by_customer(text) to anon;
