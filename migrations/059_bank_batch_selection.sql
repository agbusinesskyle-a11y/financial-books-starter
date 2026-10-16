-- Bank review v2, stage BR-6: "all N matching" in two steps. The first records exactly which bank lines the filters
-- fit, each as it was then (its revision, or for Undo the plan it would carry out), and shows them; Confirm carries out that
-- list and nothing else, each item checked again as a ticked row is. Kept an hour; used once.
CREATE TABLE bank_batch_selection (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  selection_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor text NOT NULL,
  action text NOT NULL CHECK (action IN ('exclude', 'assign', 'undo')),
  ll_account_id uuid NOT NULL,
  tab text NOT NULL,
  list text NOT NULL DEFAULT '',
  -- [[item_id, token], …]: the item's revision token (exclude, assign) or its Undo plan token (undo).
  items jsonb NOT NULL,
  -- assign: { accountId, payee }.
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id)
);
