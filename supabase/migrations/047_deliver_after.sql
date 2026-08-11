-- orders.deliver_by already captures a hard latest-time deadline ("need by
-- 4pm"). This adds the mirror image: an earliest-time constraint ("deliver
-- after 4pm", "not before 10am") — a different constraint, not a deadline,
-- so it needs its own field rather than overloading deliver_by. A "between
-- X and Y" instruction sets both fields together (X = deliver_after, Y =
-- deliver_by) — that's the intersection of the two constraints, not a
-- third field.

alter table public.orders
  add column if not exists deliver_after time;

-- Exposed through the same read-only lookup view the frontend already uses
-- for everything else on orders (orders itself is locked to service-role-
-- only reads). Appended at the end — CREATE OR REPLACE VIEW can only
-- append columns, not reorder existing ones (see migration 028).
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
  assigned_rider,
  deliver_by,
  admin_notes,
  delivered_by,
  trip_override,
  deliver_after
from public.orders;
