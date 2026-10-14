-- Reports R5a: custom KPIs and management report packages.
CREATE TABLE kpi (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  kpi_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  category text NOT NULL DEFAULT 'Custom',
  description text,
  unit text NOT NULL CHECK (unit IN ('money', 'percent', 'number')),
  direction text NOT NULL DEFAULT 'up' CHECK (direction IN ('up', 'down')),
  formula text NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, entity_id, name),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id)
);

CREATE TABLE mgmt_report (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  mgmt_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  template text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  period text NOT NULL DEFAULT 'last_month',
  basis text NOT NULL DEFAULT 'accrual' CHECK (basis IN ('accrual', 'cash')),
  cover_title text,
  cover_subtitle text,
  prepared_by text,
  intro text,
  closing text,
  sections jsonb NOT NULL DEFAULT '[]',
  sched_freq text NOT NULL DEFAULT 'none' CHECK (sched_freq IN ('none', 'daily', 'weekly', 'monthly')),
  sched_day integer NOT NULL DEFAULT 1 CHECK (sched_day BETWEEN 0 AND 28),
  sched_to text,
  sched_next date,
  last_sent_at timestamptz,
  last_error text,
  created_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id)
);

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON kpi FOR EACH ROW EXECUTE FUNCTION audit_row('kpi_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON mgmt_report FOR EACH ROW EXECUTE FUNCTION audit_row('mgmt_id');
