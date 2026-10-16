-- Bank review v2, stage 1: every review is checked against what the person saw, under the company
-- lock; durable holds and history; one way to name a transaction's party and its version.

-- Deposit lines keep their own class (a bank deposit split across classes). First: the versions computed below include it.
ALTER TABLE deposit_line ADD COLUMN class_id bigint REFERENCES class (class_id);

-- A bank warning ('changed', 'books') waiting while the bank shows the line as removed: it comes back with the line.
ALTER TABLE bank_feed_item ADD COLUMN parked_attention text CHECK (parked_attention IN ('changed', 'books'));

-- review_version moves on every review step (added, matched, excluded, undone, restored, checked, a linked books change),
-- so a page showing an older step can't act on a newer one.
ALTER TABLE bank_feed_item ADD COLUMN review_version bigint NOT NULL DEFAULT 0;

-- Held from automatic rules (they still suggest): a person undid the item, or deleted the books transaction behind it.
-- auto_hold mirrors bank_item_hold for the item that is in the books now; the hold itself is kept by bank line, so it
-- survives the item row being dropped and pulled back in.
ALTER TABLE bank_feed_item ADD COLUMN auto_hold boolean NOT NULL DEFAULT false;
CREATE TABLE bank_item_hold (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  ll_transaction_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN ('undone', 'books_deleted')),
  -- A books deletion nobody has checked yet: the 'books' warning comes back with the line if it is pulled in again.
  warn boolean NOT NULL DEFAULT false,
  actor text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_id, ll_transaction_id),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id)
);

-- 'books': a books transaction tied to this item was edited or deleted (the bank's own changes stay 'changed'/'removed').
ALTER TABLE bank_feed_item DROP CONSTRAINT bank_feed_item_attention_check;
ALTER TABLE bank_feed_item ADD CONSTRAINT bank_feed_item_attention_check CHECK (attention IN ('removed', 'changed', 'books'));

-- What a books transaction says, as one value: header facts that reach the books and every posting (not open balances,
-- which payments and credits move without changing the transaction). Used to tell a page's view is stale, and to notice a
-- linked transaction edited after the bank line was reviewed.
CREATE FUNCTION txn_version(p_txn bigint) RETURNS text STABLE LANGUAGE sql AS $$
  SELECT md5(jsonb_build_array(t.type, t.txn_date, t.doc_number, t.memo, t.customer_id, t.vendor_id, t.project_id, t.total_cents, t.voided_at, t.class_id,
      t.location_id, t.account_id, t.to_account_id, t.payment_ref, t.is_adjusting, t.currency, t.exchange_rate, t.foreign_total_cents,
      (SELECT jsonb_agg(jsonb_build_array(p.line_no, p.account_id, p.amount_cents, p.class_id, p.location_id, p.customer_id, p.vendor_id, p.project_id, p.item_id)
                        ORDER BY p.line_no NULLS FIRST, p.account_id, p.amount_cents, p.posting_id)
         FROM posting p WHERE p.txn_id = t.txn_id),
      -- each document line's own facts (what a line says can change without moving a posting: billable, description, qty × rate)
      (SELECT jsonb_agg(to_jsonb(l) - 'org_id' - 'txn_id' - 'received_qty' - 'received_cents' - 'cost_cents' - 'billable_txn_id' - 'billable_line_no' ORDER BY l.line_no)
         FROM txn_line l WHERE l.txn_id = t.txn_id),
      (SELECT jsonb_agg(to_jsonb(d) - 'org_id' - 'deposit_txn_id' ORDER BY d.line_no) FROM deposit_line d WHERE d.deposit_txn_id = t.txn_id))::text)
    FROM txn t WHERE t.txn_id = p_txn
$$;
-- The version of each linked transaction when the bank line was reviewed or last checked (links made before this: as they
-- are now), and the version last seen — every edit after that is a new change, recorded and moving the review version.
ALTER TABLE bank_feed_link ADD COLUMN txn_version text, ADD COLUMN last_seen_version text;
UPDATE bank_feed_link SET txn_version = txn_version(txn_id), last_seen_version = txn_version(txn_id);

-- Every review decision, kept even when the item is undone, the rule is edited or deleted, or the item row is dropped and
-- pulled back in: what was done, how it was chosen, the rule as it was, the bank line's facts then and exactly what was
-- recorded (detail.item, detail.plan).
CREATE TABLE bank_review_event (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Not tied to the item row; ll_transaction_id finds the same bank line again.
  item_id bigint NOT NULL,
  ll_transaction_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('added', 'matched', 'transfer', 'settled', 'excluded', 'undone', 'restored', 'checked', 'books_changed', 'books_deleted')),
  source text NOT NULL CHECK (source IN ('manual', 'row', 'batch', 'auto', 'books')),
  basis text CHECK (basis IN ('match', 'rule', 'history', 'ai', 'person')),
  rule_id bigint,
  rule_name text,
  rule_snapshot jsonb,
  separate boolean NOT NULL DEFAULT false,
  payee text,
  account_ids bigint[] NOT NULL DEFAULT '{}',
  txn_ids bigint[] NOT NULL DEFAULT '{}',
  detail jsonb,
  actor text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id)
);
CREATE INDEX bank_review_event_item ON bank_review_event (item_id, event_id DESC);
CREATE INDEX bank_review_event_source ON bank_review_event (entity_id, ll_transaction_id, event_id DESC);
CREATE INDEX bank_review_event_entity ON bank_review_event (entity_id, at DESC);

