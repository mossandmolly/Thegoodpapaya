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
alter table public.orders
  alter column sequence_number type numeric using sequence_number::numeric;

-- The override tier this fed (packer_priority_override -> sortGroupsByPriority
-- / orderItemsByQueuePriority's "override beats everything" check) is
-- retired outright, not replaced in kind — both functions keep their other
-- tiers (timeline deadline -> community rank -> group size -> alphabetical),
-- now the single shared precedence used client- and server-side (see
-- compute-next-sequence's compareTier2).
drop table if exists public.packer_priority_override;
