-- Morning View: docs/superpowers/specs/2026-10-17-morning-view-design.md
-- Historical snapshot IDs carry no live FKs on purpose; live references cascade.

-- shared helpers
CREATE FUNCTION morning_forbid_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'morning: % rows are immutable', TG_TABLE_NAME USING ERRCODE = 'P0001'; END $$;

CREATE FUNCTION morning_version_advances() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.settings_version <= OLD.settings_version THEN
    RAISE EXCEPTION 'morning: settings_version must advance (% -> %)', OLD.settings_version, NEW.settings_version USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- 1. membership registry
CREATE TABLE morning_viewer (
  org_id bigint NOT NULL REFERENCES org (org_id) ON DELETE CASCADE,
  viewer_key text NOT NULL CHECK (viewer_key = 'owner' OR viewer_key ~ '^[1-9][0-9]{0,18}$'),
  user_id bigint,
  enrollment_state text NOT NULL CHECK (enrollment_state IN ('disabled', 'pending_enrollment', 'ready')),
  membership_epoch bigint NOT NULL DEFAULT 1 CHECK (membership_epoch > 0),
  granted_at timestamptz NOT NULL DEFAULT now(),
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, viewer_key),
  UNIQUE (org_id, user_id),
  FOREIGN KEY (org_id, user_id) REFERENCES app_user (org_id, user_id) ON DELETE CASCADE,
  CONSTRAINT morning_viewer_owner_key CHECK ((viewer_key = 'owner') = (user_id IS NULL)),
  CONSTRAINT morning_viewer_user_key CHECK (user_id IS NULL OR viewer_key = user_id::text),
  CONSTRAINT morning_viewer_owner_ready CHECK (user_id IS NOT NULL OR enrollment_state = 'ready')
);
CREATE UNIQUE INDEX morning_viewer_one_second ON morning_viewer (org_id)
  WHERE user_id IS NOT NULL AND enrollment_state IN ('pending_enrollment', 'ready');
CREATE FUNCTION morning_viewer_keep_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.viewer_key = 'owner' AND EXISTS (SELECT 1 FROM org WHERE org_id = OLD.org_id) THEN
    RAISE EXCEPTION 'morning: the owner viewer row cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER morning_viewer_keep_owner BEFORE DELETE ON morning_viewer FOR EACH ROW EXECUTE FUNCTION morning_viewer_keep_owner();
CREATE FUNCTION morning_viewer_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.membership_epoch < OLD.membership_epoch THEN RAISE EXCEPTION 'morning: membership_epoch cannot go back' USING ERRCODE = 'P0001'; END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.viewer_key <> OLD.viewer_key THEN
    RAISE EXCEPTION 'morning: a viewer row keeps its identity' USING ERRCODE = 'P0001'; END IF;
  NEW.changed_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER morning_viewer_epoch BEFORE UPDATE ON morning_viewer FOR EACH ROW EXECUTE FUNCTION morning_viewer_epoch();

