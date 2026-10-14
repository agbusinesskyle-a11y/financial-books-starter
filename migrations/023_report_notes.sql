-- Reports R1b: adjusting journal entries (Adjusted Trial Balance) and a company note on each report.
ALTER TABLE txn ADD COLUMN is_adjusting boolean NOT NULL DEFAULT false;
CREATE TABLE report_note (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  report_key text NOT NULL,
  note text NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, entity_id, report_key),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id)
);
