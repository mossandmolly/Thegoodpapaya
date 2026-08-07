-- Adds "partially_delivered" as a delivery_status value — for an order
-- where the rider confirmed delivery but one or more of its items ended up
-- cancelled along the way (the Delivery tab's "not delivered" action on a
-- single item, or an item removed earlier in Today's Orders), so it's
-- distinguishable at a glance from a plain, fully-completed 'delivered'.
--
-- Still deliberately excludes 'cancelled' as a literal value here (see
-- migration 031's reasoning) — an order with ZERO active items left is
-- cancelled outright (orders.status='cancelled', set by cancel-order),
-- not "partially delivered". mark-delivered sets 'partially_delivered'
-- only when at least one item survives as active alongside at least one
-- cancelled one.

alter table public.orders drop constraint if exists orders_delivery_status_check;
alter table public.orders add constraint orders_delivery_status_check
  check (delivery_status in ('not_dispatched', 'ofd', 'delivered', 'partially_delivered'));
