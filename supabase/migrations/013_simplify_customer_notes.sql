-- 013: simplify customer_notes — one row per customer, just note + last_complaint_date

-- Rename note_date → last_complaint_date
ALTER TABLE customer_notes RENAME COLUMN note_date TO last_complaint_date;

-- Drop columns no longer needed
ALTER TABLE customer_notes
  DROP COLUMN IF EXISTS item_name,
  DROP COLUMN IF EXISTS note_type,
  DROP COLUMN IF EXISTS invoice_number;

-- Deduplicate to one row per customer (keep most recent)
DELETE FROM customer_notes
WHERE id NOT IN (
  SELECT DISTINCT ON (customer_name) id
  FROM customer_notes
  ORDER BY customer_name, last_complaint_date DESC NULLS LAST, created_at DESC NULLS LAST
);

-- Enforce one row per customer going forward
ALTER TABLE customer_notes
  DROP CONSTRAINT IF EXISTS customer_notes_customer_name_key;
ALTER TABLE customer_notes
  ADD CONSTRAINT customer_notes_customer_name_key UNIQUE (customer_name);
