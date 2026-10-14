-- Recurring transactions: a template per customer that creates invoices / sales receipts on a schedule
-- (scheduled), reminds the operator (reminder), or is used by hand (unscheduled).
-- The schedule is anchored on start_date: every interval_count interval_units from it (months clamp to
-- the month's last day, so a template started on the 31st runs on Apr 30).
CREATE TABLE recurring_template (
  org_id bigint NOT NULL,
  template_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_id bigint NOT NULL,
  customer_id bigint NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  txn_type text NOT NULL CHECK (txn_type IN ('invoice', 'sales_receipt')),
  mode text NOT NULL CHECK (mode IN ('scheduled', 'reminder', 'unscheduled')),
  interval_unit text CHECK (interval_unit IN ('day', 'week', 'month', 'year')),
  interval_count integer CHECK (interval_count BETWEEN 1 AND 365),
  start_date date,
  end_date date,
  next_run_date date,
  terms_id bigint,
  memo text,
  auto_send boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, template_id),
  UNIQUE (org_id, customer_id, name),
  CHECK (mode = 'unscheduled' OR (interval_unit IS NOT NULL AND interval_count IS NOT NULL AND start_date IS NOT NULL)),
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id),
  FOREIGN KEY (org_id, customer_id) REFERENCES customer (org_id, customer_id),
  FOREIGN KEY (org_id, terms_id) REFERENCES terms (org_id, terms_id)
);
CREATE INDEX recurring_due ON recurring_template (next_run_date) WHERE active AND mode <> 'unscheduled';

CREATE TABLE recurring_template_line (
  org_id bigint NOT NULL,
  template_id bigint NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  item_id bigint,
  description text,
  quantity numeric(14, 4) NOT NULL DEFAULT 1,
  rate_cents bigint NOT NULL DEFAULT 0,
  amount_cents bigint NOT NULL,
  PRIMARY KEY (template_id, line_no),
  FOREIGN KEY (org_id, template_id) REFERENCES recurring_template (org_id, template_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, item_id) REFERENCES item (org_id, item_id)
);

-- One row per template per run date: the job's idempotency key.
CREATE TABLE recurring_run (
  org_id bigint NOT NULL,
  template_id bigint NOT NULL,
  run_date date NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('created', 'reminded', 'failed')),
  txn_id bigint,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, run_date),
  FOREIGN KEY (org_id, template_id) REFERENCES recurring_template (org_id, template_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, txn_id) REFERENCES txn (org_id, txn_id) ON DELETE SET NULL (txn_id)
);

ALTER TABLE txn ADD FOREIGN KEY (org_id, recurring_template_id)
  REFERENCES recurring_template (org_id, template_id) ON DELETE SET NULL (recurring_template_id);

-- Late fees: one policy per company. Fees are only assessed on dates on/after effective_from (the day
-- the policy was turned on), so enabling it never back-charges old invoices in one go.
CREATE TABLE late_fee_policy (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  fee_kind text NOT NULL DEFAULT 'flat' CHECK (fee_kind IN ('flat', 'percent')),
  flat_cents bigint NOT NULL DEFAULT 0 CHECK (flat_cents >= 0),
  percent_bps integer NOT NULL DEFAULT 0 CHECK (percent_bps BETWEEN 0 AND 10000),
  grace_days integer NOT NULL DEFAULT 0 CHECK (grace_days BETWEEN 0 AND 365),
  repeat_every_days integer CHECK (repeat_every_days BETWEEN 1 AND 365),
  max_fees_per_invoice integer NOT NULL DEFAULT 1 CHECK (max_fees_per_invoice BETWEEN 1 AND 24),
  effective_from date,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, entity_id),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id),
  CHECK (NOT enabled OR effective_from IS NOT NULL)
);

-- One row per invoice per assessment date: the late-fee job's idempotency key. If the fee
-- transaction is later deleted the row stays (fee_txn_id NULL) so it isn't charged again.
CREATE TABLE late_fee_charge (
  org_id bigint NOT NULL,
  source_txn_id bigint NOT NULL,
  assessed_on date NOT NULL,
  fee_txn_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_txn_id, assessed_on),
  FOREIGN KEY (org_id, source_txn_id) REFERENCES txn (org_id, txn_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, fee_txn_id) REFERENCES txn (org_id, txn_id) ON DELETE SET NULL (fee_txn_id)
);
