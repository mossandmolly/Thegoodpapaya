-- Migration 052: merge pre-existing customer_name duplicates
--
-- Run after 051 surfaced 100+ groups of pre-existing customers rows
-- sharing a normalized_key (different spacing/punctuation/casing of the
-- same real customer — "DSRParkway 11125" / "Dsrparkway 11125", etc.),
-- accumulated before that migration's canonicalization trigger existed.
--
-- Only the customers table (and its FK children customer_phones/
-- customer_notes) needs cleaning up here — historical orders/order_items
-- are untouched and don't need to be. sales_order_id was always keyed by
-- the same normalized value regardless of which spelling was typed on any
-- given day, so these customers-table duplicates never caused split order
-- history, only redundant reference rows. (Existing orders.customer_name
-- values keep whatever spelling they were written with historically —
-- migration 051 only canonicalizes new/renamed orders going forward.)
--
-- Same deterministic pick rule as orders_canonicalize_customer_name
-- (migration 051): prefer a Zoho-verified row (zoho_contact_id not null),
-- then most recently synced, then alphabetical — so the winner picked
-- here is the exact same one the trigger would already be picking live.
do $$
declare
  grp          record;
  winner       text;
  phone_row    record;
  has_phones   boolean := to_regclass('public.customer_phones') is not null;
  has_notes    boolean := to_regclass('public.customer_notes')  is not null;
begin
  for grp in
    select normalized_key
    from public.customers
    group by normalized_key
    having count(*) > 1
  loop
    select customer_name into winner
      from public.customers
     where normalized_key = grp.normalized_key
     order by (zoho_contact_id is not null) desc, synced_at desc nulls last, customer_name asc
     limit 1;

    -- customer_phones: (customer_name, phone_number) is the primary key,
    -- and phone_number is separately unique — repointing a loser's phone
    -- to the winner's name could collide if the winner already has that
    -- exact number under their own name (same person registered twice).
    -- Row-by-row with an exception guard so one such collision doesn't
    -- abort the whole cleanup; the loser's copy just gets dropped along
    -- with its customers row below (ON DELETE CASCADE, if the table
    -- exists at all — the migration that defines it, 019, doesn't appear
    -- to have actually landed in this database).
    if has_phones then
      for phone_row in execute
        'select customer_name, phone_number from public.customer_phones
          where customer_name in (
            select customer_name from public.customers
             where normalized_key = $1 and customer_name <> $2
          )'
        using grp.normalized_key, winner
      loop
        begin
          execute
            'update public.customer_phones set customer_name = $1
              where customer_name = $2 and phone_number = $3'
            using winner, phone_row.customer_name, phone_row.phone_number;
        exception when unique_violation then
          null;
        end;
      end loop;
    end if;

    if has_notes then
      execute
        'update public.customer_notes set customer_name = $1
          where customer_name in (
            select customer_name from public.customers
             where normalized_key = $2 and customer_name <> $1
          )'
        using winner, grp.normalized_key;
    end if;

    delete from public.customers
     where normalized_key = grp.normalized_key and customer_name <> winner;
  end loop;
end $$;

-- Now that customers has (at most) one row per normalized_key, the hard
-- constraint deferred in migration 051 can safely go on — guarantees no
-- future path (a direct insert, a future edge function, anything) can
-- ever reintroduce a duplicate at the database level, not just via the
-- orders-side trigger.
alter table public.customers
  add constraint customers_normalized_key_unique unique (normalized_key);
