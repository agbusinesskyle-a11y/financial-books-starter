-- App navigation (stage N1): each person's bookmarks and pinned apps (user_key = user id, or 'owner' for the
-- environment login, as for report favorites).
CREATE TABLE nav_bookmark (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  user_key text NOT NULL,
  href text NOT NULL CHECK (href LIKE '/%' AND href NOT LIKE '//%' AND length(href) <= 500),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 120),
  position int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, entity_id, user_key, href),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id)
);

CREATE TABLE nav_pref (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  user_key text NOT NULL,
  pinned text[] NOT NULL,
  PRIMARY KEY (org_id, entity_id, user_key),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id)
);
