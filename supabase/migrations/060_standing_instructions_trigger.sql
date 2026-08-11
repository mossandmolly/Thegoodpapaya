-- Migration 050: enforce customer standing instructions at the database level
--
-- The first cut of this (parser.html's pushRows/addItemPrompt) only
-- injected customer_instructions client-side, in JS, before the insert —
-- meaning it only worked for orders created through those two specific UI
-- paths. Anything else that inserts into order_items directly (an external
-- automation tool, a future edge function, a one-off script) would silently
-- skip it, since the merge logic lived in the caller, not the data layer.
--
-- Moved here instead: a BEFORE INSERT trigger on order_items itself, so
-- every insert gets it — regardless of who's inserting or how — as long as
-- the order's header row (orders.customer_name) already exists by the time
-- the item row is. That's already guaranteed by every path in this app: the
-- orders header is always created first (create-order), item rows follow.
-- (Explicitly out of scope per current instructions: the public website
-- checkout, which writes into the separate legacy `operations` table, not
-- order_items, at all — this trigger has nothing to attach to there.)
--
-- Matched by the fully-stripped canonical key (letters/digits only — see
-- customer_instructions.normalized_key, migration 048) so every spelling
-- variant of a customer's name resolves to the same instructions
-- automatically, with nothing to "copy" when a new variant shows up via
-- Zoho or anywhere else — the lookup is always by key, never by exact
-- name, so there's no separate copy to go stale.
create or replace function public.order_items_apply_standing_instructions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cust_name text;
  norm_key  text;
  instr     text;
begin
  select customer_name into cust_name
    from public.orders where sales_order_id = new.sales_order_id;
  if cust_name is null then
    return new;
  end if;

  norm_key := lower(regexp_replace(cust_name, '[^a-zA-Z0-9]', '', 'g'));
  if norm_key = '' then
    return new;
  end if;

  select instructions into instr
    from public.customer_instructions where normalized_key = norm_key;
  if instr is null then
    return new;
  end if;

  -- Bracket-tag convention already used for admin notes elsewhere in this
  -- app (upsertBracketedNote in parser.html) — checked for so a row that
  -- already carries the tag (e.g. a caller that already merged it in,
  -- or a retried insert) doesn't end up with it twice.
  if new.description is null or new.description !~ '\[Standing:' then
    new.description := nullif(trim(both ' ' from coalesce(new.description, '') || ' [Standing: ' || instr || ']'), '');
  end if;
  if new.delivery_instructions is null or new.delivery_instructions !~ '\[Standing:' then
    new.delivery_instructions := nullif(trim(both ' ' from coalesce(new.delivery_instructions, '') || ' [Standing: ' || instr || ']'), '');
  end if;

  return new;
end;
$$;

drop trigger if exists order_items_standing_instructions on public.order_items;
create trigger order_items_standing_instructions
  before insert on public.order_items
  for each row execute function public.order_items_apply_standing_instructions();
