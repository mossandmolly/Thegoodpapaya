-- invoice_line_items has had RLS enabled since migration 001 but no policy
-- or grant was ever added — nothing in ops-dashboard has read it directly
-- before now (the storefront's "My Invoices" page goes through the
-- get_invoices_by_phone RPC instead, which runs as SECURITY DEFINER and so
-- never needed this). The new Veg Performance tab reads it directly as a
-- logged-in staff member (authenticated role), same as orders/order_items —
-- staff-only, not anon, since this is real per-line sales data.
grant select on public.invoice_line_items to authenticated;

drop policy if exists "authenticated read" on public.invoice_line_items;
create policy "authenticated read" on public.invoice_line_items
  for select to authenticated using (true);