-- 2. per-viewer preferences (recipient_settings_version = settings_version)
CREATE TABLE morning_preference (
  org_id bigint NOT NULL REFERENCES org (org_id) ON DELETE CASCADE,
  viewer_key text NOT NULL,
  membership_epoch bigint NOT NULL CHECK (membership_epoch > 0),
  enabled boolean NOT NULL DEFAULT false,
  send_minute smallint NOT NULL DEFAULT 390 CHECK (send_minute BETWEEN 0 AND 1439),
  channel text NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms', 'email')),
  phone text CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{6,14}$'),
  email text CHECK (email IS NULL OR (length(email) <= 200 AND email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$')),
  include_amounts boolean NOT NULL DEFAULT false,
  detail_threshold_cents bigint NOT NULL DEFAULT 50000 CHECK (detail_threshold_cents BETWEEN 0 AND 9007199254740991),
  settings_version bigint NOT NULL DEFAULT 1 CHECK (settings_version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, viewer_key),
  FOREIGN KEY (org_id, viewer_key) REFERENCES morning_viewer (org_id, viewer_key) ON DELETE CASCADE,
  CONSTRAINT morning_preference_one_destination CHECK ((channel = 'sms' AND email IS NULL) OR (channel = 'email' AND phone IS NULL)),
  CONSTRAINT morning_preference_enabled_destination CHECK (NOT enabled OR (channel = 'sms' AND phone IS NOT NULL) OR (channel = 'email' AND email IS NOT NULL))
);
CREATE TRIGGER morning_preference_version BEFORE UPDATE ON morning_preference FOR EACH ROW EXECUTE FUNCTION morning_version_advances();

-- 3. owner-edited company thresholds (missing row = default 1,000,000 cents)
CREATE TABLE morning_company_setting (
  org_id bigint NOT NULL REFERENCES org (org_id) ON DELETE CASCADE,
  entity_id bigint NOT NULL,
  large_threshold_cents bigint NOT NULL CHECK (large_threshold_cents BETWEEN 1 AND 9007199254740991),
  settings_version bigint NOT NULL DEFAULT 1 CHECK (settings_version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, entity_id),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id) ON DELETE CASCADE
);
CREATE TRIGGER morning_company_setting_version BEFORE UPDATE ON morning_company_setting FOR EACH ROW EXECUTE FUNCTION morning_version_advances();

-- 4. per-viewer balance floors
CREATE TABLE morning_floor (
  org_id bigint NOT NULL REFERENCES org (org_id) ON DELETE CASCADE,
  viewer_key text NOT NULL,
  account_id bigint NOT NULL,
  floor_cents bigint NOT NULL CHECK (floor_cents BETWEEN -9007199254740991 AND 9007199254740991),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, viewer_key, account_id),
  FOREIGN KEY (org_id, viewer_key) REFERENCES morning_viewer (org_id, viewer_key) ON DELETE CASCADE,
  FOREIGN KEY (org_id, account_id) REFERENCES account (org_id, account_id) ON DELETE CASCADE
);

-- 5. immutable snapshot generations (historical copies: no live entity/account FKs)
CREATE TABLE morning_snapshot_generation (
  org_id bigint NOT NULL REFERENCES org (org_id) ON DELETE CASCADE,
  viewer_key text NOT NULL,
  generation_id uuid NOT NULL,
  captured_at timestamptz NOT NULL,
  as_of_date date NOT NULL,
  zone text NOT NULL DEFAULT 'America/Phoenix' CHECK (zone = 'America/Phoenix'),
  definition_version smallint NOT NULL DEFAULT 1 CHECK (definition_version = 1),
  complete boolean NOT NULL DEFAULT true CHECK (complete),
  sealed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (org_id, viewer_key, generation_id),
  FOREIGN KEY (org_id, viewer_key) REFERENCES morning_viewer (org_id, viewer_key) ON DELETE CASCADE
);
CREATE INDEX morning_snapshot_generation_age ON morning_snapshot_generation (org_id, viewer_key, captured_at);
CREATE TABLE morning_snapshot_company (
  org_id bigint NOT NULL REFERENCES org (org_id) ON DELETE CASCADE,
  viewer_key text NOT NULL,
  generation_id uuid NOT NULL,
  observed_entity_id bigint NOT NULL,
  entity_name text NOT NULL,
  is_personal boolean NOT NULL,
  PRIMARY KEY (org_id, viewer_key, generation_id, observed_entity_id),
  FOREIGN KEY (org_id, viewer_key) REFERENCES morning_viewer (org_id, viewer_key) ON DELETE CASCADE,
  FOREIGN KEY (org_id, viewer_key, generation_id) REFERENCES morning_snapshot_generation (org_id, viewer_key, generation_id) ON DELETE CASCADE
);
CREATE TABLE morning_snapshot_account (
  org_id bigint NOT NULL REFERENCES org (org_id) ON DELETE CASCADE,
  viewer_key text NOT NULL,
  generation_id uuid NOT NULL,
  observed_account_id bigint NOT NULL,
  observed_entity_id bigint NOT NULL,
  account_name text NOT NULL,
  account_type text NOT NULL CHECK (account_type IN ('bank', 'credit_card')),
  active boolean NOT NULL,
  signed_cents bigint NOT NULL CHECK (signed_cents BETWEEN -9007199254740991 AND 9007199254740991),
  PRIMARY KEY (org_id, viewer_key, generation_id, observed_account_id),
  FOREIGN KEY (org_id, viewer_key) REFERENCES morning_viewer (org_id, viewer_key) ON DELETE CASCADE,
  FOREIGN KEY (org_id, viewer_key, generation_id, observed_entity_id)
    REFERENCES morning_snapshot_company (org_id, viewer_key, generation_id, observed_entity_id) ON DELETE CASCADE
);
CREATE FUNCTION morning_generation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Only the publication trigger may advance the seal; financial evidence never changes.
  IF pg_trigger_depth()>1 AND NOT OLD.sealed AND NEW.sealed
     AND (to_jsonb(NEW)-'sealed')=(to_jsonb(OLD)-'sealed') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'morning: snapshot generation is immutable' USING ERRCODE='P0001';
