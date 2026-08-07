-- Migration 048: customer standing instructions
--
-- Per-customer fruit/delivery instructions that must be attached to every
-- order that customer places, automatically, at the time the order is
-- created — not something a packer/rider has to remember to check.
--
-- Keyed by a FULLY canonical key (lowercase, letters/digits only — no
-- spaces at all), deliberately stricter than customers.customer_name's own
-- dedup (sync-customers' cleanCustomerName collapses whitespace/casing but
-- still treats "Villa 60" and "Villa60" as different names). That's the
-- normalization ops-dashboard/parser.html already uses for sales_order_id
-- (canonicalCustomerKey) — mirrored here in SQL so "Sunshine Signature
-- Villa 60", "sunshine signature villa-60" and "SunshineSignatureVilla60"
-- all resolve to one row regardless of which spelling shows up in Zoho or
-- gets typed by hand. Every order-creation path looks this up by key, not
-- by exact customer_name, so a brand new name variant nobody's seen before
-- still gets the right instructions on day one.
create table public.customer_instructions (
  normalized_key text        primary key,
  display_name   text        not null,   -- most-recently-seen customer_name, for the config panel only
  instructions   text        not null,
  updated_at     timestamptz not null default now()
);

alter table public.customer_instructions enable row level security;

-- Same open-access pattern as communities/clusters (migrations 006/008/
-- 036/039/044) — this app authenticates via one shared login per role, not
-- per-user row security, so read+write is permissive to any signed-in
-- caller. Also needs anon SELECT specifically: order-creation paths look
-- this up with the public anon key at the moment an order is entered, same
-- as communities/catalog.
create policy "customer_instructions_read" on public.customer_instructions
  for select using (true);
create policy "customer_instructions_write" on public.customer_instructions
  for insert with check (true);
create policy "customer_instructions_update" on public.customer_instructions
  for update using (true) with check (true);
create policy "customer_instructions_delete" on public.customer_instructions
  for delete using (true);

create trigger customer_instructions_updated_at
  before update on public.customer_instructions
  for each row execute function update_updated_at();
