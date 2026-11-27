-- orders.payment_collected_method was only ever allowed 'cash'/'online'
-- (migration 038) — but mark-order-paid has been writing 'screenshot'
-- for a while now with no migration ever widening this constraint, and
-- reconcile-zoho-payments (migration 175) needs a new 'zoho_direct' value
-- for a payment it found recorded directly in Zoho rather than through
-- either of this app's own two payment channels. Widening, not
-- loosening — still a fixed, known set of values.
alter table public.orders
  drop constraint if exists orders_payment_collected_method_check;

alter table public.orders
  add constraint orders_payment_collected_method_check
    check (payment_collected_method in ('cash', 'online', 'screenshot', 'zoho_direct'));
