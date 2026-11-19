-- Retires Clusters (migration 054) — Somya's confirmed decision: delivery
-- is sequence-driven now, not trip/cluster-driven. The "By Trip" grouping
-- view this fed was already dead (unreachable in the dashboard UI before
-- this migration), and the Not Dispatched by Cluster summary is removed
-- too. The rider/trip summaries Somya is keeping (OFD By Rider & Trip,
-- Past Trips) key off orders.trip_override and communities.combinable_group
-- only, never cluster, so they're unaffected.
drop table if exists public.clusters;

alter table public.communities
  drop column if exists cluster;
