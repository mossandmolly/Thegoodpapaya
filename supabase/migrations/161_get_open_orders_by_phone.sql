-- "My Orders" (storefront orders.html) — mirrors get_invoices_by_phone's
-- shape/matching convention, but for orders that haven't been invoiced
-- yet (invoice_status != 'done'), which invoice_line_items has no rows
-- for at all. Once an order IS invoiced, it drops out of this list
-- entirely and only shows on My Invoices from then on — the two pages
-- are mutually exclusive by design, not a toggle on the same data.
--
-- Unlike invoices (which have a real item_price snapshot from Zoho),
-- these orders have no confirmed price yet — catalog.unit_price/
-- piece_approx_kg are joined in so the client can compute the same
-- approx-price estimate the storefront cart/checkout already show,
-- never a final number.
create or replace function public.get_open_orders_by_phone(p_phone text)
returns table (
  sales_order_id text, customer_name text, created_at timestamptz,
  item_name text, description text, requested_quantity numeric,
  item_status text, unit_price numeric, unit text,
  sold_by_piece boolean, piece_approx_kg numeric, subsection text
)
language sql
stable
security definer
as $$
  select
    o.sales_order_id, o.customer_name, o.created_at,
    oi.item_name, oi.description, oi.requested_quantity, oi.status as item_status,
    c.unit_price, c.unit, c.sold_by_piece, c.piece_approx_kg, c.subsection
  from public.orders o
  join public.order_items oi on oi.sales_order_id = o.sales_order_id
  left join public.catalog c on c.item_name = oi.item_name
  where (o.phone = p_phone or o.phone = '+91' || p_phone or o.phone = regexp_replace(p_phone, '^\+91', ''))
    and coalesce(o.invoice_status, 'pending') != 'done'
    and coalesce(o.status, 'open') != 'cancelled'
    and coalesce(oi.status, 'open') != 'cancelled'
    and o.created_at >= now() - interval '14 days'
  order by o.created_at desc, oi.item_name;
$$;

grant execute on function public.get_open_orders_by_phone(text) to anon;
