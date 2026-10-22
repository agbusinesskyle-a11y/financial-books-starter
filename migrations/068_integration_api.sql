-- Generic, company-scoped integrations. No financial rows are changed.
CREATE FUNCTION integration_scopes_valid(scopes text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT cardinality(scopes) BETWEEN 1 AND 4
    AND array_position(scopes, NULL) IS NULL
    AND scopes <@ ARRAY['documents:write','bills:approve','payments:write','settlements:read']::text[]
    AND cardinality(scopes) = (SELECT count(DISTINCT s) FROM unnest(scopes) s)
$$;

CREATE TABLE api_token (
  token_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  source text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_-]{0,63}$'),
  token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  scopes text[] NOT NULL CHECK (integration_scopes_valid(scopes)),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  rate_window timestamptz,
  rate_count integer NOT NULL DEFAULT 0 CHECK (rate_count >= 0),
  FOREIGN KEY (org_id,entity_id) REFERENCES entity(org_id,entity_id)
);

ALTER TABLE txn ADD UNIQUE (org_id,entity_id,txn_id);
CREATE TABLE external_ref (
  ref_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  source text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_-]{0,63}$'),
  source_ref text NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 200),
  txn_id bigint NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id,entity_id,source,source_ref),
  UNIQUE (org_id,entity_id,source,txn_id),
  FOREIGN KEY (org_id,entity_id) REFERENCES entity(org_id,entity_id),
  FOREIGN KEY (org_id,entity_id,txn_id) REFERENCES txn(org_id,entity_id,txn_id) ON DELETE RESTRICT
);

CREATE TABLE integration_setting (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  accept_writes boolean NOT NULL DEFAULT false,
  write_floor date,
  instance_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ledger_instance text NOT NULL DEFAULT 'unconfigured',
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id,entity_id),
  FOREIGN KEY (org_id,entity_id) REFERENCES entity(org_id,entity_id)
);
-- audit_clean deliberately strips every token/hash field, including token_id. Keep the public row identity
-- outside the cleaned payload; throttling/last-used counters are operational metadata, not security edits.
CREATE FUNCTION integration_token_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b jsonb; a jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN b := audit_clean(to_jsonb(OLD)) - ARRAY['last_used_at','rate_window','rate_count']; END IF;
  IF TG_OP <> 'DELETE' THEN a := audit_clean(to_jsonb(NEW)) - ARRAY['last_used_at','rate_window','rate_count']; END IF;
  IF TG_OP = 'UPDATE' AND a IS NOT DISTINCT FROM b THEN RETURN NULL; END IF;
  INSERT INTO audit_log(org_id,entity_id,actor,action,table_name,row_id,before,after)
    VALUES(coalesce(NEW.org_id,OLD.org_id),coalesce(NEW.entity_id,OLD.entity_id),
      coalesce(nullif(current_setting('app.actor',true),''),'system'),lower(TG_OP),'api_token',
      coalesce(NEW.token_id,OLD.token_id),b,a);
  RETURN NULL;
END $$;
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON api_token FOR EACH ROW EXECUTE FUNCTION integration_token_audit();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON external_ref FOR EACH ROW EXECUTE FUNCTION audit_row('ref_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON integration_setting FOR EACH ROW EXECUTE FUNCTION audit_row('entity_id');
