-- Migration 013: Catalog table — Shopify is source of truth for item names + prices
--
-- Synced from Shopify each morning and on every product webhook.
-- zoho_item_id stored here so invoice generation can reference it directly.

CREATE TABLE IF NOT EXISTS catalog (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  shopify_product_id bigint      UNIQUE,                    -- Shopify product id
  item_name          text        NOT NULL UNIQUE,           -- exact name from Shopify
  item_name_normal   text        GENERATED ALWAYS AS (
                       lower(regexp_replace(trim(item_name), '\s+', ' ', 'g'))
                     ) STORED,                              -- normalised for matching
  unit_price         numeric(10,2) NOT NULL DEFAULT 0,
  unit               text        NOT NULL DEFAULT 'kg',     -- kg | piece | box
  active             boolean     NOT NULL DEFAULT true,
  shopify_tags       text[],
  zoho_item_id       text,                                  -- Zoho Books item_id
  zoho_item_name     text,                                  -- exact name used in Zoho
  synced_at          timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_catalog_normal   ON catalog(item_name_normal);
CREATE INDEX IF NOT EXISTS idx_catalog_active   ON catalog(active);
CREATE INDEX IF NOT EXISTS idx_catalog_shopify  ON catalog(shopify_product_id);

ALTER TABLE catalog ENABLE ROW LEVEL SECURITY;
-- service role (edge functions) bypasses RLS; ops dashboard uses anon key → read-only

CREATE POLICY catalog_read_anon ON catalog
  FOR SELECT TO anon USING (true);

-- ── Back-fill unit_price into order_items when catalog row matches ─────────────
-- (future inserts handled in place-order / CSV import code)
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS unit_price numeric(10,2);

-- ── updated_at trigger ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION catalog_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS catalog_updated_at ON catalog;
CREATE TRIGGER catalog_updated_at
  BEFORE UPDATE ON catalog
  FOR EACH ROW EXECUTE FUNCTION catalog_updated_at();
