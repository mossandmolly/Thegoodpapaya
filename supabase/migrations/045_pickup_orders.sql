-- "Empty order" / pickup-only orders — a rider needs to go collect
-- something from a customer (e.g. a returned crate), not deliver a sale.
-- No fruit is actually billed, so this must never be gated behind invoice
-- generation the way every other order is (see isFullyInvoiced's
-- short-circuit in parser.html) — it still needs one order_items row to
-- flow through Packer/Delivery's item-driven views, just with no real
-- billing behind it.

alter table public.orders
  add column if not exists is_pickup boolean not null default false;

-- Exposed through the same read-only lookup view the frontend already uses
-- for everything else on orders (orders itself is locked to service-role-
-- only reads). Appended at the end — CREATE OR REPLACE VIEW can only
-- append columns, not reorder existing ones (see migration 028).
create or replace view public.order_customer_lookup as
select
  sales_order_id, customer_name, phone, razorpay_url, invoice_status, status,
  delivery_status, delivered_at, delivery_notes, delivery_photo_path, invoice_total,
  payment_collected, payment_collected_method, payment_collected_at, delivery_photo_paths,
  assigned_rider, deliver_by, admin_notes, delivered_by, trip_override, deliver_after,
  invoice_downloaded_at, dispatched_at, is_pickup
from public.orders;
