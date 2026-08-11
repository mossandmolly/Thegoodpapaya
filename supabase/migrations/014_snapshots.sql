-- Migration 010: Snapshot table + last_updated_by on operations

-- Add last_updated_by to operations
alter table operations
  add column if not exists last_updated_by text;

-- Snapshots table — only stores packer-editable fields
create table if not exists operations_snapshots (
  id             bigserial primary key,
  snapshot_at    timestamptz not null,
  operation_id   uuid not null,
  final_quantity numeric,
  status         text
);

create index ops_snapshots_at_idx on operations_snapshots (snapshot_at desc);
create index ops_snapshots_op_idx on operations_snapshots (operation_id);

-- RLS: admin (anon key) can read snapshots, edge function (service role) writes them
alter table operations_snapshots enable row level security;

create policy "snapshots_read" on operations_snapshots for select using (true);
