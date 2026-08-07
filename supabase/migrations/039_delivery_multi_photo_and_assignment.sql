-- Delivery tab: multiple photos per delivery (was a single path), and
-- rider self-assignment. The delivery login is one shared account across
-- every rider, so "who is this" is just a name each rider types into their
-- own device once (kept in the browser, see the frontend's gp_rider_name)
-- rather than a real per-person auth account — this column just records
-- whichever name they typed.

alter table public.orders
  add column if not exists delivery_photo_paths text[] not null default '{}',
  add column if not exists assigned_rider text;

-- Fold any already-captured single photo into the new array so existing
-- deliveries don't lose their photo.
update public.orders
set delivery_photo_paths = array[delivery_photo_path]
where delivery_photo_path is not null
  and coalesce(array_length(delivery_photo_paths,1),0) = 0;

create index if not exists idx_orders_assigned_rider on public.orders(assigned_rider);

-- CREATE OR REPLACE VIEW can only append new columns at the end (see
-- migration 028's fix) — pre-existing columns stay in their prior order,
-- new ones go after.
create or replace view public.order_customer_lookup as
select
  sales_order_id,
  customer_name,
  phone,
  razorpay_url,
  invoice_status,
  status,
  delivery_status,
  delivered_at,
  delivery_notes,
  delivery_photo_path,
  invoice_total,
  payment_collected,
  payment_collected_method,
  payment_collected_at,
  delivery_photo_paths,
  assigned_rider
from public.orders;
