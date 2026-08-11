-- Migration 014 resume: run this if 014_customers_redesign.sql failed at step 5
-- (FK restore failed because customer_notes had names not present in customers)
--
-- The tables are already correctly swapped. This picks up from where it failed.

-- ── 1. Seed any customer_name in customer_notes that isn't in customers yet
INSERT INTO customers (customer_name)
  SELECT DISTINCT customer_name FROM customer_notes
  WHERE customer_name IS NOT NULL
ON CONFLICT DO NOTHING;

-- ── 2. Add the FK (was failing before due to missing names above)
ALTER TABLE customer_notes
  DROP CONSTRAINT IF EXISTS customer_notes_customer_name_fkey;

ALTER TABLE customer_notes
  ADD CONSTRAINT customer_notes_customer_name_fkey
  FOREIGN KEY (customer_name)
  REFERENCES customers(customer_name)
  ON UPDATE CASCADE ON DELETE CASCADE;

-- ── 3. RLS
ALTER TABLE customers       ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_phones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS customers_own       ON customers;
DROP POLICY IF EXISTS customer_phones_own ON customer_phones;

CREATE POLICY customers_own ON customers FOR SELECT TO anon
  USING (
    customer_name = (
      SELECT cp.customer_name FROM customer_phones cp
      WHERE cp.phone_number = (SELECT phone FROM auth.users WHERE id = auth.uid())
      LIMIT 1
    )
  );

CREATE POLICY customer_phones_own ON customer_phones FOR SELECT TO anon
  USING (
    customer_name = (
      SELECT cp2.customer_name FROM customer_phones cp2
      WHERE cp2.phone_number = (SELECT phone FROM auth.users WHERE id = auth.uid())
      LIMIT 1
    )
  );

-- ── 4. Trigger: auto-create customer row on every order insert
CREATE OR REPLACE FUNCTION orders_ensure_customer()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO customers (customer_name)
  VALUES (NEW.customer_name)
  ON CONFLICT DO NOTHING;

  IF NEW.phone IS NOT NULL THEN
    INSERT INTO customer_phones (customer_name, phone_number, label)
    VALUES (NEW.customer_name, NEW.phone, 'primary')
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_ensure_customer ON orders;
CREATE TRIGGER orders_ensure_customer
  AFTER INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_ensure_customer();

-- ── 5. Update invoice lookup RPC (now reads from customer_phones, not old table)
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
