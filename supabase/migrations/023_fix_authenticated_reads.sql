-- Migration 023: Fix RLS so authenticated users (ops dashboard staff) can read
-- catalog and customers. Previously policies were anon-only, blocking dashboard JS.

-- ── catalog ───────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "public read"               ON public.catalog;
DROP POLICY IF EXISTS "authenticated read"         ON public.catalog;

CREATE POLICY "catalog_read" ON public.catalog
  FOR SELECT USING (true);   -- all roles: anon + authenticated

CREATE POLICY "catalog_write" ON public.catalog
  FOR ALL USING (true) WITH CHECK (true);

-- ── customers ─────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS customers_anon_read         ON public.customers;
DROP POLICY IF EXISTS "authenticated read"         ON public.customers;

CREATE POLICY "customers_read" ON public.customers
  FOR SELECT USING (true);   -- all roles

CREATE POLICY "customers_write" ON public.customers
  FOR ALL USING (true) WITH CHECK (true);

-- ── customer_phones (only if it exists) ──────────────────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='customer_phones') THEN
    EXECUTE 'DROP POLICY IF EXISTS customer_phones_anon_read ON public.customer_phones';
    EXECUTE 'CREATE POLICY customer_phones_read ON public.customer_phones FOR SELECT USING (true)';
    EXECUTE 'CREATE POLICY customer_phones_write ON public.customer_phones FOR ALL USING (true) WITH CHECK (true)';
  END IF;
END $$;
