-- Migration 009: contact_name, status fix, RLS for new tables, phone RPC

-- ── Add contact_name to orders ────────────────────────────────────────────
alter table orders add column if not exists contact_name text;

-- ── Fix status constraint to include online payment states ────────────────
alter table orders drop constraint if exists orders_status_check;
alter table orders add  constraint orders_status_check
  check (status in ('placed','awaiting_payment','paid','delivered','cancelled'));

-- ── RLS: ops dashboard (anon key) reads/updates order_items ──────────────
create policy "order_items_read"   on order_items for select using (true);
create policy "order_items_update" on order_items for update using (true);

-- ── RLS: ops dashboard reads orders ──────────────────────────────────────
create policy "orders_read" on orders for select using (true);

-- ── RPC: customer looks up their own website orders by phone ─────────────
create or replace function get_orders_by_phone(p_phone text)
returns table (
  sales_id       text,
  order_date     date,
  contact_name   text,
  customer_name  text,
  community      text,
  cart           jsonb,
  total          numeric,
  payment_method text,
  status         text,
  created_at     timestamptz
) security definer language sql as $$
  select
    sales_id,
    created_at::date as order_date,
    contact_name,
    customer_name,
    community,
    cart,
    total,
    payment_method,
    status,
    created_at
  from orders
  where phone = regexp_replace(p_phone, '^\+91', '')
     or phone = p_phone
  order by created_at desc;
$$;
