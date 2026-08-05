-- Migration 051: one canonical spelling of customer_name, enforced on write
--
-- sales_order_id is already collision-safe across spellings — it's keyed
-- by canonicalCustomerKey, so "Villa 60"/"Villa-60"/"villa60" all produce
-- the same id and land on the same order_items regardless. But
-- orders.customer_name itself was never canonicalized: whichever spelling
-- happened to be first through create-order on a given day is what stuck
-- for THAT order, so the same real customer could read differently across
-- different days depending on which variant got typed/parsed first each
-- time. This makes it read consistently everywhere, always.
--
-- customers is already this app's source of truth for a customer's
-- canonical spelling (Zoho-sourced via sync-customers, best-cased). Adds a
-- generated, indexed normalized_key column to it (letters/digits only,
-- same rule as customer_instructions/sales_order_id), then a trigger on
-- orders that rewrites an incoming customer_name to match whatever's
-- already on file in customers for that key — before the row is ever
-- written, not after. A genuinely new customer (no existing match) gets
-- title-cased on the spot instead of passed through as typed, and
-- orders_ensure_customer (migration 019/020) already auto-creates their
-- customers row afterward from that, becoming the canonical spelling for
-- next time.
--
-- Fires on UPDATE OF customer_name too, not just INSERT — so
-- rename-order-customer (migration 047) gets the same guarantee: renaming
-- to a spelling variant of an existing customer snaps to that customer's
-- canonical name instead of minting a second one.
--
-- Deliberately NOT adding a hard unique constraint on customers'
-- normalized_key here — if customers already has pre-existing duplicate
-- spellings from before this migration (or before the sync-customers
-- dedup fix), a unique index would fail to create at all. Run the
-- diagnostic query below first; if it returns rows, those need merging
-- (by hand, or ask for help) before a hard constraint can safely go on.
--
--   select normalized_key, array_agg(customer_name) as spellings
--   from public.customers
--   group by normalized_key
--   having count(*) > 1;

alter table public.customers
  add column if not exists normalized_key text
  generated always as (lower(regexp_replace(customer_name, '[^a-zA-Z0-9]', '', 'g'))) stored;

create index if not exists idx_customers_normalized_key
  on public.customers(normalized_key);

create or replace function public.orders_canonicalize_customer_name()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  norm_key  text;
  canonical text;
begin
  norm_key := lower(regexp_replace(new.customer_name, '[^a-zA-Z0-9]', '', 'g'));
  if norm_key = '' then
    return new;
  end if;

  -- If customers already has more than one row for this key (a
  -- pre-existing duplicate from before this migration, or before the
  -- sync-customers dedup fix), the choice can't be arbitrary — that would
  -- just reintroduce the exact "which spelling wins" inconsistency this
  -- migration exists to remove. Prefer a Zoho-verified row over one only
  -- ever auto-created from an order (zoho_contact_id is null for those —
  -- see orders_ensure_customer, migration 019/020), then whichever
  -- synced most recently, then alphabetical as a last, purely-for-
  -- determinism tiebreak. This is a safety net for the transition, not a
  -- fix for the underlying duplicate — see this migration's diagnostic
  -- query up top.
  select customer_name into canonical
    from public.customers
   where normalized_key = norm_key
   order by (zoho_contact_id is not null) desc, synced_at desc nulls last, customer_name asc
   limit 1;

  if canonical is not null then
    -- A known customer — always use the spelling already on file,
    -- whatever this particular order happened to be typed/parsed as.
    new.customer_name := canonical;
  else
    -- First order ever for this customer — nothing to match against yet,
    -- so THIS order's spelling becomes the canonical one going forward
    -- (via orders_ensure_customer, migration 019/020). Title-case it
    -- properly rather than locking in whatever raw casing came in
    -- ("VILLA 60", "villa signature 60") as that customer's name forever.
    new.customer_name := initcap(trim(regexp_replace(new.customer_name, '\s+', ' ', 'g')));
  end if;

  return new;
end;
$$;

-- Named to sort alphabetically before orders_set_community (migration
-- 008), which also fires "before insert or update of customer_name" and
-- derives community FROM customer_name — Postgres runs same-timing
-- triggers in name order, so this needs to canonicalize first.
drop trigger if exists orders_canonicalize_customer_name on public.orders;
create trigger orders_canonicalize_customer_name
  before insert or update of customer_name on public.orders
  for each row execute function public.orders_canonicalize_customer_name();
