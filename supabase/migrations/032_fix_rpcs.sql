-- Migration 022: Update phone-lookup RPCs to include new columns
-- invoice_line_items gained: balance, amount_paid, sales_order_id (in 020)
-- RPCs declared a fixed return type that's now missing those columns.
--
-- Both functions' column list changes from whatever the last migration to
-- touch them (004/014b) left behind, so create or replace alone fails with
-- "cannot change return type of existing function" (42P13) — drop first.

DROP FUNCTION IF EXISTS get_invoices_by_phone(text);
CREATE OR REPLACE FUNCTION get_invoices_by_phone(p_phone text)
RETURNS TABLE (
  id                uuid,
  customer_name     text,
  phone_number      text,
  invoice_date      date,
  invoice_number    text,
  zoho_invoice_id   text,
  item_name         text,
  requested_quantity numeric,
  final_quantity    numeric,
  item_price        numeric,
  invoice_total     numeric,
  balance           numeric,
  amount_paid       numeric,
  payment_link      text,
  payment_link_id   text,
  payment_status    text,
  sales_order_id    text,
  pdf_url           text,
  created_at        timestamptz,
  updated_at        timestamptz
)
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT
    id, customer_name, phone_number, invoice_date, invoice_number,
    zoho_invoice_id, item_name, requested_quantity, final_quantity,
    item_price, invoice_total, balance, amount_paid,
    payment_link, payment_link_id, payment_status, sales_order_id,
    pdf_url, created_at, updated_at
  FROM invoice_line_items
  WHERE phone_number = p_phone
  ORDER BY invoice_date DESC, invoice_number DESC;
$$;

DROP FUNCTION IF EXISTS get_invoices_by_customer(text);
CREATE OR REPLACE FUNCTION get_invoices_by_customer(p_name text)
RETURNS TABLE (
  id                uuid,
  customer_name     text,
  phone_number      text,
  invoice_date      date,
  invoice_number    text,
  zoho_invoice_id   text,
  item_name         text,
  requested_quantity numeric,
  final_quantity    numeric,
  item_price        numeric,
  invoice_total     numeric,
  balance           numeric,
  amount_paid       numeric,
  payment_link      text,
  payment_link_id   text,
  payment_status    text,
  sales_order_id    text,
  pdf_url           text,
  created_at        timestamptz,
  updated_at        timestamptz
)
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT
    id, customer_name, phone_number, invoice_date, invoice_number,
    zoho_invoice_id, item_name, requested_quantity, final_quantity,
    item_price, invoice_total, balance, amount_paid,
    payment_link, payment_link_id, payment_status, sales_order_id,
    pdf_url, created_at, updated_at
  FROM invoice_line_items
  WHERE lower(customer_name) = lower(p_name)
  ORDER BY invoice_date DESC, invoice_number DESC;
$$;

GRANT EXECUTE ON FUNCTION get_invoices_by_phone(text)    TO anon;
GRANT EXECUTE ON FUNCTION get_invoices_by_customer(text) TO anon;
