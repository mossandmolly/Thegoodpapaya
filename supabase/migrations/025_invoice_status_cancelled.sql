-- cancel-order now sets orders.invoice_status = 'cancelled' (alongside
-- orders.status = 'cancelled') so the two stay in sync, but the original
-- check constraint from 020_order_pipeline.sql never allowed that value —
-- every cancel-order call has been failing with:
--   new row for relation "orders" violates check constraint
--   "orders_invoice_status_check"
-- since that change went out. Widen the constraint to include it.

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_invoice_status_check;

ALTER TABLE public.orders ADD CONSTRAINT orders_invoice_status_check
  CHECK (invoice_status IN ('pending','queued','processing','done','failed','cancelled'));
