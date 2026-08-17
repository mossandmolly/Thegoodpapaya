-- The WhatsApp listener now creates real orders directly (via the new
-- whatsapp-create-order function) instead of only landing in
-- whatsapp_parsed_orders for manual review on the Live tab — that page
-- stays as-is, this is an additional, more direct path. Items created this
-- way start flagged pending_review so ops can verify the AI got them right
-- before they flow into packing/invoicing; approving just clears the flag.
alter table order_items add column if not exists pending_review boolean not null default false;

-- The original WhatsApp message(s) that produced this order, shown right
-- on the Order Overview card so a mistake can be corrected by comparing
-- against what the customer actually typed, without needing the separate
-- Live tab.
alter table orders add column if not exists whatsapp_raw_text text;
alter table orders add column if not exists whatsapp_group_name text;

-- CREATE OR REPLACE VIEW can only append columns, not reorder existing
-- ones — see 038_delivery_payment_and_invoice_total.sql for the first
-- column added to this view since 055.
create or replace view public.order_customer_lookup as
select
  sales_order_id, customer_name, phone, razorpay_url, invoice_status, status,
  delivery_status, delivered_at, delivery_notes, delivery_photo_path, invoice_total,
  payment_collected, payment_collected_method, payment_collected_at, delivery_photo_paths,
  assigned_rider, deliver_by, admin_notes, delivered_by, trip_override, deliver_after,
  invoice_downloaded_at, dispatched_at, is_pickup, qr_image_url,
  admin_action_needed, admin_action_reason,
  whatsapp_raw_text, whatsapp_group_name
from public.orders;
