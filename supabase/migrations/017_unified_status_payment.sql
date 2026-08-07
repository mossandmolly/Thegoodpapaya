-- Migration 012: Unified status lifecycle + separate payment_status
--
-- orders.status and order_items.status now share the same values:
--   open | packed | final | invoice_generated | ofd | delivered | cancelled
--
-- Payment tracking moves to orders.payment_status:
--   paid | partially_paid | due_today | overdue
--   (UI computes "overdue by X days" from payment_due_date)

-- ── 1. order_items: add 'cancelled' to status constraint ─────────────────────
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'order_items'::regclass
      AND contype  = 'c'
      AND pg_get_constraintdef(oid) LIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE order_items DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE order_items
  ADD CONSTRAINT order_items_status_check
  CHECK (status IN ('open','packed','final','invoice_generated','ofd','delivered','cancelled'));

-- ── 2. orders: migrate old status values → unified lifecycle ──────────────────
-- Drop all existing status check constraints first
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'orders'::regclass
      AND contype  = 'c'
      AND pg_get_constraintdef(oid) LIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE orders DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

UPDATE orders SET status = 'open'
  WHERE status IN ('placed', 'awaiting_payment', 'paid');

-- ── 3. orders: add unified status constraint ──────────────────────────────────
ALTER TABLE orders
  ADD CONSTRAINT orders_status_check
  CHECK (status IN ('open','packed','final','invoice_generated','ofd','delivered','cancelled'));

ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'open';

-- ── 4. orders: add payment_status column ─────────────────────────────────────
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS payment_status TEXT
  CHECK (payment_status IN ('paid','partially_paid','due_today','overdue'))
  DEFAULT 'due_today';

-- ── 5. orders: payment tracking columns ──────────────────────────────────────
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_due_date DATE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS amount_paid      NUMERIC(10,2) NOT NULL DEFAULT 0;

-- ── 6. Backfill payment_status for existing orders ────────────────────────────
-- Online orders that reached us are effectively paid (Razorpay confirmed)
UPDATE orders
  SET payment_status = 'paid',
      amount_paid    = total
  WHERE payment_method = 'online'
    AND razorpay_url IS NOT NULL;

-- Delivered COD orders with no payment recorded → overdue
UPDATE orders
  SET payment_status = 'overdue'
  WHERE status = 'delivered'
    AND payment_method = 'cod'
    AND amount_paid = 0;

-- Everything else (open COD orders) → due_today (default already set)

CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders(payment_status);
