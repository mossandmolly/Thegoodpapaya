-- Fruit/veg assignment becomes exclusive: exactly one packer per item_name
-- (Config's new Item -> Packer table), instead of the old free-text list
-- that allowed the same item to sit on more than one packer's plate at
-- once. Dedupe first (keep the earliest-created row per item_name, drop
-- the rest) so the new unique index can actually be created.
delete from public.packer_assignments a
using public.packer_assignments b
where a.item_name = b.item_name
  and a.id > b.id;

create unique index if not exists packer_assignments_item_name_unique
  on public.packer_assignments (item_name);

-- Per-order-item override: lets a supervisor reroute one specific order's
-- item to a different packer from Single Card view, without touching the
-- default assignment above (which still applies to every other order of
-- that same item). Null = no override, falls back to the default.
alter table public.order_items
  add column if not exists assigned_packer_id uuid references public.packers(id) on delete set null;
