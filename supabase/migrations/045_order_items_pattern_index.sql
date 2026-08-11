-- The existing order_items_sales_order_id_idx (plain btree) only
-- accelerates equality/range lookups under Supabase's default (non-C)
-- locale — it does NOT accelerate LIKE 'prefix%' queries, which is exactly
-- what every one of Today's Orders/Packer/Delivery's loads runs
-- (sales_order_id like '<date>-%') to pull a single day's items. Without a
-- pattern-matching-capable index, that's a full sequential scan every
-- time, getting slower as the table accumulates more historical orders —
-- the likely cause of Packer/Delivery tabs taking 10+ seconds to load.
--
-- text_pattern_ops indexes also support plain equality/range comparisons
-- (not just pattern matching), so this doesn't need to replace the
-- existing plain index — added alongside it, purely additive.
create index if not exists idx_order_items_sales_order_id_pattern
  on public.order_items (sales_order_id text_pattern_ops);
