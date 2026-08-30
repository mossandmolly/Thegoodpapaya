-- razorpay-webhook has no idempotency guard today: Razorpay retries webhook
-- delivery on any non-2xx response or timeout, and a retry re-runs the whole
-- handler — adding the same amount to orders.amount_paid a second time AND
-- calling Zoho's recordZohoPayment again for a payment already recorded.
-- This table is a claim-first idempotency key: the webhook inserts a row
-- keyed on Razorpay's own payment id BEFORE applying anything, and any
-- redelivery of that same payment id hits the unique constraint and is
-- skipped as a no-op instead of being reprocessed.
create table if not exists public.razorpay_payment_events (
  razorpay_payment_id text        primary key,
  sales_order_id       text        not null,
  amount                numeric     not null,
  event                 text        not null,
  created_at            timestamptz not null default now()
);

alter table public.razorpay_payment_events enable row level security;
-- Service-role only (edge function), same as invoice_queue — no anon/
-- authenticated policy needed.
