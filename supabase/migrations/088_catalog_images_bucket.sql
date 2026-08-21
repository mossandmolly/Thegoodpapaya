-- New public bucket for the storefront's product thumbnails — placeholder
-- SVGs and later real bulk-uploaded photos alike. Same shape as
-- delivery-photos (migration 037) except public:true + an anon SELECT
-- policy, since these images need to load on the public storefront with no
-- login at all, unlike delivery photos which stay staff-only.
--
-- If this insert errors on permissions in your SQL editor session, create
-- it manually first instead (Storage → New bucket → name "catalog-images",
-- Public bucket ON), then just run the policy statements below.
insert into storage.buckets (id, name, public)
values ('catalog-images', 'catalog-images', true)
on conflict (id) do nothing;

drop policy if exists "catalog_images_public_select" on storage.objects;
create policy "catalog_images_public_select" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'catalog-images');

drop policy if exists "catalog_images_authenticated_insert" on storage.objects;
create policy "catalog_images_authenticated_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'catalog-images');

drop policy if exists "catalog_images_authenticated_update" on storage.objects;
create policy "catalog_images_authenticated_update" on storage.objects
  for update to authenticated
  using (bucket_id = 'catalog-images');

drop policy if exists "catalog_images_authenticated_delete" on storage.objects;
create policy "catalog_images_authenticated_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'catalog-images');
