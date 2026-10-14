-- Settings S5: budgets. A budget is per fiscal year; amounts per income/expense account per fiscal month, optionally
-- split by class, location or customer (dim_id).

CREATE TABLE budget (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  budget_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  fiscal_year integer NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 2100),
  start_month integer NOT NULL CHECK (start_month BETWEEN 1 AND 12),
  subdivide text NOT NULL DEFAULT 'none' CHECK (subdivide IN ('none', 'class', 'location', 'customer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id)
);
CREATE UNIQUE INDEX budget_name ON budget (org_id, entity_id, lower(name));

CREATE TABLE budget_line (
  budget_id bigint NOT NULL REFERENCES budget ON DELETE CASCADE,
  account_id bigint NOT NULL,
  dim_id bigint NOT NULL DEFAULT 0,
  -- 1 = the first month of the fiscal year.
  period integer NOT NULL CHECK (period BETWEEN 1 AND 12),
  amount_cents bigint NOT NULL,
  PRIMARY KEY (budget_id, account_id, dim_id, period)
);