END $$;
CREATE TRIGGER morning_snapshot_generation_immutable BEFORE UPDATE ON morning_snapshot_generation FOR EACH ROW EXECUTE FUNCTION morning_generation_immutable();
CREATE TRIGGER morning_snapshot_company_immutable BEFORE UPDATE ON morning_snapshot_company FOR EACH ROW EXECUTE FUNCTION morning_forbid_update();
CREATE TRIGGER morning_snapshot_account_immutable BEFORE UPDATE ON morning_snapshot_account FOR EACH ROW EXECUTE FUNCTION morning_forbid_update();
CREATE FUNCTION morning_snapshot_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'morning_snapshot_company' THEN
    IF NOT EXISTS (SELECT 1 FROM entity WHERE org_id = NEW.org_id AND entity_id = NEW.observed_entity_id) THEN
      RAISE EXCEPTION 'morning: observed company % is not in org %', NEW.observed_entity_id, NEW.org_id USING ERRCODE = 'P0001'; END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM account WHERE org_id = NEW.org_id AND entity_id = NEW.observed_entity_id AND account_id = NEW.observed_account_id) THEN
      RAISE EXCEPTION 'morning: observed account % is not in company %', NEW.observed_account_id, NEW.observed_entity_id USING ERRCODE = 'P0001'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER morning_snapshot_company_identity BEFORE INSERT ON morning_snapshot_company FOR EACH ROW EXECUTE FUNCTION morning_snapshot_identity();
CREATE TRIGGER morning_snapshot_account_identity BEFORE INSERT ON morning_snapshot_account FOR EACH ROW EXECUTE FUNCTION morning_snapshot_identity();

