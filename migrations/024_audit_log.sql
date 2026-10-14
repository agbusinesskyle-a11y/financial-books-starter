-- Audit log (Reports R3b): who changed what and when, with before/after values, for every write to the company's
-- records and settings, plus sign-ins. Written by triggers, so nothing can change a record without leaving a trace.
-- The person comes from the connection setting app.actor (set by the app for each request; 'system' for jobs, seeding
-- and migrations). Secrets (passwords, encrypted values, token hashes) and file contents are never copied in, and
-- derived values (open balances, timestamps) are ignored so a change shows only what someone actually changed.
CREATE TABLE audit_log (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id bigint,
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  action text NOT NULL,
  table_name text NOT NULL,
  row_id bigint,
  before jsonb,
  after jsonb
);
CREATE INDEX audit_log_org_at ON audit_log (org_id, at DESC);

CREATE FUNCTION audit_clean(j jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb) FROM jsonb_each(j) AS e(k, v)
   WHERE k !~ '(password|_enc$|token|hash|totp|signin_version)' AND k NOT IN ('content', 'logo')
$$;

CREATE FUNCTION audit_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  o jsonb; n jsonb; b jsonb := '{}'; a jsonb := '{}'; k text; org bigint;
  who text := coalesce(nullif(current_setting('app.actor', true), ''), 'system');
  pk text := TG_ARGV[0];
BEGIN
  IF TG_OP <> 'INSERT' THEN o := audit_clean(to_jsonb(OLD)); END IF;
  IF TG_OP <> 'DELETE' THEN n := audit_clean(to_jsonb(NEW)); END IF;
  IF TG_OP = 'UPDATE' THEN
    FOR k IN SELECT jsonb_object_keys(n) LOOP
      IF k NOT IN ('updated_at', 'open_cents', 'foreign_open_cents', 'last_login_at', 'created_at') AND (o -> k) IS DISTINCT FROM (n -> k) THEN
        b := b || jsonb_build_object(k, o -> k);
        a := a || jsonb_build_object(k, n -> k);
      END IF;
    END LOOP;
    IF a = '{}'::jsonb THEN RETURN NULL; END IF;
  ELSE
    b := o; a := n;
  END IF;
  org := coalesce((n ->> 'org_id')::bigint, (o ->> 'org_id')::bigint);
  IF org IS NULL AND TG_TABLE_NAME = 'budget_line' THEN
    SELECT budget.org_id INTO org FROM budget WHERE budget_id = coalesce((n ->> 'budget_id')::bigint, (o ->> 'budget_id')::bigint);
  END IF;
  INSERT INTO audit_log (org_id, actor, action, table_name, row_id, before, after)
  VALUES (org, who, lower(TG_OP), TG_TABLE_NAME, coalesce((n ->> pk)::bigint, (o ->> pk)::bigint),
          CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE b END, CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE a END);
  RETURN NULL;
END $$;

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON account FOR EACH ROW EXECUTE FUNCTION audit_row('account_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON accounting_settings FOR EACH ROW EXECUTE FUNCTION audit_row('entity_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app_user FOR EACH ROW EXECUTE FUNCTION audit_row('user_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON application FOR EACH ROW EXECUTE FUNCTION audit_row('application_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON bill_settings FOR EACH ROW EXECUTE FUNCTION audit_row('entity_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON budget FOR EACH ROW EXECUTE FUNCTION audit_row('budget_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON budget_line FOR EACH ROW EXECUTE FUNCTION audit_row('budget_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON class FOR EACH ROW EXECUTE FUNCTION audit_row('class_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON currency FOR EACH ROW EXECUTE FUNCTION audit_row('entity_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON currency_settings FOR EACH ROW EXECUTE FUNCTION audit_row('entity_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON customer FOR EACH ROW EXECUTE FUNCTION audit_row('customer_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON document FOR EACH ROW EXECUTE FUNCTION audit_row('document_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON email_settings FOR EACH ROW EXECUTE FUNCTION audit_row('entity_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON entity FOR EACH ROW EXECUTE FUNCTION audit_row('entity_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON exchange_rate FOR EACH ROW EXECUTE FUNCTION audit_row('entity_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON form_style FOR EACH ROW EXECUTE FUNCTION audit_row('entity_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON item FOR EACH ROW EXECUTE FUNCTION audit_row('item_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON late_fee_policy FOR EACH ROW EXECUTE FUNCTION audit_row('entity_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON location FOR EACH ROW EXECUTE FUNCTION audit_row('location_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON payments_settings FOR EACH ROW EXECUTE FUNCTION audit_row('entity_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON price_rule FOR EACH ROW EXECUTE FUNCTION audit_row('rule_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON project FOR EACH ROW EXECUTE FUNCTION audit_row('project_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON reconciliation FOR EACH ROW EXECUTE FUNCTION audit_row('rec_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON recurring_template FOR EACH ROW EXECUTE FUNCTION audit_row('template_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON report_note FOR EACH ROW EXECUTE FUNCTION audit_row('entity_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON sales_settings FOR EACH ROW EXECUTE FUNCTION audit_row('entity_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON statement FOR EACH ROW EXECUTE FUNCTION audit_row('statement_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON tag FOR EACH ROW EXECUTE FUNCTION audit_row('tag_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON tag_group FOR EACH ROW EXECUTE FUNCTION audit_row('group_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON terms FOR EACH ROW EXECUTE FUNCTION audit_row('terms_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON time_entry FOR EACH ROW EXECUTE FUNCTION audit_row('entry_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON txn FOR EACH ROW EXECUTE FUNCTION audit_row('txn_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON txn_tag FOR EACH ROW EXECUTE FUNCTION audit_row('txn_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON user_invite FOR EACH ROW EXECUTE FUNCTION audit_row('invite_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON vendor FOR EACH ROW EXECUTE FUNCTION audit_row('vendor_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON vendor_info_request FOR EACH ROW EXECUTE FUNCTION audit_row('request_id');
