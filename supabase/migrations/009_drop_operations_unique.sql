-- Migration 009: Drop unique constraint on operations(sales_order_id, item_name)
-- Same sales_order + item_name can appear multiple times (e.g. one free + one charged line)

alter table operations drop constraint if exists operations_sales_order_id_item_name_key;
