-- Storefront funnel report queries — NOT a migration, nothing here
-- changes the schema. Paste any one of these into the Supabase SQL
-- editor whenever you want a snapshot. All of them default to the last
-- 30 days — change the "interval '30 days'" in each one if you want a
-- different window.
--
-- Data source: storefront_events (migration 165). Every row is one step
-- a visitor's device took: catalog_viewed, item_added, item_removed,
-- checkout_viewed, phone_entered, society_entered, order_placed. phone/
-- society/door_number are only ever filled in from what that visitor
-- actually typed — nothing here is looked up or inferred.

-- ── 1. Overall funnel: how many distinct devices reached each stage ────────
select
  event_type,
  count(distinct device_id) as devices
from storefront_events
where created_at >= now() - interval '30 days'
group by event_type
order by (case event_type
  when 'catalog_viewed'  then 1
  when 'item_added'      then 2
  when 'checkout_viewed' then 3
  when 'phone_entered'   then 4
  when 'society_entered' then 5
  when 'order_placed'    then 6
  else 7 end);

-- ── 2. One-line conversion summary ──────────────────────────────────────────
select
  count(distinct device_id) filter (where event_type = 'catalog_viewed')  as visitors,
  count(distinct device_id) filter (where event_type = 'item_added')      as added_to_cart,
  count(distinct device_id) filter (where event_type = 'checkout_viewed') as reached_checkout,
  count(distinct device_id) filter (where event_type = 'order_placed')    as completed_order
from storefront_events
where created_at >= now() - interval '30 days';

-- ── 3. How many devices have items in an abandoned basket ──────────────────
-- "Abandoned" = added at least one item, in the window, but never placed
-- an order (in that same window).
with w as (
  select * from storefront_events where created_at >= now() - interval '30 days'
),
added_devices   as (select distinct device_id from w where event_type = 'item_added'),
ordered_devices as (select distinct device_id from w where event_type = 'order_placed')
select count(*) as abandoned_baskets
from (select device_id from added_devices except select device_id from ordered_devices) x;

-- ── 4. WHAT'S in those abandoned baskets, item by item ──────────────────────
-- Works out each device's last known action per item (add vs. remove) and
-- keeps only the ones still "added" — i.e. what was actually left in the
-- basket when they stopped, not just everything they ever tapped.
with w as (
  select * from storefront_events where created_at >= now() - interval '30 days'
),
ordered_devices as (select distinct device_id from w where event_type = 'order_placed'),
last_action_per_item as (
  select device_id, item_name, event_type, created_at,
         row_number() over (partition by device_id, item_name order by created_at desc) as rn
  from w
  where event_type in ('item_added','item_removed')
    and device_id not in (select device_id from ordered_devices)
)
select device_id, item_name
from last_action_per_item
where rn = 1 and event_type = 'item_added'
order by device_id, item_name;

-- ── 5. Drop-off point — furthest stage reached, for devices that never ─────
--      completed an order (1=viewed catalog ... 5=filled in address,
--      didn't place order)
with w as (
  select * from storefront_events where created_at >= now() - interval '30 days'
),
ordered_devices as (select distinct device_id from w where event_type = 'order_placed'),
stage_rank as (
  select device_id,
    case event_type
      when 'catalog_viewed'  then 1
      when 'item_added'      then 2
      when 'checkout_viewed' then 3
      when 'phone_entered'   then 4
      when 'society_entered' then 5
      else 0
    end as stage
  from w
  where device_id not in (select device_id from ordered_devices)
)
select device_id, max(stage) as furthest_stage_reached
from stage_rank
group by device_id
order by furthest_stage_reached desc;

-- ── 6. Completed orders with phone/house, most recent first ────────────────
select device_id, phone, society, door_number, sales_order_id, created_at
from storefront_events
where event_type = 'order_placed'
  and created_at >= now() - interval '30 days'
order by created_at desc;
