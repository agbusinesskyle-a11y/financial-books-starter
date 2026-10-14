-- Purchasing and inventory (stage V4): inventory items at average cost, purchase orders, item receipts,
-- inventory quantity adjustments.

ALTER TABLE item DROP CONSTRAINT item_kind_check;
ALTER TABLE item ADD CONSTRAINT item_kind_check CHECK (kind IN ('product', 'service', 'inventory', 'system'));
ALTER TABLE item
  ADD COLUMN sku text,
  ADD COLUMN reorder_point numeric(14, 4),
  ADD COLUMN asset_account_id bigint,
  -- Kept current by the inventory replay: what's on hand and what it cost.
  ADD COLUMN qty_on_hand numeric(14, 4) NOT NULL DEFAULT 0,
  ADD COLUMN value_cents bigint NOT NULL DEFAULT 0,
  ADD FOREIGN KEY (org_id, asset_account_id) REFERENCES account (org_id, account_id);
CREATE UNIQUE INDEX item_sku ON item (org_id, entity_id, lower(sku)) WHERE sku IS NOT NULL;

ALTER TABLE txn DROP CONSTRAINT txn_type_check;
ALTER TABLE txn ADD CONSTRAINT txn_type_check CHECK (type IN ('invoice', 'payment', 'sales_receipt', 'credit_memo', 'late_fee', 'deposit',
  'bill', 'bill_payment', 'expense', 'check', 'vendor_credit', 'purchase_order', 'item_receipt', 'inventory_adjustment'));
ALTER TABLE txn DROP CONSTRAINT txn_party_check;
ALTER TABLE txn ADD CONSTRAINT txn_party_check CHECK (
  CASE WHEN type IN ('invoice', 'payment', 'sales_receipt', 'credit_memo', 'late_fee') THEN customer_id IS NOT NULL AND vendor_id IS NULL
       WHEN type IN ('bill', 'bill_payment', 'vendor_credit', 'purchase_order', 'item_receipt') THEN vendor_id IS NOT NULL AND customer_id IS NULL
       WHEN type IN ('expense', 'check') THEN customer_id IS NULL
       WHEN type IN ('deposit', 'inventory_adjustment') THEN customer_id IS NULL AND vendor_id IS NULL
       ELSE true END);
ALTER TABLE txn ADD CONSTRAINT txn_adjustment_account CHECK (type <> 'inventory_adjustment' OR account_id IS NOT NULL);
-- A purchase order closed by hand (rather than by receiving everything).
ALTER TABLE txn ADD COLUMN closed_at timestamptz;
ALTER TABLE txn DROP CONSTRAINT txn_system_kind_check;
ALTER TABLE txn ADD CONSTRAINT txn_system_kind_check CHECK (system_kind IN ('opening_balance', 'opening_quantity'));

-- cost_cents: the inventory value a line moved (set by the replay; + into stock, − out of stock).
-- received_*: how much of a purchase order line has arrived. po_*: the purchase order line a bill / receipt line came from
-- (po_line_no is ignored once the purchase order is deleted and po_txn_id goes null).
ALTER TABLE txn_line
  ADD COLUMN cost_cents bigint,
  ADD COLUMN qty_change numeric(14, 4),
  ADD COLUMN received_qty numeric(14, 4) NOT NULL DEFAULT 0,
  ADD COLUMN received_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN po_txn_id bigint,
  ADD COLUMN po_line_no integer,
  ADD FOREIGN KEY (org_id, po_txn_id) REFERENCES txn (org_id, txn_id) ON DELETE SET NULL (po_txn_id);
CREATE INDEX txn_line_item ON txn_line (org_id, item_id) WHERE item_id IS NOT NULL;
CREATE INDEX txn_line_po ON txn_line (po_txn_id) WHERE po_txn_id IS NOT NULL;
