-- Automation and 1099s (stage V5): recurring vendor templates, scheduled bill payments, vendor info requests.

-- Recurring templates can belong to a vendor (bill / expense / check) as well as a customer.
ALTER TABLE recurring_template ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE recurring_template ADD COLUMN vendor_id bigint,
  ADD COLUMN account_id bigint,
  ADD FOREIGN KEY (org_id, vendor_id) REFERENCES vendor (org_id, vendor_id),
  ADD FOREIGN KEY (org_id, account_id) REFERENCES account (org_id, account_id),
  ADD CONSTRAINT recurring_party CHECK ((customer_id IS NULL) <> (vendor_id IS NULL));
ALTER TABLE recurring_template DROP CONSTRAINT recurring_template_txn_type_check;
ALTER TABLE recurring_template ADD CONSTRAINT recurring_template_txn_type_check CHECK (
  (customer_id IS NOT NULL AND txn_type IN ('invoice', 'sales_receipt')) OR (vendor_id IS NOT NULL AND txn_type IN ('bill', 'expense', 'check')));
ALTER TABLE recurring_template ADD CONSTRAINT recurring_paid_from CHECK (txn_type NOT IN ('expense', 'check') OR account_id IS NOT NULL);
CREATE UNIQUE INDEX recurring_vendor_name ON recurring_template (org_id, vendor_id, name) WHERE vendor_id IS NOT NULL;

ALTER TABLE recurring_template_line
  ADD COLUMN account_id bigint,
  ADD COLUMN customer_id bigint,
  ADD COLUMN project_id bigint,
  ADD FOREIGN KEY (org_id, account_id) REFERENCES account (org_id, account_id),
  ADD FOREIGN KEY (org_id, customer_id) REFERENCES customer (org_id, customer_id),
  ADD FOREIGN KEY (org_id, project_id) REFERENCES project (org_id, project_id);

-- A bill scheduled to be paid on a date, from an account, by a method. The daily job pays it then.
ALTER TABLE txn
  ADD COLUMN scheduled_pay_date date,
  ADD COLUMN scheduled_account_id bigint,
  ADD COLUMN scheduled_method text,
  ADD COLUMN scheduled_by text,
  ADD FOREIGN KEY (org_id, scheduled_account_id) REFERENCES account (org_id, account_id),
  ADD CONSTRAINT txn_schedule_complete CHECK ((scheduled_pay_date IS NULL) = (scheduled_account_id IS NULL)),
  ADD CONSTRAINT txn_schedule_bills CHECK (scheduled_pay_date IS NULL OR type = 'bill');
CREATE INDEX txn_scheduled ON txn (org_id, entity_id, scheduled_pay_date) WHERE scheduled_pay_date IS NOT NULL;

-- "Ask vendor for info": a single-use link (only its SHA-256 is stored) to a public form. What the vendor sends
-- is stored encrypted (it can hold bank and tax numbers) and applied only when someone accepts it.
CREATE TABLE vendor_info_request (
  org_id bigint NOT NULL,
  request_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_id bigint NOT NULL,
  vendor_id bigint NOT NULL,
  token_hash text NOT NULL UNIQUE,
  sent_to text,
  requested_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  submitted_at timestamptz,
  submission_enc text,
  status text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'submitted', 'accepted', 'dismissed', 'canceled')),
  resolved_by text,
  resolved_at timestamptz,
  CHECK ((submitted_at IS NULL) = (submission_enc IS NULL)),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id),
  FOREIGN KEY (org_id, vendor_id) REFERENCES vendor (org_id, vendor_id) ON DELETE CASCADE
);
CREATE INDEX vendor_info_vendor ON vendor_info_request (org_id, vendor_id, created_at DESC);
