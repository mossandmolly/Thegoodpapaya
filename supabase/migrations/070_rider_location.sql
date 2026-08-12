-- Rider location tracking, for guessing which society a delivery rider is
-- currently near — one row per rider (upserted, not a history log), plus a
-- one-time-geocoded lat/lng per known community so a live GPS ping can be
-- matched to the nearest one (see the geocode-communities.js script run
-- once against this table).
create table if not exists rider_locations (
  rider_name text primary key,
  lat        double precision not null,
  lng        double precision not null,
  updated_at timestamptz not null default now()
);

create table if not exists community_locations (
  community_name text primary key,
  lat            double precision,
  lng            double precision,
  geocoded_at    timestamptz
);

drop trigger if exists rider_locations_updated_at on rider_locations;
create trigger rider_locations_updated_at
  before update on rider_locations
  for each row execute function update_updated_at();

-- Same open-access pattern as stock_purchases/expenses (migration 048/066)
-- — shared-login roles, no per-row security, any authenticated session
-- reads/writes directly with the anon key.
alter table rider_locations     enable row level security;
alter table community_locations enable row level security;

drop policy if exists "rider_locations_read"      on rider_locations;
drop policy if exists "rider_locations_write"     on rider_locations;
drop policy if exists "community_locations_read"  on community_locations;
drop policy if exists "community_locations_write" on community_locations;
create policy "rider_locations_read"      on rider_locations     for select using (true);
create policy "rider_locations_write"     on rider_locations     for all    using (true);
create policy "community_locations_read"  on community_locations for select using (true);
create policy "community_locations_write" on community_locations for all    using (true);
