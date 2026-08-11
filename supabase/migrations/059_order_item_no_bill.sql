-- Migration 049: explicit "don't bill" override on order_items
--
-- Zero-billing already happens by description keyword (FREE_ITEM_RE in
-- generate-invoice/index.ts and ops-dashboard/parser.html — "replacement",
-- "exchange", "free sample", "free"). This adds an explicit checkbox
-- alongside that: either the keyword OR this flag is enough to bill the
-- line at ₹0 — needed for a comped/free item whose description doesn't
-- happen to contain one of those words.
alter table public.order_items
  add column if not exists no_bill boolean not null default false;
