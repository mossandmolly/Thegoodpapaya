-- Migration 128: get_invoices_by_phone now reads balance/amount_paid/
-- payment_link/payment_status live from orders instead of trusting the
-- copy stored on invoice_line_items. orders is updated continuously after
-- invoice creation (razorpay-webhook on every payment, create-order-
-- payment-link on a manual regenerate) while invoice_line_items' copy of
-- these same fields was only ever as fresh as whichever write path last
-- remembered to update it — a real bug already found and fixed twice
-- this session (create-order-payment-link, generate-invoice's QR/link
-- branching). This closes the whole class of bug rather than relying on
-- every future write path remembering to update both tables.
--
-- invoice_total and the item-level fields stay sourced from
-- invoice_line_items — those only ever change together with a full
-- invoice regeneration (which already rewrites invoice_line_items
-- wholesale in the same call), so there's no equivalent drift risk there.
--
-- razorpay-webhook and create-order-payment-link no longer need to also
-- write these fields onto invoice_line_items as of this migration — see
-- their own updated comments.
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
    ili.id, ili.customer_name, ili.phone_number, ili.invoice_date,
    ili.invoice_number, ili.zoho_invoice_id, ili.item_name,
    ili.requested_quantity, ili.final_quantity, ili.item_price,
    ili.invoice_total,
    o.razorpay_url                                     as payment_link,
    o.razorpay_link_id                                  as payment_link_id,
    case
      when o.balance_due <= 0  then 'paid'
      when o.amount_paid > 0   then 'partially_paid'
      else 'pending'
    end                                                  as payment_status,
    ili.pdf_url, ili.created_at, ili.updated_at,
    coalesce(o.balance_due, ili.balance)                 as balance,
    coalesce(o.amount_paid, ili.amount_paid)             as amount_paid,
    ili.sales_order_id
  from public.invoice_line_items ili
  left join public.orders o on o.sales_order_id = ili.sales_order_id
  where ili.zoho_invoice_id in (select zoho_invoice_id from recent_invoices)
  order by ili.invoice_date desc, ili.invoice_number desc;
$$;

grant execute on function public.get_invoices_by_phone(text) to anon;
