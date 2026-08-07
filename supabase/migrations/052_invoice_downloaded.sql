-- Tracks when an order's invoice PDF was last successfully pulled from Zoho
-- (via download-invoice), so Orders Overview can show a small check badge
-- instead of ops re-downloading the same invoice unsure whether it's already
-- been fetched. Set server-side by download-invoice itself right after a
-- successful Zoho PDF fetch, so both the single-select and bulk-zip
-- download paths get it, since both go through that one function.

alter table public.orders
  add column if not exists invoice_downloaded_at timestamptz;

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
  deliver_after,
  invoice_downloaded_at
from public.orders;
