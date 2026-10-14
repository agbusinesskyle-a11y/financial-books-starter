-- Clearing a change to an already-reconciled transaction (review fix). When a reconciled transaction is edited or deleted
-- later (admin override), the difference shows as a discrepancy on the next reconciliation and can be ticked there like
-- any item; it's recorded here so the earlier reconciliation's report stays exactly as it was.
CREATE TABLE reconciled_adjustment (
  rec_id bigint NOT NULL REFERENCES reconciliation ON DELETE CASCADE,
  txn_id bigint NOT NULL,
  account_id bigint NOT NULL,
  amount_cents bigint NOT NULL,
  txn_type text,
  txn_date date,
  doc text,
  party text,
  PRIMARY KEY (rec_id, txn_id, account_id)
);
CREATE INDEX reconciled_adjustment_txn ON reconciled_adjustment (txn_id, account_id);
