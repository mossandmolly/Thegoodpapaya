-- Exposes orders.created_at through order_customer_lookup so Order Overview
-- can show when each order actually landed in the system (DB insert time —
-- not the exact WhatsApp message send time, which isn't captured anywhere
-- today; created_at is the closest available timestamp).
create or replace view public.order_customer_lookup as
select
  sales_order_id, customer_name, phone, razorpay_url, invoice_status, status,
  delivery_status, delivered_at, delivery_notes, delivery_photo_path, invoice_total,
  payment_collected, payment_collected_method, payment_collected_at, delivery_photo_paths,
  assigned_rider, deliver_by, admin_notes, delivered_by, trip_override, deliver_after,
  invoice_downloaded_at, dispatched_at, is_pickup, qr_image_url,
  admin_action_needed, admin_action_reason,
  whatsapp_raw_text, whatsapp_group_name, society, created_at
from public.orders;

-- create or replace view has reset SELECT grants on this view before (see
-- migration 082's note) — re-asserting rather than risk a repeat.
grant select on public.order_customer_lookup to anon, authenticated;
