-- Settings S6a: time tracking and online invoice payments (processor-neutral; a built-in test processor until one is chosen).

CREATE TABLE time_entry (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  entry_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Who did the work: a Settings → Users person, or the owner sign-in (user_id NULL) by name.
  user_id bigint REFERENCES app_user ON DELETE SET NULL,
  person text NOT NULL,
  entry_date date NOT NULL,
  customer_id bigint,
  project_id bigint,
  item_id bigint,
  minutes integer NOT NULL CHECK (minutes > 0 AND minutes <= 1440),
  billable boolean NOT NULL DEFAULT false,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, entry_id),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id),
  FOREIGN KEY (org_id, customer_id) REFERENCES customer (org_id, customer_id),
  FOREIGN KEY (org_id, project_id) REFERENCES project (org_id, project_id),
  FOREIGN KEY (org_id, item_id) REFERENCES item (org_id, item_id),
  CHECK (NOT billable OR customer_id IS NOT NULL)
);
CREATE INDEX time_entry_date ON time_entry (org_id, entity_id, entry_date);
-- An invoice line billing a time entry.
ALTER TABLE txn_line ADD COLUMN time_entry_id bigint,
  ADD FOREIGN KEY (org_id, time_entry_id) REFERENCES time_entry (org_id, entry_id) ON DELETE SET NULL (time_entry_id);
CREATE INDEX txn_line_time ON txn_line (time_entry_id) WHERE time_entry_id IS NOT NULL;

-- A payment taken online: the processor's fee (Merchant Fees) and any fee the customer paid on top (Convenience Fee Income).
-- What reaches Undeposited Funds is total - fee + surcharge.
ALTER TABLE txn ADD COLUMN fee_cents bigint NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  ADD COLUMN surcharge_cents bigint NOT NULL DEFAULT 0 CHECK (surcharge_cents >= 0);

CREATE TABLE payments_settings (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  processor text NOT NULL DEFAULT 'test' CHECK (processor IN ('test', 'stripe', 'square')),
  card boolean NOT NULL DEFAULT true,
  ach boolean NOT NULL DEFAULT true,
  fee_payer text NOT NULL DEFAULT 'company' CHECK (fee_payer IN ('company', 'customer')),
  PRIMARY KEY (org_id, entity_id),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id)
);

-- The "Pay now" link on an emailed invoice. Only the hash is kept; a newer link replaces an older one.
CREATE TABLE invoice_pay_link (
  org_id bigint NOT NULL,
  link_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  txn_id bigint NOT NULL,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz,
  replaced_at timestamptz,
  FOREIGN KEY (org_id, txn_id) REFERENCES txn (org_id, txn_id) ON DELETE CASCADE
);
CREATE INDEX invoice_pay_link_txn ON invoice_pay_link (txn_id);

-- A checkout opened with the processor for one link. Recording the payment is keyed by checkout_id, so a repeated webhook
-- can never record it twice.
CREATE TABLE online_checkout (
  org_id bigint NOT NULL,
  checkout_id text PRIMARY KEY,
  link_id bigint NOT NULL REFERENCES invoice_pay_link ON DELETE CASCADE,
  txn_id bigint NOT NULL,
  processor text NOT NULL,
  method text NOT NULL CHECK (method IN ('card', 'ach')),
  balance_cents bigint NOT NULL,
  fee_cents bigint NOT NULL,
  surcharge_cents bigint NOT NULL,
  charged_cents bigint NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'canceled', 'failed')),
  payment_txn_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (org_id, txn_id) REFERENCES txn (org_id, txn_id) ON DELETE CASCADE
);
