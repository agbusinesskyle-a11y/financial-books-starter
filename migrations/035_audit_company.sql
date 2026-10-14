-- Companies (stage B1): each audit entry records which company it belongs to, so a company's Audit Log shows only its
-- own changes. Rows without their own entity_id take it from the transaction, customer, vendor or budget they belong to.
-- Organization-wide rows (people, sign-ins) keep entity_id NULL and show in every company of the organization.
ALTER TABLE audit_log ADD COLUMN entity_id bigint;

CREATE FUNCTION audit_entity(n jsonb, o jsonb) RETURNS bigint LANGUAGE plpgsql STABLE AS $$
DECLARE r jsonb := coalesce(n, o); e bigint;
BEGIN
  e := (r ->> 'entity_id')::bigint;
  IF e IS NOT NULL THEN RETURN e; END IF;
  IF r ? 'txn_id' THEN SELECT entity_id INTO e FROM txn WHERE txn_id = (r ->> 'txn_id')::bigint; END IF;
  IF e IS NULL AND r ? 'credit_txn_id' THEN SELECT entity_id INTO e FROM txn WHERE txn_id = (r ->> 'credit_txn_id')::bigint; END IF;
  IF e IS NULL AND r ? 'deposit_txn_id' THEN SELECT entity_id INTO e FROM txn WHERE txn_id = (r ->> 'deposit_txn_id')::bigint; END IF;
  IF e IS NULL AND r ? 'customer_id' THEN SELECT entity_id INTO e FROM customer WHERE customer_id = (r ->> 'customer_id')::bigint; END IF;
  IF e IS NULL AND r ? 'vendor_id' THEN SELECT entity_id INTO e FROM vendor WHERE vendor_id = (r ->> 'vendor_id')::bigint; END IF;
  IF e IS NULL AND r ? 'budget_id' THEN SELECT entity_id INTO e FROM budget WHERE budget_id = (r ->> 'budget_id')::bigint; END IF;
  IF e IS NULL AND r ? 'template_id' THEN SELECT entity_id INTO e FROM recurring_template WHERE template_id = (r ->> 'template_id')::bigint; END IF;
  RETURN e;
END $$;

CREATE OR REPLACE FUNCTION audit_row() RETURNS trigger LANGUAGE plpgsql AS $$
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
  INSERT INTO audit_log (org_id, entity_id, actor, action, table_name, row_id, before, after)
  VALUES (org, CASE WHEN TG_TABLE_NAME IN ('app_user', 'user_invite') THEN NULL ELSE audit_entity(n, o) END, who, lower(TG_OP), TG_TABLE_NAME,
          coalesce((n ->> pk)::bigint, (o ->> pk)::bigint),
          CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE b END, CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE a END);
  RETURN NULL;
END $$;

UPDATE audit_log SET entity_id = audit_entity(after, before) WHERE table_name NOT IN ('app_user', 'user_invite');
CREATE INDEX audit_log_entity_at ON audit_log (entity_id, at DESC);
