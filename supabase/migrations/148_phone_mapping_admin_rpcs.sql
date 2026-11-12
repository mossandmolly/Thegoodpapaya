-- Backs the new ops-dashboard "Phone Lookup" admin tab, which lets
-- Somya/Rohith find and correct a wrong customer-name/phone-number pairing
-- across every place one lives (customer_phones, orders.phone,
-- invoice_line_items.phone_number). Same phone-to-house matching logic
-- used all session via ad hoc SQL, turned into reusable RPCs so the UI
-- doesn't need to replicate the 3-table union/normalization in JS.

-- Every phone number currently mapped to more than one distinct customer
-- name — the CTA list the tab opens on, so a wrong mapping can be found
-- without already knowing which number to go looking for.
create or replace function public.admin_multi_house_numbers()
returns table (phone text, house_count int, houses text[])
language sql
stable
security definer
as $$
  with phone_owners as (
    select phone_number as phone, customer_name from public.customer_phones
    union all
    select phone, customer_name from public.orders where phone is not null and phone <> ''
    union all
    select phone_number, customer_name from public.invoice_line_items where phone_number is not null and phone_number <> ''
  ),
  normalized as (
    select
      right(regexp_replace(phone, '\D', '', 'g'), 10) as phone_norm,
      customer_name
    from phone_owners
    where regexp_replace(phone, '\D', '', 'g') <> ''
  )
  select
    phone_norm,
    count(distinct customer_name)::int,
    array_agg(distinct customer_name order by customer_name)
  from normalized
  group by phone_norm
  having count(distinct customer_name) > 1
  order by count(distinct customer_name) desc, phone_norm;
$$;

grant execute on function public.admin_multi_house_numbers() to authenticated;

-- Every distinct customer name currently associated with one phone number,
-- across the same three tables — drives the "houses mapped to this
-- number" list with ✕/✎ controls once a number is searched or picked from
-- the CTA above.
create or replace function public.admin_houses_for_phone(p_phone text)
returns table (customer_name text)
language sql
stable
security definer
as $$
  with phone_owners as (
    select phone_number as phone, customer_name from public.customer_phones
    union
    select phone, customer_name from public.orders where phone is not null and phone <> ''
    union
    select phone_number, customer_name from public.invoice_line_items where phone_number is not null and phone_number <> ''
  )
  select distinct customer_name
  from phone_owners
  where right(regexp_replace(phone, '\D', '', 'g'), 10)
      = right(regexp_replace(p_phone, '\D', '', 'g'), 10)
  order by customer_name;
$$;

grant execute on function public.admin_houses_for_phone(text) to authenticated;

-- Same join get_invoices_by_phone (migration 142) uses for the customer-
-- facing storefront, minus its invoice_date >= 2026-10-27 cutoff and
-- "10 most recent" limit — the admin tab needs to see everything to find
-- and fix an old wrong mapping, not just what a customer would currently
-- see. Matches on phone_number as given, bare-digit, or +91-prefixed, same
-- as the customer RPC's own fallback pattern.
create or replace function public.admin_invoices_for_phone(p_phone text)
returns table (
  id uuid, customer_name text, phone_number text, invoice_date date,
  invoice_number text, zoho_invoice_id text, item_name text,
  requested_quantity numeric, final_quantity numeric, item_price numeric,
  invoice_total numeric, payment_link text, payment_link_id text,
  payment_status text, pdf_url text, created_at timestamptz, updated_at timestamptz,
  balance numeric, amount_paid numeric, sales_order_id text,
  payment_collected_at timestamptz, discount_type text, discount_value numeric
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
    o.discount_value
  from public.invoice_line_items ili
  left join public.orders o on o.sales_order_id = ili.sales_order_id
  where ili.phone_number = p_phone
     or ili.phone_number = '+91' || p_phone
     or ili.phone_number = regexp_replace(p_phone, '^\+91', '')
  order by ili.invoice_date desc, ili.invoice_number desc;
$$;

grant execute on function public.admin_invoices_for_phone(text) to authenticated;

-- Same shape, matched by a contains-search on customer_name instead of an
-- exact phone — the tab's other search mode ("search by customer name").
create or replace function public.admin_invoices_for_customer_name(p_name text)
returns table (
  id uuid, customer_name text, phone_number text, invoice_date date,
  invoice_number text, zoho_invoice_id text, item_name text,
  requested_quantity numeric, final_quantity numeric, item_price numeric,
  invoice_total numeric, payment_link text, payment_link_id text,
  payment_status text, pdf_url text, created_at timestamptz, updated_at timestamptz,
  balance numeric, amount_paid numeric, sales_order_id text,
  payment_collected_at timestamptz, discount_type text, discount_value numeric
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
    o.discount_value
  from public.invoice_line_items ili
  left join public.orders o on o.sales_order_id = ili.sales_order_id
  where ili.customer_name ilike '%' || p_name || '%'
  order by ili.invoice_date desc, ili.invoice_number desc;
$$;

grant execute on function public.admin_invoices_for_customer_name(text) to authenticated;
