-- Migration 129: add Cape gooseberry to stock tracking.
--
-- The Stock tab only renders rows for items present in `catalog` (see
-- renderStockTable's activeCatalog filter) — stock_tracked_fruits alone
-- just controls which catalog items show even with zero activity, it
-- isn't a second source of rows. So this needs both: a catalog row (price
-- starts at 0, since it isn't a real Zoho item yet — sync-catalog will
-- fill in the real price automatically once it's added in Zoho Books too,
-- matched by this same item_name) and a stock_tracked_fruits row (so it
-- shows up immediately rather than only once there's real purchase/order
-- activity for it).
insert into public.catalog (item_name, unit_price, unit, active)
values ('Cape gooseberry', 0, 'kg', true)
on conflict (item_name) do nothing;

insert into public.stock_tracked_fruits (item_name)
values ('Cape gooseberry')
on conflict (item_name) do nothing;
