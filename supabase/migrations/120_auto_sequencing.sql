-- Replaces the manual push-to-queue model (migration 119) with an
-- automated one: a cron-driven edge function (compute-next-sequence)
-- partitions today's orders into numbered "sequences" (~30-35 items each,
-- whole orders only) following community priority / timeline / society-
-- cycling rules, instead of Somya clicking a push button per order. The
-- client-side "queue" board (named queues, per-queue headers) goes away
-- too — a packer now just sees her own items for whichever sequence is
-- current for her (see parser.html's computeMyCurrentSequence). There's
-- no more need for a named/lookup queue table at all — just a plain
-- sequence number directly on the order.

-- Explicit fruit/vegetable tag per packer, set once in Config — drives
-- which packers a sequence's fruit vs. vegetable items get distributed
-- across (see compute-next-sequence). Not auto-derived from existing
-- item assignments — deliberately a manual call, since a packer could in
-- principle be assigned a genuine mix.
alter table public.packers
  add column if not exists category text check (category in ('fruit','vegetable'));

-- sequence_number: which batch this order was assigned to by the auto-
-- sequencer. Null means not yet sequenced (orders.deliver_by timeline/
-- community-priority rank decide when it will be). sequenced_at breaks
-- ties within the same sequence (first sequenced, first packed) — same
-- role queue_pushed_at played for the old manual model.
alter table public.orders
  add column if not exists sequence_number integer,
  add column if not exists sequenced_at     timestamptz;

create index if not exists idx_orders_sequence_number on public.orders(sequence_number);

-- Rolling "recently sequenced societies" window (society cycling: after
-- one sequence from a society, move to the next 2 before returning) —
-- singleton row, persists across cron runs. Reset to empty by
-- compute-next-sequence itself whenever updated_at isn't today (IST) —
-- same new-day boundary packer_priority_override already resets on via
-- its own view_date key.
create table if not exists public.packer_sequence_state (
  id                 int primary key default 1 check (id = 1),
  recent_group_names text[] not null default '{}',
  updated_at         timestamptz not null default now()
);
insert into public.packer_sequence_state (id) values (1) on conflict (id) do nothing;
alter table public.packer_sequence_state enable row level security;
drop policy if exists "packer_sequence_state_all" on public.packer_sequence_state;
create policy "packer_sequence_state_all" on public.packer_sequence_state for all using (true) with check (true);

-- order_customer_lookup is the narrow view the frontend reads orders
-- through — redefine onto the new columns BEFORE dropping the old ones,
-- since CREATE OR REPLACE VIEW can't run against columns that no longer
-- exist, and vice versa a dangling view reference would block the drops.
create or replace view public.order_customer_lookup as
select
  sales_order_id, customer_name, phone, razorpay_url, invoice_status, status,
  delivery_status, delivered_at, delivery_notes, delivery_photo_path, invoice_total,
  payment_collected, payment_collected_method, payment_collected_at, delivery_photo_paths,
  assigned_rider, deliver_by, admin_notes, delivered_by, trip_override, deliver_after,
  invoice_downloaded_at, dispatched_at, is_pickup, qr_image_url,
  admin_action_needed, admin_action_reason,
  whatsapp_raw_text, whatsapp_group_name, society, created_at,
  sequence_number, sequenced_at
from public.orders;

-- create or replace view has reset SELECT grants on this view before (see
-- migration 082's note) — re-asserting rather than risk a repeat.
grant select on public.order_customer_lookup to anon, authenticated;

-- Retire the manual-push model entirely — any order still carrying an old
-- queue_id just loses it harmlessly; the sequencer picks up every
-- unsequenced order fresh on its first run, so there's nothing to carry
-- forward.
alter table public.orders drop column if exists queue_id;
alter table public.orders drop column if exists queue_pushed_at;
drop table if exists public.packer_queues;
