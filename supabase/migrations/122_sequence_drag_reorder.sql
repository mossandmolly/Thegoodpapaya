-- Replaces the day-scoped, society-level manual override (packer_priority_
-- override + parser.html's "Current Order" drag stack) with direct manual
-- control over orders.sequence_number itself, now that every order gets
-- one automatically (migration 120/121). Somya no longer needs to
-- pre-emptively reorder COMMUNITIES before they're sequenced — she drags
-- the SEQUENCES/ORDERS the cron already produced, in the Team tab's new
-- Sequences board (parser.html's renderSequenceBoard/computeSequenceBoard).
--
-- sequence_number becomes numeric so a drag can insert a value between two
-- existing ones (e.g. between 1 and 2 -> 1.5) without renumbering every
-- other sequence on every reorder — compute-next-sequence always appends a
-- brand new sequence at max(sequence_number)+1, so a fractional manual
-- insertion can never collide with a later cron run, and the cron never
-- touches an already-sequenced order (sequence_number is not null) in the
-- first place, so a manual drag is never clobbered by the next tick either.
-- order_customer_lookup's underlying rule depends on sequence_number's
-- current type, so Postgres refuses to ALTER COLUMN TYPE while it exists
-- (error 0A000) — same issue migration 120 hit swapping queue_id for this
-- same column, fixed the same way: drop the view, change the column,
-- recreate the view identically (its own grant along with it).
drop view if exists public.order_customer_lookup;

alter table public.orders
  alter column sequence_number type numeric using sequence_number::numeric;

create view public.order_customer_lookup as
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

grant select on public.order_customer_lookup to anon, authenticated;

-- The override tier this fed (packer_priority_override -> sortGroupsByPriority
-- / orderItemsByQueuePriority's "override beats everything" check) is
-- retired outright, not replaced in kind — both functions keep their other
-- tiers (timeline deadline -> community rank -> group size -> alphabetical),
-- now the single shared precedence used client- and server-side (see
-- compute-next-sequence's compareTier2).
drop table if exists public.packer_priority_override;
