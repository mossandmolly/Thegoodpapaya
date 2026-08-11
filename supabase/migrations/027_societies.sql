-- 017_societies.sql
-- Apartment complex / society lookup table.
-- Replaces the hardcoded CANONICAL_SOCIETIES + SOC_ALIASES arrays in order-parser.js.
-- canonical_name: lowercase key used by the parser
-- aliases: alternate spoken/typed forms that resolve to this canonical name

create table if not exists public.societies (
  id             uuid        primary key default gen_random_uuid(),
  canonical_name text        not null unique,
  aliases        text[]      not null default '{}',
  active         boolean     not null default true,
  created_at     timestamptz not null default now()
);

alter table public.societies enable row level security;
create policy "public read"   on public.societies for select using (true);
create policy "anon insert"   on public.societies for insert with check (true);
create policy "anon update"   on public.societies for update using (true);
create policy "anon delete"   on public.societies for delete using (true);

-- Seed: all canonical names + spoken/typed aliases
insert into public.societies (canonical_name, aliases) values
  ('77degree',          array['77', '77-degree']),
  ('80trees',           array['80tree']),
  ('ahad',              array[]::text[]),
  ('akme',              array['akmi']),
  ('ascentia',          array['essentia']),
  ('assetz',            array[]::text[]),
  ('bhuvi',             array[]::text[]),
  ('dsr',               array[]::text[]),
  ('dsrparkway',        array[]::text[]),
  ('espana',            array[]::text[]),
  ('ferns',             array['feens']),
  ('iksha',             array['lksha']),
  ('iris',              array[]::text[]),
  ('ivy',               array[]::text[]),
  ('jade',              array[]::text[]),
  ('kethana',           array[]::text[]),
  ('krishvigavakshi',   array['krishvagavakshi','krishvi','krishvika','krishvigavakahi','krishvigavkshi','krishvugavakshi']),
  ('lakefront',         array[]::text[]),
  ('lotus',             array[]::text[]),
  ('meda',              array[]::text[]),
  ('pristine',          array[]::text[]),
  ('regalia',           array['regaila']),
  ('rohan',             array[]::text[]),
  ('saroj',             array[]::text[]),
  ('silvedale',         array[]::text[]),
  ('silverdale',        array[]::text[]),
  ('silversun',         array[]::text[]),
  ('summerfieldvilla',  array[]::text[]),
  ('suncity',           array[]::text[]),
  ('sunnyside',         array['sunny']),
  ('sunshinesignature', array[]::text[]),
  ('t1',                array[]::text[]),
  ('t2',                array[]::text[]),
  ('t3',                array[]::text[]),
  ('t4',                array[]::text[]),
  ('t5',                array[]::text[]),
  ('t6',                array[]::text[]),
  ('t7',                array[]::text[]),
  ('uberphase1',        array['uber']),
  ('uberphase2',        array[]::text[]),
  ('vajram',            array[]::text[]),
  ('vars',              array[]::text[]),
  ('villa',             array['vella','vela','vila','vill']),
  ('wing',              array[]::text[]),
  ('dhavala',           array[]::text[]),
  ('palmera',           array[]::text[])
on conflict (canonical_name) do nothing;
