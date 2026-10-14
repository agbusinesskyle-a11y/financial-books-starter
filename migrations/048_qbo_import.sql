-- Stage B7: a company's books brought over from QuickBooks Online export files. Each QuickBooks
-- transaction becomes the same kind of transaction here (check, expense, deposit ...), or a journal entry when its shape
-- doesn't fit one; either way it posts exactly what QuickBooks' Journal shows. source_type keeps QuickBooks' own name for it.
ALTER TABLE txn
  ADD COLUMN source text CHECK (source IS NULL OR source IN ('qbo_import')),
  ADD COLUMN source_type text;

CREATE TABLE import_batch (
  org_id bigint NOT NULL REFERENCES org (org_id),
  batch_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_id bigint NOT NULL,
  source text NOT NULL CHECK (source IN ('qbo_import')),
  company_name text NOT NULL,
  summary jsonb NOT NULL,
  parity jsonb,
  imported_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, batch_id),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id) ON DELETE CASCADE
);
