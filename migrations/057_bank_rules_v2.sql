-- Bank review v2, stage BR-5: rules v2 — several fed accounts, split lines, memo replace or append. Conditions
-- may also look at the bank's own text ("bank_text": the original description), kept in the conditions jsonb as before.
ALTER TABLE bank_rule
  -- The fed accounts the rule applies to (null or empty: ll_account_id if set, else every account). ll_account_id stays
  -- set when there is exactly one, so the list can name it.
  ADD COLUMN ll_account_ids uuid[],
  -- [{ "accountId": n, "percent": basis points (10000 = 100%) | "cents": n, "description": text }]: fixed amounts first,
  -- percentages share what's left. Null: the whole amount to account_id.
  ADD COLUMN splits jsonb CHECK (splits IS NULL OR jsonb_typeof(splits) = 'array'),
  ADD COLUMN memo_mode text NOT NULL DEFAULT 'replace' CHECK (memo_mode IN ('replace', 'append'));
UPDATE bank_rule SET ll_account_ids = ARRAY[ll_account_id] WHERE ll_account_id IS NOT NULL;
