-- migrations/065_tax_books_t2.sql
-- Tax Books stage T2 (the Tax Books design, §4.5, §7, §13 T2, §13.1 T2; the design itself is not part of this starter): source bindings —
-- where one measurement (activity, beginning or ending balance) of one book account is ROUTED on a return. A binding is routing, not
-- authority: which provider's result is the tax amount of a slot is decided by tax_provider_assignment (T1) or, without a row, by the
-- default authority of lib/tax/authority.js; a binding keeps its routing when another provider takes the slot (cash layer, COGS
-- workpaper, a reviewed manual value) and then serves as that provider's input or as comparison evidence (Codex t2-plan-r1 B1).
-- Tax Books never writes to the ledger: nothing here references a posting row or blocks a ledger write; a changed source shows stale.
-- Invariants the DATABASE guarantees: company and organization scope, the inclusion path of included books, one row per target in a
-- set, the shape of a set (whole once, or all shares totalling exactly 1, or all amounts, two or more rows), the binding of every
-- inclusion edge a binding depends on, and the serialization of graph changes with binding writes: every binding or attribution write and
-- every inclusion-edge change takes the organization's inclusion-graph lock (advisory key 74120062, T1 migration 064) and re-reads the
-- graph under it (Codex t2-plan-r2 B5). Invariants the APPLICATION guarantees (lib/tax/bindings.js, under the locks it takes): dollar
-- amounts totalling the residual of their partition version, canonical slot keys, catalog validity, references and their versions.

-- The treatments of spec §4.5, plus cogs_tieout: the book cost of goods sold shown beside the computed COGS line (comparison only;
-- book COGS is never purchases, spec §4.10).
CREATE DOMAIN tax_treatment AS text CHECK (VALUE IN ('input', 'statement_row', 'equity_event', 'guaranteed_payment', 'cogs_input', 'cogs_tieout', 'not_tax', 'k1_booked', 'manual_feed'));
-- Which treatments name a catalog slot (and may carry a slot key).
CREATE FUNCTION tax_treatment_has_slot(p_treatment text) RETURNS boolean IMMUTABLE LANGUAGE sql AS $$
  SELECT p_treatment IN ('input', 'statement_row', 'cogs_input', 'manual_feed')
$$;

-- The effective inclusion graph of one return (spec §4.4, Codex t2-plan-r1 B4): the return's direct inclusion edges and, through each
-- included company's own disregarded period, that company's edges, recursively (T1 refuses cycles and gives each source one income-tax
-- owner per period, so a source appears once). path: the inclusion ids from the return down to the source; entities: the companies on
-- the way (access is checked for every one); top_activity_id: the activity of the return the books join; period_matches: every edge
-- on the path covers exactly the return's period (a nested edge on a part-year disregarded period does not, and blocks). A direct child
-- is always included for the return's whole period (T1 includeBooks dates the edge to the return), whatever its own disregarded period:
-- a company formed mid-year simply has no postings before it started, and no other return owns its earlier months (T1 refuses a
-- non-disregarded overlapping period). Any depth (Codex t2-plan-r2 B4): the walk stops only where an edge is already on the path, which an
-- acyclic graph (T1) never reaches; nothing is cut off silently.
CREATE FUNCTION tax_inclusion_sources(p_org bigint, p_return bigint)
RETURNS TABLE (source_entity_id bigint, path bigint[], entities bigint[], top_activity_id bigint, source_book_basis text, period_matches boolean)
STABLE LANGUAGE sql AS $$
  WITH RECURSIVE ret AS (SELECT period_start, period_end FROM tax_return WHERE org_id = p_org AND return_id = p_return),
  g AS (
    SELECT i.source_entity_id, ARRAY[i.inclusion_id] AS path, ARRAY[i.source_entity_id] AS entities, i.activity_id AS top_activity_id, i.source_book_basis,
           (i.period_start = ret.period_start AND i.period_end = ret.period_end) AS period_matches
      FROM activity_inclusion i, ret WHERE i.org_id = p_org AND i.return_id = p_return
    UNION ALL
    SELECT j.source_entity_id, g.path || j.inclusion_id, g.entities || j.source_entity_id, g.top_activity_id, j.source_book_basis,
           g.period_matches AND j.period_start = ret.period_start AND j.period_end = ret.period_end
      FROM g CROSS JOIN ret
      JOIN tax_return r ON r.org_id = p_org AND r.entity_id = g.source_entity_id AND r.return_type = 'disregarded' AND r.period_start <= ret.period_end AND r.period_end >= ret.period_start
      JOIN activity_inclusion j ON j.org_id = r.org_id AND j.return_id = r.return_id
     WHERE NOT j.inclusion_id = ANY (g.path))
  SELECT source_entity_id, path, entities, top_activity_id, source_book_basis, period_matches FROM g
$$;

