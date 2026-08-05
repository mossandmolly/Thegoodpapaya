-- Migration 047: rename an order's customer (and cascade its sales_order_id)
--
-- sales_order_id is "YYYY-MM-DD-CustomerName" (see 020) — it's *derived*
-- from the customer name, not an independent identifier, so editing the
-- name from Order Overview has to rename the primary key too, everywhere
-- it's duplicated (order_items.sales_order_id has no FK — that table was
-- dropped and recreated outside the tracked migrations at some point, see
-- 020's DROP — so a plain repoint is safe there). invoice_queue DOES have
-- a real FK to orders(sales_order_id) with ON DELETE CASCADE, which makes
-- a straight "rename the parent, then fix up the children" ordering
-- impossible (the child row would briefly point at a parent id that
-- doesn't exist yet, however you sequence it) — so that FK needs to be
-- deferrable, and the whole rename needs to run as one transaction with
-- constraint checking deferred to commit. This finds *any* FK anywhere in
-- public that references orders(sales_order_id) — not just invoice_queue
-- by name — so a future table added the same way doesn't silently break
-- this again.

do $$
declare
  con record;
begin
  for con in
    select conrelid::regclass::text as tbl, conname
    from pg_constraint
    where contype = 'f'
      and confrelid = 'public.orders'::regclass
      and (
        select array_agg(attname)
        from unnest(confkey) k(attnum)
        join pg_attribute a on a.attrelid = confrelid and a.attnum = k.attnum
      ) = array['sales_order_id']
  loop
    execute format('alter table %s alter constraint %I deferrable initially immediate', con.tbl, con.conname);
  end loop;
end $$;

-- Renames the order: repoints every table with a sales_order_id column
-- (found dynamically — covers order_items, invoice_queue, and anything
-- else with that column name, present or future) from the old id to the
-- new one, then renames the orders row itself last. security definer since
-- orders' RLS is service-role-only for writes (see 020) and this needs to
-- touch it directly; only service_role may call it (grants below) — the
-- edge function wrapping this is the actual write path, same as every
-- other orders mutation in this app.
create or replace function public.rename_order_customer(
  p_old_sales_order_id text,
  p_new_customer_name  text,
  p_new_sales_order_id text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  t record;
begin
  if not exists (select 1 from public.orders where sales_order_id = p_old_sales_order_id) then
    raise exception 'Order % not found', p_old_sales_order_id;
  end if;
  if p_old_sales_order_id <> p_new_sales_order_id
     and exists (select 1 from public.orders where sales_order_id = p_new_sales_order_id) then
    raise exception 'An order already exists for % — pick a different name or merge manually', p_new_sales_order_id;
  end if;

  set constraints all deferred;

  for t in
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'sales_order_id' and table_name <> 'orders'
  loop
    execute format(
      'update public.%I set sales_order_id = $1 where sales_order_id = $2',
      t.table_name
    ) using p_new_sales_order_id, p_old_sales_order_id;
  end loop;

  update public.orders
     set sales_order_id = p_new_sales_order_id,
         customer_name  = p_new_customer_name
   where sales_order_id = p_old_sales_order_id;
end;
$$;

revoke all on function public.rename_order_customer(text,text,text) from public;
revoke all on function public.rename_order_customer(text,text,text) from anon;
revoke all on function public.rename_order_customer(text,text,text) from authenticated;
grant execute on function public.rename_order_customer(text,text,text) to service_role;
