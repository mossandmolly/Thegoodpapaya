-- "Pay All" feature: one Razorpay payment link covering every pending
-- invoice shown to a customer on the storefront, instead of one link per
-- invoice. Razorpay's own `notes` field only holds short strings (fine for
-- "which orders", not for "how much of this payment belongs to each one"),
-- so the authoritative order->amount breakdown lives here instead;
-- razorpay-webhook looks it up by the link's own Razorpay id the moment a
-- payment lands, and splits the single payment back across each order's
-- orders row + Zoho invoice.
create table if not exists public.razorpay_bulk_payment_links (
  razorpay_link_id text        primary key,
  phone             text        not null,
  breakdown         jsonb       not null, -- [{ "sales_order_id": "...", "amount": 452.30 }, ...] — amount is that order's balance_due at link-creation time
  created_at        timestamptz not null default now(),
  consumed_at       timestamptz
);

alter table public.razorpay_bulk_payment_links enable row level security;
-- Service-role only (edge functions: create-storefront-bulk-payment-link
-- writes it, razorpay-webhook reads it) — same as razorpay_payment_events,
-- no anon/authenticated policy needed.