-- §4.8 Owners and members of a company, per period (pulled forward from T4 at the owner's request, 2026-10-16): who holds an interest,
-- in what role, from when to when, and the exact profit, loss and capital fractions (numerator / denominator; NULL = not known yet,
-- which blocks what depends on it and is never zero). History is kept like household members: a change closes the earlier row the day
-- before and adds a new one; nothing is deleted. Capital accounts, basis, liabilities, allocations and K-1s stay T4 (migration 067), which
-- builds on these rows. A binding's interest_id points here.
CREATE TABLE ownership_interest (
  org_id bigint NOT NULL REFERENCES org (org_id),
  interest_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_id bigint NOT NULL,
  party_id bigint NOT NULL,
  role text NOT NULL CHECK (role IN ('general_partner', 'limited_partner', 'shareholder', 'single_member')),
  effective_from date NOT NULL,
  effective_to date,
  profit_num bigint, profit_den bigint, loss_num bigint, loss_den bigint, capital_num bigint, capital_den bigint,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, interest_id),
  UNIQUE (org_id, entity_id, party_id, effective_from),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id),
  FOREIGN KEY (org_id, party_id) REFERENCES tax_party (org_id, party_id),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK ((profit_num IS NULL) = (profit_den IS NULL) AND (loss_num IS NULL) = (loss_den IS NULL) AND (capital_num IS NULL) = (capital_den IS NULL)),
  CHECK (profit_num IS NULL OR (profit_num >= 0 AND profit_den > 0 AND profit_num <= profit_den)),
  CHECK (loss_num IS NULL OR (loss_num >= 0 AND loss_den > 0 AND loss_num <= loss_den)),
  CHECK (capital_num IS NULL OR (capital_num >= 0 AND capital_den > 0 AND capital_num <= capital_den))
);
CREATE INDEX ownership_interest_company ON ownership_interest (org_id, entity_id, effective_from);
-- Scope and party kind: the owner is a party of the organization, never the company itself; a shareholder is a person or a trust (an S
-- corporation has no company shareholders); an interest with no end date has an active owner; a household return has no owners. The party
-- is read FOR SHARE (Codex t2-r1 B5): a concurrent edit of its kind, company or active state is waited for and its committed facts are
-- the ones checked (tax_check_party_owner_facts below guards the other order).
CREATE FUNCTION tax_check_ownership_interest() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record;
BEGIN
  SELECT kind, entity_id, active INTO p FROM tax_party WHERE org_id = NEW.org_id AND party_id = NEW.party_id FOR SHARE;
  IF NOT p.active AND NEW.effective_to IS NULL THEN RAISE EXCEPTION 'ownership_interest: the owner is an inactive party; reactivate it first, or give the interest its end date'; END IF;
  IF p.kind = 'entity_in_org' AND p.entity_id = NEW.entity_id THEN RAISE EXCEPTION 'ownership_interest: a company is not its own owner'; END IF;
  IF NEW.role = 'shareholder' AND p.kind NOT IN ('individual', 'grantor_trust', 'trust') THEN RAISE EXCEPTION 'ownership_interest: a shareholder is a person or a trust'; END IF;
  -- Which roles a return takes is checked against the return PERIODS an interest falls in (tax_check_roster below), never against
  -- today's defaults (Codex r6 R6-N2); outside any period lib/tax/ownership.js uses the defaults.
  -- An interest keeps its company and owner (a binding that selected it names both); a different owner is a different interest.
  IF TG_OP = 'UPDATE' AND (NEW.entity_id, NEW.party_id) IS DISTINCT FROM (OLD.entity_id, OLD.party_id) THEN
    RAISE EXCEPTION 'ownership_interest: an interest keeps its company and its owner; end it and add the new one'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ownership_interest_check BEFORE INSERT OR UPDATE ON ownership_interest FOR EACH ROW EXECUTE FUNCTION tax_check_ownership_interest();

