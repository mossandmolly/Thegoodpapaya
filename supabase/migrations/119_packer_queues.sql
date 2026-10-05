-- Packer Single Card queue, phase 2: replaces the automatic community-
-- priority/time-sensitivity ranking that fed Single Card with a manual one.
-- Somya pushes specific orders into a named, numbered queue (Queue 1,
-- Queue 2, ...) from Order Overview; a packer's Single Card view now shows
-- ONLY items from pushed orders — queue 1's orders exhausted before queue
-- 2's even starts (see parser.html's computePackerQueue). Nothing else
-- (Grid, Time Sensitive, Team view, Trip/Flat grouping, community_priority
-- itself) changes — those still use orderItemsByQueuePriority exactly as
-- before. This is additive and scoped to Single Card only.

create table if not exists public.packer_queues (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  seq        integer not null,
  created_at timestamptz not null default now()
);

alter table public.packer_queues enable row level security;
create policy "packer_queues_all" on public.packer_queues for all using (true) with check (true);

-- queue_id: which queue (if any) this order has been pushed into. Null
-- means "not pushed" — such an order never appears in any packer's Single
-- Card queue, however urgent, until Somya explicitly pushes it.
-- queue_pushed_at: when it was (re)pushed — breaks ties between orders in
-- the same queue (first pushed, first packed), same role dispatched_at
-- plays for delivery trips.
alter table public.orders
  add column if not exists queue_id        uuid references public.packer_queues(id) on delete set null,
  add column if not exists queue_pushed_at timestamptz;

create index if not exists idx_orders_queue_id on public.orders(queue_id);

-- order_customer_lookup is the narrow view the frontend reads orders
-- through (orders itself is locked to service-role-only reads). Redefined
-- here to append the two new columns on top of migration 092's full list —
-- CREATE OR REPLACE VIEW can only append columns, not reorder existing ones.
create or replace view public.order_customer_lookup as
select
  sales_order_id, customer_name, phone, razorpay_url, invoice_status, status,
  delivery_status, delivered_at, delivery_notes, delivery_photo_path, invoice_total,
  payment_collected, payment_collected_method, payment_collected_at, delivery_photo_paths,
  assigned_rider, deliver_by, admin_notes, delivered_by, trip_override, deliver_after,
  invoice_downloaded_at, dispatched_at, is_pickup, qr_image_url,
  admin_action_needed, admin_action_reason,
  whatsapp_raw_text, whatsapp_group_name, society, created_at,
  queue_id, queue_pushed_at
from public.orders;

-- create or replace view has reset SELECT grants on this view before (see
-- migration 082's note) — re-asserting rather than risk a repeat.
grant select on public.order_customer_lookup to anon, authenticated;
