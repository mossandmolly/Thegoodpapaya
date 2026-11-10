-- A rider marking a delivery paid (cash OR online) used to write straight
-- to orders.payment_collected — which the storefront reads live, with zero
-- verification. That was already a soft spot for cash (never checked
-- against anything), and became a sharper one for online: with dynamic QR
-- removed, a static-QR payment has no automatic webhook reconciliation any
-- more, so a rider's own claim was about to become the ONLY signal for it.
-- mark-delivered no longer flips payment_collected from a rider's claim —
-- only a server-confirmed payment (Razorpay webhook) or an explicit
-- Somya/Rohith verification (mark-order-paid) does that. A rider's claim
-- instead lands here, visible but not yet trusted anywhere customer-facing.
alter table public.orders
  add column if not exists payment_pending_verification boolean not null default false,
  add column if not exists payment_claimed_method text check (payment_claimed_method in ('cash','online')),
  add column if not exists payment_claimed_at     timestamptz,
  add column if not exists payment_claimed_by     text;

create index if not exists idx_orders_payment_pending_verification
  on public.orders(payment_pending_verification) where payment_pending_verification;
