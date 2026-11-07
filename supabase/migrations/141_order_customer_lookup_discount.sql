-- Expose the new orders.discount_type/discount_value (migration 140)
-- through order_customer_lookup so Order Overview can read and display
-- them — same reasoning as every other column this view adds: orders'
-- RLS locks direct reads to service-role only, so the dashboard goes
-- through this narrow anon-granted view instead of an edge-function round
-- trip for data that's just being displayed/read.
-- CREATE OR REPLACE VIEW (not drop+recreate) is enough here since this only
-- appends columns, no type change on an existing one.
create or replace view public.order_customer_lookup as
select
  sales_order_id, customer_name, phone, razorpay_url, invoice_status, status,
  delivery_status, delivered_at, delivery_notes, delivery_photo_path, invoice_total,
  payment_collected, payment_collected_method, payment_collected_at, delivery_photo_paths,
  assigned_rider, deliver_by, admin_notes, delivered_by, trip_override, deliver_after,
  invoice_downloaded_at, dispatched_at, is_pickup, qr_image_url,
  admin_action_needed, admin_action_reason,
  whatsapp_raw_text, whatsapp_group_name, society, created_at,
  sequence_number, sequenced_at,
  discount_type, discount_value
from public.orders;

grant select on public.order_customer_lookup to anon, authenticated;
