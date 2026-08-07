-- Delivery tab enhancements:
--   1. Item table + highlighted total on each card needs orders.invoice_total
--      exposed through order_customer_lookup (per-item amount is computed
--      client-side from catalog.unit_price, but the total shown is the real
--      billed total).
--   2. Payment captured by the delivery rider at drop-off — "Delivered &
--      Paid" vs "Delivered — Not Paid", plus whether it was cash — separate
--      from Zoho/Razorpay's own payment tracking, this is what the rider
--      confirms in the field.

alter table public.orders
  add column if not exists payment_collected boolean not null default false,
  add column if not exists payment_collected_method text
    check (payment_collected_method in ('cash','online')),
  add column if not exists payment_collected_at timestamptz;

-- order_customer_lookup is the narrow view the frontend reads orders
-- through (orders itself is locked to service-role-only reads). Redefined
-- here to add invoice_total and the payment-collected columns.
--
-- CREATE OR REPLACE VIEW can only append new columns at the end — it
-- errors ("cannot change name of view column") if a new column is
-- inserted before an existing one, since that shifts every column after
-- it into a different ordinal position. So the pre-existing columns stay
-- in their original 027 order here and everything new goes after them.
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
  payment_collected_at
from public.orders;
