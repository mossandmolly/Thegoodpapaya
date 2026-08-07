-- 012: audit columns on operations + merge complaint_history into customer_notes

-- Packer / checker audit trail
ALTER TABLE operations
  ADD COLUMN IF NOT EXISTS last_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS finalized_by    text,
  ADD COLUMN IF NOT EXISTS finalized_at    timestamptz;

-- Extend customer_notes so it can absorb complaint_history
ALTER TABLE customer_notes
  ADD COLUMN IF NOT EXISTS item_name      text,        -- NULL = applies to all items for this customer
  ADD COLUMN IF NOT EXISTS note_type      text NOT NULL DEFAULT 'note',
  ADD COLUMN IF NOT EXISTS note_date      date,
  ADD COLUMN IF NOT EXISTS invoice_number text;

-- Migrate complaint_history records in (skip if table doesn't exist yet)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'complaint_history') THEN
    INSERT INTO customer_notes (customer_name, note, note_type, note_date, invoice_number)
    SELECT
      customer_name,
      COALESCE(NULLIF(description, ''), complaint_type) AS note,
      complaint_type   AS note_type,
      complaint_date   AS note_date,
      invoice_number
    FROM complaint_history;

    DROP TABLE complaint_history;
  END IF;
END$$;

-- Ensure RLS is on and policies are correct
ALTER TABLE customer_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon read notes"         ON customer_notes;
DROP POLICY IF EXISTS "auth manage notes"       ON customer_notes;
DROP POLICY IF EXISTS "anon read customer_notes" ON customer_notes;
DROP POLICY IF EXISTS "auth write customer_notes" ON customer_notes;

CREATE POLICY "anon read notes"   ON customer_notes FOR SELECT TO anon        USING (true);
CREATE POLICY "auth manage notes" ON customer_notes FOR ALL   TO authenticated USING (true);
