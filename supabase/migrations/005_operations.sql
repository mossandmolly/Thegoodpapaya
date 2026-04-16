-- Migration 005: Operations dashboard tables

-- ── Communities ───────────────────────────────────────────────
create table if not exists communities (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,
  created_at    timestamptz not null default now()
);

-- ── Packers ───────────────────────────────────────────────────
create table if not exists packers (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- ── Packer assignments (fixed: packer handles fruit) ─────────
create table if not exists packer_assignments (
  id            uuid primary key default gen_random_uuid(),
  packer_id     uuid not null references packers(id) on delete cascade,
  item_name     text not null,
  unique (packer_id, item_name)
);

-- ── Customer notes ────────────────────────────────────────────
create table if not exists customer_notes (
  id            uuid primary key default gen_random_uuid(),
  customer_name text not null references customers(customer_name) on update cascade on delete cascade,
  note          text,
  updated_at    timestamptz not null default now()
);

create unique index idx_customer_notes_customer on customer_notes(customer_name);

-- ── Operations working table ──────────────────────────────────
create table if not exists operations (
  id                 uuid primary key default gen_random_uuid(),
  sales_order_id     text not null,          -- YYYY-MM-DD-CustomerName
  invoice_date       date not null,
  customer_name      text not null,
  community          text,                   -- auto-extracted from customer_name
  item_name          text not null,
  description        text,                   -- ripeness, size, special requests
  requested_quantity numeric,
  final_quantity     numeric,
  status             text not null default 'draft' check (status in ('draft', 'final')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (sales_order_id, item_name)
);

create index idx_operations_date        on operations(invoice_date);
create index idx_operations_order       on operations(sales_order_id);
create index idx_operations_community   on operations(community);
create index idx_operations_status      on operations(status);

-- ── Auto-update updated_at ────────────────────────────────────
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

create trigger operations_updated_at
  before update on operations
  for each row execute function update_updated_at();

create trigger customer_notes_updated_at
  before update on customer_notes
  for each row execute function update_updated_at();

-- ── Extract community from customer name ──────────────────────
-- Rule: last space-separated token containing a digit = door number
--       everything before = community name
create or replace function extract_community(customer_name text)
returns text language plpgsql immutable as $$
declare
  parts text[];
  i int;
begin
  parts := string_to_array(trim(customer_name), ' ');
  -- Walk from the end, find last token with a digit = door number
  for i in reverse array_length(parts, 1)..1 loop
    if parts[i] ~ '\d' then
      -- Everything before this token is the community
      if i = 1 then return null; end if;
      return array_to_string(parts[1:i-1], ' ');
    end if;
  end loop;
  return customer_name; -- fallback
end;
$$;

-- ── Auto-populate community on insert/update ──────────────────
create or replace function set_community()
returns trigger language plpgsql as $$
begin
  new.community := extract_community(new.customer_name);
  return new;
end;
$$;

create trigger operations_set_community
  before insert or update of customer_name on operations
  for each row execute function set_community();

-- ── Populate communities table from operations ────────────────
create or replace function sync_communities()
returns trigger language plpgsql as $$
begin
  if new.community is not null then
    insert into communities(name) values (new.community)
    on conflict (name) do nothing;
  end if;
  return new;
end;
$$;

create trigger operations_sync_communities
  after insert or update of community on operations
  for each row execute function sync_communities();

-- ── RLS: operations table accessible by service role only ─────
alter table operations       enable row level security;
alter table packers          enable row level security;
alter table packer_assignments enable row level security;
alter table customer_notes   enable row level security;
alter table communities      enable row level security;

-- Operations dashboard uses service role key — no anon access needed
