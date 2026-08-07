-- Migration 011: Fix order_items status default after lifecycle change
-- Migration 010 changed the status CHECK to the new lifecycle values but
-- the column default was still 'pending' (now invalid). Set it to 'open'.

ALTER TABLE order_items ALTER COLUMN status SET DEFAULT 'open';
