-- Reports: each person's favorite reports (user_key = user id, or 'owner' for the environment login).
CREATE TABLE report_favorite (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  user_key text NOT NULL,
  report_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, entity_id, user_key, report_key),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id)
);