-- 6. visit pointers
CREATE TABLE morning_visit (
  org_id bigint NOT NULL REFERENCES org (org_id) ON DELETE CASCADE,
  viewer_key text NOT NULL,
  comparison_generation_id uuid,
  latest_generation_id uuid,
  reuse_anchor_at timestamptz,
  latest_shown_at timestamptz,
  visit_version bigint NOT NULL DEFAULT 1 CHECK (visit_version > 0),
  PRIMARY KEY (org_id, viewer_key),
  FOREIGN KEY (org_id, viewer_key) REFERENCES morning_viewer (org_id, viewer_key) ON DELETE CASCADE,
  CONSTRAINT morning_visit_comparison_fk FOREIGN KEY (org_id, viewer_key, comparison_generation_id)
    REFERENCES morning_snapshot_generation (org_id, viewer_key, generation_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT morning_visit_latest_fk FOREIGN KEY (org_id, viewer_key, latest_generation_id)
    REFERENCES morning_snapshot_generation (org_id, viewer_key, generation_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT morning_visit_latest_parts CHECK ((latest_generation_id IS NULL) = (reuse_anchor_at IS NULL)
    AND (latest_generation_id IS NULL) = (latest_shown_at IS NULL)),
  CONSTRAINT morning_visit_comparison_needs_latest CHECK (comparison_generation_id IS NULL OR latest_generation_id IS NOT NULL),
  CONSTRAINT morning_visit_comparison_differs CHECK (comparison_generation_id IS NULL OR comparison_generation_id <> latest_generation_id)
);
CREATE FUNCTION morning_visit_times() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v morning_visit; l_at timestamptz; c_at timestamptz;
BEGIN
  SELECT * INTO v FROM morning_visit WHERE org_id = NEW.org_id AND viewer_key = NEW.viewer_key;
  IF NOT FOUND OR v.latest_generation_id IS NULL THEN RETURN NULL; END IF;
  SELECT captured_at INTO l_at FROM morning_snapshot_generation WHERE org_id = v.org_id AND viewer_key = v.viewer_key AND generation_id = v.latest_generation_id;
  IF l_at IS DISTINCT FROM v.latest_shown_at THEN RAISE EXCEPTION 'morning: latest_shown_at must equal L.captured_at' USING ERRCODE = 'P0001'; END IF;
  IF v.reuse_anchor_at > v.latest_shown_at THEN RAISE EXCEPTION 'morning: anchor after latest_shown_at' USING ERRCODE = 'P0001'; END IF;
  IF v.comparison_generation_id IS NOT NULL THEN
    SELECT captured_at INTO c_at FROM morning_snapshot_generation WHERE org_id = v.org_id AND viewer_key = v.viewer_key AND generation_id = v.comparison_generation_id;
    IF NOT (c_at < l_at AND c_at <= v.reuse_anchor_at) THEN RAISE EXCEPTION 'morning: comparison must be older than latest and not newer than the anchor' USING ERRCODE = 'P0001'; END IF;
  END IF;
  -- Deferred FKs also permit visit-before-generation insertion. Seal the final
  -- referenced set at commit, even if the immediate publication found no parent.
  UPDATE morning_snapshot_generation SET sealed=true
    WHERE org_id=v.org_id AND viewer_key=v.viewer_key AND NOT sealed
      AND generation_id IN (v.comparison_generation_id,v.latest_generation_id);
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER morning_visit_times AFTER INSERT OR UPDATE ON morning_visit DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION morning_visit_times();

CREATE FUNCTION morning_seal_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE morning_snapshot_generation SET sealed=true
   WHERE org_id=NEW.org_id AND viewer_key=NEW.viewer_key AND NOT sealed
     AND generation_id IN (NEW.comparison_generation_id,NEW.latest_generation_id);
  RETURN NULL;
END $$;
CREATE TRIGGER morning_seal_generation AFTER INSERT OR UPDATE ON morning_visit
  FOR EACH ROW EXECUTE FUNCTION morning_seal_generation();
CREATE FUNCTION morning_snapshot_child_set() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; published boolean;
BEGIN
  IF TG_OP='DELETE' THEN r:=OLD; ELSE r:=NEW; END IF;
  -- A parent-generation, viewer or organization cascade is intentional cleanup.
  IF TG_OP='DELETE' AND (NOT EXISTS(SELECT 1 FROM org WHERE org_id=r.org_id)
    OR NOT EXISTS(SELECT 1 FROM morning_viewer WHERE org_id=r.org_id AND viewer_key=r.viewer_key)) THEN RETURN OLD; END IF;
  SELECT sealed INTO published FROM morning_snapshot_generation
    WHERE org_id=r.org_id AND viewer_key=r.viewer_key AND generation_id=r.generation_id FOR SHARE;
  IF published THEN RAISE EXCEPTION 'morning: snapshot child set is sealed' USING ERRCODE='P0001'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER morning_snapshot_company_set BEFORE INSERT OR DELETE ON morning_snapshot_company
  FOR EACH ROW EXECUTE FUNCTION morning_snapshot_child_set();
CREATE TRIGGER morning_snapshot_account_set BEFORE INSERT OR DELETE ON morning_snapshot_account
  FOR EACH ROW EXECUTE FUNCTION morning_snapshot_child_set();

-- 7. dismissals (no live source FK; hashes only)
CREATE TABLE morning_dismissal (
  org_id bigint NOT NULL REFERENCES org (org_id) ON DELETE CASCADE,
  viewer_key text NOT NULL,
  item_key text NOT NULL CHECK (length(item_key) BETWEEN 1 AND 512),
  item_version text NOT NULL CHECK (item_version ~ '^[0-9a-f]{64}$'),
  rule_version smallint NOT NULL CHECK (rule_version > 0),
  note text CHECK (note IS NULL OR length(note) <= 500),
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, viewer_key, item_key),
  FOREIGN KEY (org_id, viewer_key) REFERENCES morning_viewer (org_id, viewer_key) ON DELETE CASCADE
);

-- 8. organization delivery settings (delivery_settings_version = settings_version)
CREATE TABLE morning_delivery_setting (
  org_id bigint PRIMARY KEY REFERENCES org (org_id) ON DELETE CASCADE,
  delivery_enabled boolean NOT NULL DEFAULT false,
  trusted_origin text CHECK (trusted_origin IS NULL OR trusted_origin ~ '^https?://[^/\s]+$'),
  trusted_origin_fingerprint text CHECK (trusted_origin_fingerprint IS NULL OR trusted_origin_fingerprint ~ '^[0-9a-f]{64}$'),
  observed_origin_fingerprint text CHECK (observed_origin_fingerprint IS NULL OR observed_origin_fingerprint ~ '^[0-9a-f]{64}$'),
  settings_version bigint NOT NULL DEFAULT 1 CHECK (settings_version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT morning_delivery_origin CHECK (NOT delivery_enabled OR (trusted_origin IS NOT NULL AND trusted_origin_fingerprint IS NOT NULL))
);
CREATE TRIGGER morning_delivery_setting_version BEFORE UPDATE ON morning_delivery_setting FOR EACH ROW EXECUTE FUNCTION morning_version_advances();

-- 9. pinned transports
CREATE TABLE morning_transport (
  org_id bigint NOT NULL REFERENCES org (org_id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('sms', 'email')),
  email_entity_id bigint,
  source_revision bigint NOT NULL DEFAULT 1 CHECK (source_revision > 0),
  approved_revision bigint CHECK (approved_revision IS NULL OR approved_revision > 0),
  approved_fingerprint text CHECK (approved_fingerprint IS NULL OR approved_fingerprint ~ '^[0-9a-f]{64}$'),
  approved_at timestamptz,
  approved_by text CHECK (approved_by IS NULL OR approved_by = 'owner'),
  suspended boolean NOT NULL DEFAULT true,
  PRIMARY KEY (org_id, channel),
  FOREIGN KEY (org_id, email_entity_id) REFERENCES entity (org_id, entity_id) ON DELETE SET NULL (email_entity_id),
  CONSTRAINT morning_transport_sms_no_entity CHECK (channel = 'email' OR email_entity_id IS NULL),
  CONSTRAINT morning_transport_email_selected CHECK (channel = 'sms' OR email_entity_id IS NOT NULL OR approved_revision IS NULL),
  CONSTRAINT morning_transport_approval_parts CHECK ((approved_revision IS NULL) = (approved_fingerprint IS NULL)
    AND (approved_revision IS NULL) = (approved_at IS NULL) AND (approved_revision IS NULL) = (approved_by IS NULL)),
  CONSTRAINT morning_transport_approval_not_ahead CHECK (approved_revision IS NULL OR approved_revision <= source_revision),
  CONSTRAINT morning_transport_live_is_exact CHECK (suspended OR (approved_revision IS NOT NULL AND approved_revision = source_revision))
);
CREATE FUNCTION morning_transport_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_revision < OLD.source_revision THEN RAISE EXCEPTION 'morning: source_revision cannot go back' USING ERRCODE = 'P0001'; END IF;
  IF NEW.email_entity_id IS DISTINCT FROM OLD.email_entity_id THEN
    NEW.source_revision := greatest(NEW.source_revision, OLD.source_revision + 1);
    NEW.approved_revision := NULL; NEW.approved_fingerprint := NULL; NEW.approved_at := NULL; NEW.approved_by := NULL;
    NEW.suspended := true;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER morning_transport_guard BEFORE UPDATE ON morning_transport FOR EACH ROW EXECUTE FUNCTION morning_transport_guard();

-- The configured environment origin is observed under SECURITY exclusive, before
-- read snapshots. Persist change-and-restore invalidation for both channels.
CREATE FUNCTION morning_origin_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.observed_origin_fingerprint IS NOT NULL AND
     NEW.observed_origin_fingerprint IS DISTINCT FROM OLD.observed_origin_fingerprint THEN
    UPDATE morning_transport SET source_revision=source_revision+1, suspended=true WHERE org_id=NEW.org_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER morning_origin_changed AFTER UPDATE OF observed_origin_fingerprint ON morning_delivery_setting
  FOR EACH ROW EXECUTE FUNCTION morning_origin_changed();

-- 10. transport source-revision hooks on the ordinary settings
CREATE FUNCTION morning_email_source_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o email_settings; n email_settings;
BEGIN
  IF TG_OP <> 'INSERT' THEN o := OLD; END IF;
  IF TG_OP <> 'DELETE' THEN n := NEW; END IF;
  IF TG_OP = 'UPDATE' AND (o.mode, o.from_name, o.from_email, o.reply_to, o.smtp_host, o.smtp_port, o.smtp_security, o.smtp_user, o.smtp_password_enc)
       IS NOT DISTINCT FROM (n.mode, n.from_name, n.from_email, n.reply_to, n.smtp_host, n.smtp_port, n.smtp_security, n.smtp_user, n.smtp_password_enc) THEN
    RETURN NULL;
  END IF;
  UPDATE morning_transport SET source_revision = source_revision + 1, suspended = true
   WHERE org_id = coalesce(n.org_id, o.org_id) AND channel = 'email' AND email_entity_id = coalesce(n.entity_id, o.entity_id);
  RETURN NULL;
END $$;
CREATE TRIGGER morning_email_source_changed AFTER INSERT OR UPDATE OR DELETE ON email_settings FOR EACH ROW EXECUTE FUNCTION morning_email_source_changed();
CREATE FUNCTION morning_sms_source_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o sms_settings; n sms_settings;
BEGIN
  IF TG_OP <> 'INSERT' THEN o := OLD; END IF;
  IF TG_OP <> 'DELETE' THEN n := NEW; END IF;
  IF TG_OP = 'UPDATE' AND (o.enabled, o.account_sid, o.auth_token_enc, o.phone) IS NOT DISTINCT FROM (n.enabled, n.account_sid, n.auth_token_enc, n.phone) THEN
    RETURN NULL;
  END IF;
  UPDATE morning_transport SET source_revision = source_revision + 1, suspended = true
   WHERE org_id = coalesce(n.org_id, o.org_id) AND channel = 'sms';
  RETURN NULL;
END $$;
CREATE TRIGGER morning_sms_source_changed AFTER INSERT OR UPDATE OR DELETE ON sms_settings FOR EACH ROW EXECUTE FUNCTION morning_sms_source_changed();

-- 11. daily claims (never pruned while the registry row exists)
CREATE TABLE morning_message_claim (
  org_id bigint NOT NULL REFERENCES org (org_id) ON DELETE CASCADE,
  viewer_key text NOT NULL,
  sent_on date NOT NULL,
  claim_id uuid NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('claimed', 'sent', 'failed', 'unknown', 'skipped')),
  captured_at timestamptz NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  attempt_started_at timestamptz,
  membership_epoch bigint NOT NULL,
  recipient_settings_version bigint NOT NULL,
  delivery_settings_version bigint NOT NULL,
  transport_source_revision bigint NOT NULL,
  transport_approved_revision bigint NOT NULL,
  channel text NOT NULL CHECK (channel IN ('sms', 'email')),
  baseline_generation_id uuid,
  baseline_captured_at timestamptz,
  outcome text CHECK (outcome IS NULL OR length(outcome) <= 300),
  outcome_redacted_at timestamptz,
  PRIMARY KEY (org_id, viewer_key, sent_on),
  FOREIGN KEY (org_id, viewer_key) REFERENCES morning_viewer (org_id, viewer_key) ON DELETE CASCADE,
  CONSTRAINT morning_claim_sent_attempted CHECK (state <> 'sent' OR attempt_started_at IS NOT NULL),
  CONSTRAINT morning_claim_completed CHECK ((state = 'claimed') = (completed_at IS NULL))
);
CREATE FUNCTION morning_claim_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.org_id, NEW.viewer_key, NEW.sent_on, NEW.claim_id, NEW.captured_at, NEW.claimed_at, NEW.membership_epoch,
      NEW.recipient_settings_version, NEW.delivery_settings_version, NEW.transport_source_revision,
      NEW.transport_approved_revision, NEW.channel)
     IS DISTINCT FROM (OLD.org_id, OLD.viewer_key, OLD.sent_on, OLD.claim_id, OLD.captured_at, OLD.claimed_at, OLD.membership_epoch,
      OLD.recipient_settings_version, OLD.delivery_settings_version, OLD.transport_source_revision,
      OLD.transport_approved_revision, OLD.channel) THEN
    RAISE EXCEPTION 'morning: claim identity and captured versions are immutable' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.attempt_started_at IS NOT NULL AND NEW.attempt_started_at IS DISTINCT FROM OLD.attempt_started_at THEN
    RAISE EXCEPTION 'morning: attempt_started_at is write-once' USING ERRCODE = 'P0001'; END IF;
  IF OLD.baseline_generation_id IS NOT NULL AND NEW.baseline_generation_id IS DISTINCT FROM OLD.baseline_generation_id THEN
    RAISE EXCEPTION 'morning: baseline is write-once' USING ERRCODE = 'P0001'; END IF;
  IF OLD.state <> 'claimed' AND (NEW.state <> OLD.state OR NEW.completed_at IS DISTINCT FROM OLD.completed_at) THEN
    RAISE EXCEPTION 'morning: a finished claim stays finished' USING ERRCODE = 'P0001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER morning_claim_guard BEFORE UPDATE ON morning_message_claim FOR EACH ROW EXECUTE FUNCTION morning_claim_guard();

