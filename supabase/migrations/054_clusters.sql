-- Cluster: a coarse geographic grouping of societies, used to summarize
-- not-dispatched orders on Orders Overview by delivery priority. Distinct
-- from communities.combinable_group, which groups societies into one
-- shared TRIP for routing — a cluster is a much coarser regional label
-- (several trips' worth of societies) purely for the summary headers.
create table if not exists public.clusters (
  name       text primary key,
  stack_rank integer
);

-- Same open-access RLS pattern as communities (006/008/036/039) — this app
-- authenticates via one shared login per role, not per-user row security,
-- so every policy here is deliberately permissive to any signed-in caller.
alter table public.clusters enable row level security;
drop policy if exists "clusters_read" on public.clusters;
create policy "clusters_read" on public.clusters for select using (true);
drop policy if exists "clusters_write" on public.clusters;
create policy "clusters_write" on public.clusters for insert with check (true);
drop policy if exists "clusters_update" on public.clusters;
create policy "clusters_update" on public.clusters for update using (true) with check (true);
drop policy if exists "clusters_delete" on public.clusters;
create policy "clusters_delete" on public.clusters for delete using (true);

alter table public.communities
  add column if not exists cluster text;

-- dispatched_at: when an order actually flipped to 'ofd' (set by
-- dispatch-order). Used to group a rider's OFD orders into "trips" — a
-- burst of dispatches in close succession — and report each trip's start
-- time as the LAST dispatch in that burst (see parser.html's
-- groupOfdIntoTrips for the actual clustering).
alter table public.orders
  add column if not exists dispatched_at timestamptz;

-- Exposed through the same read-only lookup view the frontend already uses
-- for everything else on orders (orders itself is locked to service-role-
-- only reads). Appended at the end — CREATE OR REPLACE VIEW can only
-- append columns, not reorder existing ones (see migration 028).
create or replace view public.order_customer_lookup as
select
  sales_order_id, customer_name, phone, razorpay_url, invoice_status, status,
  delivery_status, delivered_at, delivery_notes, delivery_photo_path, invoice_total,
  payment_collected, payment_collected_method, payment_collected_at, delivery_photo_paths,
  assigned_rider, deliver_by, admin_notes, delivered_by, trip_override, deliver_after,
  invoice_downloaded_at, dispatched_at
from public.orders;

-- Seed the 10 clusters with their initial delivery-priority order —
-- editable afterward in Config -> Clusters (stack_rank = lower number
-- goes out first).
insert into public.clusters (name, stack_rank) values
  ('Cluster 1', 1), ('Cluster 2', 2), ('Cluster 3', 3), ('Cluster 4', 4),
  ('Cluster 5', 5), ('Cluster 6', 6), ('Cluster 7', 7), ('Cluster 8', 8),
  ('Cluster 9', 9), ('Cluster 10', 10)
on conflict (name) do nothing;

-- Best-effort seed of communities.cluster from the society list given at
-- setup time. Matches by substring (ilike) since actual stored community
-- names vary in spacing/casing ("77 Degree" vs "77degree"). This is a
-- starting point, not guaranteed exact — broad single-word terms (villa,
-- tower) could catch more or fewer rows than intended depending on what's
-- actually in the table. Review/correct in Config -> Communities
-- afterward. Only fills rows that don't already have a cluster (safe to
-- re-run, won't clobber a manual edit).
update public.communities set cluster='Cluster 1' where cluster is null and (
  name ilike '%77%degree%' or name ilike '%rohan%' or name ilike '%kew%' or name ilike '%palladian%'
);
update public.communities set cluster='Cluster 2' where cluster is null and (
  name ilike '%espana%' or name ilike '%iris%'
);
update public.communities set cluster='Cluster 3' where cluster is null and (
  name ilike '%ascentia%' or name ilike '%vajram%' or name ilike '%akme%' or name ilike '%pristine%'
  or name ilike '%dnr%arista%' or name ilike '%arista%'
);
update public.communities set cluster='Cluster 4' where cluster is null and (
  name ilike '%ferns%' or name ilike '%sjr%redwood%' or name ilike '%sjr%bluewater%'
  or name ilike '%purva%skydale%' or name ilike '%snnraj%' or name ilike '%eternia%'
  or name ilike '%ozone%evergreen%'
);
update public.communities set cluster='Cluster 5' where cluster is null and (
  name ilike '%uber%' or name ilike '%ahad%' or name ilike '%regalia%'
  or name ilike '%sunshine%signature%' or name ilike '%silverdale%' or name ilike '%suncity%'
);
update public.communities set cluster='Cluster 6' where cluster is null and (
  name ilike '%meda%' or name ilike '%vars%' or name ilike '%saroj%' or name ilike '%lakefront%'
);
update public.communities set cluster='Cluster 7' where cluster is null and (
  name ilike '%krishvigavakshi%' or name ilike '%sunnyside%' or name ilike '%iksha%'
  or name ilike '%bhuvi%' or name ilike '%kethana%' or name ilike '%vaswani%'
  or name ilike '%sls%signature%' or name ilike '%sls%sunflower%'
);
update public.communities set cluster='Cluster 8' where cluster is null and (
  name ilike '%summerfield%villa%' or name ilike '%villa%'
);
update public.communities set cluster='Cluster 9' where cluster is null and (
  name ilike '%tower%'
);
update public.communities set cluster='Cluster 10' where cluster is null and (
  name ilike '%dhavala%' or name ilike '%assetz%' or name ilike '%80%trees%'
  or name ilike '%silversun%' or name ilike '%indio%'
);
