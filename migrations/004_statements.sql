-- Customer statements. `content` is the snapshot that was generated (rows, totals, aging), so a
-- statement prints the same later even after payments change the books.
CREATE TABLE statement (
  org_id bigint NOT NULL,
  statement_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_id bigint NOT NULL,
  customer_id bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('balance_forward', 'open_item', 'transaction')),
  statement_date date NOT NULL,
  start_date date,
  end_date date,
  total_due_cents bigint NOT NULL,
  content jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  sent_to text,
  UNIQUE (org_id, statement_id),
  CHECK (kind = 'open_item' OR (start_date IS NOT NULL AND end_date IS NOT NULL AND start_date <= end_date)),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id),
  FOREIGN KEY (org_id, customer_id) REFERENCES customer (org_id, customer_id)
);
CREATE INDEX statement_customer ON statement (org_id, customer_id, created_at DESC);

-- Messages can belong to a statement; hand-logged customer replies are 'received'.
ALTER TABLE message ADD COLUMN related_statement_id bigint,
  ADD FOREIGN KEY (org_id, related_statement_id) REFERENCES statement (org_id, statement_id) ON DELETE SET NULL (related_statement_id);
ALTER TABLE message DROP CONSTRAINT message_status_check,
  ADD CONSTRAINT message_status_check CHECK (status IN ('logged', 'sent', 'failed', 'received'));
