-- Settings S4b: journal entries, transfers, credit card payments, and reconciliation.

ALTER TABLE txn DROP CONSTRAINT txn_type_check;
ALTER TABLE txn ADD CONSTRAINT txn_type_check CHECK (type IN ('invoice', 'payment', 'sales_receipt', 'credit_memo', 'late_fee', 'deposit',
  'bill', 'bill_payment', 'expense', 'check', 'vendor_credit', 'purchase_order', 'item_receipt', 'inventory_adjustment', 'estimate',
  'journal_entry', 'transfer', 'cc_payment'));
ALTER TABLE txn DROP CONSTRAINT txn_party_check;
ALTER TABLE txn ADD CONSTRAINT txn_party_check CHECK (
  CASE WHEN type IN ('invoice', 'payment', 'sales_receipt', 'credit_memo', 'late_fee', 'estimate') THEN customer_id IS NOT NULL AND vendor_id IS NULL
       WHEN type IN ('bill', 'bill_payment', 'vendor_credit', 'purchase_order', 'item_receipt') THEN vendor_id IS NOT NULL AND customer_id IS NULL
       WHEN type IN ('expense', 'check') THEN customer_id IS NULL
       WHEN type IN ('deposit', 'inventory_adjustment', 'journal_entry', 'transfer', 'cc_payment') THEN customer_id IS NULL AND vendor_id IS NULL
       ELSE true END);

-- Transfers and card payments: money leaves account_id and arrives in to_account_id.
ALTER TABLE txn ADD COLUMN to_account_id bigint, ADD COLUMN reverses_txn_id bigint,
  ADD FOREIGN KEY (org_id, to_account_id) REFERENCES account (org_id, account_id),
  ADD FOREIGN KEY (org_id, reverses_txn_id) REFERENCES txn (org_id, txn_id) ON DELETE SET NULL (reverses_txn_id),
  ADD CONSTRAINT txn_transfer_accounts CHECK (type NOT IN ('transfer', 'cc_payment') OR (account_id IS NOT NULL AND to_account_id IS NOT NULL AND account_id <> to_account_id));
-- Journal entry lines: account_id with a signed amount (+ debit, − credit), optionally a customer or vendor.
ALTER TABLE txn_line ADD COLUMN vendor_id bigint, ADD FOREIGN KEY (org_id, vendor_id) REFERENCES vendor (org_id, vendor_id);

-- A finished reconciliation of one account to a statement, and the transactions it cleared (with the amount then).
CREATE TABLE reconciliation (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  rec_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id bigint NOT NULL,
  statement_date date NOT NULL,
  beginning_cents bigint NOT NULL,
  ending_cents bigint NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  completed_by text NOT NULL,
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id),
  FOREIGN KEY (org_id, account_id) REFERENCES account (org_id, account_id)
);
CREATE INDEX reconciliation_account ON reconciliation (account_id, statement_date);
CREATE TABLE reconciled_item (
  rec_id bigint NOT NULL REFERENCES reconciliation ON DELETE CASCADE,
  txn_id bigint NOT NULL,
  account_id bigint NOT NULL,
  amount_cents bigint NOT NULL,
  PRIMARY KEY (txn_id, account_id)
);
CREATE INDEX reconciled_item_rec ON reconciled_item (rec_id);
