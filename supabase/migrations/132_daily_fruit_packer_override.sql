-- Blanket "all of this fruit goes to this packer, just for today" override,
-- settable from the Team tab (parser.html's renderDailyFruitOverridePanel) —
-- distinct from packer_assignments (migration 005), which is the permanent
-- Item -> Packer default edited in Config. Scoped to a single calendar date
-- (IST) so it never silently carries into tomorrow — per Somya, "next day
-- needs to be done afresh." effectivePackerIdForItem (parser.html) and
-- compute-next-sequence both check this ahead of the permanent default,
-- behind only a genuine per-item reassignment (order_items.assigned_packer_id).
create table if not exists public.daily_fruit_packer_overrides (
  item_name      text not null,
  override_date  date not null,
  packer_id      uuid not null references public.packers(id) on delete cascade,
  set_at         timestamptz not null default now(),
  primary key (item_name, override_date)
);

alter table public.daily_fruit_packer_overrides enable row level security;

-- Same open-access pattern as packer_assignments/communities (migrations
-- 005/006) — one shared login per role, no per-user row security.
create policy "daily_fruit_packer_overrides_all" on public.daily_fruit_packer_overrides
  for all using (true) with check (true);
