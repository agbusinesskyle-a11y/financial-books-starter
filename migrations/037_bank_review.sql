-- Bank transactions, stage B3: what the books did with each bank item. A bank item is linked to the books transaction(s)
-- it became: 'added' (created from the bank item), 'grouped' (a deposit created from payments waiting in Undeposited
-- Funds) or 'matched' (already in the books). One bank item can match several transactions; a transfer between two fed
-- accounts links one transaction to both accounts' bank items.
CREATE TABLE bank_feed_link (
  org_id bigint NOT NULL,
  item_id bigint NOT NULL,
  txn_id bigint NOT NULL,
  how text NOT NULL CHECK (how IN ('added', 'grouped', 'matched')),
  linked_at timestamptz NOT NULL DEFAULT now(),
  linked_by text NOT NULL,
  PRIMARY KEY (item_id, txn_id),
  FOREIGN KEY (org_id, item_id) REFERENCES bank_feed_item (org_id, item_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, txn_id) REFERENCES txn (org_id, txn_id) ON DELETE CASCADE
);
CREATE INDEX bank_feed_link_txn ON bank_feed_link (txn_id);

ALTER TABLE bank_feed_item ADD COLUMN reviewed_at timestamptz, ADD COLUMN reviewed_by text;

-- Deleting a books transaction a bank item was added or matched to sends the bank item back to For review (as QBO does).
CREATE FUNCTION bank_feed_link_gone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE bank_feed_item b SET review_state = 'new', reviewed_at = NULL, reviewed_by = NULL, updated_at = now()
   WHERE b.item_id = OLD.item_id AND b.review_state IN ('added', 'matched')
     AND NOT EXISTS (SELECT 1 FROM bank_feed_link l WHERE l.item_id = OLD.item_id);
  RETURN NULL;
END $$;
CREATE TRIGGER bank_feed_link_gone AFTER DELETE ON bank_feed_link FOR EACH ROW EXECUTE FUNCTION bank_feed_link_gone();
