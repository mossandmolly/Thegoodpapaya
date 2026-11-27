-- Idempotency log for reconcile-zoho-payments (migration 175) — same
-- shape/purpose as razorpay_payment_events (migration 097), but for THIS
-- function instead. Without it, every run re-scans the same rolling 24h
-- window of Zoho payments and re-fetches every distinct invoice's live
-- balance every single time, even ones it already resolved hours ago —
-- fine at a handful of payments/day, but genuinely dangerous (thousands
-- of redundant Zoho calls per run, real risk of the function timing out
-- before finishing) at real volume. Logging a payment_id here the first
-- time it's actually evaluated means every later run that still sees it
-- in its window skips straight past it with zero Zoho calls.
create table if not exists public.zoho_payment_reconcile_log (
  payment_id    text        primary key,
  invoice_id    text,
  processed_at  timestamptz not null default now()
);

create index if not exists idx_zoho_payment_reconcile_log_processed_at
  on public.zoho_payment_reconcile_log(processed_at);

alter table public.zoho_payment_reconcile_log enable row level security;
-- Service-role only (edge function), same as razorpay_payment_events —
-- no anon/authenticated policy needed.
