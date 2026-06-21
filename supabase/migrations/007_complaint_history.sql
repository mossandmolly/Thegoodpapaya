-- Complaint history for customer service context
-- Populated via periodic CSV uploads from admin panel

CREATE TABLE IF NOT EXISTS complaint_history (
  id            BIGSERIAL PRIMARY KEY,
  customer_name TEXT      NOT NULL,
  invoice_number TEXT,
  complaint_date DATE     NOT NULL,
  complaint_type TEXT     NOT NULL DEFAULT 'other',
  -- complaint_type values: 'quantity', 'quality', 'delivery', 'payment', 'integrity', 'other'
  description   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX complaint_history_customer_idx ON complaint_history (customer_name);
CREATE INDEX complaint_history_date_idx     ON complaint_history (complaint_date DESC);

-- RLS: readable by anon key (ops dashboard), writable by service role only
ALTER TABLE complaint_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read_complaints"
  ON complaint_history FOR SELECT
  TO anon
  USING (true);

-- Service role bypasses RLS for CSV uploads via edge function or direct insert