-- The roster of one company, valid over its WHOLE history after every change (Codex t2-plan-r5 R5-N1), like household members: the same
-- owner never holds two interests on one day; at most one single member on any day; on every day the stated profit, loss and capital
-- shares total at most 1 (exact fractions; unknown shares are not counted, and never zero); and every interest in effect during one of
-- the company's return periods has a role that period's return takes (a partnership's partners, an S corporation's shareholders, a
-- disregarded company's single member, nobody on a household return) — the period's own resolved return type, not today's defaults.
-- Run after each row change of the roster and when a period is opened or its return type, dates change, so neither a later save, an
-- end date moved across a successor nor a period opened under other defaults can leave an invalid roster. It first locks the company row
-- (the lock lib/data/writes.js lockEntity takes; Tax Books writes hold it already, after the graph lock), so competing roster and period
-- writes of one company serialize and each check reads the other's committed rows (Codex r6 R6-N1). That holds only in READ COMMITTED,
-- where each statement after the wait takes a fresh snapshot: a REPEATABLE READ (or SERIALIZABLE) transaction keeps the snapshot of its
-- first statement, so after waiting for the lock it would still check the roster without the competing writer's rows and could commit
-- two single members (Codex r7 R7-N1). Roster and period writes are therefore refused there — the rule 064 applies to inclusion edges.
CREATE FUNCTION tax_check_roster(o bigint, ent bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE d date; x record; pn numeric; pd numeric; ln numeric; ld numeric; cn numeric; cd numeric; g numeric; members int; per record;
BEGIN
  IF current_setting('transaction_isolation') IN ('repeatable read', 'serializable')
    THEN RAISE EXCEPTION 'tax_check_roster: change owners and return periods in a READ COMMITTED transaction; a % snapshot cannot see a competing roster change committed while it waited', upper(current_setting('transaction_isolation')); END IF;
  PERFORM 1 FROM entity WHERE org_id = o AND entity_id = ent FOR UPDATE;
  IF EXISTS (SELECT 1 FROM ownership_interest a JOIN ownership_interest b ON b.org_id = a.org_id AND b.entity_id = a.entity_id AND b.party_id = a.party_id AND b.interest_id > a.interest_id
              WHERE a.org_id = o AND a.entity_id = ent
                AND daterange(a.effective_from, a.effective_to, '[]') && daterange(b.effective_from, b.effective_to, '[]'))
    THEN RAISE EXCEPTION 'ownership_interest: this owner would hold two interests on the same days; end one before the other starts'; END IF;
  -- Every day the roster changes on: each start, and the day after each end.
  FOR d IN SELECT effective_from FROM ownership_interest WHERE org_id = o AND entity_id = ent
           UNION SELECT effective_to + 1 FROM ownership_interest WHERE org_id = o AND entity_id = ent AND effective_to IS NOT NULL LOOP
    pn := 0; pd := 1; ln := 0; ld := 1; cn := 0; cd := 1; members := 0;
    FOR x IN SELECT * FROM ownership_interest WHERE org_id = o AND entity_id = ent AND effective_from <= d AND (effective_to IS NULL OR effective_to >= d) LOOP
      IF x.role = 'single_member' THEN members := members + 1; END IF;
      IF x.profit_num IS NOT NULL THEN pn := pn * x.profit_den + x.profit_num * pd; pd := pd * x.profit_den; g := gcd(pn, pd); pn := div(pn, g); pd := div(pd, g); END IF;
      IF x.loss_num IS NOT NULL THEN ln := ln * x.loss_den + x.loss_num * ld; ld := ld * x.loss_den; g := gcd(ln, ld); ln := div(ln, g); ld := div(ld, g); END IF;
      IF x.capital_num IS NOT NULL THEN cn := cn * x.capital_den + x.capital_num * cd; cd := cd * x.capital_den; g := gcd(cn, cd); cn := div(cn, g); cd := div(cd, g); END IF;
    END LOOP;
    IF members > 1 THEN RAISE EXCEPTION 'ownership_interest: a disregarded company has one owner at a time (two single members on %)', d; END IF;
    IF pn > pd THEN RAISE EXCEPTION 'ownership_interest: the profit shares in effect on % would total %/%, more than 1', d, pn, pd; END IF;
    IF ln > ld THEN RAISE EXCEPTION 'ownership_interest: the loss shares in effect on % would total %/%, more than 1', d, ln, ld; END IF;
    IF cn > cd THEN RAISE EXCEPTION 'ownership_interest: the capital shares in effect on % would total %/%, more than 1', d, cn, cd; END IF;
  END LOOP;
  FOR per IN SELECT r.return_type, r.period_start, r.period_end, i.role FROM tax_return r JOIN ownership_interest i ON i.org_id = r.org_id AND i.entity_id = r.entity_id
              AND i.effective_from <= r.period_end AND (i.effective_to IS NULL OR i.effective_to >= r.period_start)
             WHERE r.org_id = o AND r.entity_id = ent LOOP
    IF NOT ((per.return_type = 'form_1065' AND per.role IN ('general_partner', 'limited_partner')) OR (per.return_type = 'form_1120s' AND per.role = 'shareholder')
            OR (per.return_type = 'disregarded' AND per.role = 'single_member')) THEN
      RAISE EXCEPTION 'ownership_interest: the % – % period files %, which takes no % interest: end or correct the interests for that period first', per.period_start, per.period_end,
        per.return_type, per.role; END IF;
  END LOOP;
END $$;
CREATE FUNCTION tax_check_roster_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'ownership_interest' THEN PERFORM tax_check_roster(NEW.org_id, NEW.entity_id);
  -- A period moved to another company is a roster change of that company too (Codex t2-r1 non-blocking 2).
  ELSIF TG_OP = 'INSERT' OR (NEW.entity_id, NEW.return_type, NEW.period_start, NEW.period_end) IS DISTINCT FROM (OLD.entity_id, OLD.return_type, OLD.period_start, OLD.period_end) THEN
    PERFORM tax_check_roster(NEW.org_id, NEW.entity_id); END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER ownership_interest_roster AFTER INSERT OR UPDATE ON ownership_interest FOR EACH ROW EXECUTE FUNCTION tax_check_roster_row();
CREATE TRIGGER tax_return_roster AFTER INSERT OR UPDATE ON tax_return FOR EACH ROW EXECUTE FUNCTION tax_check_roster_row();
-- The party facts an owner's interest depends on (Codex t2-r1 B5): an owner that becomes one of our companies is never the company it
-- owns; a party that holds a shareholder interest stays a person or a trust; a party with an interest that has no end date stays active.
-- The interest side (tax_check_ownership_interest) reads the party FOR SHARE, so a party edit and an interest write of the same party
-- serialize on the party row; in READ COMMITTED whichever waits rereads the other's committed facts (each statement of this function takes
-- a fresh snapshot) and is refused. A REPEATABLE READ or SERIALIZABLE snapshot could not see an interest committed while it waited, so an
-- edit of these facts is refused there, as for roster writes.
CREATE FUNCTION tax_check_party_owner_facts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.kind, NEW.entity_id, NEW.active) IS NOT DISTINCT FROM (OLD.kind, OLD.entity_id, OLD.active) THEN RETURN NEW; END IF;
  IF current_setting('transaction_isolation') IN ('repeatable read', 'serializable')
    THEN RAISE EXCEPTION 'tax_party: change a party''s kind, company or active state in a READ COMMITTED transaction; a % snapshot cannot see an owner''s interest committed while it waited', upper(current_setting('transaction_isolation')); END IF;
  IF NEW.kind = 'entity_in_org' AND EXISTS (SELECT 1 FROM ownership_interest o WHERE o.org_id = OLD.org_id AND o.party_id = OLD.party_id AND o.entity_id = NEW.entity_id)
    THEN RAISE EXCEPTION 'tax_party: this party is an owner of that company, and a company is not its own owner'; END IF;
  IF NEW.kind NOT IN ('individual', 'grantor_trust', 'trust')
     AND EXISTS (SELECT 1 FROM ownership_interest o WHERE o.org_id = OLD.org_id AND o.party_id = OLD.party_id AND o.role = 'shareholder')
    THEN RAISE EXCEPTION 'tax_party: this party holds shares, so it stays a person or a trust'; END IF;
  IF NOT NEW.active AND EXISTS (SELECT 1 FROM ownership_interest o WHERE o.org_id = OLD.org_id AND o.party_id = OLD.party_id AND o.effective_to IS NULL)
    THEN RAISE EXCEPTION 'tax_party: this party is a current owner (an interest with no end date): end the interest before deactivating the party'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tax_party_owner_facts BEFORE UPDATE ON tax_party FOR EACH ROW EXECUTE FUNCTION tax_check_party_owner_facts();

