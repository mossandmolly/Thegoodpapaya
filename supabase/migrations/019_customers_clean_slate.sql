-- Migration 019: Drop and recreate customers table from scratch.
-- Previous migrations left conflicting constraints; this is a clean slate.

-- 1. Drop FKs that reference customers
ALTER TABLE customer_notes  DROP CONSTRAINT IF EXISTS customer_notes_customer_name_fkey;
ALTER TABLE customer_phones DROP CONSTRAINT IF EXISTS customer_phones_customer_name_fkey;
ALTER TABLE customer_phones DROP CONSTRAINT IF EXISTS customer_phones_new_customer_name_fkey;

-- 2. Drop the old customers table (CASCADE removes leftover indexes/constraints)
DROP TABLE IF EXISTS public.customers CASCADE;

-- 3. Clean new customers table
CREATE TABLE public.customers (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_name    text        NOT NULL UNIQUE,
  zoho_contact_id  text        UNIQUE,
  active           boolean     NOT NULL DEFAULT true,
  synced_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- 4. RLS — anon can read all, service role has full access (bypasses RLS)
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

CREATE POLICY customers_anon_read ON public.customers
  FOR SELECT TO anon USING (true);

CREATE POLICY customers_anon_insert ON public.customers
  FOR INSERT TO anon WITH CHECK (true);

-- 5. Seed from ALL sources before re-adding FKs, so no orphan risk
INSERT INTO public.customers (customer_name)
  SELECT DISTINCT customer_name FROM public.orders
  WHERE customer_name IS NOT NULL
ON CONFLICT (customer_name) DO NOTHING;

INSERT INTO public.customers (customer_name)
  SELECT DISTINCT customer_name FROM public.customer_notes
  WHERE customer_name IS NOT NULL
ON CONFLICT (customer_name) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'customer_phones'
  ) THEN
    INSERT INTO public.customers (customer_name)
      SELECT DISTINCT customer_name FROM public.customer_phones
      WHERE customer_name IS NOT NULL
    ON CONFLICT (customer_name) DO NOTHING;
  END IF;
END $$;

-- 6. Restore customer_notes FK (all names now guaranteed to exist)
ALTER TABLE customer_notes
  ADD CONSTRAINT customer_notes_customer_name_fkey
  FOREIGN KEY (customer_name) REFERENCES public.customers(customer_name)
  ON UPDATE CASCADE ON DELETE CASCADE;

-- 7. Restore customer_phones FK if that table still exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'customer_phones'
  ) THEN
    ALTER TABLE customer_phones
      ADD CONSTRAINT customer_phones_customer_name_fkey
      FOREIGN KEY (customer_name) REFERENCES public.customers(customer_name)
      ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
END $$;

-- 8. Trigger: auto-create customer row on every order insert
CREATE OR REPLACE FUNCTION orders_ensure_customer()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.customers (customer_name)
  VALUES (NEW.customer_name)
  ON CONFLICT (customer_name) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_ensure_customer ON public.orders;
CREATE TRIGGER orders_ensure_customer
  AFTER INSERT ON public.orders
  FOR EACH ROW EXECUTE FUNCTION orders_ensure_customer();
