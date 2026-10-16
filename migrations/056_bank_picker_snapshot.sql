-- Bank review v2, stage BR-2: what a page's payee and category pickers offered. A form carries the snapshot's hash;
-- the text it sends is resolved against the list the person saw, so a record renamed or added since can't take over a choice.
-- Stored once per distinct list (a list that didn't change has the same hash); one no page has shown for 60 days is dropped.
CREATE TABLE bank_picker_snapshot (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('payee', 'category')),
  hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{32}$'),
  -- [[key, value, [forms…]], …]: each record's id or key, the value shown, and every form of its label it answered to.
  records jsonb NOT NULL,
  used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_id, kind, hash),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id)
);
