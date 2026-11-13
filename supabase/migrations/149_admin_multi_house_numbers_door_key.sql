-- admin_multi_house_numbers (migration 148) was flagging 225 phone numbers
-- by counting DISTINCT customer_name — which caught a flood of false
-- positives where the same physical house is just written inconsistently
-- ("Royal Pavilion 8132" / "Sobha Royal Pavilion 8132" / "Srp 8132" — one
-- door, three spellings), drowning out the genuinely wrong mappings (a
-- phone shared across different door numbers entirely, e.g. Pristine 221 /
-- 4101 / 443).
--
-- Re-keyed on a "door_key" instead: the last run of digits in the name
-- (falls back to the full lowercased name when there's no digit at all) —
-- same heuristic worked out ad hoc this session. Only a phone with more
-- than one DISTINCT door number is flagged now; spelling-only variants of
-- the same door collapse into one and drop off the list entirely. The
-- houses array still shows every raw customer_name spelling found, for
-- context once you open one.
--
-- Known caveat carried over as-is: a name like "Srp 11153 Wing 11" grabs
-- "11" (the last digit run) rather than "11153", since "Wing 11" trails
-- the real door number — worth tightening later if this misfires often in
-- practice, but not changed here since it hasn't been confirmed as a real
-- problem yet.
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
  )
  select
    phone_norm,
    count(distinct door_key)::int,
    array_agg(distinct customer_name order by customer_name)
  from normalized
  group by phone_norm
  having count(distinct door_key) > 1
  order by count(distinct door_key) desc, phone_norm;
$$;

grant execute on function public.admin_multi_house_numbers() to authenticated;
