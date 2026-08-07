-- Migration 053: standing instructions become multiple, audience-targeted entries
--
-- The first cut of customer_instructions (048) was one row per customer —
-- a single plain-text note applied to both description (packing) and
-- delivery_instructions (delivery) alike. Turns out a customer can need
-- DIFFERENT notes for each — a packing-specific note ("always slightly
-- raw") and a delivery-specific one ("leave at gate") aren't the same
-- thing and showing one to the wrong audience is just noise. This moves
-- to multiple rows per customer, each tagged with who it's for.
--
-- normalized_key was the primary key (one row per customer); now it's
-- just an indexed column, since more than one row per customer is the
-- whole point. A fresh uuid id becomes the real primary key.
alter table public.customer_instructions
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists target text not null default 'both'
    check (target in ('packer', 'delivery', 'both')),
  add column if not exists created_at timestamptz not null default now();

-- Backfill id for any pre-existing rows before it becomes the PK (gen_random_uuid()
-- default only applies to NEW rows, not ones already present).
update public.customer_instructions set id = gen_random_uuid() where id is null;
alter table public.customer_instructions alter column id set not null;

alter table public.customer_instructions drop constraint if exists customer_instructions_pkey;
alter table public.customer_instructions add primary key (id);

create index if not exists idx_customer_instructions_normalized_key
  on public.customer_instructions(normalized_key);

-- Applies every standing instruction for this order's customer, split by
-- audience: 'packer'/'both' entries merge into description (what the
-- packer sees), 'delivery'/'both' into delivery_instructions (what the
-- rider sees) — multiple matching entries concatenate into one
-- [Standing: ...] block rather than needing one instruction per customer.
create or replace function public.order_items_apply_standing_instructions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cust_name    text;
  norm_key     text;
  packer_text  text;
  delivery_text text;
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

  select string_agg(instructions, '; ' order by created_at) into packer_text
    from public.customer_instructions
   where normalized_key = norm_key and target in ('packer', 'both');

  select string_agg(instructions, '; ' order by created_at) into delivery_text
    from public.customer_instructions
   where normalized_key = norm_key and target in ('delivery', 'both');

  if packer_text is not null
     and (new.description is null or new.description !~ '\[Standing:') then
    new.description := nullif(trim(both ' ' from coalesce(new.description, '') || ' [Standing: ' || packer_text || ']'), '');
  end if;

  if delivery_text is not null
     and (new.delivery_instructions is null or new.delivery_instructions !~ '\[Standing:') then
    new.delivery_instructions := nullif(trim(both ' ' from coalesce(new.delivery_instructions, '') || ' [Standing: ' || delivery_text || ']'), '');
  end if;

  return new;
end;
$$;