-- §4.5 The company's reusable default for one measurement of one account, for the catalog of one return type (an included child's
-- accounts default into their owner's return type). A default never holds a dollar split or a line attribution (one period's figures).
-- Owner and K-1 references are stable parties, resolved to the period's interest or K-1 record on reuse.
CREATE TABLE tax_binding_default (
  org_id bigint NOT NULL REFERENCES org (org_id),
  default_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_id bigint NOT NULL,
  account_id bigint NOT NULL,
  return_type text NOT NULL CHECK (return_type IN ('form_1065', 'form_1120s', 'household_1040')),
  measurement text NOT NULL CHECK (measurement IN ('activity', 'begin', 'end')),
  treatment tax_treatment NOT NULL,
  destination text CHECK (length(destination) BETWEEN 1 AND 100),
  -- none: no activity; fixed: this activity of the company's own return (a slot dimension or source-activity provenance); inclusion:
  -- the top activity of whichever period's inclusion path reuses it (§13.1 T2: period-specific references are re-resolved, never copied).
  activity_rule text NOT NULL DEFAULT 'none' CHECK (activity_rule IN ('none', 'fixed', 'inclusion')),
  activity_id bigint,
  interest_party_id bigint,
  k1_issuer_party_id bigint,
  share_num bigint CHECK (share_num > 0),
  share_den bigint CHECK (share_den > 0),
  row_label text CHECK (length(row_label) BETWEEN 1 AND 200),
  memo text CHECK (length(memo) <= 500),
  target_key text NOT NULL CHECK (length(target_key) BETWEEN 3 AND 300),
  catalog_edition smallint NOT NULL,
  source text NOT NULL DEFAULT 'person' CHECK (source IN ('person', 'rule', 'history', 'ai')),
  source_detail jsonb NOT NULL DEFAULT '{}',
  confidence text CHECK (confidence IN ('high', 'medium', 'low')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT coalesce(nullif(current_setting('app.actor', true), ''), 'system'),
  UNIQUE (org_id, default_id),
  UNIQUE (org_id, account_id, return_type, measurement, target_key),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id),
  -- A default is advice about an account; deleting an unused account takes its defaults with it.
  FOREIGN KEY (org_id, account_id) REFERENCES account (org_id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, activity_id) REFERENCES tax_activity (org_id, activity_id),
  FOREIGN KEY (org_id, interest_party_id) REFERENCES tax_party (org_id, party_id),
  FOREIGN KEY (org_id, k1_issuer_party_id) REFERENCES tax_party (org_id, party_id),
  CHECK ((share_num IS NULL) = (share_den IS NULL)),
  CHECK (share_num IS NULL OR share_num <= share_den),
  CHECK ((activity_rule = 'fixed') = (activity_id IS NOT NULL))
);

