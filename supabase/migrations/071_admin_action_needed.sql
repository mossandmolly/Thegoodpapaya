-- Surfaces cases where an automated payment-collection step silently
-- couldn't run — e.g. mark-delivered's switchToPaymentLink skips creating
-- a WhatsApp payment link when there's no phone number on file, which
-- previously left no trace anywhere. Set by whichever function hits the
-- gap, cleared once resolved (a phone gets added and a link successfully
-- generated, or an admin otherwise handles it).
alter table orders add column if not exists admin_action_needed boolean not null default false;
alter table orders add column if not exists admin_action_reason text;

create or replace view public.order_customer_lookup as
select
  sales_order_id, customer_name, phone, razorpay_url, invoice_status, status,
  delivery_status, delivered_at, delivery_notes, delivery_photo_path, invoice_total,
  payment_collected, payment_collected_method, payment_collected_at, delivery_photo_paths,
  assigned_rider, deliver_by, admin_notes, delivered_by, trip_override, deliver_after,
  invoice_downloaded_at, dispatched_at, is_pickup, qr_image_url,
  admin_action_needed, admin_action_reason
from public.orders;
