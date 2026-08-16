-- Migration 075: WhatsApp listener connection status
--
-- Single-row table the whatsapp-listener service upserts on every connect,
-- disconnect and periodic heartbeat (using its service-role key, same as
-- whatsapp_parsed_orders inserts) — lets the ops dashboard's Live tab flag
-- when the listener has gone down, without anyone having to check Railway
-- logs by hand.

create table if not exists public.whatsapp_listener_status (
  id          int         primary key default 1,
  status      text        not null default 'unknown', -- 'connected' | 'reconnecting' | 'logged_out' | 'unknown'
  detail      text,
  updated_at  timestamptz not null default now(),
  constraint whatsapp_listener_status_singleton check (id = 1)
);

insert into public.whatsapp_listener_status (id, status)
values (1, 'unknown')
on conflict (id) do nothing;

alter table public.whatsapp_listener_status enable row level security;

-- Read-only for the dashboard (anon key); writes go through the listener's
-- service-role key, which bypasses RLS entirely — same split as `orders`.
drop policy if exists "public read" on public.whatsapp_listener_status;
create policy "public read" on public.whatsapp_listener_status for select using (true);
