-- Phone Lookup is getting its own Mark as Paid action (same gate, same
-- flow, same mark-order-paid edge function as Order Overview) — but
-- mark-order-paid's own frontend gating (isPickup, cancelled, rider's
-- pending-verification claim) reads fields these two RPCs never returned,
-- since until now the tab only ever displayed data, never acted on it.
create or replace function public.admin_invoices_for_phone(p_phone text)
returns table (
  id uuid, customer_name text, phone_number text, invoice_date date,
  invoice_number text, zoho_invoice_id text, item_name text,
  requested_quantity numeric, final_quantity numeric, item_price numeric,
  invoice_total numeric, payment_link text, payment_link_id text,
  payment_status text, pdf_url text, created_at timestamptz, updated_at timestamptz,
  balance numeric, amount_paid numeric, sales_order_id text,
  payment_collected_at timestamptz, discount_type text, discount_value numeric,
  payment_collected boolean, is_pickup boolean, order_status text,
  payment_pending_verification boolean, payment_claimed_method text,
  payment_claimed_at timestamptz, payment_claimed_by text
)
language sql
stable
security definer
as $$
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
    ili.sales_order_id,
    o.payment_collected_at,
    o.discount_type,
    o.discount_value,
    o.payment_collected,
    o.is_pickup,
    o.status                                             as order_status,
    o.payment_pending_verification,
    o.payment_claimed_method,
    o.payment_claimed_at,
    o.payment_claimed_by
  from public.invoice_line_items ili
  left join public.orders o on o.sales_order_id = ili.sales_order_id
  where (ili.phone_number = p_phone
     or ili.phone_number = '+91' || p_phone
     or ili.phone_number = regexp_replace(p_phone, '^\+91', ''))
    and ili.invoice_date >= date '2026-10-27'
  order by ili.invoice_date desc, ili.invoice_number desc;
$$;

grant execute on function public.admin_invoices_for_phone(text) to authenticated;

create or replace function public.admin_invoices_for_customer_name(p_name text)
returns table (
  id uuid, customer_name text, phone_number text, invoice_date date,
  invoice_number text, zoho_invoice_id text, item_name text,
  requested_quantity numeric, final_quantity numeric, item_price numeric,
  invoice_total numeric, payment_link text, payment_link_id text,
  payment_status text, pdf_url text, created_at timestamptz, updated_at timestamptz,
  balance numeric, amount_paid numeric, sales_order_id text,
  payment_collected_at timestamptz, discount_type text, discount_value numeric,
  payment_collected boolean, is_pickup boolean, order_status text,
  payment_pending_verification boolean, payment_claimed_method text,
  payment_claimed_at timestamptz, payment_claimed_by text
)
language sql
stable
security definer
as $$
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
    ili.sales_order_id,
    o.payment_collected_at,
    o.discount_type,
    o.discount_value,
    o.payment_collected,
    o.is_pickup,
    o.status                                             as order_status,
    o.payment_pending_verification,
    o.payment_claimed_method,
    o.payment_claimed_at,
    o.payment_claimed_by
  from public.invoice_line_items ili
  left join public.orders o on o.sales_order_id = ili.sales_order_id
  where ili.customer_name ilike '%' || p_name || '%'
    and ili.invoice_date >= date '2026-10-27'
  order by ili.invoice_date desc, ili.invoice_number desc;
$$;

grant execute on function public.admin_invoices_for_customer_name(text) to authenticated;
