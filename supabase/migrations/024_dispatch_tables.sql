-- Fruit inventory ledger: opening stock, purchases, write-offs
create table if not exists fruit_inventory (
  id          uuid primary key default gen_random_uuid(),
  fruit_name  text not null,
  entry_type  text not null check (entry_type in ('opening','purchase','writeoff')),
  quantity    numeric not null check (quantity >= 0),
  notes       text,
  entry_date  date not null default current_date,
  created_at  timestamptz not null default now()
);

-- Packing lots: each ration given to packers
create table if not exists packing_lots (
  id             uuid primary key default gen_random_uuid(),
  fruit_name     text not null,
  lot_number     int not null,
  lot_size       numeric not null check (lot_size > 0),
  packed_in_lot  numeric not null default 0 check (packed_in_lot >= 0),
  returned_qty   numeric not null default 0 check (returned_qty >= 0),
  return_reason  text,
  lot_date       date not null default current_date,
  created_at     timestamptz not null default now(),
  unique (fruit_name, lot_number, lot_date)
);

alter table fruit_inventory enable row level security;
alter table packing_lots    enable row level security;

create policy "auth read fruit_inventory"  on fruit_inventory for select using (auth.role() = 'authenticated');
create policy "auth insert fruit_inventory" on fruit_inventory for insert with check (auth.role() = 'authenticated');
create policy "auth update fruit_inventory" on fruit_inventory for update using (auth.role() = 'authenticated');
create policy "auth delete fruit_inventory" on fruit_inventory for delete using (auth.role() = 'authenticated');

create policy "auth read packing_lots"   on packing_lots for select using (auth.role() = 'authenticated');
create policy "auth insert packing_lots" on packing_lots for insert with check (auth.role() = 'authenticated');
create policy "auth update packing_lots" on packing_lots for update using (auth.role() = 'authenticated');
create policy "auth delete packing_lots" on packing_lots for delete using (auth.role() = 'authenticated');
