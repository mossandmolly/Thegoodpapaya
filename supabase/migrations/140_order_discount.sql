-- Per-order discount, set from Order Overview, applied to the Zoho invoice
-- at generate-invoice time (both a fresh invoice and a regeneration —
-- generate-invoice always rebuilds the Zoho invoice from current order
-- state, so this just becomes one more input to that same call).
-- discount_type is null when no discount is set; discount_value is the
-- raw number entered — rupees for 'flat', 0-100 for 'percent'.
alter table public.orders
  add column if not exists discount_type  text    check (discount_type in ('flat','percent')),
  add column if not exists discount_value numeric check (discount_value >= 0);

-- A discount_value without a discount_type (or vice versa) is meaningless —
-- keep them in lockstep rather than relying on application code alone to
-- never leave one set without the other.
alter table public.orders
  add constraint orders_discount_pair_check
  check ((discount_type is null) = (discount_value is null));
