-- Somya's manual "Current Order" override (Team view) — lets her drag-
-- reorder the stack of societies for today, overriding the algorithmic
-- community-priority ranking (sortGroupsByPriority) that would otherwise
-- decide the order everywhere it's used: Order Overview's Time Sensitive
-- view, Packer's Time Sensitive view, and every packer's own Single Card
-- queue. Scoped to view_date so it resets on its own each new day rather
-- than needing to be cleared by hand.
create table if not exists public.packer_priority_override (
  view_date  date not null,
  group_name text not null,
  sort_order integer not null,
  updated_at timestamptz not null default now(),
  primary key (view_date, group_name)
);

alter table public.packer_priority_override enable row level security;
drop policy if exists "packer_priority_override_all" on public.packer_priority_override;
create policy "packer_priority_override_all" on public.packer_priority_override for all using (true) with check (true);
