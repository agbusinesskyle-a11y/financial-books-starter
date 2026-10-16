-- migrations/064_tax_books_t1.sql
-- Tax Books stage T1 (the Tax Books design, §13 T1; the design itself is not part of this starter): contracts only, no computation.
-- Every table is scoped by (org_id, entity_id) like the rest of the schema; nothing here ever touches posting/txn.

-- btree_gist gives the exclusion constraints (tax_return_one_period, activity_inclusion_one_owner) their bigint '=' operators. It is a
-- trusted extension, so the app role (scripts/create-app-role.js: CREATE on the database, not superuser) installs it like any other
-- statement of a migration.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- §4.1 Parties: who a return or a K-1 is about. A grantor trust reports on a person's return through grantor_reporting.
CREATE TABLE tax_party (
  org_id bigint NOT NULL REFERENCES org (org_id),
  party_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('individual', 'grantor_trust', 'trust', 'entity_in_org', 'entity_outside')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  entity_id bigint,
  tax_id_enc text,
  tax_id_last4 text CHECK (tax_id_last4 ~ '^[0-9]{4}$'),
  address jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT coalesce(nullif(current_setting('app.actor', true), ''), 'system'),
  UNIQUE (org_id, party_id),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id),
  CHECK ((kind = 'entity_in_org') = (entity_id IS NOT NULL))
);
CREATE UNIQUE INDEX tax_party_entity ON tax_party (org_id, entity_id) WHERE entity_id IS NOT NULL;

CREATE TABLE grantor_reporting (
  org_id bigint NOT NULL REFERENCES org (org_id),
  grantor_reporting_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trust_party_id bigint NOT NULL,
  owner_party_id bigint NOT NULL,
  share_num bigint NOT NULL CHECK (share_num > 0),
  share_den bigint NOT NULL CHECK (share_den > 0),
  effective_from date NOT NULL,
  effective_to date,
  method text NOT NULL CHECK (method IN ('optional_1', 'optional_2', 'optional_3', 'filing_1041')),
  evidence_note text,
  reviewed_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, trust_party_id) REFERENCES tax_party (org_id, party_id),
  FOREIGN KEY (org_id, owner_party_id) REFERENCES tax_party (org_id, party_id),
  CHECK (trust_party_id <> owner_party_id),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (share_num <= share_den)
);
CREATE INDEX grantor_reporting_trust ON grantor_reporting (org_id, trust_party_id);

-- The individuals on a household's joint return (taxpayer and spouse are two parties).
CREATE TABLE tax_household_member (
  org_id bigint NOT NULL REFERENCES org (org_id),
  entity_id bigint NOT NULL,
  party_id bigint NOT NULL,
  role text NOT NULL CHECK (role IN ('taxpayer', 'spouse')),
  effective_from date NOT NULL,
  effective_to date,
  PRIMARY KEY (org_id, entity_id, party_id, effective_from),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id),
  FOREIGN KEY (org_id, party_id) REFERENCES tax_party (org_id, party_id),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

-- §4.2 Company defaults for the NEXT period. A change of return_type or tax_method_default is reviewed: the data module
-- (lib/tax/periods.js, Task 8) requires change_reason with the change; the database records the reason, and the audit trigger the row.
CREATE TABLE tax_profile (
  org_id bigint NOT NULL REFERENCES org (org_id),
  entity_id bigint NOT NULL,
  return_type text NOT NULL DEFAULT 'none' CHECK (return_type IN ('none', 'form_1065', 'form_1120s', 'disregarded', 'household_1040')),
  activity_kind text CHECK (activity_kind IN ('trade', 'rental', 'farm', 'portfolio')),
  tax_method_default text NOT NULL DEFAULT 'cash' CHECK (tax_method_default IN ('cash', 'accrual')),
  book_basis_default text NOT NULL DEFAULT 'accrual' CHECK (book_basis_default IN ('cash', 'accrual')),
  year_end_month smallint NOT NULL DEFAULT 12 CHECK (year_end_month BETWEEN 1 AND 12),
  state_codes text[] NOT NULL DEFAULT '{}',
  business_code text CHECK (business_code ~ '^[0-9]{6}$'),
  date_started date,
  s_election_date date,
  accountant_may_edit boolean NOT NULL DEFAULT true,
  change_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, entity_id),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id),
  CHECK ((return_type = 'disregarded') = (activity_kind IS NOT NULL))
);

