-- orders.society (migration 081) needs to also be exposed through
-- order_customer_lookup — the frontend reads orders through this view, not
-- the raw table, same reasoning as every other column added to it since 038.
create or replace view public.order_customer_lookup as
select
  sales_order_id, customer_name, phone, razorpay_url, invoice_status, status,
  delivery_status, delivered_at, delivery_notes, delivery_photo_path, invoice_total,
  payment_collected, payment_collected_method, payment_collected_at, delivery_photo_paths,
  assigned_rider, deliver_by, admin_notes, delivered_by, trip_override, deliver_after,
  invoice_downloaded_at, dispatched_at, is_pickup, qr_image_url,
  admin_action_needed, admin_action_reason,
  whatsapp_raw_text, whatsapp_group_name, society
from public.orders;

-- create or replace view has, at least once before (see the
-- whatsapp_pending_review incident), silently reset SELECT grants on this
-- view for anon/authenticated even though no prior migration touching it
-- ever needed an explicit grant — re-asserting it here rather than risk a
-- repeat "permission denied for view order_customer_lookup" that blocks
-- every order-pushing path, not just this one column.
grant select on public.order_customer_lookup to anon, authenticated;
