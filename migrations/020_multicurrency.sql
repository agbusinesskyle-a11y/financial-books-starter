-- Settings S6b: multicurrency. The books stay in the home currency (USD): every *_cents amount the ledger and the
-- A/R and A/P checks use is home currency. A foreign-currency transaction also keeps its own amounts and the rate.

CREATE TABLE currency_settings (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  -- Once on, never off (as in QuickBooks).
  turned_on_at timestamptz NOT NULL DEFAULT now(),
  turned_on_by text NOT NULL,
  home text NOT NULL DEFAULT 'USD',
  PRIMARY KEY (org_id, entity_id),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id)
);

CREATE TABLE currency (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  code char(3) NOT NULL CHECK (code ~ '^[A-Z]{3}$'),
  name text NOT NULL,
  PRIMARY KEY (org_id, entity_id, code),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id)
);

-- Home currency per 1 unit of the foreign currency, from this date on.
CREATE TABLE exchange_rate (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  code char(3) NOT NULL,
  rate_date date NOT NULL,
  rate numeric(18,8) NOT NULL CHECK (rate > 0),
  PRIMARY KEY (org_id, entity_id, code, rate_date),
  FOREIGN KEY (org_id, entity_id, code) REFERENCES currency (org_id, entity_id, code) ON DELETE CASCADE
);

ALTER TABLE customer ADD COLUMN currency char(3);
ALTER TABLE vendor ADD COLUMN currency char(3);

ALTER TABLE txn
  ADD COLUMN currency char(3),
  ADD COLUMN exchange_rate numeric(18,8) CHECK (exchange_rate > 0),
  ADD COLUMN foreign_total_cents bigint,
  ADD COLUMN foreign_open_cents bigint,
  ADD CONSTRAINT txn_currency_parts CHECK ((currency IS NULL) = (exchange_rate IS NULL) AND (currency IS NULL) = (foreign_total_cents IS NULL));
ALTER TABLE txn_line ADD COLUMN foreign_amount_cents bigint, ADD COLUMN foreign_rate_cents bigint;
-- The foreign amount an application moved (its amount_cents is the home amount it took off the charge).
ALTER TABLE application ADD COLUMN foreign_cents bigint;

-- Month-end revaluation of open foreign balances (unrealized gain or loss), with its automatic reversal.
ALTER TABLE txn DROP CONSTRAINT txn_type_check;
ALTER TABLE txn ADD CONSTRAINT txn_type_check CHECK (type IN ('invoice', 'payment', 'sales_receipt', 'credit_memo', 'late_fee', 'deposit',
  'bill', 'bill_payment', 'expense', 'check', 'vendor_credit', 'purchase_order', 'item_receipt', 'inventory_adjustment', 'estimate',
  'journal_entry', 'transfer', 'cc_payment', 'fx_revaluation'));
ALTER TABLE txn DROP CONSTRAINT txn_party_check;
ALTER TABLE txn ADD CONSTRAINT txn_party_check CHECK (
  CASE WHEN type IN ('invoice', 'payment', 'sales_receipt', 'credit_memo', 'late_fee', 'estimate') THEN customer_id IS NOT NULL AND vendor_id IS NULL
       WHEN type IN ('bill', 'bill_payment', 'vendor_credit', 'purchase_order', 'item_receipt') THEN vendor_id IS NOT NULL AND customer_id IS NULL
       WHEN type IN ('expense', 'check') THEN customer_id IS NULL
       WHEN type IN ('deposit', 'inventory_adjustment', 'journal_entry', 'transfer', 'cc_payment', 'fx_revaluation') THEN customer_id IS NULL AND vendor_id IS NULL
       ELSE true END);