-- 12. owner-issued, epoch-bound setup links
ALTER TABLE user_invite ADD COLUMN owner_issued boolean NOT NULL DEFAULT false,
  ADD COLUMN morning_membership_epoch bigint CHECK (morning_membership_epoch IS NULL OR morning_membership_epoch > 0),
  ADD CONSTRAINT user_invite_morning_provenance CHECK (owner_issued = (morning_membership_epoch IS NOT NULL));

-- 13. relationship closure edges (both directions, same org), §5.4 + plan decision 4
CREATE VIEW morning_relationship_edge AS
  WITH e(org_id, a, b) AS (
    SELECT org_id, credit_txn_id, charge_txn_id FROM application
    UNION ALL SELECT org_id, credit_txn_id, via_txn_id FROM application WHERE via_txn_id IS NOT NULL
    UNION ALL SELECT org_id, charge_txn_id, via_txn_id FROM application WHERE via_txn_id IS NOT NULL
    UNION ALL SELECT org_id, txn_id, source_txn_id FROM txn WHERE source_txn_id IS NOT NULL
    UNION ALL SELECT org_id, txn_id, deposit_for_txn_id FROM txn WHERE deposit_for_txn_id IS NOT NULL
    UNION ALL SELECT org_id, txn_id, reverses_txn_id FROM txn WHERE reverses_txn_id IS NOT NULL
    UNION ALL SELECT org_id, txn_id, companion_of_txn_id FROM txn WHERE companion_of_txn_id IS NOT NULL
    UNION ALL SELECT org_id, deposit_txn_id, source_txn_id FROM deposit_line WHERE source_txn_id IS NOT NULL
    UNION ALL SELECT org_id, txn_id, po_txn_id FROM txn_line WHERE po_txn_id IS NOT NULL
    UNION ALL SELECT org_id, txn_id, billable_txn_id FROM txn_line WHERE billable_txn_id IS NOT NULL
    UNION ALL SELECT org_id, txn_id, estimate_txn_id FROM txn_line WHERE estimate_txn_id IS NOT NULL)
  SELECT org_id, a, b FROM e WHERE a <> b
  UNION ALL SELECT org_id, b, a FROM e WHERE a <> b;

