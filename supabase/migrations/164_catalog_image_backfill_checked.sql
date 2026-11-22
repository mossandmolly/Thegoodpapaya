-- backfill-compress-catalog-images had no way to remember which items it
-- already looked at between separate invocations, so every single run
-- re-scanned from the top of the list (ordered by item_name) and kept
-- re-processing the exact same first few items forever, never actually
-- making progress. This column is the fix — set once an item's photo has
-- been looked at (compressed, already small enough, or a permanent "too
-- large" error that needs a manual re-upload instead), so the function's
-- own query can skip anything already checked and the same curl loop can
-- just be re-run as many times as needed.
alter table public.catalog
  add column if not exists image_backfill_checked_at timestamptz;
