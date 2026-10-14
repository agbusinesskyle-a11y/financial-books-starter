-- Fixes from the independent review of stages B1–B3.

-- (2) Which ledgerline tenant an organization may read. Set by whoever runs the service (LEDGERLINE_ORG_ID); until it
-- is set, nothing can be linked. Every read of ledgerline is limited to it.
ALTER TABLE org ADD COLUMN ledgerline_org_id uuid UNIQUE;

-- (4) A ledgerline account can move from one company to another (ownership is dated in ledgerline). Each company keeps
-- its own mapping of the account, its own items from the days it owned it, and its own verified months.
ALTER TABLE bank_feed_item DROP CONSTRAINT bank_feed_item_org_id_ll_account_id_fkey;
ALTER TABLE bank_rule DROP CONSTRAINT bank_rule_org_id_ll_account_id_fkey;
ALTER TABLE ledgerline_verified_month DROP CONSTRAINT ledgerline_verified_month_org_id_ll_account_id_fkey;
ALTER TABLE ledgerline_account DROP CONSTRAINT ledgerline_account_org_id_ll_account_id_key;
ALTER TABLE ledgerline_account DROP CONSTRAINT ledgerline_account_pkey;
ALTER TABLE ledgerline_account ADD PRIMARY KEY (entity_id, ll_account_id), ADD UNIQUE (org_id, entity_id, ll_account_id),
  ADD COLUMN owned_now boolean NOT NULL DEFAULT true;
ALTER TABLE bank_feed_item ADD FOREIGN KEY (org_id, entity_id, ll_account_id) REFERENCES ledgerline_account (org_id, entity_id, ll_account_id);
ALTER TABLE bank_rule ADD FOREIGN KEY (org_id, entity_id, ll_account_id) REFERENCES ledgerline_account (org_id, entity_id, ll_account_id) ON DELETE CASCADE;
ALTER TABLE ledgerline_verified_month ADD COLUMN entity_id bigint;
UPDATE ledgerline_verified_month v SET entity_id = a.entity_id FROM ledgerline_account a WHERE a.ll_account_id = v.ll_account_id;
DELETE FROM ledgerline_verified_month WHERE entity_id IS NULL;
ALTER TABLE ledgerline_verified_month ALTER COLUMN entity_id SET NOT NULL, DROP CONSTRAINT ledgerline_verified_month_pkey,
  ADD PRIMARY KEY (entity_id, ll_account_id, period_start),
  ADD FOREIGN KEY (org_id, entity_id, ll_account_id) REFERENCES ledgerline_account (org_id, entity_id, ll_account_id) ON DELETE CASCADE;

-- (3) Audit entries from before companies kept only the changed fields, so some couldn't be placed in a company. Place
-- them from the row's own insert entry, else from the row as it is now. Whatever still can't be placed is shown in no
-- company (only people and invitations are organization-wide).
UPDATE audit_log a SET entity_id = i.entity_id FROM audit_log i
 WHERE a.entity_id IS NULL AND a.table_name NOT IN ('app_user', 'user_invite', 'session')
   AND i.table_name = a.table_name AND i.row_id = a.row_id AND i.org_id = a.org_id AND i.action = 'insert' AND i.entity_id IS NOT NULL;
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT c.relname AS tbl, encode(g.tgargs, 'escape') AS args FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
            WHERE g.tgname = 'audit' AND c.relname NOT IN ('app_user', 'user_invite') LOOP
    EXECUTE format('UPDATE audit_log a SET entity_id = audit_entity(to_jsonb(r), NULL) FROM %I r WHERE a.entity_id IS NULL AND a.table_name = %L AND r.%I = a.row_id',
      t.tbl, t.tbl, split_part(t.args, '\000', 1));
  END LOOP;
END $$;

-- (12) Payment terms became per company in 034, which moved customers and vendors to their company's copy. Recurring
-- templates, sales settings and transactions follow the same way.
UPDATE recurring_template r SET terms_id = n.terms_id FROM terms o JOIN terms n ON n.org_id = o.org_id AND n.name = o.name AND n.due_days = o.due_days
 WHERE o.terms_id = r.terms_id AND n.entity_id = r.entity_id AND o.entity_id <> r.entity_id;
UPDATE sales_settings s SET default_terms_id = n.terms_id FROM terms o JOIN terms n ON n.org_id = o.org_id AND n.name = o.name AND n.due_days = o.due_days
 WHERE o.terms_id = s.default_terms_id AND n.entity_id = s.entity_id AND o.entity_id <> s.entity_id;
UPDATE txn x SET terms_id = n.terms_id FROM terms o JOIN terms n ON n.org_id = o.org_id AND n.name = o.name AND n.due_days = o.due_days
 WHERE o.terms_id = x.terms_id AND n.entity_id = x.entity_id AND o.entity_id <> x.entity_id;

-- (17) A person's company list belongs to their own organization.
ALTER TABLE app_user_company ADD FOREIGN KEY (org_id, user_id) REFERENCES app_user (org_id, user_id) ON DELETE CASCADE;

-- (9) Deleting one of several transactions a bank item was matched to leaves the rest; the item is flagged for a look.
CREATE OR REPLACE FUNCTION bank_feed_link_gone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM bank_feed_link l WHERE l.item_id = OLD.item_id) THEN
    UPDATE bank_feed_item SET attention = 'changed', updated_at = now() WHERE item_id = OLD.item_id AND review_state IN ('added', 'matched');
  ELSE
    UPDATE bank_feed_item b SET review_state = 'new', reviewed_at = NULL, reviewed_by = NULL, attention = NULL, updated_at = now()
     WHERE b.item_id = OLD.item_id AND b.review_state IN ('added', 'matched');
  END IF;
  RETURN NULL;
END $$;

-- (4) A bank transaction belongs to the company that owned its account that day; if ownership changes, the new owner
-- gets its own copy to review and the old owner sees it as removed by the bank.
ALTER TABLE bank_feed_item DROP CONSTRAINT bank_feed_item_org_id_ll_transaction_id_key, ADD UNIQUE (org_id, entity_id, ll_transaction_id);
