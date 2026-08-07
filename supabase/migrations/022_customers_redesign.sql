-- Migration 014: Customers table redesign
--
-- Problem with old design:
--   customers had customer_name UNIQUE + phone_number UNIQUE (one phone per household)
--   customer_phones held extra phones, but was a separate lookup
--   Composite PK (customer_name, phone_number) was considered but rejected:
--   you cannot add a customer to the customers table without a phone number,
--   which breaks everyone who orders via CSV or spoken entry.
--
-- New design:
--   customers(customer_name PK)          — household registry, phone NOT required
--   customer_phones(customer_name, phone_number composite PK)  — phones, optional
--
-- Impact of an order existing without a matching customers row:
--   ✓ Ops (packing, checking, invoicing)  — unaffected, reads orders/order_items directly
--   ✗ Website customer login              — can't look up invoices by phone
-- So we auto-create a customers row whenever an order is inserted.
-- That way orders are never orphaned.

-- ── 1. New customers table (phone-free) ────────────────────────────────────────
CREATE TABLE customers_new (
  customer_name TEXT        PRIMARY KEY,   -- "Villa 23", always set from order
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 2. New customer_phones table ─────────────────────────────────────────────
CREATE TABLE customer_phones_new (
  customer_name TEXT        NOT NULL REFERENCES customers_new(customer_name)
                            ON UPDATE CASCADE ON DELETE CASCADE,
  phone_number  TEXT        NOT NULL,
  label         TEXT        NOT NULL DEFAULT 'primary',  -- primary | spouse | member | work
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_name, phone_number)
);

-- One phone belongs to exactly one household globally
CREATE UNIQUE INDEX idx_customer_phones_new_phone ON customer_phones_new(phone_number);
CREATE INDEX idx_customer_phones_new_name ON customer_phones_new(customer_name);

-- ── 3. Migrate data ─────────────────────────────────────────────────────────────────
INSERT INTO customers_new (customer_name, created_at)
  SELECT customer_name, created_at FROM customers
ON CONFLICT DO NOTHING;

INSERT INTO customer_phones_new (customer_name, phone_number, label, created_at)
  SELECT customer_name, phone_number, 'primary', created_at
  FROM customers
  WHERE phone_number IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO customer_phones_new (customer_name, phone_number, label, created_at)
  SELECT cp.customer_name, cp.phone_number, COALESCE(cp.label, 'member'), cp.created_at
  FROM customer_phones cp
  WHERE EXISTS (
    SELECT 1 FROM customers_new cn WHERE cn.customer_name = cp.customer_name
  )
ON CONFLICT DO NOTHING;

-- Also seed customers_new from orders for any customer_name not yet in customers
INSERT INTO customers_new (customer_name)
  SELECT DISTINCT customer_name FROM orders
  WHERE customer_name IS NOT NULL
ON CONFLICT DO NOTHING;

-- ── 4. Swap tables ────────────────────────────────────────────────────────────────
DROP TABLE customer_phones;   -- replaced by customer_phones_new
DROP TABLE customers;         -- replaced by customers_new
                              -- CASCADE drops FK from customer_notes automatically

ALTER TABLE customers_new      RENAME TO customers;
ALTER TABLE customer_phones_new RENAME TO customer_phones;

-- ── 5. Restore customer_notes FK ──────────────────────────────────────────────
-- customer_name is now a clean PK on customers, so FK works again
ALTER TABLE customer_notes
  ADD CONSTRAINT customer_notes_customer_name_fkey
  FOREIGN KEY (customer_name)
  REFERENCES customers(customer_name)
  ON UPDATE CASCADE ON DELETE CASCADE;

-- ── 6. RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE customers       ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_phones ENABLE ROW LEVEL SECURITY;

-- Customer can see their own household record
CREATE POLICY customers_own ON customers FOR SELECT TO anon
  USING (
    customer_name = (
      SELECT cp.customer_name FROM customer_phones cp
      WHERE cp.phone_number = (SELECT phone FROM auth.users WHERE id = auth.uid())
      LIMIT 1
    )
  );

-- Customer can see all phones for their household
CREATE POLICY customer_phones_own ON customer_phones FOR SELECT TO anon
  USING (
    customer_name = (
      SELECT cp2.customer_name FROM customer_phones cp2
      WHERE cp2.phone_number = (SELECT phone FROM auth.users WHERE id = auth.uid())
      LIMIT 1
    )
  );

-- ── 7. Auto-create customer row on every order insert ─────────────────────────
-- Ensures orders are never orphaned: every order's customer_name
-- is guaranteed to exist in customers, even before a phone is collected.
CREATE OR REPLACE FUNCTION orders_ensure_customer()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO customers (customer_name)
  VALUES (NEW.customer_name)
  ON CONFLICT DO NOTHING;

  -- If the order carries a phone, add it to customer_phones too
  IF NEW.phone IS NOT NULL THEN
    INSERT INTO customer_phones (customer_name, phone_number, label)
    VALUES (NEW.customer_name, NEW.phone, 'primary')
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_ensure_customer
  AFTER INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_ensure_customer();

-- ── 8. Update invoice lookup RPC ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_invoices_by_phone(p_phone text)
RETURNS TABLE (
  id uuid, customer_name text, phone_number text, invoice_date date,
  invoice_number text, zoho_invoice_id text, item_name text,
  requested_quantity numeric, final_quantity numeric, item_price numeric,
  invoice_total numeric, payment_link text, payment_link_id text,
  payment_status text, pdf_url text, created_at timestamptz, updated_at timestamptz,
  balance numeric, amount_paid numeric
)
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT ili.*
  FROM invoice_line_items ili
  WHERE ili.customer_name = (
    SELECT cp.customer_name
    FROM customer_phones cp
    WHERE cp.phone_number = p_phone
    LIMIT 1
  )
  ORDER BY ili.invoice_date DESC, ili.invoice_number DESC;
$$;

GRANT EXECUTE ON FUNCTION get_invoices_by_phone(text) TO anon;
