-- Companies (stage B1): each organization (a customer account) holds several companies, each its own books.
-- 1. Payment terms belong to a company (as in QBO), not to the whole organization. Existing terms go to the company that
--    uses them; a company with none gets a copy of its organization's terms.
-- 2. Which companies each person can open: everyone (the default, e.g. the owner and admins) or a chosen list.
ALTER TABLE terms ADD COLUMN entity_id bigint;
ALTER TABLE terms DROP CONSTRAINT terms_org_id_name_key;
UPDATE terms t SET entity_id = (SELECT min(e.entity_id) FROM entity e WHERE e.org_id = t.org_id);
-- Terms already used by customers or vendors of another company in the same organization get their own copy there.
INSERT INTO terms (org_id, entity_id, name, due_days)
SELECT DISTINCT t.org_id, x.entity_id, t.name, t.due_days
  FROM terms t JOIN (SELECT org_id, entity_id, terms_id FROM customer UNION SELECT org_id, entity_id, terms_id FROM vendor) x
    ON x.org_id = t.org_id AND x.terms_id = t.terms_id AND x.entity_id <> t.entity_id;
UPDATE customer c SET terms_id = n.terms_id FROM terms o JOIN terms n ON n.org_id = o.org_id AND n.name = o.name AND n.due_days = o.due_days
  WHERE o.terms_id = c.terms_id AND n.entity_id = c.entity_id AND o.entity_id <> c.entity_id;
UPDATE vendor v SET terms_id = n.terms_id FROM terms o JOIN terms n ON n.org_id = o.org_id AND n.name = o.name AND n.due_days = o.due_days
  WHERE o.terms_id = v.terms_id AND n.entity_id = v.entity_id AND o.entity_id <> v.entity_id;
INSERT INTO terms (org_id, entity_id, name, due_days)
SELECT t.org_id, e.entity_id, t.name, t.due_days FROM entity e JOIN terms t ON t.org_id = e.org_id AND t.entity_id = (SELECT min(entity_id) FROM entity WHERE org_id = e.org_id)
 WHERE NOT EXISTS (SELECT 1 FROM terms x WHERE x.entity_id = e.entity_id);
ALTER TABLE terms ALTER COLUMN entity_id SET NOT NULL,
  ADD FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id),
  ADD UNIQUE (org_id, entity_id, name);

ALTER TABLE app_user ADD COLUMN all_companies boolean NOT NULL DEFAULT true;
CREATE TABLE app_user_company (
  user_id bigint NOT NULL REFERENCES app_user ON DELETE CASCADE,
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  PRIMARY KEY (user_id, entity_id),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id) ON DELETE CASCADE
);