-- §4.3 One return period. Revisions arrive in T3 (the next tax migration). A period for an edition with no catalog computes nothing.
CREATE TABLE tax_return (
  org_id bigint NOT NULL REFERENCES org (org_id),
  return_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_id bigint NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  return_type text NOT NULL CHECK (return_type IN ('form_1065', 'form_1120s', 'disregarded', 'household_1040')),
  form_edition smallint NOT NULL CHECK (form_edition BETWEEN 2000 AND 2100),
  tax_method text NOT NULL CHECK (tax_method IN ('cash', 'accrual')),
  book_basis text NOT NULL CHECK (book_basis IN ('cash', 'accrual')),
  consolidation_policy text NOT NULL DEFAULT 'inclusion_edges' CHECK (consolidation_policy IN ('inclusion_edges', 'none')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'review', 'final', 'filed', 'amended')),
  -- §4.3 initial (first) period, Codex t1-r1 B8: a claim, not a checkbox. 'requested' is what someone asked for (the period may
  -- start mid-year, needs no predecessor, but its openings stay unknown); 'verified' is the reviewed first year, with who verified
  -- it and the evidence (formation documents), and only then are beginnings zero. tax_check_initial refuses obvious chronology
  -- conflicts. `initial` is derived from the status, so no code path can set the bare flag.
  initial_status text CHECK (initial_status IN ('requested', 'verified')),
  initial_verified_by text CHECK (length(initial_verified_by) BETWEEN 1 AND 200),
  initial_evidence text CHECK (length(initial_evidence) BETWEEN 1 AND 500),
  initial_verified_at timestamptz,
  initial boolean NOT NULL GENERATED ALWAYS AS (initial_status IS NOT NULL) STORED,
  final_return boolean NOT NULL DEFAULT false,
  -- Derived, never declared: with calendar-year ends (the checks below) a period is short exactly when it starts after January 1,
  -- which only an initial period may do (spec §2: the one supported short period). A later stage reading the flag gets the dates' answer.
  short_period boolean NOT NULL GENERATED ALWAYS AS (extract(month FROM period_start) <> 1 OR extract(day FROM period_start) <> 1) STORED,
  predecessor_baseline_id bigint,
  -- Where a period's openings come from, derived (spec §4.3, rule 0.2): zero only for a verified initial period; the predecessor
  -- baseline where one is chosen; otherwise unknown — a requested initial period and a reconstructed first Tax Books period alike.
  opening_state text NOT NULL GENERATED ALWAYS AS (CASE WHEN initial_status = 'verified' THEN 'zero' WHEN predecessor_baseline_id IS NOT NULL THEN 'baseline' ELSE 'unknown' END) STORED,
  -- §4.3: a predecessor on the other book basis is a reviewed exception, recorded here (why, and who accepted it) or refused
  -- by tax_check_predecessor; it is never implied.
  predecessor_basis_exception_reason text CHECK (length(predecessor_basis_exception_reason) BETWEEN 1 AND 500),
  predecessor_basis_exception_by text CHECK (length(predecessor_basis_exception_by) BETWEEN 1 AND 200),
  -- The same for a predecessor on another consolidation policy (a standalone balance sheet seeding a period that includes child
  -- books, or the reverse): a reviewed exception recorded here, or refused by tax_check_predecessor.
  predecessor_consolidation_exception_reason text CHECK (length(predecessor_consolidation_exception_reason) BETWEEN 1 AND 500),
  predecessor_consolidation_exception_by text CHECK (length(predecessor_consolidation_exception_by) BETWEEN 1 AND 200),
  filing_status text CHECK (filing_status IN ('single', 'mfj', 'mfs', 'hoh')),
  dependents_count smallint CHECK (dependents_count >= 0),
  dependents_enc text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, return_id),
  UNIQUE (org_id, entity_id, period_start, period_end, return_type),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id),
  CHECK (period_end > period_start),
  -- The basis exception is a reason and a reviewer together, and only where there is a predecessor to except.
  CHECK ((predecessor_basis_exception_reason IS NULL) = (predecessor_basis_exception_by IS NULL)),
  CHECK (predecessor_baseline_id IS NOT NULL OR predecessor_basis_exception_reason IS NULL),
  CHECK ((predecessor_consolidation_exception_reason IS NULL) = (predecessor_consolidation_exception_by IS NULL)),
  CHECK (predecessor_baseline_id IS NOT NULL OR predecessor_consolidation_exception_reason IS NULL),
  -- v1: calendar years only; the initial period may start later in the year (spec §2, §4.3).
  CHECK (extract(month FROM period_end) = 12 AND extract(day FROM period_end) = 31),
  CHECK (initial_status IS NOT NULL OR (extract(month FROM period_start) = 1 AND extract(day FROM period_start) = 1)),
  -- Verified means a reviewer and the evidence, together; nothing else carries them. A first year has no predecessor.
  CHECK ((initial_status IS NOT DISTINCT FROM 'verified') = (initial_verified_by IS NOT NULL AND initial_evidence IS NOT NULL)),
  CHECK ((initial_verified_by IS NULL) = (initial_evidence IS NULL)),
  CHECK (initial_status IS NULL OR predecessor_baseline_id IS NULL),
  -- The household columns belong to a household return only.
  CHECK ((return_type = 'household_1040') OR (filing_status IS NULL AND dependents_count IS NULL AND dependents_enc IS NULL)),
  -- §2: in v1 exactly one period covers any date for a company. The natural key above (spec §4.3) only refuses a duplicate; this
  -- refuses a second return type for the same dates and an initial mid-year period inside a full year, race-free at commit.
  -- tax_check_return_inclusions still speaks first, with the reason, when the two periods disagree on being disregarded.
  CONSTRAINT tax_return_one_period EXCLUDE USING gist (org_id WITH =, entity_id WITH =, daterange(period_start, period_end, '[]') WITH &&)
);

