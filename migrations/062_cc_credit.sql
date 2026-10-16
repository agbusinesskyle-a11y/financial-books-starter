-- Credit card credit: a refund onto a company card. The card's balance owed goes down and the categories (or
-- products) are credited — the mirror of an expense on the card. The vendor is optional, as on an expense; never a customer.
ALTER TABLE txn DROP CONSTRAINT txn_type_check;
ALTER TABLE txn ADD CONSTRAINT txn_type_check CHECK (type IN ('invoice', 'payment', 'sales_receipt', 'credit_memo', 'late_fee', 'deposit',
  'bill', 'bill_payment', 'expense', 'check', 'vendor_credit', 'purchase_order', 'item_receipt', 'inventory_adjustment', 'estimate',
  'journal_entry', 'transfer', 'cc_payment', 'fx_revaluation', 'cc_credit'));
ALTER TABLE txn DROP CONSTRAINT txn_party_check;
ALTER TABLE txn ADD CONSTRAINT txn_party_check CHECK (
  CASE WHEN type IN ('invoice', 'payment', 'sales_receipt', 'credit_memo', 'late_fee', 'estimate') THEN customer_id IS NOT NULL AND vendor_id IS NULL
       WHEN type IN ('bill', 'bill_payment', 'vendor_credit', 'purchase_order', 'item_receipt') THEN vendor_id IS NOT NULL AND customer_id IS NULL
       WHEN type IN ('expense', 'check', 'cc_credit') THEN customer_id IS NULL
       WHEN type IN ('deposit', 'inventory_adjustment', 'journal_entry', 'transfer', 'cc_payment', 'fx_revaluation') THEN customer_id IS NULL AND vendor_id IS NULL
       ELSE true END);
-- It always names the card it went back to.
ALTER TABLE txn DROP CONSTRAINT txn_paid_from;
ALTER TABLE txn ADD CONSTRAINT txn_paid_from CHECK (type NOT IN ('bill_payment', 'expense', 'check', 'cc_credit') OR account_id IS NOT NULL);
-- A card refund's reference number repeats like an expense's (the merchant's), so it isn't unique across the company.
DROP INDEX txn_doc_number;
CREATE UNIQUE INDEX txn_doc_number ON txn (org_id, entity_id, type, doc_number)
  WHERE doc_number IS NOT NULL AND type NOT IN ('check', 'bill_payment', 'expense', 'bill', 'vendor_credit', 'cc_credit');
