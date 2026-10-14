-- Forms, stage F6: QBO's "Upload a bill / receipt" on the bill, expense and check forms. The file is kept
-- here while the form is open; the AI provider reads it to fill the form in; saving the form attaches it to the transaction.
CREATE TABLE form_upload (
  org_id bigint NOT NULL REFERENCES org (org_id),
  upload_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_id bigint NOT NULL,
  form_type text NOT NULL CHECK (form_type IN ('bill', 'expense', 'check')),
  filename text NOT NULL,
  content_type text NOT NULL,
  content bytea NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  extracted jsonb,
  error text,
  txn_id bigint,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, upload_id),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id),
  FOREIGN KEY (org_id, txn_id) REFERENCES txn (org_id, txn_id) ON DELETE SET NULL (txn_id)
);
CREATE INDEX form_upload_entity ON form_upload (org_id, entity_id, created_at DESC);