-- §4.3 Baselines: the predecessor of a period's openings, with identity and a versioned payload (baseline_fact).
CREATE TABLE tax_baseline (
  org_id bigint NOT NULL REFERENCES org (org_id),
  baseline_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_id bigint NOT NULL,
  source_period_start date NOT NULL,
  source_period_end date NOT NULL,
  return_type text NOT NULL CHECK (return_type IN ('form_1065', 'form_1120s', 'disregarded', 'household_1040')),
  form_edition smallint NOT NULL CHECK (form_edition BETWEEN 2000 AND 2100),
  book_basis text NOT NULL CHECK (book_basis IN ('cash', 'accrual')),
  -- Declared by the payload, never defaulted (§0 rule 2): whether the filed balance sheet includes child books (inclusion_edges)
  -- or stands alone (none). Part of the baseline's content, compared on re-import and against the period it precedes.
  consolidation_policy text NOT NULL CHECK (consolidation_policy IN ('inclusion_edges', 'none')),
  kind text NOT NULL CHECK (kind IN ('imported_filed', 'final_revision', 'corrected')),
  source_revision_id bigint,             -- FK added in T3 when tax_return_revision exists
  supersedes_baseline_id bigint,
  source_document_hash text,
  source_document_pages text,
  extraction_status text NOT NULL DEFAULT 'raw' CHECK (extraction_status IN ('raw', 'verified', 'approved')),
  payload_version integer NOT NULL DEFAULT 1 CHECK (payload_version >= 1),
  import_key text NOT NULL,              -- natural key of the import run: idempotent re-import
  reviewed_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, baseline_id),
  UNIQUE (org_id, entity_id, baseline_id),
  -- One payload version per baseline row. An import is idempotent by (entity, import_key, payload_version): the same payload
  -- again creates nothing new, and a new version of it (a corrected payload) is a NEW baseline row, never a second version
  -- under the old one. baseline_fact's key below ties every fact to its baseline's version, so payload_version has one home.
  CONSTRAINT tax_baseline_import_identity UNIQUE (org_id, entity_id, import_key, payload_version),
  CONSTRAINT tax_baseline_payload_version UNIQUE (org_id, baseline_id, payload_version),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id),
  -- §11: a corrected baseline supersedes only a baseline of the same company. The key carries entity_id (as 063_loans.sql
  -- does for loan pairs), so the database refuses a cross-company supersedes without a trigger.
  CONSTRAINT tax_baseline_supersedes_same_company FOREIGN KEY (org_id, entity_id, supersedes_baseline_id) REFERENCES tax_baseline (org_id, entity_id, baseline_id),
  CHECK (source_period_end > source_period_start),
  CHECK ((kind = 'corrected') = (supersedes_baseline_id IS NOT NULL)),
  CHECK ((kind = 'final_revision') = (source_revision_id IS NOT NULL)),
  CHECK (supersedes_baseline_id IS DISTINCT FROM baseline_id)
);
ALTER TABLE tax_return ADD CONSTRAINT tax_return_predecessor FOREIGN KEY (org_id, predecessor_baseline_id) REFERENCES tax_baseline (org_id, baseline_id);

CREATE TABLE baseline_fact (
  org_id bigint NOT NULL REFERENCES org (org_id),
  fact_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  baseline_id bigint NOT NULL,
  payload_version integer NOT NULL,
  fact_kind text NOT NULL CHECK (fact_kind IN ('schedule_l_end', 'tax_capital', 'outside_basis', 'stock_basis', 'debt_basis', 'liability', 'aaa', 'oaa', 'pti', 'ae_p',
    'suspended_loss', 'carryforward', 'asset', 'k1_item', 'form_line')),
  field_id text,
  -- Part of the fact identity (the unique index below): the importer says which measurement a fact is; there is no default.
  measurement text NOT NULL CHECK (measurement IN ('activity', 'begin', 'end')),
  effective_on date NOT NULL,
  party_key text, interest_key text, activity_key text, loan_key text, asset_key text,
  -- A statement row's stable key (spec §4.7 statement_row): one filed field with several statement rows (199A detail, K line
  -- 20c items) keeps each row as its own fact.
  row_key text,
  amount_cents bigint,
  state text NOT NULL CHECK (state IN ('known', 'unknown', 'not_applicable')),
  provenance jsonb NOT NULL DEFAULT '{}',
  review_status text NOT NULL DEFAULT 'raw' CHECK (review_status IN ('raw', 'verified', 'approved')),
  approved_by text,
  UNIQUE (org_id, fact_id),
  -- A fact's payload_version is its baseline's (tax_baseline_payload_version): the two columns can never disagree, and the
  -- promotion identity (baseline_id, payload_version, fact identity) of §4.3 names exactly one baseline row.
  CONSTRAINT baseline_fact_payload_version FOREIGN KEY (org_id, baseline_id, payload_version) REFERENCES tax_baseline (org_id, baseline_id, payload_version),
  CHECK ((state = 'known') = (amount_cents IS NOT NULL))
);
-- One fact per identity per payload version. A unique index, not a table constraint: the identity keys are nullable, and
-- only an index accepts the coalesce() expressions that make two NULL keys count as the same identity.
CREATE UNIQUE INDEX baseline_fact_identity ON baseline_fact (org_id, baseline_id, payload_version, fact_kind, coalesce(field_id, ''), measurement, coalesce(party_key, ''), coalesce(interest_key, ''), coalesce(activity_key, ''), coalesce(loan_key, ''), coalesce(asset_key, ''), coalesce(row_key, ''));

