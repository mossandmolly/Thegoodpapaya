-- Tracks customer-initiated item cancellations from My Orders
-- (cancel-order-item) separately from staff-initiated ones in the ops
-- dashboard — order_items.status looks identical ('cancelled') either
-- way, so without this there's no way to tell the two apart, let alone
-- answer "how many customers cancel their own items, and how long after
-- placing the order" (funnel dashboard) or filter for them (Order
-- Overview). self_cancelled_at vs. the order's own created_at is what
-- gives that time-to-cancel gap.
alter table public.order_items
  add column if not exists self_cancelled boolean not null default false,
  add column if not exists self_cancelled_at timestamptz;

create index if not exists idx_order_items_self_cancelled_at
  on public.order_items(self_cancelled_at) where self_cancelled;
