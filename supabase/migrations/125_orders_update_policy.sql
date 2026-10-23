-- Migration 125: orders has never had an UPDATE policy — every manual
-- drag in the Team tab's Sequences board (migration 122: reorderSequence/
-- moveOrderToSequence, both calling writeSequenceNumber's direct
-- `sb.from('orders').update(...)`) has been silently updating ZERO rows
-- since the day it shipped.
--
-- orders enabled row level security back in migration 009, and the only
-- policy ever added for it since is migration 011's "orders_read" —
-- SELECT only. With RLS enabled and no UPDATE policy, Postgres doesn't
-- raise an error on an UPDATE from anon/authenticated — it just matches
-- zero rows and returns success, which is exactly why writeSequenceNumber
-- never saw an error to alert on, but a fresh page load (re-reading the
-- real, never-actually-changed row) always showed the drag "reverting".
-- Every other order mutation in this app (dispatch, mark delivered,
-- assign rider, etc.) goes through an RPC or edge function running as
-- service_role, which bypasses RLS entirely — this is the only place that
-- ever tried a raw client-side update against this table directly, which
-- is exactly why only this one feature was ever affected.
--
-- Mirrors order_items_update's existing convention (migration 010: "for
-- update using (true)" — any authenticated session, no row-level
-- restriction) rather than inventing a narrower one here, since this is
-- an internal ops tool gated by Supabase Auth login, not column-level
-- security — same trust boundary this app already relies on everywhere
-- else an authenticated client writes directly to a table.
create policy "orders_update" on public.orders for update
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');