-- §4.3 Opening bridge: a baseline fact (a filed form-line aggregate) allocated to the current books' accounts, reviewed.
CREATE TABLE opening_bridge (
  org_id bigint NOT NULL REFERENCES org (org_id),
  bridge_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  return_id bigint NOT NULL,
  fact_id bigint NOT NULL,
  account_id bigint NOT NULL,
  allocated_cents bigint NOT NULL,
  books_cents bigint,
  explanation text,
  approved_by text,
  UNIQUE (org_id, return_id, fact_id, account_id),
  FOREIGN KEY (org_id, return_id) REFERENCES tax_return (org_id, return_id),
  FOREIGN KEY (org_id, fact_id) REFERENCES baseline_fact (org_id, fact_id),
  FOREIGN KEY (org_id, account_id) REFERENCES account (org_id, account_id)
);

-- §4.4 Activities and the inclusion edge (the only way another company's books enter a return).
CREATE TABLE tax_activity (
  org_id bigint NOT NULL REFERENCES org (org_id),
  activity_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  return_entity_id bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('trade', 'rental', 'farm', 'portfolio', 'holding')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  schedule text NOT NULL CHECK (schedule IN ('p1', 'sch_c', 'sch_e1', 'sch_f', 'f8825', 'none')),
  property jsonb,
  effective_from date NOT NULL,
  effective_to date,
  disposed_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, activity_id),
  FOREIGN KEY (org_id, return_entity_id) REFERENCES entity (org_id, entity_id),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE TABLE activity_inclusion (
  org_id bigint NOT NULL REFERENCES org (org_id),
  inclusion_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  return_id bigint NOT NULL,
  activity_id bigint NOT NULL,
  source_entity_id bigint NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  source_book_basis text NOT NULL CHECK (source_book_basis IN ('cash', 'accrual')),
  consolidated_in_parent boolean NOT NULL DEFAULT false,
  coverage jsonb NOT NULL DEFAULT '{}',
  approved_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, inclusion_id),
  FOREIGN KEY (org_id, return_id) REFERENCES tax_return (org_id, return_id),
  FOREIGN KEY (org_id, activity_id) REFERENCES tax_activity (org_id, activity_id),
  FOREIGN KEY (org_id, source_entity_id) REFERENCES entity (org_id, entity_id),
  -- One income-tax owner per source company per period; a source is never included twice (§4.4). Overlap, not equal dates: an
  -- initial period may start mid-year (§2), and a 2025 return and another company's initial 2025-06-01.. return that both
  -- included one child would put the child's books in two returns. An exclusion constraint refuses that at commit, race-free.
  CONSTRAINT activity_inclusion_one_owner EXCLUDE USING gist (org_id WITH =, source_entity_id WITH =, daterange(period_start, period_end, '[]') WITH &&)
);

CREATE TABLE activity_treatment (
  org_id bigint NOT NULL REFERENCES org (org_id),
  treatment_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  activity_id bigint NOT NULL,
  recipient_party_id bigint NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  participation text NOT NULL DEFAULT 'unknown' CHECK (participation IN ('material', 'passive', 'unknown')),
  grouping text,
  special_treatment text,
  reviewed_by text,
  UNIQUE (org_id, activity_id, recipient_party_id, period_start, period_end),
  FOREIGN KEY (org_id, activity_id) REFERENCES tax_activity (org_id, activity_id),
  FOREIGN KEY (org_id, recipient_party_id) REFERENCES tax_party (org_id, party_id)
);

-- §4.7 Exactly one provider per input slot of a return.
CREATE TABLE tax_provider_assignment (
  org_id bigint NOT NULL REFERENCES org (org_id),
  assignment_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  return_id bigint NOT NULL,
  slot_key text NOT NULL CHECK (length(slot_key) BETWEEN 3 AND 400),
  provider_kind text NOT NULL CHECK (provider_kind IN ('books', 'manual', 'asset_register', 'k1_record', 'cogs_workpaper', 'cash_layer')),
  -- Supported provider envelope versions (lib/tax/providers.js SUPPORTED_SCHEMA_VERSIONS); a new version adds itself here.
  provider_schema_version integer NOT NULL CHECK (provider_schema_version IN (1)),
  source_ref jsonb NOT NULL DEFAULT '{}',
  -- Every assignment names the immutable source version it came from (Codex t1-r1 B3); canonical form is checked in code.
  source_version text NOT NULL CHECK (length(source_version) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, return_id, slot_key),
  FOREIGN KEY (org_id, return_id) REFERENCES tax_return (org_id, return_id)
);

