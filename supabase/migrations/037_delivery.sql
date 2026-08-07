-- Delivery tab: tracks whether an order has been delivered, plus an
-- optional remark and a photo (proof of delivery / left-at-gate note etc.)
-- captured by the delivery staff when they mark it.

alter table public.orders
  add column if not exists delivery_status text not null default 'pending'
    check (delivery_status in ('pending','delivered')),
  add column if not exists delivered_at       timestamptz,
  add column if not exists delivery_notes     text,
  add column if not exists delivery_photo_path text;

create index if not exists idx_orders_delivery_status on public.orders(delivery_status);

-- Delivery instructions ("deliver after 4pm", "don't ring bell", "don't
-- collect money") live on order_items, not orders — the parser already
-- puts everything it reads into each item's existing `description`, and
-- continues to; this is an ADDITIONAL field so the Delivery tab can show
-- just the delivery-relevant note without the rest of the item description
-- mixed in. Also editable directly from the Delivery tab.
alter table public.order_items
  add column if not exists delivery_instructions text;

-- order_customer_lookup is the narrow view the frontend reads orders
-- through (orders itself is locked to service-role-only reads). Redefined
-- here to add the delivery columns on top of its existing ones — if this
-- view has picked up extra logic since it was first created (it isn't
-- tracked in a migration file), reconcile that before running this.
create or replace view public.order_customer_lookup as
select
  sales_order_id,
  customer_name,
  phone,
  razorpay_url,
  invoice_status,
  status,
  delivery_status,
  delivered_at,
  delivery_notes,
  delivery_photo_path
from public.orders;

-- Storage bucket for delivery photos: create it in the dashboard first
-- (Storage → New bucket → name "delivery-photos", Public bucket OFF), then
-- run this to let any signed-in ops session (admin, packer, or the shared
-- delivery login) upload to and view it.
insert into storage.buckets (id, name, public)
values ('delivery-photos', 'delivery-photos', false)
on conflict (id) do nothing;

drop policy if exists "delivery_photos_authenticated_insert" on storage.objects;
create policy "delivery_photos_authenticated_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'delivery-photos');

drop policy if exists "delivery_photos_authenticated_select" on storage.objects;
create policy "delivery_photos_authenticated_select" on storage.objects
  for select to authenticated
  using (bucket_id = 'delivery-photos');
