-- Cancelling an order or item has always just overwritten status to
-- 'cancelled' with no record of what it was before — fine for a one-way
-- cancel, but means there's nothing to restore to if that cancellation
-- turns out to have been a mistake. These columns capture the
-- pre-cancellation value at the moment something gets cancelled, so
-- uncancel-order can put it back exactly where it was (e.g. an item that
-- was 'invoiced' comes back 'invoiced', not reset to 'open').
alter table order_items add column if not exists pre_cancel_status text;
alter table orders add column if not exists pre_cancel_invoice_status text;