-- Scope triggers (spec §11, §4.4): an inclusion's return and activity belong to the same return entity; an inclusion never
-- includes the return's own books; the source must be disregarded for THAT period, so a K-1 payer is never included; a
-- recursive walk over the existing edges refuses one that would close a cycle; an opening bridge's account belongs to the
-- return's entity and its fact to the period's predecessor baseline.
-- Concurrency (Codex t1-r1 B10): each trigger sees only committed edges, so two transactions could each add half of a loop (A→B
-- and B→A, or B→C and D→A over A→B and C→D) and both commit; the parents' company locks do not conflict. Every inclusion write
-- therefore first takes ONE transaction-scoped advisory lock per organization (key 74120062 with the org's hash), held to commit,
-- and only then reads the graph: in READ COMMITTED each statement after the wait takes a fresh snapshot and sees the edge the
-- other transaction committed. A REPEATABLE READ transaction keeps an older snapshot, so the check could miss that edge; graph
-- changes are refused there (SERIALIZABLE is left to its own conflict detection).
CREATE FUNCTION tax_check_inclusion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; a record;
BEGIN
  IF current_setting('transaction_isolation') = 'repeatable read'
    THEN RAISE EXCEPTION 'activity_inclusion: change inclusion edges in a READ COMMITTED (or SERIALIZABLE) transaction; a REPEATABLE READ snapshot cannot see a concurrent edge'; END IF;
  PERFORM pg_advisory_xact_lock(74120062, hashint8(NEW.org_id));
  SELECT entity_id, period_start, period_end INTO r FROM tax_return WHERE org_id = NEW.org_id AND return_id = NEW.return_id;
  SELECT return_entity_id INTO a FROM tax_activity WHERE org_id = NEW.org_id AND activity_id = NEW.activity_id;
  IF a.return_entity_id <> r.entity_id THEN RAISE EXCEPTION 'activity_inclusion: activity belongs to another company''s return'; END IF;
  IF NEW.source_entity_id = r.entity_id THEN RAISE EXCEPTION 'activity_inclusion: a return cannot include its own books'; END IF;
  IF NEW.period_start <> r.period_start OR NEW.period_end <> r.period_end THEN RAISE EXCEPTION 'activity_inclusion: period must match the return period'; END IF;
  -- Periods, not profiles (§0 rule 3): only the source's own return periods decide. Any return of the source for an overlapping
  -- period that is not 'disregarded' makes it a K-1 payer for that period, and the source must have a 'disregarded' return for
  -- an overlapping period (overlap, not equality, because an initial period may start mid-year). tax_profile is defaults for
  -- the NEXT period (§4.2) and says nothing about this one; missing is never a permissive default (§0 rule 2).
  -- tax_check_return_inclusions below keeps both facts true from the tax_return side while the inclusion stands.
  IF EXISTS (SELECT 1 FROM tax_return s WHERE s.org_id = NEW.org_id AND s.entity_id = NEW.source_entity_id
               AND s.period_start <= NEW.period_end AND s.period_end >= NEW.period_start AND s.return_type <> 'disregarded')
    THEN RAISE EXCEPTION 'activity_inclusion: only a disregarded company can be included; the source files its own return for this period'; END IF;
  IF NOT EXISTS (SELECT 1 FROM tax_return s WHERE s.org_id = NEW.org_id AND s.entity_id = NEW.source_entity_id
                   AND s.period_start <= NEW.period_end AND s.period_end >= NEW.period_start AND s.return_type = 'disregarded')
    THEN RAISE EXCEPTION 'activity_inclusion: only a disregarded company can be included; the source has no disregarded return period covering this period (a profile is not evidence)'; END IF;
  -- No cycles (§4.4): walk the inclusion edges downward from the source over overlapping periods (UNION keeps the walk
  -- finite); reaching this return's entity means the new edge would close a loop. The row being updated is left out.
  IF EXISTS (
    WITH RECURSIVE reach (entity_id) AS (
      SELECT NEW.source_entity_id
      UNION
      SELECT i.source_entity_id FROM reach x
        JOIN tax_return t ON t.org_id = NEW.org_id AND t.entity_id = x.entity_id
        JOIN activity_inclusion i ON i.org_id = t.org_id AND i.return_id = t.return_id AND i.inclusion_id <> NEW.inclusion_id
       WHERE i.period_start <= NEW.period_end AND i.period_end >= NEW.period_start)
    SELECT 1 FROM reach WHERE entity_id = r.entity_id)
    THEN RAISE EXCEPTION 'activity_inclusion: this inclusion would form a cycle (the source already includes the return''s company for this period)'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER activity_inclusion_scope BEFORE INSERT OR UPDATE ON activity_inclusion FOR EACH ROW EXECUTE FUNCTION tax_check_inclusion();

-- The bridge is not one of the cross-company references §11 allows: the account AND the fact's baseline are the return's company.
-- And the bridge allocates the predecessor's facts, nothing else (§4.3): a period without a predecessor (an initial period, or a
-- reconstructed one whose openings stay unknown) has nothing to bridge, and a fact of another baseline of the same company (a
-- superseded import, another year) is not this period's opening.
-- Which facts are account openings (Codex t1-r1 B7): a Schedule L balance (fact_kind schedule_l_end) measured at the END of the
-- predecessor's period and effective on its last day. A beginning column, a mid-year figure, or a per-interest/K-1 fact is never
-- an account opening. An approved row (approved_by set) needs a fact whose own review is done (verified or approved); a draft row
-- may reference a raw fact, and the fact's review and the allocation's approval stay two separate acts.
CREATE FUNCTION tax_check_bridge() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; a_entity bigint; fb record;
BEGIN
  SELECT entity_id, predecessor_baseline_id INTO r FROM tax_return WHERE org_id = NEW.org_id AND return_id = NEW.return_id;
  SELECT entity_id INTO a_entity FROM account WHERE org_id = NEW.org_id AND account_id = NEW.account_id;
  SELECT bf.baseline_id, b.entity_id, bf.fact_kind, bf.measurement, bf.effective_on, bf.review_status, b.source_period_end INTO fb
    FROM baseline_fact bf JOIN tax_baseline b ON b.org_id = bf.org_id AND b.baseline_id = bf.baseline_id
   WHERE bf.org_id = NEW.org_id AND bf.fact_id = NEW.fact_id;
  IF a_entity <> r.entity_id THEN RAISE EXCEPTION 'opening_bridge: account belongs to another company'; END IF;
  IF fb.entity_id <> r.entity_id THEN RAISE EXCEPTION 'opening_bridge: the fact''s baseline belongs to another company'; END IF;
  IF r.predecessor_baseline_id IS NULL OR r.predecessor_baseline_id <> fb.baseline_id
    THEN RAISE EXCEPTION 'opening_bridge: the fact must belong to the period''s predecessor baseline'; END IF;
  IF fb.fact_kind <> 'schedule_l_end' THEN RAISE EXCEPTION 'opening_bridge: only a Schedule L balance (schedule_l_end) is an account opening, not %', fb.fact_kind; END IF;
  IF fb.measurement <> 'end' THEN RAISE EXCEPTION 'opening_bridge: an opening is the predecessor''s end-of-period balance, not its % measurement', fb.measurement; END IF;
  IF fb.effective_on <> fb.source_period_end
    THEN RAISE EXCEPTION 'opening_bridge: the fact is effective %, not on the predecessor''s end (%)', fb.effective_on, fb.source_period_end; END IF;
  IF NEW.approved_by IS NOT NULL AND fb.review_status NOT IN ('verified', 'approved')
    THEN RAISE EXCEPTION 'opening_bridge: an approved allocation needs a verified fact; this fact is %', fb.review_status; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER opening_bridge_scope BEFORE INSERT OR UPDATE ON opening_bridge FOR EACH ROW EXECUTE FUNCTION tax_check_bridge();

