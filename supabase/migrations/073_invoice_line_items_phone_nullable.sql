-- invoice_line_items.phone_number has been NOT NULL since the original
-- schema (001), back when the customer-facing invoices page's RLS policy
-- matched purely on phone. sync-invoices' processInvoice has long since
-- treated "no phone on file" as a valid, expected case for a customer
-- (falls back to null, just logs a warning) — but the NOT NULL constraint
-- never caught up, so every invoice for a phone-less customer silently
-- failed to sync any line items at all.
alter table invoice_line_items alter column phone_number drop not null;
