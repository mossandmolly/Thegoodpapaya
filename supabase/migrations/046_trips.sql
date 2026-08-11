-- Trip view/flat view toggle for Overview/Packer/Delivery, per the manual
-- combinable_group tagging migration 032 already added to communities (no
-- OSRM/geo-clustering yet — that's still a separate, later piece; this is
-- just letting an order's trip grouping be read/derived and, when needed,
-- manually overridden).
--
-- An order's trip is: trip_override if set, else its community's
-- combinable_group, else the community name itself (a lone community is
-- its own single-community trip). trip_override lets one specific order be
-- moved to a different trip without touching its actual community (a
-- customer's neighborhood shouldn't change just to fix trip grouping).

alter table public.orders
  add column if not exists trip_override text;

-- communities only had SELECT + INSERT policies (migration 006 + 008) —
-- INSERT covers the auto-populate-from-orders trigger, but nothing ever
-- let an authenticated session UPDATE a row, which the new Config page's
-- lat/lng/combinable_group/stack_rank/no_later_than editor needs.
drop policy if exists "communities_update" on public.communities;
create policy "communities_update" on public.communities
  for update using (true) with check (true);

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
  delivered_by,
  trip_override
from public.orders;