-- The other side of that ordering: a fact's review is not withdrawn while an approved allocation stands on it.
CREATE FUNCTION tax_check_fact_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.review_status NOT IN ('verified', 'approved') AND OLD.review_status IN ('verified', 'approved')
     AND EXISTS (SELECT 1 FROM opening_bridge ob WHERE ob.org_id = OLD.org_id AND ob.fact_id = OLD.fact_id AND ob.approved_by IS NOT NULL)
    THEN RAISE EXCEPTION 'baseline_fact: an approved opening bridge allocates this fact; withdraw that approval before its review'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER baseline_fact_review_check BEFORE UPDATE ON baseline_fact FOR EACH ROW EXECUTE FUNCTION tax_check_fact_review();

-- A predecessor baseline must be the same company, the same return type, end the day before the period starts, and be on the
-- period's book basis and consolidation policy (§4.3) — or each exception is reviewed and recorded on the period (reason and who), and only then. Once
-- opening bridges allocate its facts (tax_check_bridge), the predecessor is neither changed nor cleared while they stand.
CREATE FUNCTION tax_check_predecessor() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.predecessor_baseline_id IS DISTINCT FROM OLD.predecessor_baseline_id
     AND EXISTS (SELECT 1 FROM opening_bridge ob WHERE ob.org_id = OLD.org_id AND ob.return_id = OLD.return_id)
    THEN RAISE EXCEPTION 'tax_return: remove the opening bridges before changing the predecessor'; END IF;
  IF NEW.predecessor_baseline_id IS NULL THEN RETURN NEW; END IF;
  SELECT entity_id, return_type, source_period_end, book_basis, consolidation_policy INTO b FROM tax_baseline WHERE org_id = NEW.org_id AND baseline_id = NEW.predecessor_baseline_id;
  IF b.entity_id <> NEW.entity_id THEN RAISE EXCEPTION 'tax_return: predecessor baseline belongs to another company'; END IF;
  IF b.return_type <> NEW.return_type THEN RAISE EXCEPTION 'tax_return: predecessor baseline is for another return type'; END IF;
  IF b.source_period_end <> NEW.period_start - 1 THEN RAISE EXCEPTION 'tax_return: predecessor baseline must end the day before the period starts'; END IF;
  IF b.book_basis <> NEW.book_basis AND NEW.predecessor_basis_exception_reason IS NULL
    THEN RAISE EXCEPTION 'tax_return: predecessor baseline is on the % basis and this period on the % basis; record the reviewed exception or choose a compatible predecessor', b.book_basis, NEW.book_basis; END IF;
  IF b.book_basis = NEW.book_basis AND NEW.predecessor_basis_exception_reason IS NOT NULL
    THEN RAISE EXCEPTION 'tax_return: a predecessor basis exception is recorded but the bases match'; END IF;
  -- The consolidation policy is checked the same way (Codex t1-r1 B7): a standalone balance sheet never silently seeds a period
  -- that includes child books, nor a consolidated one a standalone period.
  IF b.consolidation_policy <> NEW.consolidation_policy AND NEW.predecessor_consolidation_exception_reason IS NULL
    THEN RAISE EXCEPTION 'tax_return: predecessor baseline has consolidation policy % and this period %; record the reviewed exception or choose a compatible predecessor', b.consolidation_policy, NEW.consolidation_policy; END IF;
  IF b.consolidation_policy = NEW.consolidation_policy AND NEW.predecessor_consolidation_exception_reason IS NOT NULL
    THEN RAISE EXCEPTION 'tax_return: a predecessor consolidation exception is recorded but the policies match'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tax_return_predecessor_check BEFORE INSERT OR UPDATE ON tax_return FOR EACH ROW EXECUTE FUNCTION tax_check_predecessor();

