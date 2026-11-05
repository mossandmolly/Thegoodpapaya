-- create-storefront-bulk-payment-link now reuses an existing unconsumed
-- link when nothing about the pending set has changed since it was made
-- (see that function's own comment) — needs the short_url on hand to
-- return it without a second Razorpay call, so store it alongside the id.
alter table public.razorpay_bulk_payment_links
  add column if not exists payment_url text;
