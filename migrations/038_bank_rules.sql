-- Bank rules, stage B4 (QBO Banking → Rules). A rule looks at money in or out on one fed account (or any), with conditions
-- on the bank description and amount, and assigns a payee, category, class, location and memo. "suggest" rules fill in the
-- Add form and the suggestion column; "auto" rules add the item to the books as soon as it arrives (unless the books
-- already have a matching transaction). Rules run in priority order; the first that fits wins.
CREATE TABLE bank_rule (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  rule_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  priority integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  money text NOT NULL CHECK (money IN ('in', 'out')),
  ll_account_id uuid,
  match_all boolean NOT NULL DEFAULT true,
  -- [{ "field": "description" | "amount", "op": "contains" | "not_contains" | "is" | "starts" | "equals" | "more" | "less" | "between",
  --    "value": text or cents, "value2": cents }]
  conditions jsonb NOT NULL DEFAULT '[]',
  payee text CHECK (payee IS NULL OR payee ~ '^[cv]:\d{1,18}$'),
  account_id bigint,
  class_id bigint,
  location_id bigint,
  memo text,
  mode text NOT NULL DEFAULT 'suggest' CHECK (mode IN ('suggest', 'auto')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, rule_id),
  UNIQUE (org_id, entity_id, name),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id),
  FOREIGN KEY (org_id, account_id) REFERENCES account (org_id, account_id),
  FOREIGN KEY (org_id, ll_account_id) REFERENCES ledgerline_account (org_id, ll_account_id) ON DELETE CASCADE
);
CREATE INDEX bank_rule_entity ON bank_rule (entity_id, priority, rule_id);
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON bank_rule FOR EACH ROW EXECUTE FUNCTION audit_row('rule_id');

-- Which rule added an item automatically (shown on the Categorized tab as "Added by rule").
ALTER TABLE bank_feed_item ADD COLUMN rule_id bigint REFERENCES bank_rule (rule_id) ON DELETE SET NULL;
