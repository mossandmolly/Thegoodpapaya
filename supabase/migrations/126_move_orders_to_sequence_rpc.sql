-- Migration 126: replaces migration 125's broad "any authenticated user
-- can update any column on orders" policy with a narrow RPC — the
-- client never gets direct UPDATE access to orders at all, matching how
-- every other order mutation in this app already works (dispatch, mark
-- delivered, assign rider, rename_order_customer — all an RPC or edge
-- function running as service_role, never a raw client-side table
-- write). The only thing a logged-in user can do through this function
-- is move one or more orders' sequence_number — nothing else about the
-- row is touchable through it.
drop policy if exists "orders_update" on public.orders;

create or replace function public.move_orders_to_sequence(
  p_sales_order_ids text[],
  p_sequence_number  numeric
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.orders
     set sequence_number = p_sequence_number
   where sales_order_id = any(p_sales_order_ids);
end;
$$;

revoke all on function public.move_orders_to_sequence(text[], numeric) from public;
revoke all on function public.move_orders_to_sequence(text[], numeric) from anon;
grant execute on function public.move_orders_to_sequence(text[], numeric) to authenticated;
