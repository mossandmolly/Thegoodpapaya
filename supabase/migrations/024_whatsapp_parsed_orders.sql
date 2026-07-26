-- 024_whatsapp_parsed_orders.sql
-- Separate, running-list table fed by the WhatsApp group listener.
-- Independent of `operations` — rows land here first, get reviewed on the
-- parser page, and only reach `operations` when pushed via "Push to operations".
-- `cleared` is a soft-hide flag (not a delete) so the "Clear" CTA is reversible
-- and the raw parse history stays auditable.

create table if not exists public.whatsapp_parsed_orders (
  id             uuid        primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  order_date     date        not null,
  group_name     text,
  customer_name  text        not null,
  phone          text,
  item_name      text        not null,
  description    text,
  quantity       text,
  sales_order    text,
  cleared        boolean     not null default false
);

create index if not exists whatsapp_parsed_orders_cleared_idx
  on public.whatsapp_parsed_orders (cleared, created_at);

alter table public.whatsapp_parsed_orders enable row level security;
create policy "public read"   on public.whatsapp_parsed_orders for select using (true);
create policy "anon insert"   on public.whatsapp_parsed_orders for insert with check (true);
create policy "anon update"   on public.whatsapp_parsed_orders for update using (true);
create policy "anon delete"   on public.whatsapp_parsed_orders for delete using (true);
