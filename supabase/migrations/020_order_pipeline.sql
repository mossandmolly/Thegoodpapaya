-- Migration 020: Unified order pipeline
-- • Drop order_items (superseded by operations)
-- • Recreate orders with unified schema (all sources: website, csv, manual)
-- • Add sales_order_id to invoice_line_items
-- • Create invoice_queue for async batch invoice generation

-- ── 1. Drop order_items ───────────────────────────────────────────────────────
DROP TABLE IF EXISTS public.order_items CASCADE;

-- ── 2. Drop and recreate orders with new schema ──────────────────────────────
DROP TABLE IF EXISTS public.orders CASCADE;

CREATE TABLE public.orders (
  sales_order_id   text          PRIMARY KEY,        -- YYYY-MM-DD-CustomerName[-N]

  -- Order identity
  customer_name    text          NOT NULL,
  community        text,
  phone            text,                             -- 10-digit, no country code
  contact_name     text,
  source           text          NOT NULL DEFAULT 'website'
                   CHECK (source IN ('website','csv','manual')),
  payment_method   text          NOT NULL DEFAULT 'cod'
                   CHECK (payment_method IN ('cod','online')),
  notes            text,
  cart             jsonb,                            -- raw cart snapshot (website orders)

  -- Invoice tracking
  invoice_status   text          NOT NULL DEFAULT 'pending'
                   CHECK (invoice_status IN ('pending','queued','processing','done','failed')),
  zoho_invoice_id  text,
  invoice_number   text,
  invoice_date     date,
  invoice_total    numeric(10,2),
  amount_paid      numeric(10,2) NOT NULL DEFAULT 0, -- cumulative across all payments
  balance_due      numeric(10,2),

  -- Razorpay payment link
  razorpay_link_id text,
  razorpay_url     text,

  created_at       timestamptz   NOT NULL DEFAULT now(),
  updated_at       timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX idx_orders_customer       ON public.orders(customer_name);
CREATE INDEX idx_orders_invoice_status ON public.orders(invoice_status);
CREATE INDEX idx_orders_created        ON public.orders(created_at DESC);

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

-- ── 3. Updated_at trigger for orders ─────────────────────────────────────────
-- update_updated_at() is already defined in migration 005
CREATE TRIGGER orders_updated_at
  BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── 4. Re-add orders_ensure_customer trigger ──────────────────────────────────
CREATE OR REPLACE FUNCTION orders_ensure_customer()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.customers (customer_name)
  VALUES (NEW.customer_name)
  ON CONFLICT (customer_name) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_ensure_customer
  AFTER INSERT ON public.orders
  FOR EACH ROW EXECUTE FUNCTION orders_ensure_customer();

-- ── 5. Add unit_price to operations if missing ────────────────────────────────
ALTER TABLE public.operations
  ADD COLUMN IF NOT EXISTS unit_price numeric(10,2);

-- ── 6. Add sales_order_id to invoice_line_items ───────────────────────────────
-- No FK constraint — Zoho-synced invoices may not have a matching orders row.
ALTER TABLE public.invoice_line_items
  ADD COLUMN IF NOT EXISTS sales_order_id text;

CREATE INDEX IF NOT EXISTS idx_ili_sales_order
  ON public.invoice_line_items(sales_order_id);

-- ── 7. Create invoice_queue ───────────────────────────────────────────────────
CREATE TABLE public.invoice_queue (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id   text        NOT NULL REFERENCES public.orders(sales_order_id) ON DELETE CASCADE,
  status           text        NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','processing','done','failed')),
  error_message    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sales_order_id)
);

ALTER TABLE public.invoice_queue ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER invoice_queue_updated_at
  BEFORE UPDATE ON public.invoice_queue
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
