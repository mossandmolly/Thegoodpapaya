-- orders_ensure_customer (migration 030) only guards against ON CONFLICT
-- (customer_name) — the exact-name unique constraint. Migration 062 later
-- added a second, independent unique constraint on customers.normalized_key
-- (a generated, letters/digits-only column), which ON CONFLICT
-- (customer_name) does nothing to protect: two DIFFERENT customer_name
-- values that both strip down to an empty normalized_key (blank, symbols-
-- only, emoji-only — e.g. a WhatsApp sender with no real display name)
-- collide on customers_normalized_key_unique and throw an unhandled
-- 23505, rolling back the entire order insert, not just the customers
-- side effect.
--
-- The other two customer-normalization triggers (orders_canonicalize_
-- customer_name, migration 061; order_items_apply_standing_instructions,
-- migration 060) already skip when the normalized key is empty — this
-- brings orders_ensure_customer in line with that same guard.
create or replace function public.orders_ensure_customer()
returns trigger language plpgsql as $$
begin
  if lower(regexp_replace(new.customer_name, '[^a-zA-Z0-9]', '', 'g')) = '' then
    return new;
  end if;

  insert into public.customers (customer_name)
  values (new.customer_name)
  on conflict (customer_name) do nothing;
  return new;
end;
$$;