-- §4.5 One period's routing of one measurement of one account to one target. The set of rows of one (return, account, measurement) is
-- the account-level allocation of that measurement's residual (what its line attributions leave): one whole row, or two or more rows
-- by exact shares (summing to 1), or by dollar amounts tied to source_version — the partition base version (measurement version and
-- attribution set, lib/tax/partition.js); a dollar split goes stale, blocking, when either changes.
CREATE TABLE tax_binding (
  org_id bigint NOT NULL REFERENCES org (org_id),
  binding_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  return_id bigint NOT NULL,
  source_entity_id bigint NOT NULL,
  -- The inclusion edges from the return down to the source ('{}' for the return's own books), checked by tax_check_binding.
  inclusion_path bigint[] NOT NULL DEFAULT '{}',
  account_id bigint NOT NULL,
  measurement text NOT NULL CHECK (measurement IN ('activity', 'begin', 'end')),
  treatment tax_treatment NOT NULL,
  destination text CHECK (length(destination) BETWEEN 1 AND 100),
  -- The activity: the slot's activity dimension where the line requires one, otherwise source-activity provenance (Codex B6).
  activity_id bigint,
  interest_party_id bigint,
  interest_id bigint,          -- the period's ownership interest (ownership_interest, above)
  interest_version text,       -- the selected interest's version when resolved (lib/tax/references.js: T2 selects from ownership_interest)
  k1_issuer_party_id bigint,
  k1_source_id bigint,         -- the K-1 record selected; its FK arrives in T4 (067) with k1_record
  k1_source_version text,
  -- The canonical slot key (lib/tax/providers.js) when the treatment names a slot and every dimension the line requires is resolved.
  slot_key text CHECK (length(slot_key) BETWEEN 3 AND 400),
  target_key text NOT NULL CHECK (length(target_key) BETWEEN 3 AND 300),
  row_label text CHECK (length(row_label) BETWEEN 1 AND 200),
  share_num bigint CHECK (share_num > 0),
  share_den bigint CHECK (share_den > 0),
  amount_cents bigint CHECK (amount_cents <> 0),
  override boolean NOT NULL DEFAULT false,      -- this period departs from the company default
  copied_from_default_id bigint,                -- provenance only (a default may be replaced later)
  copied_from_revision bigint,                  -- FK arrives in T3 (064) with tax_return_revision
  source_version text NOT NULL CHECK (length(source_version) BETWEEN 1 AND 200),
  catalog_edition smallint NOT NULL,            -- the catalog the destination was checked against (§4.3: may precede form_edition)
  pending jsonb NOT NULL DEFAULT '[]',          -- [{ kind: activity|interest|k1|recognition, reason }]: unresolved, blocking its outputs
  memo text CHECK (length(memo) <= 500),
  source text NOT NULL DEFAULT 'person' CHECK (source IN ('person', 'default', 'rule', 'history', 'ai')),
  source_detail jsonb NOT NULL DEFAULT '{}',
  confidence text CHECK (confidence IN ('high', 'medium', 'low')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT coalesce(nullif(current_setting('app.actor', true), ''), 'system'),
  UNIQUE (org_id, binding_id),
  UNIQUE (org_id, return_id, account_id, measurement, target_key),
  FOREIGN KEY (org_id, return_id) REFERENCES tax_return (org_id, return_id),
  FOREIGN KEY (org_id, source_entity_id) REFERENCES entity (org_id, entity_id),
  FOREIGN KEY (org_id, account_id) REFERENCES account (org_id, account_id),
  FOREIGN KEY (org_id, activity_id) REFERENCES tax_activity (org_id, activity_id),
  FOREIGN KEY (org_id, interest_party_id) REFERENCES tax_party (org_id, party_id),
  FOREIGN KEY (org_id, k1_issuer_party_id) REFERENCES tax_party (org_id, party_id),
  CHECK ((share_num IS NULL) = (share_den IS NULL)),
  CHECK (share_num IS NULL OR share_num <= share_den),
  CHECK (share_num IS NULL OR amount_cents IS NULL),
  CHECK (tax_treatment_has_slot(treatment) OR slot_key IS NULL),
  CHECK ((interest_id IS NULL) = (interest_version IS NULL)),
  CHECK ((k1_source_id IS NULL) = (k1_source_version IS NULL)),
  FOREIGN KEY (org_id, interest_id) REFERENCES ownership_interest (org_id, interest_id)
);
CREATE INDEX tax_binding_slot ON tax_binding (org_id, return_id, slot_key) WHERE slot_key IS NOT NULL;
CREATE INDEX tax_binding_source ON tax_binding (org_id, return_id, source_entity_id, account_id);

-- §4.5 Line attribution: one posting line (txn, line) of an account's period activity routed to its own target (mixed accounts,
-- owner-specific movements). Lines are consumed first; the account's set takes the residual (lib/tax/partition.js). A line is
-- attributed at most once per return. No FK to txn: an edited or deleted transaction makes the attribution stale or orphaned, never
-- blocked. txn_version (migration 055's txn_version()) is the transaction as the person saw it; any later change makes it stale.
CREATE TABLE tax_binding_line (
  org_id bigint NOT NULL REFERENCES org (org_id),
  binding_line_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  return_id bigint NOT NULL,
  source_entity_id bigint NOT NULL,
  inclusion_path bigint[] NOT NULL DEFAULT '{}',
  account_id bigint NOT NULL,
  txn_id bigint NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  treatment tax_treatment NOT NULL,
  destination text CHECK (length(destination) BETWEEN 1 AND 100),
  activity_id bigint,
  interest_party_id bigint,
  interest_id bigint,
  interest_version text,
  k1_issuer_party_id bigint,
  k1_source_id bigint,
  k1_source_version text,
  slot_key text CHECK (length(slot_key) BETWEEN 3 AND 400),
  target_key text NOT NULL CHECK (length(target_key) BETWEEN 3 AND 300),
  row_label text CHECK (length(row_label) BETWEEN 1 AND 200),
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0),   -- the line's amount on the account when attributed
  txn_version text NOT NULL,
  catalog_edition smallint NOT NULL,
  pending jsonb NOT NULL DEFAULT '[]',
  memo text CHECK (length(memo) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT coalesce(nullif(current_setting('app.actor', true), ''), 'system'),
  UNIQUE (org_id, binding_line_id),
  UNIQUE (org_id, return_id, account_id, txn_id, line_no),
  FOREIGN KEY (org_id, return_id) REFERENCES tax_return (org_id, return_id),
  FOREIGN KEY (org_id, source_entity_id) REFERENCES entity (org_id, entity_id),
  FOREIGN KEY (org_id, account_id) REFERENCES account (org_id, account_id),
  FOREIGN KEY (org_id, activity_id) REFERENCES tax_activity (org_id, activity_id),
  FOREIGN KEY (org_id, interest_party_id) REFERENCES tax_party (org_id, party_id),
  FOREIGN KEY (org_id, k1_issuer_party_id) REFERENCES tax_party (org_id, party_id),
  CHECK (tax_treatment_has_slot(treatment) OR slot_key IS NULL),
  CHECK ((interest_id IS NULL) = (interest_version IS NULL)),
  CHECK ((k1_source_id IS NULL) = (k1_source_version IS NULL)),
  FOREIGN KEY (org_id, interest_id) REFERENCES ownership_interest (org_id, interest_id)
);

-- §7 Suggestions as records: what was proposed (rule, history, AI), the full decision the person saw (decision_key, lib/tax/suggest.js
-- decisionKey: account name and type, measurement version, target, activity, evidence, rules version and the binding state), the
-- amount shown, and what a person did. AI proposals wait here until accepted or rejected (with a reason).
CREATE TABLE tax_binding_suggestion (
  org_id bigint NOT NULL REFERENCES org (org_id),
  suggestion_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  return_id bigint NOT NULL,
  source_entity_id bigint NOT NULL,
  account_id bigint NOT NULL,
  measurement text NOT NULL CHECK (measurement IN ('activity', 'begin', 'end')),
  treatment tax_treatment NOT NULL,
  destination text CHECK (length(destination) BETWEEN 1 AND 100),
  activity_id bigint,
  source text NOT NULL CHECK (source IN ('rule', 'history', 'ai')),
  basis text NOT NULL CHECK (length(basis) BETWEEN 1 AND 200),
  confidence text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  evidence jsonb NOT NULL DEFAULT '{}',
  call_id bigint REFERENCES ai_call (call_id),
  source_version text NOT NULL CHECK (length(source_version) BETWEEN 1 AND 200),
  decision_key text NOT NULL CHECK (length(decision_key) = 32),
  shown_cents bigint,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'rejected')),
  reason text CHECK (length(reason) <= 500),
  decided_by text,
  decided_at timestamptz,
  binding_ids bigint[],
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, suggestion_id),
  FOREIGN KEY (org_id, return_id) REFERENCES tax_return (org_id, return_id),
  FOREIGN KEY (org_id, source_entity_id) REFERENCES entity (org_id, entity_id),
  FOREIGN KEY (org_id, account_id) REFERENCES account (org_id, account_id),
  CHECK (status <> 'rejected' OR length(btrim(reason)) > 0),
  CHECK ((status = 'proposed') = (decided_at IS NULL))
);