-- 14. indexes for the window, relationship and freshness reads (Task 0 determines indexes before acceptance; Task 21 rechecks before merge)
CREATE INDEX txn_morning_created ON txn (org_id, created_at);
CREATE INDEX txn_morning_updated ON txn (org_id, updated_at);
-- Measured Task 0 eligibility and relationship scans; no new persistent facts.
CREATE INDEX txn_morning_party ON txn (org_id, txn_id) WHERE customer_id IS NOT NULL OR vendor_id IS NOT NULL;
CREATE INDEX posting_morning_party ON posting (org_id, txn_id) INCLUDE (customer_id, vendor_id)
  WHERE customer_id IS NOT NULL OR vendor_id IS NOT NULL;
CREATE INDEX txn_morning_reverses ON txn (org_id, txn_id, reverses_txn_id) WHERE reverses_txn_id IS NOT NULL;
CREATE INDEX txn_morning_companion ON txn (org_id, txn_id, companion_of_txn_id) WHERE companion_of_txn_id IS NOT NULL;
CREATE INDEX txn_source ON txn (source_txn_id) WHERE source_txn_id IS NOT NULL;
CREATE INDEX deposit_line_source ON deposit_line (source_txn_id) WHERE source_txn_id IS NOT NULL;
CREATE INDEX deposit_line_deposit ON deposit_line (deposit_txn_id);
CREATE INDEX bank_feed_pull_ok ON bank_feed_pull (org_id, entity_id, finished_at DESC) WHERE status = 'ok';
CREATE INDEX bank_feed_item_morning ON bank_feed_item (org_id, entity_id, ll_account_id) WHERE review_state = 'new' OR attention IS NOT NULL;

-- 15. audit (audit_row casts its key column to bigint, migration 024: only tables with a bigint key are audited here;
--     the registry, preferences and transports record their own changed_at/updated_at and versions instead)
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON morning_company_setting FOR EACH ROW EXECUTE FUNCTION audit_row('entity_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON morning_delivery_setting FOR EACH ROW EXECUTE FUNCTION audit_row('org_id');
