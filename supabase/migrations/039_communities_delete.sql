-- communities had SELECT (006), INSERT (008), and UPDATE (036) policies,
-- but nothing ever let an authenticated session DELETE a row — needed now
-- that Config's Communities table gets a manual add/remove UI (previously
-- rows only ever grew automatically from order data, never removed).
create policy "communities_delete" on public.communities
  for delete using (true);
