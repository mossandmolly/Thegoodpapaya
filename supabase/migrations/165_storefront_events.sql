-- Funnel tracking for the storefront: one row per meaningful step a
-- visitor takes, tied to an anonymous per-device id (config.js's
-- getDeviceId(), a random id generated once and kept in localStorage —
-- no account/login exists to key this on instead). phone/society/
-- door_number are null until the visitor actually types them in, same as
-- everywhere else in this app — nothing here is inferred or looked up.
--
-- Event types:
--   catalog_viewed   — index.html loaded
--   item_added       — a cart line was added/increased (item_name, quantity)
--   item_removed     — a cart line was removed entirely (item_name)
--   checkout_viewed  — checkout.html loaded with a non-empty cart
--   phone_entered    — a valid 10-digit phone was typed/confirmed at checkout
--   society_entered  — society + door number were both filled in
--   order_placed     — place-order succeeded (written server-side, not by
--                       the browser — see supabase/functions/place-order,
--                       so it's never lost to a redirect/payment hop that
--                       never makes it back to order-confirmed.html)
--
-- Same public-anon-insert-only / staff-only-read pattern as
-- invoice_page_visits (migration 157) and customer_feedback (155) — a
-- visitor can log their own funnel step but never read anyone else's.
create table if not exists public.storefront_events (
  id          uuid primary key default gen_random_uuid(),
  device_id   text not null,
  event_type  text not null check (event_type in (
                'catalog_viewed', 'item_added', 'item_removed',
                'checkout_viewed', 'phone_entered', 'society_entered',
                'order_placed'
              )),
  item_name       text,
  quantity        numeric,
  phone           text,
  society         text,
  door_number     text,
  sales_order_id  text,
  created_at      timestamptz not null default now()
);

create index if not exists idx_storefront_events_device_id  on public.storefront_events(device_id);
create index if not exists idx_storefront_events_created_at on public.storefront_events(created_at);
create index if not exists idx_storefront_events_event_type on public.storefront_events(event_type);

alter table public.storefront_events enable row level security;

drop policy if exists "anon insert" on public.storefront_events;
create policy "anon insert" on public.storefront_events
  for insert to anon with check (true);

drop policy if exists "authenticated read" on public.storefront_events;
create policy "authenticated read" on public.storefront_events
  for select to authenticated using (true);
