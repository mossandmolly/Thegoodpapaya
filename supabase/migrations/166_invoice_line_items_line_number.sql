-- invoice_line_items had unique(zoho_invoice_id, item_name), meant to stop
-- a re-run from inserting the same line twice ("prevent duplicate syncs" —
-- see migration 001). That assumed an invoice never legitimately has two
-- lines with the same item name — wrong whenever an order genuinely has
-- the same item added twice (e.g. the "DUPLICATE/held" case already
-- flagged elsewhere in this app). When that happens, generate-invoice's
-- own insert into this table violates the constraint and Postgres rejects
-- the WHOLE batch, not just the duplicate — so the invoice silently never
-- gets any row here at all, regardless of how many times it's regenerated
-- (the write is wrapped in a try/catch that only logs to the console).
--
-- Re-keyed on the line's position within the invoice instead of its name
-- — line_number stays stable across a regenerate (generate-invoice always
-- rebuilds the full set in the same order order_items comes back in, and
-- deletes the old rows first), so this still blocks a genuine duplicate
-- sync, while two rows that happen to share an item name are now simply
-- two different line numbers instead of a constraint violation.
alter table public.invoice_line_items
  add column if not exists line_number integer;

-- Backfill existing rows with a row_number() over invoice_date/created_at
-- order so every existing row gets a value before the constraint below is
-- added — arbitrary but stable, and nothing reads line_number for
-- anything except this uniqueness check, so its exact value for old rows
-- doesn't matter.
with numbered as (
  select id, row_number() over (partition by zoho_invoice_id order by created_at, id) - 1 as rn
  from public.invoice_line_items
  where line_number is null
)
update public.invoice_line_items ili
set line_number = numbered.rn
from numbered
where ili.id = numbered.id;

alter table public.invoice_line_items
  alter column line_number set not null;

alter table public.invoice_line_items
  drop constraint if exists invoice_line_items_zoho_invoice_id_item_name_key;

alter table public.invoice_line_items
  add constraint invoice_line_items_zoho_invoice_id_line_number_key
  unique (zoho_invoice_id, line_number);