-- Codex t2-plan-r1 B9: one of our own companies keeps its EIN once, on entity (Settings → Company). A T1 party of kind entity_in_org
-- may still hold its own encrypted id; lib/tax/parties.js reconcileOwnCompanyTaxIds moves or compares it (never erasing it) and records
-- the outcome: 'company' (the company's EIN is the authority) or 'conflict' (the two differ: unresolved until an admin chooses).
-- NULL = not reconciled yet: readers show the party's own legacy id, flagged for reconciliation.
ALTER TABLE tax_party ADD COLUMN own_tax_id_state text CHECK (own_tax_id_state IN ('company', 'conflict')),
  ADD CONSTRAINT tax_party_own_tax_id_state CHECK (own_tax_id_state IS NULL OR kind = 'entity_in_org');
-- The evidence of one conflict (Codex t2-plan-r2 B9): both encrypted candidates as they stood when the conflict was found (the audit
-- trail drops *_enc columns, so the ciphertexts are kept here), and the admin's decision. Never deleted; read only by the reconciliation
-- form, which shows the last four digits.
CREATE TABLE tax_party_tax_id_evidence (
  org_id bigint NOT NULL REFERENCES org(org_id),
  evidence_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  party_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  party_tax_id_enc text NOT NULL,
  party_tax_id_last4 text NOT NULL,
  company_ein_enc text NOT NULL,
  company_ein_last4 text NOT NULL,
  found_at timestamptz NOT NULL DEFAULT now(),
  decision text CHECK (decision IN ('company', 'party')),
  decided_by text,
  decided_at timestamptz,
  CHECK ((decision IS NULL) = (decided_by IS NULL) AND (decision IS NULL) = (decided_at IS NULL)),
  FOREIGN KEY (org_id, party_id) REFERENCES tax_party (org_id, party_id),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id)
);
CREATE UNIQUE INDEX tax_party_tax_id_evidence_open ON tax_party_tax_id_evidence (org_id, party_id) WHERE decision IS NULL;

