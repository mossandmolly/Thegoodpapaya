-- Two independent additions (neither needs the trip-planning data still
-- pending): an admin-facing order notes field distinct from the
-- rider-facing delivery_notes and the parsed per-item delivery_instructions,
-- and a manual packer-to-fruit assignment table for the new Packer
-- All/My orders split.

alter table public.orders
  add column if not exists admin_notes text;

create table if not exists public.packers (
  name            text primary key,
  assigned_fruits text[] not null default '{}'
);

-- No separate packer auth role exists (packers share the same login as
-- admin, same as this app's other non-financial config) — any signed-in
-- session can read (needed client-side to filter "my orders" by fruit)
-- and write (Config page management) this table.
alter table public.packers enable row level security;
drop policy if exists "packers_authenticated_all" on public.packers;
create policy "packers_authenticated_all" on public.packers
  for all to authenticated using (true) with check (true);

-- Performance attribution: WHO actually packed/delivered something, as
-- opposed to who it was merely assigned to (assigned_rider, or a packer's
-- fruit assignment in the packers table above) — a packer working from
-- "All orders" can pack an item nobody assigned them, and this is what
-- lets that get credited to whoever actually did it. Both are plain typed
-- names (see gp_rider_name/gp_packer_name in the frontend — no separate
-- per-person auth exists), not foreign keys to any auth table.
-- packed_at is what "average time to pack an item" is computed from (the
-- gap between one item's packed_at and the next one the same packer
-- finished), so it's set at the same moment as packed_by, every time.
alter table public.order_items
  add column if not exists packed_by text,
  add column if not exists packed_at timestamptz;

alter table public.orders
  add column if not exists delivered_by text;

-- Exposed through the same read-only lookup view the frontend already uses
-- for everything else on orders (orders itself is locked to service-role-
-- only reads). Appended at the end — CREATE OR REPLACE VIEW can only
-- append columns, not reorder existing ones (see migration 028).
create or replace view public.order_customer_lookup as
select
  sales_order_id,
  customer_name,
  phone,
  razorpay_url,
  invoice_status,
  status,
  delivery_status,
  delivered_at,
  delivery_notes,
  delivery_photo_path,
  invoice_total,
  payment_collected,
  payment_collected_method,
  payment_collected_at,
  delivery_photo_paths,
  assigned_rider,
  deliver_by,
  admin_notes,
  delivered_by
from public.orders;
