-- One-time cleanup for the phantom-duplicate-invoice bug: generate-invoice's
-- regeneration path (delete old Zoho invoice, create new one) was deleting
-- invoice_line_items by the BRAND-NEW zoho_invoice_id before inserting —
-- which never had any rows under it, so the delete was always a no-op. The
-- stale rows under the OLD (now-deleted-in-Zoho) zoho_invoice_id were never
-- cleaned up, so every regenerated invoice left an orphaned duplicate behind
-- that still showed up on the storefront next to the real, current one
-- (code fix: generate-invoice now deletes by sales_order_id instead, which
-- is stable across regenerations).
--
-- This sweeps every order that already has this leftover: for any
-- sales_order_id, keep only the invoice_line_items rows matching that
-- order's CURRENT zoho_invoice_id (the real, live invoice) and delete
-- everything else under it.
delete from public.invoice_line_items ili
using public.orders o
where o.sales_order_id = ili.sales_order_id
  and o.zoho_invoice_id is not null
  and ili.zoho_invoice_id is distinct from o.zoho_invoice_id;
