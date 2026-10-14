-- Projects already exist (001); names are unique per customer.
ALTER TABLE project ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT project_name_per_customer UNIQUE (org_id, customer_id, name),
  ADD CONSTRAINT project_name_present CHECK (length(btrim(name)) > 0),
  ADD CONSTRAINT project_dates CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date);
CREATE INDEX txn_project ON txn (org_id, project_id) WHERE project_id IS NOT NULL;

-- Files attached to a customer, optionally to one of their transactions. Stored in Postgres (≤ 10 MB).
-- Always served as a download; the type served comes from the file extension, never the upload.
CREATE TABLE document (
  org_id bigint NOT NULL,
  document_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id bigint NOT NULL,
  txn_id bigint,
  filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 200),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content bytea NOT NULL,
  note text,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  uploaded_by text NOT NULL,
  UNIQUE (org_id, document_id),
  FOREIGN KEY (org_id, customer_id) REFERENCES customer (org_id, customer_id),
  FOREIGN KEY (org_id, txn_id) REFERENCES txn (org_id, txn_id) ON DELETE SET NULL (txn_id)
);
CREATE INDEX document_customer ON document (org_id, customer_id, uploaded_at DESC);
CREATE INDEX document_txn ON document (org_id, txn_id) WHERE txn_id IS NOT NULL;
