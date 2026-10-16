-- Bank review v2, stage BR-7: files and notes on a bank line. Both are kept with the bank line by its ledgerline
-- id, so they stay when the line is dropped and pulled back in (as the review history does).

-- A file (a receipt, an invoice) added on the bank item page. Once the line is in the books it is filed as a document on the
-- transaction it became (when that has a vendor or customer to file it under); document_id is that document.
CREATE TABLE bank_item_attachment (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  attachment_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ll_transaction_id uuid NOT NULL,
  filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 200),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content bytea NOT NULL,
  document_id bigint REFERENCES document (document_id) ON DELETE SET NULL,
  uploaded_by text NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id)
);
CREATE INDEX bank_item_attachment_line ON bank_item_attachment (entity_id, ll_transaction_id);

-- An internal note on a bank line (who, when): for whoever reviews it next.
CREATE TABLE bank_item_note (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  note_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ll_transaction_id uuid NOT NULL,
  note text NOT NULL CHECK (length(btrim(note)) BETWEEN 1 AND 1000),
  actor text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id)
);
CREATE INDEX bank_item_note_line ON bank_item_note (entity_id, ll_transaction_id, at DESC);
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON bank_item_note FOR EACH ROW EXECUTE FUNCTION audit_row('note_id');
