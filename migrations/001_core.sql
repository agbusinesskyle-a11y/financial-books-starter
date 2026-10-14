-- Core books schema. Every table carries org_id; child rows reference parents through
-- (org_id, id) composite keys so a row can never point across tenants (ledgerline's shape).

CREATE TABLE org (
  org_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9_]+$'),
  name text NOT NULL
);

CREATE TABLE entity (
  org_id bigint NOT NULL REFERENCES org,
  entity_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  time_zone text NOT NULL DEFAULT 'America/Chicago',
  email text,
  phone text,
  address jsonb,
  UNIQUE (org_id, entity_id)
);

CREATE TABLE terms (
  org_id bigint NOT NULL REFERENCES org,
  terms_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  due_days integer NOT NULL CHECK (due_days BETWEEN 0 AND 365),
  UNIQUE (org_id, terms_id),
  UNIQUE (org_id, name)
);

CREATE TABLE item (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  item_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  description text,
  kind text NOT NULL DEFAULT 'product' CHECK (kind IN ('product', 'service', 'system')),
  rate_cents bigint NOT NULL DEFAULT 0 CHECK (rate_cents >= 0),
  taxable boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (org_id, item_id),
  UNIQUE (org_id, entity_id, name),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id)
);

CREATE TABLE customer (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  customer_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  display_name text NOT NULL CHECK (length(btrim(display_name)) > 0),
  company_name text,
  email text,
  phone text,
  mobile text,
  billing_address jsonb,
  shipping_address jsonb,
  shipping_same_as_billing boolean NOT NULL DEFAULT true,
  note_line text,
  terms_id bigint,
  tax_exempt boolean NOT NULL DEFAULT false,
  tax_exempt_reason text,
  preferred_payment_method text,
  preferred_delivery text NOT NULL DEFAULT 'email' CHECK (preferred_delivery IN ('email', 'print', 'none')),
  late_fees_enabled boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, customer_id),
  UNIQUE (org_id, entity_id, display_name),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id),
  FOREIGN KEY (org_id, terms_id) REFERENCES terms (org_id, terms_id)
);

CREATE TABLE project (
  org_id bigint NOT NULL,
  project_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id bigint NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'canceled')),
  start_date date,
  end_date date,
  description text,
  UNIQUE (org_id, project_id),
  FOREIGN KEY (org_id, customer_id) REFERENCES customer (org_id, customer_id)
);

-- open_cents: for invoice/late_fee the amount still owed; for payment/credit_memo the unapplied amount.
-- A voided transaction keeps its lines for history but carries total 0 / open 0 (QBO shows voids as $0.00).
CREATE TABLE txn (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  txn_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id bigint NOT NULL,
  project_id bigint,
  type text NOT NULL CHECK (type IN ('invoice', 'payment', 'sales_receipt', 'credit_memo', 'late_fee')),
  doc_number text,
  txn_date date NOT NULL,
  due_date date,
  memo text,
  payment_method text,
  payment_ref text,
  total_cents bigint NOT NULL CHECK (total_cents >= 0),
  open_cents bigint NOT NULL CHECK (open_cents >= 0 AND open_cents <= total_cents),
  voided_at timestamptz,
  recurring_template_id bigint,
  source_txn_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, txn_id),
  UNIQUE (org_id, entity_id, type, doc_number),
  CHECK (type NOT IN ('invoice', 'late_fee') OR due_date IS NOT NULL),
  CHECK (due_date IS NULL OR due_date >= txn_date),
  CHECK (type <> 'sales_receipt' OR open_cents = 0),
  CHECK (voided_at IS NULL OR (total_cents = 0 AND open_cents = 0)),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id),
  FOREIGN KEY (org_id, customer_id) REFERENCES customer (org_id, customer_id),
  FOREIGN KEY (org_id, project_id) REFERENCES project (org_id, project_id),
  FOREIGN KEY (org_id, source_txn_id) REFERENCES txn (org_id, txn_id)
);
CREATE INDEX txn_customer_date ON txn (org_id, customer_id, txn_date DESC, txn_id DESC);

CREATE TABLE txn_line (
  org_id bigint NOT NULL,
  txn_id bigint NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  item_id bigint,
  description text,
  quantity numeric(14, 4) NOT NULL DEFAULT 1,
  rate_cents bigint NOT NULL DEFAULT 0,
  amount_cents bigint NOT NULL,
  PRIMARY KEY (txn_id, line_no),
  FOREIGN KEY (org_id, txn_id) REFERENCES txn (org_id, txn_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, item_id) REFERENCES item (org_id, item_id)
);

-- A payment or credit memo (credit side) applied against an invoice or late fee (charge side).
CREATE TABLE application (
  org_id bigint NOT NULL,
  application_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  credit_txn_id bigint NOT NULL,
  charge_txn_id bigint NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  applied_on date NOT NULL,
  UNIQUE (credit_txn_id, charge_txn_id),
  CHECK (credit_txn_id <> charge_txn_id),
  FOREIGN KEY (org_id, credit_txn_id) REFERENCES txn (org_id, txn_id),
  FOREIGN KEY (org_id, charge_txn_id) REFERENCES txn (org_id, txn_id)
);
CREATE INDEX application_charge ON application (charge_txn_id);

CREATE TABLE activity_event (
  org_id bigint NOT NULL,
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id bigint NOT NULL,
  txn_id bigint,
  kind text NOT NULL CHECK (kind ~ '^[a-z_]+$'),
  summary text NOT NULL,
  actor text NOT NULL DEFAULT 'system',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  data jsonb NOT NULL DEFAULT '{}',
  FOREIGN KEY (org_id, customer_id) REFERENCES customer (org_id, customer_id),
  FOREIGN KEY (org_id, txn_id) REFERENCES txn (org_id, txn_id) ON DELETE SET NULL (txn_id)
);
CREATE INDEX activity_customer_time ON activity_event (org_id, customer_id, occurred_at DESC, event_id DESC);