-- Scope (spec §4.4, §4.5, §11): a binding sits on a return that is not a disregarded company's own period (that company's books are
-- bound on the return that includes them); its account belongs to its source company; the source is the return's own company (empty
-- path) or a company reached by exactly the stored inclusion path of THIS return, on the return's whole period; its activity belongs
-- to the return's company; an attributed line's transaction belongs to the source. Provider authority is not decided here (B1).
CREATE FUNCTION tax_check_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; acc_entity bigint; act_entity bigint;
BEGIN
  -- The inclusion-graph lock, held to commit, before the path is read (B5): an edge removal waits for this write and then sees it.
  PERFORM pg_advisory_xact_lock(74120062, hashint8(NEW.org_id));
  -- Only in READ COMMITTED does the path read below see an edge change committed while this waited (Codex t2-r1 non-blocking 1): a
  -- REPEATABLE READ or SERIALIZABLE snapshot keeps its first statement's graph and could bind through a removed edge.
  IF current_setting('transaction_isolation') IN ('repeatable read', 'serializable')
    THEN RAISE EXCEPTION '%: write bindings in a READ COMMITTED transaction; a % snapshot cannot see an inclusion change committed while it waited', TG_TABLE_NAME, upper(current_setting('transaction_isolation')); END IF;
  SELECT entity_id, return_type INTO r FROM tax_return WHERE org_id = NEW.org_id AND return_id = NEW.return_id;
  IF r.return_type = 'disregarded' THEN RAISE EXCEPTION '%: a disregarded company''s books are bound on the return that includes them, not on its own period', TG_TABLE_NAME; END IF;
  SELECT entity_id INTO acc_entity FROM account WHERE org_id = NEW.org_id AND account_id = NEW.account_id;
  IF acc_entity IS DISTINCT FROM NEW.source_entity_id THEN RAISE EXCEPTION '%: the account belongs to another company than the source', TG_TABLE_NAME; END IF;
  IF NEW.source_entity_id = r.entity_id THEN
    IF cardinality(NEW.inclusion_path) <> 0 THEN RAISE EXCEPTION '%: the return''s own books have no inclusion path', TG_TABLE_NAME; END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM tax_inclusion_sources(NEW.org_id, NEW.return_id) s WHERE s.source_entity_id = NEW.source_entity_id AND s.path = NEW.inclusion_path AND s.period_matches)
    THEN RAISE EXCEPTION '%: another company''s books enter this return only through its inclusion path, for the return''s whole period', TG_TABLE_NAME; END IF;
  IF NEW.activity_id IS NOT NULL THEN
    SELECT return_entity_id INTO act_entity FROM tax_activity WHERE org_id = NEW.org_id AND activity_id = NEW.activity_id;
    IF act_entity IS DISTINCT FROM r.entity_id THEN RAISE EXCEPTION '%: the activity belongs to another company''s return', TG_TABLE_NAME; END IF;
  END IF;
  -- The selected interest (Codex t2-plan-r5 R5-N3) is an interest in the RETURN's company, held by the binding's owner.
  IF NEW.interest_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ownership_interest i WHERE i.org_id = NEW.org_id AND i.interest_id = NEW.interest_id
       AND i.entity_id = r.entity_id AND i.party_id = NEW.interest_party_id)
    THEN RAISE EXCEPTION '%: the selected interest is not this owner''s interest in the return''s company', TG_TABLE_NAME; END IF;
  IF TG_TABLE_NAME = 'tax_binding_line' THEN
    IF NOT EXISTS (SELECT 1 FROM txn t WHERE t.org_id = NEW.org_id AND t.txn_id = NEW.txn_id AND t.entity_id = NEW.source_entity_id)
      THEN RAISE EXCEPTION 'tax_binding_line: the transaction belongs to another company than the source'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tax_binding_scope BEFORE INSERT OR UPDATE ON tax_binding FOR EACH ROW EXECUTE FUNCTION tax_check_binding();
CREATE TRIGGER tax_binding_line_scope BEFORE INSERT OR UPDATE ON tax_binding_line FOR EACH ROW EXECUTE FUNCTION tax_check_binding();

CREATE FUNCTION tax_check_binding_default() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE acc_entity bigint; act_entity bigint;
BEGIN
  SELECT entity_id INTO acc_entity FROM account WHERE org_id = NEW.org_id AND account_id = NEW.account_id;
  IF acc_entity IS DISTINCT FROM NEW.entity_id THEN RAISE EXCEPTION 'tax_binding_default: the account belongs to another company'; END IF;
  IF NEW.activity_id IS NOT NULL THEN
    SELECT return_entity_id INTO act_entity FROM tax_activity WHERE org_id = NEW.org_id AND activity_id = NEW.activity_id;
    IF act_entity IS DISTINCT FROM NEW.entity_id THEN RAISE EXCEPTION 'tax_binding_default: a fixed activity is one of the company''s own activities'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tax_binding_default_scope BEFORE INSERT OR UPDATE ON tax_binding_default FOR EACH ROW EXECUTE FUNCTION tax_check_binding_default();

-- The set rule, at commit (a save replaces a whole set inside one transaction): whole once, or every row a share and the shares
-- totalling exactly 1 (exact fractions; numeric div/gcd keep them integral), or every row an amount; two or more rows to split. An
-- UPDATE that moves a row to another set checks the set it left too (Codex non-blocking 4).
CREATE FUNCTION tax_check_binding_group(o bigint, ret bigint, acc bigint, m text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE n int; whole int; shares int; amounts int; num numeric := 0; den numeric := 1; g numeric; x record;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE share_num IS NULL AND amount_cents IS NULL), count(*) FILTER (WHERE share_num IS NOT NULL), count(*) FILTER (WHERE amount_cents IS NOT NULL)
    INTO n, whole, shares, amounts FROM tax_binding WHERE org_id = o AND return_id = ret AND account_id = acc AND measurement = m;
  IF n = 0 THEN RETURN; END IF;
  IF whole > 0 AND n > 1 THEN RAISE EXCEPTION 'tax_binding: account % (%) is bound whole once, or split; never both', acc, m; END IF;
  IF shares > 0 AND (shares <> n OR n < 2) THEN RAISE EXCEPTION 'tax_binding: a share split of account % (%) names every row''s share and has at least two rows', acc, m; END IF;
  IF amounts > 0 AND (amounts <> n OR n < 2) THEN RAISE EXCEPTION 'tax_binding: a dollar split of account % (%) names every row''s amount and has at least two rows', acc, m; END IF;
  IF shares > 0 THEN
    FOR x IN SELECT share_num, share_den FROM tax_binding WHERE org_id = o AND return_id = ret AND account_id = acc AND measurement = m LOOP
      num := num * x.share_den + x.share_num * den; den := den * x.share_den; g := gcd(num, den); num := div(num, g); den := div(den, g);
    END LOOP;
    IF num <> den THEN RAISE EXCEPTION 'tax_binding: the shares of account % (%) total %/%, not 1', acc, m, num, den; END IF;
  END IF;
