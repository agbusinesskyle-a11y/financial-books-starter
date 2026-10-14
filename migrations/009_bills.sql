-- Bills and spending (stage V3): bills, bill payments, expenses, checks, vendor credits.

ALTER TABLE txn DROP CONSTRAINT txn_type_check;
ALTER TABLE txn ADD CONSTRAINT txn_type_check CHECK (type IN ('invoice', 'payment', 'sales_receipt', 'credit_memo', 'late_fee', 'deposit',
  'bill', 'bill_payment', 'expense', 'check', 'vendor_credit'));
ALTER TABLE txn DROP CONSTRAINT txn_party_check;
-- Customer documents have a customer; vendor documents a vendor (optional on expenses and checks); deposits neither.
ALTER TABLE txn ADD CONSTRAINT txn_party_check CHECK (
  CASE WHEN type IN ('invoice', 'payment', 'sales_receipt', 'credit_memo', 'late_fee') THEN customer_id IS NOT NULL AND vendor_id IS NULL
       WHEN type IN ('bill', 'bill_payment', 'vendor_credit') THEN vendor_id IS NOT NULL AND customer_id IS NULL
       WHEN type IN ('expense', 'check') THEN customer_id IS NULL
       WHEN type = 'deposit' THEN customer_id IS NULL AND vendor_id IS NULL
       ELSE true END);
-- Bills carry a due date; money-out documents carry the account the money came from.
ALTER TABLE txn ADD CONSTRAINT txn_bill_due CHECK (type <> 'bill' OR due_date IS NOT NULL);
ALTER TABLE txn ADD CONSTRAINT txn_paid_from CHECK (type NOT IN ('bill_payment', 'expense', 'check') OR account_id IS NOT NULL);

ALTER TABLE txn
  ADD COLUMN approval_status text CHECK (approval_status IN ('awaiting', 'approved', 'rejected')),
  ADD COLUMN approved_by text,
  ADD COLUMN approved_at timestamptz,
  ADD COLUMN rejected_reason text,
  ADD COLUMN printed_at timestamptz,
  ADD COLUMN system_kind text CHECK (system_kind IN ('opening_balance'));
ALTER TABLE txn ADD CONSTRAINT txn_approval_bills CHECK ((type = 'bill') = (approval_status IS NOT NULL));

-- Check numbers are unique per bank account.
CREATE UNIQUE INDEX txn_check_number ON txn (org_id, account_id, doc_number)
  WHERE type IN ('check', 'bill_payment') AND payment_method = 'Check' AND doc_number IS NOT NULL;
ALTER TABLE txn DROP CONSTRAINT txn_org_id_entity_id_type_doc_number_key;
CREATE UNIQUE INDEX txn_doc_number ON txn (org_id, entity_id, type, doc_number)
  WHERE doc_number IS NOT NULL AND type NOT IN ('check', 'bill_payment', 'expense', 'bill', 'vendor_credit');
-- A vendor's bill numbers are their own; unique per vendor.
CREATE UNIQUE INDEX txn_vendor_doc_number ON txn (org_id, vendor_id, type, doc_number)
  WHERE doc_number IS NOT NULL AND type IN ('bill', 'vendor_credit');

-- Vendor document lines: a category (account) line or a product line, optionally tagged to a customer / project.
ALTER TABLE txn_line
  ADD COLUMN account_id bigint,
  ADD COLUMN customer_id bigint,
  ADD COLUMN project_id bigint,
  ADD FOREIGN KEY (org_id, account_id) REFERENCES account (org_id, account_id),
  ADD FOREIGN KEY (org_id, customer_id) REFERENCES customer (org_id, customer_id),
  ADD FOREIGN KEY (org_id, project_id) REFERENCES project (org_id, project_id),
  ADD CONSTRAINT txn_line_account_or_item CHECK (account_id IS NULL OR item_id IS NULL);
CREATE INDEX txn_line_project ON txn_line (org_id, project_id) WHERE project_id IS NOT NULL;

-- What a product costs when bought (bills and checks); income account is for selling.
ALTER TABLE item ADD COLUMN expense_account_id bigint,
  ADD COLUMN purchase_cost_cents bigint CHECK (purchase_cost_cents IS NULL OR purchase_cost_cents >= 0),
  ADD FOREIGN KEY (org_id, expense_account_id) REFERENCES account (org_id, account_id);

ALTER TABLE posting ADD COLUMN vendor_id bigint,
  ADD FOREIGN KEY (org_id, vendor_id) REFERENCES vendor (org_id, vendor_id);
CREATE INDEX posting_project ON posting (org_id, project_id) WHERE project_id IS NOT NULL;

-- Company preferences for bills (more arrive with the Settings work).
CREATE TABLE bill_settings (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  require_approval boolean NOT NULL DEFAULT true,
  next_check_number integer NOT NULL DEFAULT 1001 CHECK (next_check_number > 0),
  PRIMARY KEY (org_id, entity_id),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id)
);
