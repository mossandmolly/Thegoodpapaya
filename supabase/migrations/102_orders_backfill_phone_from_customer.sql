-- Auto-fills orders.phone from customer_phones on insert, whenever the
-- order itself doesn't already carry one (e.g. WhatsApp couldn't resolve a
-- real number for this message — see whatsapp-listener's resolveSenderPhone
-- — or the order came from Quick Order Entry / the image parser, neither of
-- which ever captures a phone at all).
--
-- Pairs with the new Order Overview "+ Add phone" action (set-order-phone
-- edge function), which upserts into customer_phones whenever ops manually
-- keys a number in. Once that's happened once for a customer, every
-- SUBSEQUENT order for them (any spelling variant — customer_name is
-- already canonicalized by orders_canonicalize_customer_name, which this
-- fires after — see the trigger name ordering note below) picks up the
-- phone automatically, with no re-entry needed. Never overwrites a phone
-- an order already has (e.g. WhatsApp resolved one directly) — this is a
-- fallback fill, not a source of truth override.
--
-- most-recently-added phone wins when a customer has more than one row
-- (multiple Zoho contact numbers, or ops correcting an old/wrong one) —
-- newer information should win over stale.
create or replace function public.orders_fill_phone_from_customer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.phone is null or new.phone = '' then
    select phone_number into new.phone
      from public.customer_phones
     where customer_name = new.customer_name
     order by created_at desc
     limit 1;
  end if;
  return new;
end;
$$;

-- Named to sort after orders_canonicalize_customer_name (migration 061,
-- same before-insert timing) — Postgres runs same-timing triggers in name
-- order, and this needs customer_name already canonicalized before it
-- looks up customer_phones by it, or a spelling variant would miss a match
-- that exists under the canonical spelling.
drop trigger if exists orders_fill_phone_from_customer on public.orders;
create trigger orders_fill_phone_from_customer
  before insert on public.orders
  for each row execute function public.orders_fill_phone_from_customer();
