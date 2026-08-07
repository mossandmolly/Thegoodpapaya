-- Delivery status becomes a real 3-stage lifecycle instead of a plain
-- pending/delivered flag: not_dispatched -> ofd (out for delivery, once
-- every item on the order has been physically collected into the rider's
-- bag) -> delivered. "Cancelled" is deliberately NOT a delivery_status
-- value here — a cancelled order is detected via orders.status='cancelled'
-- and overrides whatever delivery_status says, everywhere this app reads
-- the two together (avoids the two ever disagreeing with each other).

update public.orders set delivery_status = 'not_dispatched' where delivery_status = 'pending';

alter table public.orders drop constraint if exists orders_delivery_status_check;
alter table public.orders alter column delivery_status set default 'not_dispatched';
alter table public.orders add constraint orders_delivery_status_check
  check (delivery_status in ('not_dispatched', 'ofd', 'delivered'));

-- Per-item "physically packed into the delivery bag" checkbox — separate
-- from order_items.status (the pack/invoice pipeline), since an item can
-- be fully invoiced and still not yet collected for today's delivery run.
-- Once every non-cancelled item on an order is collected, the order
-- auto-advances to 'ofd' (see the dispatch-order edge function).
alter table public.order_items
  add column if not exists collected boolean not null default false;
