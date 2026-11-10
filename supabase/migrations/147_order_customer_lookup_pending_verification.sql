-- Expose the new orders.payment_pending_verification/payment_claimed_*
-- (migration 146) through order_customer_lookup so Order Overview and the
-- Delivery panel can show "PAID – PENDING VERIFICATION" instead of a flat
-- PAID for a rider's unverified claim.
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
  discount_type, discount_value,
  payment_refunded, refunded_at, refund_amount, refund_reason,
  payment_pending_verification, payment_claimed_method, payment_claimed_at, payment_claimed_by
from public.orders;

grant select on public.order_customer_lookup to anon, authenticated;
