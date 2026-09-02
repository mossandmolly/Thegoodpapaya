-- ── 1. customer_phones ──────────────────────────────────────────────────
-- The LIVE get_invoices_by_phone RPC (diverged from what's committed in
-- 032_fix_rpcs.sql — see part 2 below) looks up customer_name via this
-- table, not via invoice_line_items.phone_number directly. But the table
-- itself was never actually created in this database — every phone lookup
-- on the customer-facing invoices website has been failing with "relation
-- customer_phones does not exist". sync-invoices' writes to it, and the
-- orders_fill_phone_from_customer trigger (migration 102) reading it, have
-- been silently failing the same way this whole time.
--
-- Matches the shape already committed in 029_customers_clean_slate.sql,
-- written idempotently (IF NOT EXISTS) so it's safe to run standalone
-- without that migration's destructive TRUNCATEs of orders/order_items/etc.
-- customers.customer_name is confirmed UNIQUE live (customers_customer_name_key),
-- so the foreign key below is safe.
create table if not exists public.customer_phones (
  customer_name text        not null references public.customers(customer_name) on update cascade on delete cascade,
  phone_number  text        not null,
  label         text        not null default 'primary',
  created_at    timestamptz not null default now(),
  primary key (customer_name, phone_number)
);

create unique index if not exists idx_customer_phones_phone on public.customer_phones(phone_number);
create index        if not exists idx_customer_phones_name  on public.customer_phones(customer_name);

alter table public.customer_phones enable row level security;

drop policy if exists customer_phones_read  on public.customer_phones;
drop policy if exists customer_phones_write on public.customer_phones;
create policy customer_phones_read  on public.customer_phones for select using (true);
create policy customer_phones_write on public.customer_phones for all    using (true) with check (true);

-- ── 2. Fix get_invoices_by_phone's column mismatch ─────────────────────
-- Live version does `select ili.*` against a RETURNS TABLE that only lists
-- 19 of invoice_line_items' real 20 columns (missing sales_order_id) — a
-- second, independent bug that throws "structure of query does not match
-- function result type" the moment the customer_phones fix above unblocks
-- the first error. Rewritten with an explicit column list, same pattern as
-- its sibling get_invoices_by_customer (below), sales_order_id included in
-- both so the frontend's invoice-number/zoho-id/sales-order-id fallback
-- key actually has all three to fall back through.
drop function if exists public.get_invoices_by_phone(text);
create or replace function public.get_invoices_by_phone(p_phone text)
returns table (
  id uuid, customer_name text, phone_number text, invoice_date date,
  invoice_number text, zoho_invoice_id text, item_name text,
  requested_quantity numeric, final_quantity numeric, item_price numeric,
  invoice_total numeric, payment_link text, payment_link_id text,
  payment_status text, pdf_url text, created_at timestamptz, updated_at timestamptz,
  balance numeric, amount_paid numeric, sales_order_id text
)
language sql
stable
security definer
as $$
  select
    id, customer_name, phone_number, invoice_date,
    invoice_number, zoho_invoice_id, item_name,
    requested_quantity, final_quantity, item_price,
    invoice_total, payment_link, payment_link_id,
    payment_status, pdf_url, created_at, updated_at,
    balance, amount_paid, sales_order_id
  from public.invoice_line_items
  where customer_name = (
    select cp.customer_name from public.customer_phones cp
    where cp.phone_number = p_phone
    limit 1
  )
  order by invoice_date desc, invoice_number desc;
$$;

grant execute on function public.get_invoices_by_phone(text) to anon;

-- get_invoices_by_customer already had a correct explicit column list (no
-- mismatch bug) — just adding sales_order_id here too, for parity.
drop function if exists public.get_invoices_by_customer(text);
create or replace function public.get_invoices_by_customer(p_name text)
returns table (
  id uuid, customer_name text, phone_number text, invoice_date date,
  invoice_number text, zoho_invoice_id text, item_name text,
  requested_quantity numeric, final_quantity numeric, item_price numeric,
  invoice_total numeric, payment_link text, payment_link_id text,
  payment_status text, pdf_url text, created_at timestamptz, updated_at timestamptz,
  balance numeric, amount_paid numeric, sales_order_id text
)
language sql
stable
security definer
as $$
  select
    id, customer_name, phone_number, invoice_date,
    invoice_number, zoho_invoice_id, item_name,
    requested_quantity, final_quantity, item_price,
    invoice_total, payment_link, payment_link_id,
    payment_status, pdf_url, created_at, updated_at,
    balance, amount_paid, sales_order_id
  from public.invoice_line_items
  where lower(customer_name) = lower(p_name)
  order by invoice_date desc, invoice_number desc;
$$;

grant execute on function public.get_invoices_by_customer(text) to anon;
