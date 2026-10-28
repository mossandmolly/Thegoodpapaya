-- Migration 127: get_invoices_by_phone (migration 104) matched by going
-- phone -> customer_phones.customer_name (picking ONE arbitrary name,
-- limit 1) -> invoice_line_items.customer_name = that exact string. Real
-- customers have 2-3 spelling variants of their name across invoices
-- (e.g. "Somya P" / "Somya Priyadarshini" / "somya p") — any invoice
-- filed under a variant other than the one name customer_phones happened
-- to have on file was silently excluded from what the customer sees.
--
-- invoice_line_items.phone_number already exists and is populated
-- independently per invoice by sync-invoices, resolved from Zoho's own
-- contact id (resolveAndSyncCustomer) — not derived from the name string
-- at all. Matching on it directly sidesteps the name-duplicate problem
-- entirely, rather than working around it.
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
  with recent_invoices as (
    select ili.zoho_invoice_id
    from public.invoice_line_items ili
    where ili.phone_number = p_phone
       or ili.phone_number = '+91' || p_phone
       or ili.phone_number = regexp_replace(p_phone, '^\+91', '')
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
