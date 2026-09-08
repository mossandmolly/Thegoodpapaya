-- Audit log for standalone ("ad-hoc") Razorpay payment links created from
-- Order Overview's Payment Link button — links with no sales_order_id, so
-- there's no orders/invoice row to find them from otherwise. RLS open,
-- matching every other ops-dashboard table.
create table if not exists public.adhoc_payment_links (
  id                uuid primary key default gen_random_uuid(),
  phone             text not null,
  amount            numeric not null,
  description       text,
  razorpay_link_id  text not null,
  payment_url       text not null,
  created_by        text,
  created_at        timestamptz not null default now()
);

alter table public.adhoc_payment_links enable row level security;
create policy "adhoc_payment_links_all" on public.adhoc_payment_links for all using (true) with check (true);
