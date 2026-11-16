-- Resolves a house name for each customer_feedback row from its phone
-- number, same 3-table union (customer_phones / orders / invoice_line_items)
-- the Phone Lookup RPCs already use — "most recently created wins" on a
-- tie, matching orders_fill_phone_from_customer's own tie-break. Feedback
-- itself carries no customer_name (the survey only ever asked for a phone),
-- so this is a best-effort lookup, not a guaranteed match — a brand-new
-- phone with no order/invoice/manual-entry history yet resolves to null.
create or replace function public.admin_feedback_with_house()
returns table (
  id uuid, phone_number text, improvement_text text, recommend_score int,
  created_at timestamptz, house_name text
)
language sql
stable
security definer
as $$
  with phone_owners as (
    select phone_number as phone, customer_name, created_at as src_created_at from public.customer_phones
    union all
    select phone, customer_name, created_at from public.orders where phone is not null and phone <> ''
    union all
    select phone_number, customer_name, created_at from public.invoice_line_items where phone_number is not null and phone_number <> ''
  ),
  normalized as (
    select
      right(regexp_replace(phone, '\D', '', 'g'), 10) as phone_norm,
      customer_name,
      src_created_at
    from phone_owners
    where regexp_replace(phone, '\D', '', 'g') <> ''
  ),
  best as (
    select distinct on (phone_norm) phone_norm, customer_name
    from normalized
    order by phone_norm, src_created_at desc
  )
  select
    f.id, f.phone_number, f.improvement_text, f.recommend_score, f.created_at,
    b.customer_name as house_name
  from public.customer_feedback f
  left join best b on b.phone_norm = right(regexp_replace(coalesce(f.phone_number,''), '\D', '', 'g'), 10)
  order by f.created_at desc;
$$;

grant execute on function public.admin_feedback_with_house() to authenticated;
