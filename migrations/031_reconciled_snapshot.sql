-- A finished reconciliation keeps what it cleared (stage tie-out fix). Deleting or changing a reconciled
-- transaction (admin override) no longer removes it from the reconciliation, so the finished report still adds up and the
-- next reconciliation shows the change as a discrepancy, as QBO does. The snapshot columns let the report show an item
-- whose transaction was deleted.
ALTER TABLE reconciled_item
  ADD COLUMN txn_type text,
  ADD COLUMN txn_date date,
  ADD COLUMN doc text,
  ADD COLUMN party text;

UPDATE reconciled_item i SET txn_type = t.type, txn_date = t.txn_date, doc = coalesce(t.doc_number, t.payment_ref),
    party = coalesce((SELECT display_name FROM customer c WHERE c.customer_id = t.customer_id), (SELECT display_name FROM vendor v WHERE v.vendor_id = t.vendor_id))
  FROM txn t WHERE t.txn_id = i.txn_id;
