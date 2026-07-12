-- Foundation for packing/delivery trip planning — data model only, no
-- algorithm yet (that needs your society config + combinability data,
-- which comes next). Adds:
--   1. catalog.weight_kg — per-unit weight, needed to sum an order's total
--      weight against the rider's carry capacity. Seeded from the existing
--      client-side PKG map in parser.html (originally sized for packaging
--      material estimation) for the items it already covers.
--   2. orders.deliver_by — a structured "deliver by HH:MM" deadline,
--      separate from the free-text delivery_instructions field, so the
--      scheduler can read it directly instead of parsing natural language.
--   3. communities gets the trip-planning columns added directly (lat/lng
--      for OSRM distance lookups, your manual combinable_group tag,
--      stack_rank, no_later_than) rather than a new table — communities is
--      already the canonical, continuously-grown list of every society
--      real orders have used, so it's the right home for this rather than
--      a second parallel list. (The old migration 017 "societies" table —
--      id/canonical_name/aliases — is a different, unused, pre-communities
--      approach; left alone here.) All new columns null/empty until you
--      give me the location + grouping data to fill in.
--   4. app_settings — a plain key/value table for the one setting needed
--      so far (rider_capacity_kg), extensible for whatever else comes up.

alter table public.catalog
  add column if not exists weight_kg numeric;

update public.catalog set weight_kg = 0.20 where lower(item_name) in ('apple','gala apple','royal gala apple','washington apple','green apple','pink lady apple','rockit apple','rose apple','robusta banana');
update public.catalog set weight_kg = 0.40 where lower(item_name) in ('guava','guava white','guava pink','nati guava');
update public.catalog set weight_kg = 0.10 where lower(item_name) in ('yelakki banana','yelakki banana organic');
update public.catalog set weight_kg = 0.35 where lower(item_name) in ('pomegranate','pomegranate large','pomegranate medium','pomegranate organic');
update public.catalog set weight_kg = 0.16 where lower(item_name) in ('pear');
update public.catalog set weight_kg = 0.10 where lower(item_name) in ('mandarin orange');
update public.catalog set weight_kg = 0.25 where lower(item_name) in ('valencia orange');
update public.catalog set weight_kg = 0.05 where lower(item_name) in ('plum');
update public.catalog set weight_kg = 0.15 where lower(item_name) in ('peach');
update public.catalog set weight_kg = 0.50 where lower(item_name) in ('mango','kesar mango','langra mango','banganapalli mango','alphonso mango','badami mango','dasheri mango','totapuri mango','sindhura mango','malika mango','malgova mango','benishan mango','imampasand mango');

alter table public.orders
  add column if not exists deliver_by time;

alter table public.communities
  add column if not exists lat              double precision,
  add column if not exists lng              double precision,
  add column if not exists combinable_group text,
  add column if not exists stack_rank       integer,
  add column if not exists no_later_than    time;

create table if not exists public.app_settings (
  key   text primary key,
  value text
);

insert into public.app_settings (key, value)
values ('rider_capacity_kg', '15')
on conflict (key) do nothing;

-- Expose deliver_by through the read-only lookup view the frontend already
-- uses (orders itself is locked to service-role-only reads). Appended at
-- the end, not inserted earlier — CREATE OR REPLACE VIEW can only append
-- new columns, not reorder existing ones (see migration 028).
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
  deliver_by
from public.orders;
