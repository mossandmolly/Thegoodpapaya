-- Tracks when the current dynamic QR was created, so a periodic sweep
-- (sync-invoices) can proactively refresh it at 90 minutes — safely before
-- Razorpay's own ~2hr close_by — instead of waiting for it to actually
-- expire. Replaces the earlier "refresh on last house of a society
-- delivered" approach (removed): a plain age check needs no rider
-- location/society-completion detection at all.
alter table orders add column if not exists qr_created_at timestamptz;
