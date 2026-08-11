-- Migration 019: Clean slate — drop and recreate customers + dependents.
-- No data is preserved. Fresh start.
-- Going forward:
--   customers       ← sync-customers (Zoho) + orders_ensure_customer trigger
--   catalog         ← sync-catalog (Zoho)
--   orders          ← order-entry.html (staff entry)
--   customer_phones ← customer phone registration (invoice portal)
--   operations      ← auto-created from orders (packing/delivery workflow)

-- ── 1. Drop customers and its direct child tables ────────────────────────────
--    CASCADE automatically removes any FK constraints pointing at customers
--    from other tables (operations, etc.) — those tables themselves survive.
DROP TABLE IF EXISTS public.customer_notes  CASCADE;
DROP TABLE IF EXISTS public.customer_phones CASCADE;
DROP TABLE IF EXISTS public.customers       CASCADE;

-- ── 2. Fresh customers table ──────────────────────────────────────────────────
CREATE TABLE public.customers (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_name    text        NOT NULL UNIQUE,
  zoho_contact_id  text        UNIQUE,
  active           boolean     NOT NULL DEFAULT true,
  synced_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

CREATE POLICY customers_anon_read ON public.customers
  FOR SELECT TO anon USING (true);

CREATE POLICY customers_anon_insert ON public.customers
  FOR INSERT TO anon WITH CHECK (true);

-- ── 3. Fresh customer_phones table ───────────────────────────────────────────
CREATE TABLE public.customer_phones (
  customer_name text        NOT NULL REFERENCES public.customers(customer_name)
                            ON UPDATE CASCADE ON DELETE CASCADE,
  phone_number  text        NOT NULL,
  label         text        NOT NULL DEFAULT 'primary',
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_name, phone_number)
);

CREATE UNIQUE INDEX idx_customer_phones_phone ON public.customer_phones(phone_number);
CREATE INDEX        idx_customer_phones_name  ON public.customer_phones(customer_name);

ALTER TABLE public.customer_phones ENABLE ROW LEVEL SECURITY;

CREATE POLICY customer_phones_anon_read ON public.customer_phones
  FOR SELECT TO anon USING (true);

-- ── 4. Fresh customer_notes table ────────────────────────────────────────────
CREATE TABLE public.customer_notes (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_name text        NOT NULL REFERENCES public.customers(customer_name)
                            ON UPDATE CASCADE ON DELETE CASCADE,
  note          text        NOT NULL,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_customer_notes_customer ON public.customer_notes(customer_name);

ALTER TABLE public.customer_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY customer_notes_anon_read ON public.customer_notes
  FOR SELECT TO anon USING (true);

-- ── 5. Re-add FK on operations if it exists (EXECUTE avoids parse-time error) ──
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'operations' AND column_name = 'customer_name'
  ) THEN
    EXECUTE 'ALTER TABLE public.operations DROP CONSTRAINT IF EXISTS operations_customer_name_fkey';
    EXECUTE 'ALTER TABLE public.operations ADD CONSTRAINT operations_customer_name_fkey
             FOREIGN KEY (customer_name) REFERENCES public.customers(customer_name) ON UPDATE CASCADE';
  END IF;
END $$;

-- ── 6. Trigger: auto-create customer on every order insert ────────────────────
CREATE OR REPLACE FUNCTION orders_ensure_customer()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.customers (customer_name)
  VALUES (NEW.customer_name)
  ON CONFLICT (customer_name) DO NOTHING;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='orders') THEN
    EXECUTE 'DROP TRIGGER IF EXISTS orders_ensure_customer ON public.orders';
    EXECUTE $t$
      CREATE TRIGGER orders_ensure_customer
        AFTER INSERT ON public.orders
        FOR EACH ROW EXECUTE FUNCTION orders_ensure_customer()
    $t$;
  END IF;
END $$;

-- ── 7. Clear all operational data (EXECUTE avoids parse-time errors) ──────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['order_items','orders','operations','catalog'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=t) THEN
      EXECUTE 'TRUNCATE public.' || quote_ident(t) || ' CASCADE';
    END IF;
  END LOOP;
END $$;
