-- Bank review v3, stage S3: a bank line's file copied from a texted receipt remembers which receipt it came
-- from, so rejecting that receipt takes the copy (and any document made from it that no transaction holds) away again.
-- From here on a receipt's photo reaches the books only this way. (When this was written no copy of the books held any
-- texted receipt — the practice copy had none — so there are no earlier, untracked copies to account for.)
ALTER TABLE bank_item_attachment ADD COLUMN receipt_id bigint REFERENCES receipt (receipt_id) ON DELETE SET NULL;
CREATE INDEX bank_item_attachment_receipt ON bank_item_attachment (receipt_id) WHERE receipt_id IS NOT NULL;

-- A books transaction deleted directly (not by the bank review's Undo) and the line left with none: as before, the line
-- goes back to For review — and now the texted receipts it took go back to waiting on its review too, as an Undo does.
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
    UPDATE receipt SET status = 'review', txn_id = NULL, updated_at = now() WHERE item_id = OLD.item_id AND status = 'added';
  END IF;
  INSERT INTO bank_review_event (org_id, entity_id, item_id, ll_transaction_id, kind, source, txn_ids, actor)
    VALUES (b.org_id, b.entity_id, b.item_id, b.ll_transaction_id, 'books_deleted', 'books', ARRAY[OLD.txn_id],
            coalesce(nullif(current_setting('app.actor', true), ''), 'system'));
  RETURN NULL;
END $$;