-- An initial period is the company's first (Codex t1-r1 B8, t1-r2 B8): refused when an earlier period of the company is on file,
-- or when the profile's date_started is not the period's first day (any earlier inception makes the year a reconstruction, whose
-- openings stay unknown); a VERIFIED initial period also needs date_started recorded. And no period is
-- opened before a company's initial period. Checked when a period is written with new dates, company or initial status, so a
-- later profile edit does not lock unrelated updates (status changes) of an existing period.
CREATE FUNCTION tax_check_initial() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s record; started date;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.entity_id, NEW.period_start, NEW.period_end, NEW.initial_status) IS NOT DISTINCT FROM (OLD.entity_id, OLD.period_start, OLD.period_end, OLD.initial_status)
    THEN RETURN NEW; END IF;
  IF NEW.initial_status IS NOT NULL THEN
    SELECT period_start, period_end INTO s FROM tax_return WHERE org_id = NEW.org_id AND entity_id = NEW.entity_id AND return_id <> NEW.return_id AND period_end < NEW.period_start
     ORDER BY period_end LIMIT 1;
    IF FOUND THEN RAISE EXCEPTION 'tax_return: an initial period is the company''s first, but an earlier period (% to %) is on file', s.period_start, s.period_end; END IF;
    SELECT date_started INTO started FROM tax_profile WHERE org_id = NEW.org_id AND entity_id = NEW.entity_id;
    IF started IS NOT NULL AND started <> NEW.period_start
      THEN RAISE EXCEPTION 'tax_return: the company started on %, but this first period starts %; an initial return starts the day the company started (a reconstructed first Tax Books period keeps unknown openings)',
        started, NEW.period_start; END IF;
    IF NEW.initial_status = 'verified' AND started IS NULL
      THEN RAISE EXCEPTION 'tax_return: a verified initial period needs the company''s start date on its tax profile'; END IF;
  END IF;
  SELECT period_start INTO s FROM tax_return WHERE org_id = NEW.org_id AND entity_id = NEW.entity_id AND return_id <> NEW.return_id AND initial_status IS NOT NULL AND period_start > NEW.period_end LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'tax_return: the company''s initial period starts %; no period comes before it', s.period_start; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tax_return_initial_check BEFORE INSERT OR UPDATE ON tax_return FOR EACH ROW EXECUTE FUNCTION tax_check_initial();

