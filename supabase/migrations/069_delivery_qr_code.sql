-- Razorpay Dynamic QR Code (a real Razorpay product — /v1/payments/qr_codes)
-- shown on the Delivery panel for each OFD order, generated automatically
-- by dispatch-order the moment an order flips to 'ofd'. Separate from
-- razorpay_link_id/razorpay_url, which stay exactly as-is for the manual
-- "Generate Payment Link" flow on Order Overview — that one no longer
-- feeds the Delivery panel's QR display.
alter table orders add column if not exists qr_code_id  text;
alter table orders add column if not exists qr_image_url text;

-- CREATE OR REPLACE VIEW can only append columns, not reorder existing
-- ones (see migration 028) — appended at the end, same as every other
-- column added to this view since 055.
create or replace view public.order_customer_lookup as
select
  sales_order_id, customer_name, phone, razorpay_url, invoice_status, status,
  delivery_status, delivered_at, delivery_notes, delivery_photo_path, invoice_total,
  payment_collected, payment_collected_method, payment_collected_at, delivery_photo_paths,
  assigned_rider, deliver_by, admin_notes, delivered_by, trip_override, deliver_after,
  invoice_downloaded_at, dispatched_at, is_pickup, qr_image_url
from public.orders;