-- Who a transaction is with: its customer or vendor, else the one customer/vendor on its lines, else 'Multiple'.
-- txn_party_key gives 'c:ID' / 'v:ID' only when there is exactly one.
CREATE FUNCTION txn_party_key(p_txn bigint) RETURNS text STABLE LANGUAGE sql AS $$
  SELECT CASE WHEN t.customer_id IS NOT NULL THEN 'c:' || t.customer_id WHEN t.vendor_id IS NOT NULL THEN 'v:' || t.vendor_id
    ELSE (SELECT CASE WHEN count(DISTINCT k) = 1 THEN min(k) END FROM (
      SELECT CASE WHEN p.customer_id IS NOT NULL THEN 'c:' || p.customer_id ELSE 'v:' || p.vendor_id END AS k
        FROM posting p WHERE p.txn_id = t.txn_id AND (p.customer_id IS NOT NULL OR p.vendor_id IS NOT NULL)) s) END
    FROM txn t WHERE t.txn_id = p_txn
$$;
CREATE FUNCTION txn_party(p_txn bigint) RETURNS text STABLE LANGUAGE sql AS $$
  SELECT coalesce(
    (SELECT coalesce(c.display_name, v.display_name) FROM txn t LEFT JOIN customer c ON c.customer_id = t.customer_id LEFT JOIN vendor v ON v.vendor_id = t.vendor_id
      WHERE t.txn_id = p_txn AND (t.customer_id IS NOT NULL OR t.vendor_id IS NOT NULL)),
    (SELECT CASE WHEN count(DISTINCT n) = 1 THEN min(n) WHEN count(DISTINCT n) > 1 THEN 'Multiple' END FROM (
      SELECT coalesce(c.display_name, v.display_name) AS n FROM posting p LEFT JOIN customer c ON c.customer_id = p.customer_id LEFT JOIN vendor v ON v.vendor_id = p.vendor_id
       WHERE p.txn_id = p_txn AND (p.customer_id IS NOT NULL OR p.vendor_id IS NOT NULL)) s))
$$;

-- A books transaction behind a reviewed bank item was deleted (outside the bank review's own Undo, which says so with the
-- setting fb.bank_undo): with others left, the item is flagged 'books'; with none left, it goes back to For review,
-- flagged 'books' and held from automatic rules (a person removed it on purpose). Either way the history records it.
CREATE OR REPLACE FUNCTION bank_feed_link_gone() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b bank_feed_item;
BEGIN
  IF coalesce(current_setting('fb.bank_undo', true), '') = 'on' THEN RETURN NULL; END IF;
  SELECT * INTO b FROM bank_feed_item WHERE item_id = OLD.item_id;
  IF NOT FOUND OR b.review_state NOT IN ('added', 'matched') THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM bank_feed_link l WHERE l.item_id = OLD.item_id) THEN
    -- (While the bank shows the line as removed, the books warning waits to come back with it.)
    UPDATE bank_feed_item SET attention = coalesce(attention, 'books'),
           parked_attention = CASE WHEN attention = 'removed' AND parked_attention IS NULL THEN 'books' ELSE parked_attention END,
           review_version = review_version + 1, updated_at = now() WHERE item_id = OLD.item_id;
  ELSE
    UPDATE bank_feed_item SET review_state = 'new', reviewed_at = NULL, reviewed_by = NULL, attention = 'books', auto_hold = true,
      review_version = review_version + 1, updated_at = now() WHERE item_id = OLD.item_id;
    INSERT INTO bank_item_hold (org_id, entity_id, ll_transaction_id, reason, warn, actor)
      VALUES (b.org_id, b.entity_id, b.ll_transaction_id, 'books_deleted', true, coalesce(nullif(current_setting('app.actor', true), ''), 'system'))
      ON CONFLICT (entity_id, ll_transaction_id) DO UPDATE SET reason = EXCLUDED.reason, warn = true, actor = EXCLUDED.actor, at = now();
  END IF;
  INSERT INTO bank_review_event (org_id, entity_id, item_id, ll_transaction_id, kind, source, txn_ids, actor)
    VALUES (b.org_id, b.entity_id, b.item_id, b.ll_transaction_id, 'books_deleted', 'books', ARRAY[OLD.txn_id],
            coalesce(nullif(current_setting('app.actor', true), ''), 'system'));
  RETURN NULL;
END $$;

