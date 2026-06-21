-- Migration 021: Invoice queue retry + order_date on orders
-- • Adds retry_count and last_attempted_at to invoice_queue
-- • Adds order_date to orders (date the order is for, distinct from invoice_date in Zoho)

-- ── invoice_queue: retry support ─────────────────────────────────────────────
ALTER TABLE public.invoice_queue
  ADD COLUMN IF NOT EXISTS retry_count      int         NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempted_at timestamptz;

-- ── orders: order_date ────────────────────────────────────────────────────────
-- The date the delivery/packing is for. Set by all order sources.
-- Defaults to today so existing rows get a sensible value.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS order_date date NOT NULL DEFAULT CURRENT_DATE;

CREATE INDEX IF NOT EXISTS idx_orders_order_date ON public.orders(order_date);
