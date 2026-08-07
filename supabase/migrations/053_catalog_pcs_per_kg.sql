-- Manual Quick Order entry sometimes gets the qty field wrong for
-- weight-sold items: an intern types "12" because the customer's message
-- said "12 pcs" of e.g. Yelakki banana, when that really means ~1kg, not
-- 12kg. There's no fixed pieces-per-kg ratio across fruits (a Yelakki piece
-- and a papaya piece are nowhere near the same weight), so this is captured
-- per catalog item instead of guessed in code.
--
-- Null means "not set yet" — the dashboard prompts for it the first time a
-- piece-count description is seen for that item, then saves it here so
-- every later order for the same item auto-corrects without asking again.

alter table public.catalog
  add column if not exists pcs_per_kg numeric;
