-- Settings S2: sales settings, message templates, reminders, statement defaults and form styles.

CREATE TABLE sales_settings (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  default_terms_id bigint,
  default_delivery text NOT NULL DEFAULT 'none' CHECK (default_delivery IN ('none', 'email', 'print')),
  custom_numbers boolean NOT NULL DEFAULT true,
  next_invoice_number integer CHECK (next_invoice_number BETWEEN 1 AND 99999999),
  service_date boolean NOT NULL DEFAULT false,
  discount boolean NOT NULL DEFAULT false,
  shipping boolean NOT NULL DEFAULT false,
  deposit boolean NOT NULL DEFAULT false,
  statement_kind text NOT NULL DEFAULT 'balance_forward' CHECK (statement_kind IN ('balance_forward', 'open_item', 'transaction')),
  statement_aging boolean NOT NULL DEFAULT true,
  -- Email: templates by kind ({ subject, greeting, body }), copies.
  templates jsonb NOT NULL DEFAULT '{}',
  cc text,
  bcc text,
  copy_me boolean NOT NULL DEFAULT false,
  -- Automatic reminders: rules [{ days }] (negative = before the due date); sent only for due dates on/after reminders_from.
  reminders_on boolean NOT NULL DEFAULT false,
  reminders_from date,
  reminder_rules jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (org_id, entity_id),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id),
  FOREIGN KEY (org_id, default_terms_id) REFERENCES terms (org_id, terms_id)
);

CREATE TABLE form_style (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  show_logo boolean NOT NULL DEFAULT true,
  accent text NOT NULL DEFAULT '#0f5c5c' CHECK (accent ~ '^#[0-9a-f]{6}$'),
  font text NOT NULL DEFAULT 'helvetica' CHECK (font IN ('helvetica', 'times', 'courier')),
  show_terms boolean NOT NULL DEFAULT true,
  show_due_date boolean NOT NULL DEFAULT true,
  show_project boolean NOT NULL DEFAULT true,
  show_service_date boolean NOT NULL DEFAULT true,
  show_message boolean NOT NULL DEFAULT true,
  footer text,
  PRIMARY KEY (org_id, entity_id),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id)
);

-- Discount (before tax; posts to Discounts given) and shipping (posts to Shipping income) on invoices and sales receipts.
-- total_cents = lines - discount_cents + shipping_cents.
ALTER TABLE txn
  ADD COLUMN terms_id bigint,
  ADD COLUMN discount_percent numeric(7,4) CHECK (discount_percent > 0 AND discount_percent <= 100),
  ADD COLUMN discount_cents bigint NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  ADD COLUMN shipping_cents bigint NOT NULL DEFAULT 0 CHECK (shipping_cents >= 0),
  -- A payment recorded as the deposit on an invoice.
  ADD COLUMN deposit_for_txn_id bigint,
  ADD FOREIGN KEY (org_id, terms_id) REFERENCES terms (org_id, terms_id),
  ADD FOREIGN KEY (org_id, deposit_for_txn_id) REFERENCES txn (org_id, txn_id) ON DELETE SET NULL (deposit_for_txn_id);
CREATE UNIQUE INDEX txn_deposit_for ON txn (deposit_for_txn_id) WHERE deposit_for_txn_id IS NOT NULL;

ALTER TABLE txn_line ADD COLUMN service_date date;

ALTER TABLE customer ADD COLUMN no_reminders boolean NOT NULL DEFAULT false;

-- One reminder per invoice per rule, ever.
CREATE TABLE invoice_reminder (
  org_id bigint NOT NULL,
  txn_id bigint NOT NULL,
  rule_days integer NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL,
  PRIMARY KEY (txn_id, rule_days),
  FOREIGN KEY (org_id, txn_id) REFERENCES txn (org_id, txn_id) ON DELETE CASCADE
);
