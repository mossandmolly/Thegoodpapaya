-- A third sell-by unit, alongside weight (kg) and piece — some items
-- (Kiwi, Blueberry, etc.) are sold by the box/punnet rather than loose by
-- weight or individually. Mirrors sold_by_piece/piece_approx_kg exactly:
-- unit_price stays per-kg always (even for box items), box_approx_kg is
-- what approx pricing multiplies by, same as piece mode already does.
alter table public.catalog
  add column if not exists sold_by_box boolean not null default false,
  add column if not exists box_approx_kg numeric;