END $$;
CREATE FUNCTION tax_check_binding_set() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN PERFORM tax_check_binding_group(OLD.org_id, OLD.return_id, OLD.account_id, OLD.measurement); END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN PERFORM tax_check_binding_group(NEW.org_id, NEW.return_id, NEW.account_id, NEW.measurement); END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER tax_binding_set AFTER INSERT OR UPDATE OR DELETE ON tax_binding DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tax_check_binding_set();

-- The same rule for a default's set (no dollar splits exist there).
CREATE FUNCTION tax_check_default_group(o bigint, acc bigint, rt text, m text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE n int; whole int; num numeric := 0; den numeric := 1; g numeric; x record;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE share_num IS NULL) INTO n, whole FROM tax_binding_default WHERE org_id = o AND account_id = acc AND return_type = rt AND measurement = m;
  IF n = 0 THEN RETURN; END IF;
  IF whole > 0 AND n > 1 THEN RAISE EXCEPTION 'tax_binding_default: account % (%) defaults whole once, or split by share; never both', acc, m; END IF;
  IF whole = 0 AND n < 2 THEN RAISE EXCEPTION 'tax_binding_default: a share split of account % (%) has at least two rows', acc, m; END IF;
  IF whole = 0 THEN
    FOR x IN SELECT share_num, share_den FROM tax_binding_default WHERE org_id = o AND account_id = acc AND return_type = rt AND measurement = m LOOP
      num := num * x.share_den + x.share_num * den; den := den * x.share_den; g := gcd(num, den); num := div(num, g); den := div(den, g);
    END LOOP;
    IF num <> den THEN RAISE EXCEPTION 'tax_binding_default: the shares of account % (%) total %/%, not 1', acc, m, num, den; END IF;
  END IF;
END $$;
CREATE FUNCTION tax_check_default_set() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN PERFORM tax_check_default_group(OLD.org_id, OLD.account_id, OLD.return_type, OLD.measurement); END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN PERFORM tax_check_default_group(NEW.org_id, NEW.account_id, NEW.return_type, NEW.measurement); END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER tax_binding_default_set AFTER INSERT OR UPDATE OR DELETE ON tax_binding_default DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tax_check_default_set();

-- An inclusion edge on the path of any binding (direct or nested) keeps its return, company and activity while those bindings stand
-- (they carry the path and the top activity); removing it needs the bindings removed first.
CREATE FUNCTION tax_check_inclusion_bound() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- The inclusion-graph lock, held to commit (B5): a binding write in flight finishes first, and its rows are then seen below.
  PERFORM pg_advisory_xact_lock(74120062, hashint8(OLD.org_id));
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.return_id, NEW.source_entity_id, NEW.activity_id, NEW.period_start, NEW.period_end) IS NOT DISTINCT FROM (OLD.return_id, OLD.source_entity_id, OLD.activity_id, OLD.period_start, OLD.period_end)
      THEN RETURN NEW; END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM tax_binding b WHERE b.org_id = OLD.org_id AND OLD.inclusion_id = ANY (b.inclusion_path))
     OR EXISTS (SELECT 1 FROM tax_binding_line b WHERE b.org_id = OLD.org_id AND OLD.inclusion_id = ANY (b.inclusion_path))
    THEN RAISE EXCEPTION 'activity_inclusion: the included company''s accounts are bound on this return; remove those bindings first'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER activity_inclusion_bound BEFORE UPDATE OR DELETE ON activity_inclusion FOR EACH ROW EXECUTE FUNCTION tax_check_inclusion_bound();

-- A period with bindings keeps the facts its destinations were checked against.
CREATE FUNCTION tax_check_return_bindings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.entity_id, NEW.return_type, NEW.period_start, NEW.period_end, NEW.form_edition) IS DISTINCT FROM (OLD.entity_id, OLD.return_type, OLD.period_start, OLD.period_end, OLD.form_edition)
     AND (EXISTS (SELECT 1 FROM tax_binding b WHERE b.org_id = OLD.org_id AND b.return_id = OLD.return_id)
          OR EXISTS (SELECT 1 FROM tax_binding_line b WHERE b.org_id = OLD.org_id AND b.return_id = OLD.return_id))
    THEN RAISE EXCEPTION 'tax_return: this period has source bindings; its company, return type, dates and edition stay as they are while they stand'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tax_return_bindings_check BEFORE UPDATE ON tax_return FOR EACH ROW EXECUTE FUNCTION tax_check_return_bindings();

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON ownership_interest FOR EACH ROW EXECUTE FUNCTION audit_row('interest_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON tax_binding_default FOR EACH ROW EXECUTE FUNCTION audit_row('default_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON tax_binding FOR EACH ROW EXECUTE FUNCTION audit_row('binding_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON tax_binding_line FOR EACH ROW EXECUTE FUNCTION audit_row('binding_line_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON tax_binding_suggestion FOR EACH ROW EXECUTE FUNCTION audit_row('suggestion_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON tax_party_tax_id_evidence FOR EACH ROW EXECUTE FUNCTION audit_row('evidence_id');
