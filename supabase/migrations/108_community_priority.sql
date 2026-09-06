-- Phase 1 of the Packer Single-Card Queue feature. Additive, parallel to
-- the existing communities/clusters model (untouched) — powers only the
-- new Packer "Single Card" view. See plan doc for full rationale.

create table if not exists public.community_priority (
  unique_id    text primary key,        -- owner-assigned slug, e.g. 'srp'
  display_name text not null,
  rank         integer,                 -- lower = pack first; null = unranked, sorts last
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.community_priority_keywords (
  id                  uuid primary key default gen_random_uuid(),
  community_unique_id text not null references public.community_priority(unique_id)
                       on update cascade on delete cascade,
  keyword             text not null,
  created_at          timestamptz not null default now()
);
-- A phrase must resolve to exactly one community, or matching is ambiguous.
create unique index if not exists community_priority_keywords_unique_kw
  on public.community_priority_keywords (lower(keyword));

-- Phase-2 foundation only — created now so phase 2 doesn't need a second
-- migration, but nothing reads these yet.
create table if not exists public.community_combinable_groups (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  created_at timestamptz not null default now()
);
create table if not exists public.community_combinable_group_members (
  group_id            uuid not null references public.community_combinable_groups(id) on delete cascade,
  community_unique_id text not null references public.community_priority(unique_id) on delete cascade,
  primary key (group_id, community_unique_id)
);

alter table public.community_priority enable row level security;
alter table public.community_priority_keywords enable row level security;
alter table public.community_combinable_groups enable row level security;
alter table public.community_combinable_group_members enable row level security;

drop policy if exists "community_priority_all" on public.community_priority;
create policy "community_priority_all" on public.community_priority for all using (true) with check (true);
drop policy if exists "community_priority_keywords_all" on public.community_priority_keywords;
create policy "community_priority_keywords_all" on public.community_priority_keywords for all using (true) with check (true);
drop policy if exists "community_combinable_groups_all" on public.community_combinable_groups;
create policy "community_combinable_groups_all" on public.community_combinable_groups for all using (true) with check (true);
drop policy if exists "community_combinable_group_members_all" on public.community_combinable_group_members;
create policy "community_combinable_group_members_all" on public.community_combinable_group_members for all using (true) with check (true);

-- Reference matching rule (documents the spec; the live Packer queue
-- mirrors this same substring rule in JS for instant, no-round-trip
-- reactivity — see matchCommunityPriority() in parser.html).
create or replace function public.match_community_priority(p_text text)
returns table(unique_id text, rank integer, matched_keyword text)
language sql stable security definer as $$
  select cp.unique_id, cp.rank, k.keyword
  from public.community_priority_keywords k
  join public.community_priority cp on cp.unique_id = k.community_unique_id
  where p_text is not null and strpos(lower(p_text), lower(k.keyword)) > 0
  order by length(k.keyword) desc   -- longest/most-specific keyword wins on overlap
  limit 1;
$$;
grant execute on function public.match_community_priority(text) to anon, authenticated;

-- Packer Single-Card timer, reusing the pre-existing (previously unused)
-- app_settings key/value table from migration 042.
insert into public.app_settings (key, value) values ('packer_card_timer_seconds', '90')
on conflict (key) do nothing;

-- One-time seed, run manually from the SQL editor once ready (not run
-- automatically here — should happen after review, not silently at
-- migration time). Transfers existing communities.stack_rank 1:1 as a
-- starting point; additional keyword synonyms per place (e.g. "srp" +
-- "royal pavilion" both mapping to one unique_id) are then added
-- incrementally via the new Config UI.
--
-- insert into community_priority (unique_id, display_name, rank)
--   select lower(regexp_replace(name,'[^a-zA-Z0-9]','','g')), name, stack_rank
--   from communities where stack_rank is not null
--   on conflict (unique_id) do nothing;
-- insert into community_priority_keywords (community_unique_id, keyword)
--   select lower(regexp_replace(name,'[^a-zA-Z0-9]','','g')), name
--   from communities where stack_rank is not null
--   on conflict (lower(keyword)) do nothing;
