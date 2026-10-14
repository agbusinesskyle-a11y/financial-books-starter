-- Settings S3: estimates (non-posting) with progress invoicing, and price rules.

ALTER TABLE txn DROP CONSTRAINT txn_type_check;
ALTER TABLE txn ADD CONSTRAINT txn_type_check CHECK (type IN ('invoice', 'payment', 'sales_receipt', 'credit_memo', 'late_fee', 'deposit',
  'bill', 'bill_payment', 'expense', 'check', 'vendor_credit', 'purchase_order', 'item_receipt', 'inventory_adjustment', 'estimate'));
ALTER TABLE txn DROP CONSTRAINT txn_party_check;
ALTER TABLE txn ADD CONSTRAINT txn_party_check CHECK (
  CASE WHEN type IN ('invoice', 'payment', 'sales_receipt', 'credit_memo', 'late_fee', 'estimate') THEN customer_id IS NOT NULL AND vendor_id IS NULL
       WHEN type IN ('bill', 'bill_payment', 'vendor_credit', 'purchase_order', 'item_receipt') THEN vendor_id IS NOT NULL AND customer_id IS NULL
       WHEN type IN ('expense', 'check') THEN customer_id IS NULL
       WHEN type IN ('deposit', 'inventory_adjustment') THEN customer_id IS NULL AND vendor_id IS NULL
       ELSE true END);

-- An estimate's open_cents is what hasn't been invoiced yet; due_date is its expiration date.
ALTER TABLE txn ADD COLUMN estimate_status text CHECK (estimate_status IN ('pending', 'accepted', 'rejected', 'closed')),
  ADD CONSTRAINT txn_estimate_status CHECK ((type = 'estimate') = (estimate_status IS NOT NULL));

-- An invoice line made from an estimate line (progress invoicing adds up these).
ALTER TABLE txn_line ADD COLUMN estimate_txn_id bigint, ADD COLUMN estimate_line_no integer,
  ADD FOREIGN KEY (org_id, estimate_txn_id) REFERENCES txn (org_id, txn_id) ON DELETE SET NULL (estimate_txn_id);
CREATE INDEX txn_line_estimate ON txn_line (estimate_txn_id) WHERE estimate_txn_id IS NOT NULL;

-- Special prices: a fixed price or a percent off, for chosen customers and/or products (empty = all), over a date range.
CREATE TABLE price_rule (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  rule_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('fixed', 'percent_off')),
  price_cents bigint CHECK (price_cents >= 0),
  percent_off numeric(7,4) CHECK (percent_off > 0 AND percent_off <= 100),
  customer_ids bigint[] NOT NULL DEFAULT '{}',
  item_ids bigint[] NOT NULL DEFAULT '{}',
  start_date date,
  end_date date,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id),
  CHECK ((kind = 'fixed') = (price_cents IS NOT NULL) AND (kind = 'percent_off') = (percent_off IS NOT NULL)),
  CHECK (start_date IS NULL OR end_date IS NULL OR start_date <= end_date)
);
