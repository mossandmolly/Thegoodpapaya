-- Migration 014: customers table — composite primary key
-- New design: (customer_name, phone_number) is the PK.
-- One row per household member.
-- customer_name (society + door number) is the household key.
-- Multiple rows with the same customer_name = multiple people in that household.
-- customer_phones table is absorbed and dropped.
--
-- How orders link to customers:
--   orders.customer_name = customers.customer_name
--   (no FK enforced — spoken/CSV orders arrive before phone is collected,
--    but customer_name is always present and always the link)

-- ── 1. Create new customers table ────────────────────────────────────────────
CREATE TABLE customers_new (
  customer_name TEXT        NOT NULL,               -- household: e.g. "Villa 23"
  phone_number  TEXT        NOT NULL,               -- individual mobile: +91XXXXXXXXXX
  label         TEXT        NOT NULL DEFAULT 'primary',  -- primary | spouse | member | work
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_name, phone_number)
);

-- A phone number belongs to exactly one household globally
CREATE UNIQUE INDEX idx_customers_phone ON customers_new(phone_number);
-- Fast lookup of all members of a household
CREATE INDEX idx_customers_name ON customers_new(customer_name);

-- ── 2. Migrate existing data ──────────────────────────────────────────────────
-- Primary phones from old customers table
INSERT INTO customers_new (customer_name, phone_number, label, created_at)
  SELECT customer_name, phone_number, 'primary', created_at
  FROM customers
  WHERE phone_number IS NOT NULL
ON CONFLICT DO NOTHING;

-- Additional phones from customer_phones table
INSERT INTO customers_new (customer_name, phone_number, label, created_at)
  SELECT customer_name, phone_number, COALESCE(label, 'member'), created_at
  FROM customer_phones
ON CONFLICT DO NOTHING;

-- ── 3. Drop old tables ────────────────────────────────────────────────────────
-- customer_notes has a FK on customers(customer_name) — drop it first.
-- customer_name is still the household key in customer_notes; the FK just
-- can't point to a composite-PK table, so we enforce this in app code instead.
ALTER TABLE customer_notes
  DROP CONSTRAINT IF EXISTS customer_notes_customer_name_fkey;

DROP TABLE customer_phones;   -- absorbed into customers_new
DROP TABLE customers;         -- replaced by customers_new

ALTER TABLE customers_new RENAME TO customers;

-- ── 4. RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;

-- A logged-in user can see all members of their household
-- (any phone in that household gives access to the full household record)
CREATE POLICY customers_own_household ON customers
  FOR SELECT TO anon
  USING (
    customer_name = (
      SELECT customer_name FROM customers
      WHERE phone_number = (SELECT phone FROM auth.users WHERE id = auth.uid())
      LIMIT 1
    )
  );

-- ── 5. Update get_invoices_by_phone RPC ───────────────────────────────────────
-- Was looking up via customer_phones; now looks up via customers directly.
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
    SELECT c.customer_name
    FROM customers c
    WHERE c.phone_number = p_phone
    LIMIT 1
  )
  ORDER BY ili.invoice_date DESC, ili.invoice_number DESC;
$$;

GRANT EXECUTE ON FUNCTION get_invoices_by_phone(text) TO anon;
