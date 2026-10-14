-- Settings S4a: accounting settings, classes, locations, tags, billable expenses, automation and warnings.

CREATE TABLE accounting_settings (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  fiscal_start_month integer NOT NULL DEFAULT 1 CHECK (fiscal_start_month BETWEEN 1 AND 12),
  method text NOT NULL DEFAULT 'accrual' CHECK (method IN ('accrual', 'cash')),
  date_format text NOT NULL DEFAULT 'mdy' CHECK (date_format IN ('mdy', 'dmy', 'ymd')),
  show_account_numbers boolean NOT NULL DEFAULT true,
  classes_on boolean NOT NULL DEFAULT false,
  class_mode text NOT NULL DEFAULT 'txn' CHECK (class_mode IN ('txn', 'line')),
  locations_on boolean NOT NULL DEFAULT false,
  location_label text NOT NULL DEFAULT 'Location',
  billable_on boolean NOT NULL DEFAULT false,
  billable_markup numeric(7,4) CHECK (billable_markup >= 0 AND billable_markup <= 1000),
  billable_income_account_id bigint,
  auto_apply_customer boolean NOT NULL DEFAULT false,
  auto_apply_vendor boolean NOT NULL DEFAULT false,
  warn_duplicate_bills boolean NOT NULL DEFAULT true,
  PRIMARY KEY (org_id, entity_id),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id),
  FOREIGN KEY (org_id, billable_income_account_id) REFERENCES account (org_id, account_id)
);

-- Classes (one level of sub-classes) and locations, carried onto postings for reports.
CREATE TABLE class (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  class_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  parent_id bigint REFERENCES class (class_id),
  active boolean NOT NULL DEFAULT true,
  UNIQUE (org_id, class_id),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id)
);
CREATE UNIQUE INDEX class_name ON class (org_id, entity_id, coalesce(parent_id, 0), lower(name));

CREATE TABLE location (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  location_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (org_id, location_id),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id)
);
CREATE UNIQUE INDEX location_name ON location (org_id, entity_id, lower(name));

ALTER TABLE txn ADD COLUMN class_id bigint, ADD COLUMN location_id bigint,
  ADD FOREIGN KEY (org_id, class_id) REFERENCES class (org_id, class_id),
  ADD FOREIGN KEY (org_id, location_id) REFERENCES location (org_id, location_id);
ALTER TABLE txn_line ADD COLUMN class_id bigint,
  ADD FOREIGN KEY (org_id, class_id) REFERENCES class (org_id, class_id),
  -- A cost line the customer will be billed for, and (on an invoice line) the cost line it bills.
  ADD COLUMN billable boolean NOT NULL DEFAULT false,
  ADD COLUMN billable_txn_id bigint,
  ADD COLUMN billable_line_no integer,
  ADD FOREIGN KEY (org_id, billable_txn_id) REFERENCES txn (org_id, txn_id) ON DELETE SET NULL (billable_txn_id);
CREATE INDEX txn_line_billable ON txn_line (billable_txn_id) WHERE billable_txn_id IS NOT NULL;
ALTER TABLE posting ADD COLUMN class_id bigint, ADD COLUMN location_id bigint;

-- Tags: labels on any transaction, optionally grouped ("Campaign: Spring promo").
CREATE TABLE tag_group (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  group_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id)
);
CREATE UNIQUE INDEX tag_group_name ON tag_group (org_id, entity_id, lower(name));
CREATE TABLE tag (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  tag_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id bigint REFERENCES tag_group ON DELETE SET NULL,
  name text NOT NULL,
  UNIQUE (org_id, tag_id),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id)
);
CREATE UNIQUE INDEX tag_name ON tag (org_id, entity_id, coalesce(group_id, 0), lower(name));
CREATE TABLE txn_tag (
  org_id bigint NOT NULL,
  txn_id bigint NOT NULL,
  tag_id bigint NOT NULL,
  PRIMARY KEY (txn_id, tag_id),
  FOREIGN KEY (org_id, txn_id) REFERENCES txn (org_id, txn_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, tag_id) REFERENCES tag (org_id, tag_id) ON DELETE CASCADE
);
CREATE INDEX txn_tag_tag ON txn_tag (tag_id);

-- Duplicate bill numbers for a vendor become a warning (Settings → Accounting) instead of an error; credits stay unique.
DROP INDEX txn_vendor_doc_number;
CREATE UNIQUE INDEX txn_vendor_doc_number ON txn (org_id, vendor_id, type, doc_number) WHERE doc_number IS NOT NULL AND type = 'vendor_credit';