-- The inclusion rules hold from the tax_return side too, so writing a period cannot undo what tax_check_inclusion verified
-- (§0 rule 3, §4.4): a company whose books are included in another return cannot get, or be changed to, a return that files
-- for an overlapping period (a K-1 payer is never included, in either order); the disregarded period that is the evidence for
-- an inclusion keeps its company, dates and type and is not deleted while the inclusion stands; a period that owns inclusions
-- keeps its company and dates (the edges' "period must match" and "activity belongs to the return entity" were checked against
-- them); and a company is disregarded or files its own return for a period, never both (tax_return_one_period refuses every
-- overlapping period; this BEFORE trigger runs first and names the reason when the two disagree on being disregarded). Remove
-- the inclusion first, and the change is an ordinary one.
CREATE FUNCTION tax_check_return_inclusions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE evidence boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    evidence := OLD.return_type = 'disregarded' AND EXISTS (SELECT 1 FROM activity_inclusion i WHERE i.org_id = OLD.org_id AND i.source_entity_id = OLD.entity_id
                  AND i.period_start <= OLD.period_end AND i.period_end >= OLD.period_start);
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF evidence THEN RAISE EXCEPTION 'tax_return: this disregarded period is the evidence for including the company''s books in another return; remove that inclusion first'; END IF;
    RETURN OLD;
  END IF;
  IF NEW.return_type <> 'disregarded' AND EXISTS (SELECT 1 FROM activity_inclusion i WHERE i.org_id = NEW.org_id AND i.source_entity_id = NEW.entity_id
                                                   AND i.period_start <= NEW.period_end AND i.period_end >= NEW.period_start)
    THEN RAISE EXCEPTION 'tax_return: this company''s books are included in another return for this period, so it cannot file its own return (a K-1 payer is never included)'; END IF;
  IF evidence AND (NEW.entity_id, NEW.period_start, NEW.period_end, NEW.return_type) IS DISTINCT FROM (OLD.entity_id, OLD.period_start, OLD.period_end, OLD.return_type)
    THEN RAISE EXCEPTION 'tax_return: this disregarded period is the evidence for including the company''s books in another return; remove that inclusion first'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.entity_id, NEW.period_start, NEW.period_end) IS DISTINCT FROM (OLD.entity_id, OLD.period_start, OLD.period_end)
     AND EXISTS (SELECT 1 FROM activity_inclusion i WHERE i.org_id = OLD.org_id AND i.return_id = OLD.return_id)
    THEN RAISE EXCEPTION 'tax_return: the company and dates of a period that includes other companies'' books cannot change; remove the inclusions first'; END IF;
  IF EXISTS (SELECT 1 FROM tax_return s WHERE s.org_id = NEW.org_id AND s.entity_id = NEW.entity_id AND s.return_id <> NEW.return_id
               AND s.period_start <= NEW.period_end AND s.period_end >= NEW.period_start AND (s.return_type = 'disregarded') <> (NEW.return_type = 'disregarded'))
    THEN RAISE EXCEPTION 'tax_return: a company is disregarded or files its own return for a period, never both; an overlapping % period exists',
      CASE WHEN NEW.return_type = 'disregarded' THEN 'filing' ELSE 'disregarded' END; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tax_return_inclusion_check BEFORE INSERT OR UPDATE OR DELETE ON tax_return FOR EACH ROW EXECUTE FUNCTION tax_check_return_inclusions();

-- §4.1, Codex t1-r1 B9: the people on a household return and the owners a grantor trust reports to are individual parties (a
-- company or another trust is neither), and a party keeps its 'individual' kind while it is either.
CREATE FUNCTION tax_check_individual() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pid bigint; k text;
BEGIN
  IF TG_TABLE_NAME = 'grantor_reporting' THEN pid := NEW.owner_party_id; ELSE pid := NEW.party_id; END IF;
  SELECT kind INTO k FROM tax_party WHERE org_id = NEW.org_id AND party_id = pid;
  IF k IS DISTINCT FROM 'individual' THEN RAISE EXCEPTION '%: party % is a %, not an individual', TG_TABLE_NAME, pid, coalesce(k, 'missing party'); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tax_household_member_individual BEFORE INSERT OR UPDATE ON tax_household_member FOR EACH ROW EXECUTE FUNCTION tax_check_individual();
CREATE TRIGGER grantor_reporting_individual BEFORE INSERT OR UPDATE ON grantor_reporting FOR EACH ROW EXECUTE FUNCTION tax_check_individual();
CREATE FUNCTION tax_check_party_kind() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.kind = 'individual' AND NEW.kind <> 'individual'
     AND (EXISTS (SELECT 1 FROM tax_household_member m WHERE m.org_id = OLD.org_id AND m.party_id = OLD.party_id)
          OR EXISTS (SELECT 1 FROM grantor_reporting g WHERE g.org_id = OLD.org_id AND g.owner_party_id = OLD.party_id))
    THEN RAISE EXCEPTION 'tax_party: this party is a household member or grantor owner, so it stays an individual'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tax_party_kind_check BEFORE UPDATE ON tax_party FOR EACH ROW EXECUTE FUNCTION tax_check_party_kind();

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON tax_party FOR EACH ROW EXECUTE FUNCTION audit_row('party_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON grantor_reporting FOR EACH ROW EXECUTE FUNCTION audit_row('grantor_reporting_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON tax_household_member FOR EACH ROW EXECUTE FUNCTION audit_row('party_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON tax_profile FOR EACH ROW EXECUTE FUNCTION audit_row('entity_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON tax_return FOR EACH ROW EXECUTE FUNCTION audit_row('return_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON tax_baseline FOR EACH ROW EXECUTE FUNCTION audit_row('baseline_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON baseline_fact FOR EACH ROW EXECUTE FUNCTION audit_row('fact_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON opening_bridge FOR EACH ROW EXECUTE FUNCTION audit_row('bridge_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON tax_activity FOR EACH ROW EXECUTE FUNCTION audit_row('activity_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON activity_inclusion FOR EACH ROW EXECUTE FUNCTION audit_row('inclusion_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON activity_treatment FOR EACH ROW EXECUTE FUNCTION audit_row('treatment_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON tax_provider_assignment FOR EACH ROW EXECUTE FUNCTION audit_row('assignment_id');
