-- Lets Somya/Rohith mark a flagged phone number "reviewed" from the Phone
-- Lookup tab so it stops cluttering the CTA list — but only until the
-- underlying mapping actually changes again, not forever. Storing a
-- snapshot "signature" (the sorted door-key set at review time, same
-- door-key heuristic as admin_multi_house_numbers/migration 149) rather
-- than just a boolean/timestamp means this doesn't depend on trusting
-- updated_at being properly maintained on three different tables — the
-- CTA just recomputes the current signature on every load and compares.
create table if not exists public.phone_mapping_review_dismissals (
  phone_norm   text        primary key,
  signature    text        not null,
  dismissed_by text,
  dismissed_at timestamptz not null default now()
);

alter table public.phone_mapping_review_dismissals enable row level security;
drop policy if exists "authenticated all" on public.phone_mapping_review_dismissals;
create policy "authenticated all" on public.phone_mapping_review_dismissals
  for all to authenticated using (true) with check (true);

-- The current door-key signature for one phone — the ops-dashboard reads
-- this right before writing a dismissal row, so what's stored always
-- matches what was actually on screen when "reviewed" was clicked.
create or replace function public.admin_phone_mapping_signature(p_phone text)
returns text
language sql
stable
security definer
as $$
  with phone_owners as (
    select phone_number as phone, customer_name from public.customer_phones
    union all
    select phone, customer_name from public.orders where phone is not null and phone <> ''
    union all
    select phone_number, customer_name from public.invoice_line_items where phone_number is not null and phone_number <> ''
  ),
  normalized as (
    select
      customer_name,
      coalesce(substring(customer_name from '(\d+)(?!.*\d)'), lower(trim(customer_name))) as door_key
    from phone_owners
    where right(regexp_replace(phone, '\D', '', 'g'), 10)
        = right(regexp_replace(p_phone, '\D', '', 'g'), 10)
  )
  select array_to_string(array_agg(distinct door_key order by door_key), ',')
  from normalized;
$$;

grant execute on function public.admin_phone_mapping_signature(text) to authenticated;

-- Re-defined to skip anything dismissed whose signature hasn't moved since
-- — a dismissal whose stored signature no longer matches the freshly
-- computed one (a house added/removed/changed) falls straight back onto
-- the list, same as if it had never been reviewed.
create or replace function public.admin_multi_house_numbers()
returns table (phone text, house_count int, houses text[])
language sql
stable
security definer
as $$
  with phone_owners as (
    select phone_number as phone, customer_name from public.customer_phones
    union all
    select phone, customer_name from public.orders where phone is not null and phone <> ''
    union all
    select phone_number, customer_name from public.invoice_line_items where phone_number is not null and phone_number <> ''
  ),
  normalized as (
    select
      right(regexp_replace(phone, '\D', '', 'g'), 10) as phone_norm,
      customer_name,
      coalesce(substring(customer_name from '(\d+)(?!.*\d)'), lower(trim(customer_name))) as door_key
    from phone_owners
    where regexp_replace(phone, '\D', '', 'g') <> ''
  ),
  flagged as (
    select
      phone_norm,
      count(distinct door_key) as house_count,
      array_agg(distinct customer_name order by customer_name) as houses,
      array_to_string(array_agg(distinct door_key order by door_key), ',') as signature
    from normalized
    group by phone_norm
    having count(distinct door_key) > 1
  )
  select f.phone_norm, f.house_count::int, f.houses
  from flagged f
  left join public.phone_mapping_review_dismissals d on d.phone_norm = f.phone_norm
  where d.phone_norm is null or d.signature is distinct from f.signature
  order by f.house_count desc, f.phone_norm;
$$;

grant execute on function public.admin_multi_house_numbers() to authenticated;
