-- Canonical spelling flipped from "Chilli bhaji" to "Chilli bhajji" (the
-- name migration 085 tracked is no longer the canonical one) — remove the
-- stale entry and track the corrected spelling instead. Safe to run
-- whether or not 085 was ever actually applied (delete is a no-op if the
-- row doesn't exist).
delete from stock_tracked_fruits where item_name = 'Chilli bhaji';

insert into stock_tracked_fruits (item_name)
values ('Chilli bhajji')
on conflict (item_name) do nothing;
