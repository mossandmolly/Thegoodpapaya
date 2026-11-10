-- Razorpay can refund a payment after the fact (e.g. "payment made on
-- closed qr code" — a customer paid into a dynamic QR we'd already closed,
-- Razorpay accepted it anyway, then auto-refunded) and until now nothing in
-- this system ever heard about that: the order stayed marked paid forever,
-- discovered only when a customer mentioned it. razorpay-webhook now listens
-- for refund.processed and flips the affected order over using these
-- columns, rather than silently leaving amount_paid/payment_collected wrong.
alter table public.orders
  add column if not exists payment_refunded boolean     not null default false,
  add column if not exists refunded_at       timestamptz,
  add column if not exists refund_amount     numeric,
  add column if not exists refund_reason     text;

create index if not exists idx_orders_payment_refunded
  on public.orders(payment_refunded) where payment_refunded;

-- Idempotency claim for the refund webhook, same pattern as
-- razorpay_payment_events (migration 097): Razorpay retries delivery on any
-- non-2xx response, and refund.created + refund.processed can both arrive
-- for the same refund — claiming the refund id first means a redelivery or
-- the second event hits the unique constraint and is skipped instead of
-- double-applying the reversal.
create table if not exists public.razorpay_refund_events (
  razorpay_refund_id text        primary key,
  sales_order_id      text        not null,
  amount               numeric     not null,
  event                text        not null,
  created_at           timestamptz not null default now()
);

alter table public.razorpay_refund_events enable row level security;
-- Service-role only (edge function), same as razorpay_payment_events — no
-- anon/authenticated policy needed.
