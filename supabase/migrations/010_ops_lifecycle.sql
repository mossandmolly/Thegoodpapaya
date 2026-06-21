-- Migration 010: Ops lifecycle redesign
--
-- Changes:
--   order_items.status   → open | packed | final | invoice_generated | ofd | delivered
--   order_items.item_status → NOBILL | REMOVED (nullable — most items have neither)
--   order_items          → audit columns: packed_by, finalized_by, packed_at, finalized_at
--   orders.status        → expanded to include invoice_generated | ofd
--   orders               → zoho_invoice_id, zoho_invoice_number, zoho_invoice_url
--   orders               → order_date (extracted from sales_id for easy date queries)
--   trigger              → auto-set item_status=NOBILL when description contains
--                          replacement / exchange / sample

-- ── 1. Add item_status column + drop ALL check constraints on order_items ─────
-- (the inline check in migration 008 may have an auto-generated name, so we
--  drop every CHECK constraint on the table rather than guessing the name)
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS item_status TEXT;

DO $$
DECLARE r RECORD;
BEGIN
  -- Use pg_constraint so we can inspect the constraint definition,
  -- and only drop CHECK constraints that reference the 'status' column.
  -- This avoids touching NOT NULL pseudo-constraints.
  FOR r IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'order_items'::regclass
      AND contype  = 'c'
      AND pg_get_constraintdef(oid) LIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE order_items DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

-- ── 2. Migrate old status values ──────────────────────────────────────────────
-- cancelled → REMOVED (item_status) + revert to open
UPDATE order_items
SET item_status = 'REMOVED', status = 'open'
WHERE status = 'cancelled';

-- pending / adjusted → open
UPDATE order_items
SET status = 'open'
WHERE status IN ('pending', 'adjusted');

-- ── 3. Enforce new constraints ─────────────────────────────────────────────────
ALTER TABLE order_items
  ADD CONSTRAINT order_items_status_check
  CHECK (status IN ('open', 'packed', 'final', 'invoice_generated', 'ofd', 'delivered'));

ALTER TABLE order_items
  ADD CONSTRAINT order_items_item_status_check
  CHECK (item_status IN ('NOBILL', 'REMOVED'));

-- ── 4. Audit columns ──────────────────────────────────────────────────────────
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS packed_by     TEXT;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS finalized_by  TEXT;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS packed_at     TIMESTAMPTZ;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS finalized_at  TIMESTAMPTZ;

-- ── 5. Expand orders status ───────────────────────────────────────────────────
ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders
  ADD  CONSTRAINT orders_status_check
  CHECK (status IN (
    'placed', 'awaiting_payment', 'paid',
    'invoice_generated', 'ofd', 'delivered', 'cancelled'
  ));

-- ── 6. Zoho invoice tracking ──────────────────────────────────────────────────
ALTER TABLE orders ADD COLUMN IF NOT EXISTS zoho_invoice_id     TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS zoho_invoice_number TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS zoho_invoice_url    TEXT;

-- ── 7. order_date on orders (extracted from sales_id YYYY-MM-DD prefix) ───────
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_date DATE;

UPDATE orders
SET order_date = (
  -- sales_id format: YYYY-MM-DD-... so the first 10 chars are the date
  CAST(LEFT(sales_id, 10) AS DATE)
)
WHERE order_date IS NULL
  AND sales_id ~ '^\d{4}-\d{2}-\d{2}-';

CREATE INDEX IF NOT EXISTS idx_orders_order_date ON orders(order_date);

-- ── 8. Auto-NOBILL trigger ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION order_items_auto_nobill()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.item_status IS NULL AND NEW.description IS NOT NULL AND (
    LOWER(NEW.description) LIKE '%replacement%' OR
    LOWER(NEW.description) LIKE '%exchange%'    OR
    LOWER(NEW.description) LIKE '%sample%'
  ) THEN
    NEW.item_status := 'NOBILL';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS order_items_auto_nobill ON order_items;
CREATE TRIGGER order_items_auto_nobill
  BEFORE INSERT OR UPDATE OF description ON order_items
  FOR EACH ROW EXECUTE FUNCTION order_items_auto_nobill();
