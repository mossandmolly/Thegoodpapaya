-- catalog's RLS policies (catalog_read_anon, "public read" — migrations
-- 019/028) already permit anon SELECT on every row, but that alone isn't
-- enough: Postgres also requires a base table-level GRANT before RLS is
-- even evaluated. Nothing ever explicitly granted it to anon — ops-dashboard
-- never noticed because staff are logged in, so their requests run as
-- authenticated (which does have access), not anon. The new storefront is
-- the first genuinely-anonymous (logged-out) reader of this table, and hit
-- "permission denied for table catalog" (42501) as a result.
grant select on public.catalog to anon;
