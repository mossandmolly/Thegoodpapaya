-- 014: drop foreign key on customer_notes.customer_name
-- Notes should be free-form; no requirement for customer to exist elsewhere
ALTER TABLE customer_notes DROP CONSTRAINT IF EXISTS customer_notes_customer_name_fkey;
