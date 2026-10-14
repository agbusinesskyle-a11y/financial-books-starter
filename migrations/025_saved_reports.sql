-- Reports R4: saved (custom) reports with optional email schedules, and each person's default report settings.
CREATE TABLE saved_report (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  saved_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  report_key text NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  query text NOT NULL DEFAULT '',
  owner_key text NOT NULL,
  owner_name text NOT NULL,
  shared boolean NOT NULL DEFAULT false,
  group_name text,
  sched_freq text NOT NULL DEFAULT 'none' CHECK (sched_freq IN ('none', 'daily', 'weekly', 'monthly')),
  sched_day integer NOT NULL DEFAULT 1 CHECK (sched_day BETWEEN 0 AND 28),
  sched_to text,
  sched_format text NOT NULL DEFAULT 'pdf' CHECK (sched_format IN ('pdf', 'xlsx', 'csv')),
  sched_next date,
  last_sent_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id)
);
CREATE INDEX saved_report_due ON saved_report (sched_next) WHERE sched_freq <> 'none';

-- report_key '*' holds the look ("use these settings for all reports"); a report's own row holds all its options.
CREATE TABLE report_default (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  user_key text NOT NULL,
  report_key text NOT NULL,
  query text NOT NULL,
  PRIMARY KEY (org_id, entity_id, user_key, report_key),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id)
);

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON saved_report FOR EACH ROW EXECUTE FUNCTION audit_row('saved_id');
