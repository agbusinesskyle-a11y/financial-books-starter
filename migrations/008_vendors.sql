-- Vendors (stage V2). Bank and tax ID numbers are stored AES-256-GCM encrypted (SETTINGS_KEY);
-- only the last four digits are kept in clear, for display.

CREATE TABLE vendor (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  vendor_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  display_name text NOT NULL CHECK (length(btrim(display_name)) > 0),
  company_name text,
  title text,
  first_name text,
  middle_name text,
  last_name text,
  suffix text,
  email text,
  cc text,
  bcc text,
  phone text,
  mobile text,
  fax text,
  other_phone text,
  website text,
  check_name text,
  billing_address jsonb,
  notes text,
  terms_id bigint,
  account_no text,
  default_expense_account_id bigint,
  billing_rate_cents bigint CHECK (billing_rate_cents IS NULL OR billing_rate_cents >= 0),
  track_1099 boolean NOT NULL DEFAULT false,
  tax_id_enc text,
  tax_id_last4 text,
  bank_routing_enc text,
  bank_account_enc text,
  bank_account_last4 text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, vendor_id),
  UNIQUE (org_id, entity_id, display_name),
  CHECK ((bank_routing_enc IS NULL) = (bank_account_enc IS NULL)),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id),
  FOREIGN KEY (org_id, terms_id) REFERENCES terms (org_id, terms_id),
  FOREIGN KEY (org_id, default_expense_account_id) REFERENCES account (org_id, account_id)
);
CREATE INDEX vendor_entity_name ON vendor (org_id, entity_id, lower(display_name));

-- Vendor transactions arrive in V3; the column exists now so lists and merges can be written once.
ALTER TABLE txn ADD COLUMN vendor_id bigint,
  ADD FOREIGN KEY (org_id, vendor_id) REFERENCES vendor (org_id, vendor_id);
CREATE INDEX txn_vendor_date ON txn (org_id, vendor_id, txn_date DESC, txn_id DESC) WHERE vendor_id IS NOT NULL;

-- History, documents and messages can belong to a customer or a vendor (exactly one).
ALTER TABLE activity_event ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE activity_event ADD COLUMN vendor_id bigint,
  ADD FOREIGN KEY (org_id, vendor_id) REFERENCES vendor (org_id, vendor_id),
  ADD CONSTRAINT activity_party CHECK ((customer_id IS NULL) <> (vendor_id IS NULL));
CREATE INDEX activity_vendor_time ON activity_event (org_id, vendor_id, occurred_at DESC, event_id DESC) WHERE vendor_id IS NOT NULL;

ALTER TABLE document ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE document ADD COLUMN vendor_id bigint,
  ADD FOREIGN KEY (org_id, vendor_id) REFERENCES vendor (org_id, vendor_id),
  ADD CONSTRAINT document_party CHECK ((customer_id IS NULL) <> (vendor_id IS NULL));
CREATE INDEX document_vendor ON document (org_id, vendor_id, uploaded_at DESC) WHERE vendor_id IS NOT NULL;

ALTER TABLE message ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE message ADD COLUMN vendor_id bigint,
  ADD FOREIGN KEY (org_id, vendor_id) REFERENCES vendor (org_id, vendor_id),
  ADD CONSTRAINT message_party CHECK ((customer_id IS NULL) <> (vendor_id IS NULL));
