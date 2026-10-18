-- migrations/066_tax_books_t3.sql
-- Tax Books stage T3 (spec docs/superpowers/specs/2026-10-15-tax-books-design.md §4.3 revisions, §4.6, §4.7 manual items, §4.10, §4.11, §4.12,
-- §5.2-§5.9, §13 T3, §13.1 T3): the standalone engine, draft only. Tax Books still never writes to the ledger: nothing here references a
-- posting row or blocks a ledger write; a changed source makes a decision stale (its recorded txn_version no longer matches): the decision
-- is RETAINED, shown as stale, and what it decided is unresolved until a person clears it or decides again (never the default).
-- Invariants the DATABASE guarantees: organization and company scope of every row (the return's company; a transaction of that company;
-- an activity of that company), one decision per (return, transaction, kind), one manual item per (return, item), one COGS workpaper per
-- (return, activity), the shape of each row, revisions immutable and working-only (finalization is stage T4). Invariants the APPLICATION
-- guarantees (lib/tax/*.js under the graph lock and the company lock): that a decision matches the books as shown (txn_version), that a
-- slot key is a canonical non-computed slot of the period's catalog, that a closing subset balances, and the engine arithmetic. The scope
-- trigger below checks SCALAR scope only (the return's company; the transaction's, account's or activity's company); the saved account
-- arrays (accounts, affected_accounts, source_accounts) and their domains are the application's evidence: the checks here constrain their
-- cardinality and allowed values, not that each id is an account of the company or that its domain is right — lib/tax/*.js writes them from
-- the source as shown, and the engine reads them (never the source as it is now) when it reconciles a saved decision.

-- §4.3 One computed snapshot of a return. T3 takes WORKING revisions only: inputs (every decision and mapping read), results (each catalog
-- field's exact semantic cents as a string, its status and reasons, checks, the M-1 bridge), source_detail (the posting and application rows
-- consumed, with versions, so a deleted or re-posted row can still be shown) and the dependency manifest (spec §5.9) that drift compares.
-- A revision is never edited or deleted. The audit trigger is not attached: the row is append-only and records who took it; copying its
-- results into audit_log would only duplicate them.
CREATE TABLE tax_return_revision (
  org_id bigint NOT NULL REFERENCES org (org_id),
  revision_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  return_id bigint NOT NULL,
  revision_no integer NOT NULL CHECK (revision_no >= 1),
  kind text NOT NULL CHECK (kind IN ('working', 'final', 'filed')),
  taken_at timestamptz NOT NULL DEFAULT now(),
  taken_by text NOT NULL CHECK (length(taken_by) BETWEEN 1 AND 200),
  catalog_hash text NOT NULL CHECK (length(catalog_hash) = 32),
  engine_version text NOT NULL CHECK (length(engine_version) BETWEEN 1 AND 50),
  inputs jsonb NOT NULL,
  results jsonb NOT NULL,
  source_detail jsonb NOT NULL,
  dependency_manifest jsonb NOT NULL,
  filed_at timestamptz,
  filed_by text,
  as_filed_pdf text,
  as_filed_vs_revision jsonb,
  UNIQUE (org_id, revision_id),
  UNIQUE (org_id, return_id, revision_no),
  FOREIGN KEY (org_id, return_id) REFERENCES tax_return (org_id, return_id)
);
-- Working only until T4 enables finalization (spec §13 T3 "Finalization disabled"); immutable always.
CREATE FUNCTION tax_check_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'tax_return_revision: a revision is never changed or deleted; take a new working revision'; END IF;
  IF NEW.kind <> 'working' THEN RAISE EXCEPTION 'tax_return_revision: only working revisions are taken in this stage; finalization arrives with stage T4'; END IF;
  IF NEW.filed_at IS NOT NULL OR NEW.filed_by IS NOT NULL OR NEW.as_filed_pdf IS NOT NULL OR NEW.as_filed_vs_revision IS NOT NULL
    THEN RAISE EXCEPTION 'tax_return_revision: a working revision is not filed'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tax_return_revision_check BEFORE INSERT OR UPDATE OR DELETE ON tax_return_revision FOR EACH ROW EXECUTE FUNCTION tax_check_revision();
-- The references T1 and T2 left for this table.
ALTER TABLE tax_baseline ADD CONSTRAINT tax_baseline_source_revision FOREIGN KEY (org_id, source_revision_id) REFERENCES tax_return_revision (org_id, revision_id);
ALTER TABLE tax_binding ADD CONSTRAINT tax_binding_copied_from_revision FOREIGN KEY (org_id, copied_from_revision) REFERENCES tax_return_revision (org_id, revision_id);

-- §4.12 Book entry classification, confirmed by a person. closing: the listed journal lines are a balanced closing subset — income and
-- expense closed into equity — removed from every Tax Books measurement of the period together (both legs); correction and normal: kept as
-- posted (a genuine correction stays). Candidates are proposed by shape (lib/tax/classify.js) and never stored until a person decides.
-- tax_only and opening are spec classes this stage does not take (lib/tax/classify.js refuses them with the reason). accounts: the income,
-- expense and equity accounts the entry posted to when it was decided, so a stale decision still blocks them after its lines change or go;
-- account_domains: for each of them, the domain the decision reached when it was saved (income for an income or expense account, balance for
-- equity) — a held decision is read from this saved record, never from the account as it is now (Codex t3-plan-r5 R5-2).
CREATE TABLE book_entry_classification (
  org_id bigint NOT NULL REFERENCES org (org_id),
  classification_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  return_id bigint NOT NULL,
  source_entity_id bigint NOT NULL,
  txn_id bigint NOT NULL,
  class text NOT NULL CHECK (class IN ('closing', 'correction', 'normal')),
  lines integer[],
  accounts bigint[] NOT NULL DEFAULT '{}',
  account_domains text[] NOT NULL DEFAULT '{}' CHECK (account_domains <@ ARRAY['income', 'balance']::text[]),
  txn_version text NOT NULL,
  reviewed_by text NOT NULL CHECK (length(reviewed_by) BETWEEN 1 AND 200),
  reason text CHECK (length(reason) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, classification_id),
  UNIQUE (org_id, return_id, txn_id),
  FOREIGN KEY (org_id, return_id) REFERENCES tax_return (org_id, return_id),
  FOREIGN KEY (org_id, source_entity_id) REFERENCES entity (org_id, entity_id),
  CHECK ((class = 'closing') = (lines IS NOT NULL AND cardinality(lines) >= 2)),
  CHECK (cardinality(account_domains) = cardinality(accounts))
);

-- §4.11 Timing reviews: one revision-bound decision per (return, transaction, kind), made on the return of the period the money moved
-- (or the accrual was booked) in. include / exclude; slot_key and cents where the decision recognizes money no account measures (an
-- advance, a prepayment, money applied to an opening balance) — always the WHOLE amount the event shows (split decisions are not taken in
-- this stage); recognize_on for a reviewed receipt date (receipt_date: a settlement the bank dated after the money was received).
-- txn_version is the transaction as the person saw it; event_version is the economic event as decided — its amount and the allocation
-- links it was decided against (applications are not part of txn_version, migration 055): either changing makes the decision stale,
-- unresolved until it is made again. affected_accounts: the income and expense accounts the decided event posted to, so a decision whose
-- transaction later changes shape (an accrual entry turned into a cash expense) still names what it decided; affected_domains: what it
-- decided, saved with it (a timing decision decides when income and expense count: income) — never read from the accounts as they are now;
-- source_accounts: the balance accounts the decided money moved through (a prepayment: the prepaid account it was paid into), so an entry
-- that later uses up that balance is tied to this decision by the SAVED record, whatever became of the payment's postings.
CREATE TABLE cash_timing_review (
  org_id bigint NOT NULL REFERENCES org (org_id),
  review_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  return_id bigint NOT NULL,
  source_entity_id bigint NOT NULL,
  txn_id bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('unrestricted_advance', 'refundable_deposit', 'prepaid_expense', 'opening_ar_ap_payment', 'earlier_settlement', 'receipt_date',
    'imported_accrual_je', 'related_party_accrual', 'economic_performance')),
  decision text NOT NULL CHECK (decision IN ('include', 'exclude')),
  slot_key text CHECK (length(slot_key) BETWEEN 3 AND 400),
  cents bigint,
  recognize_on date,
  txn_version text NOT NULL,
  event_version text NOT NULL CHECK (length(event_version) BETWEEN 1 AND 200),
  affected_accounts bigint[] NOT NULL DEFAULT '{}',
  affected_domains text[] NOT NULL DEFAULT '{income}' CHECK (cardinality(affected_domains) >= 1 AND affected_domains <@ ARRAY['income', 'balance']::text[]),
  source_accounts bigint[] NOT NULL DEFAULT '{}',
  reviewed_by text NOT NULL CHECK (length(reviewed_by) BETWEEN 1 AND 200),
  reason text CHECK (length(reason) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, review_id),
  UNIQUE (org_id, return_id, txn_id, kind),
  FOREIGN KEY (org_id, return_id) REFERENCES tax_return (org_id, return_id),
  FOREIGN KEY (org_id, source_entity_id) REFERENCES entity (org_id, entity_id),
  CHECK ((slot_key IS NULL) = (cents IS NULL)),
  CHECK (cents IS NULL OR cents <> 0),
  CHECK ((kind = 'receipt_date') = (recognize_on IS NOT NULL)),
  CHECK (kind <> 'receipt_date' OR decision = 'include')
);

-- §4.7 The manual provider's store: one item per (return, item_key). item_key is a canonical slot key of the period's catalog, or
-- 'answer:k1_inflows' (whether the return receives K-1s; T3 takes only "none"). entered: exactly one value (amount_cents for an amount line,
-- rows for a statement line, detail for an answer line); not_applicable: none. No row = unresolved (spec §0 rule 2: never zero).
CREATE TABLE tax_manual_item (
  org_id bigint NOT NULL REFERENCES org (org_id),
  item_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  return_id bigint NOT NULL,
  item_key text NOT NULL CHECK (length(item_key) BETWEEN 3 AND 400),
  status text NOT NULL CHECK (status IN ('entered', 'not_applicable')),
  amount_cents bigint,
  rows jsonb,
  detail jsonb,
  workpaper text CHECK (length(workpaper) <= 2000),
  source text NOT NULL DEFAULT 'typed' CHECK (source IN ('typed')),
  entered_by text NOT NULL CHECK (length(entered_by) BETWEEN 1 AND 200),
  reviewed_by text CHECK (length(reviewed_by) BETWEEN 1 AND 200),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, item_id),
  UNIQUE (org_id, return_id, item_key),
  FOREIGN KEY (org_id, return_id) REFERENCES tax_return (org_id, return_id),
  CHECK (status = 'entered' OR (amount_cents IS NULL AND rows IS NULL AND detail IS NULL)),
  CHECK (status <> 'entered' OR ((amount_cents IS NOT NULL)::int + (rows IS NOT NULL)::int + (detail IS NOT NULL)::int) = 1)
);

-- §4.6 Adjustments: a group (one decision with its purpose, support and status) and its delta lines in the destination's semantic sign
-- (spec §5.1). source proposal: a rule proposal answered by a person (accepted or rejected with a reason), tied to the source version it was
-- shown at (a changed source makes the answer stale and the proposal unanswered again); person: entered and accepted by the person; engine
-- groups are computed, never stored. withdrawn: a person's accepted group taken back, with the reason — or an accepted proposal answer
-- RETIRED with the reason once its proposal is no longer computed (Codex t3-r2 R2-3: a retirement is not a rejection of the source version;
-- the identical version may be answered again, so the one-answer index leaves retired rows out). superseded_at: set on every earlier answer
-- of the same logical proposal (source_ref) when a later answer is saved (Codex t3-r3 R3-2) — the one unmarked row per key is the OPERATIVE
-- answer, whatever version it names; a superseded row is history (kept with its lines, frozen in revisions), never selected again when its
-- version returns, and never blocks a new answer to that version. Computed totals are never destinations (checked in
-- lib/tax/adjustments.js against the catalog).
-- This migration was edited in place during stage T3 (unreleased; Codex t3-r2/r3). The runner tracks migrations by filename, so a database
-- that applied the pre-edit 066 is not upgraded by rerunning it: such a database (test or scratch only — T3 shipped nowhere) must be rebuilt.
CREATE TABLE tax_adjustment_group (
  org_id bigint NOT NULL REFERENCES org (org_id),
  group_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  return_id bigint NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('meals_50', 'penalties', 'officer_life', 'tax_exempt_interest', 'method_timing', 'book_tax_depreciation', 'k1_replacement', 'elimination',
    'reclass', 'other')),
  source text NOT NULL CHECK (source IN ('proposal', 'person')),
  source_ref text CHECK (length(source_ref) BETWEEN 1 AND 300),
  source_version text CHECK (length(source_version) BETWEEN 1 AND 200),
  memo text NOT NULL CHECK (length(btrim(memo)) BETWEEN 1 AND 500),
  evidence text CHECK (length(evidence) <= 1000),
  status text NOT NULL CHECK (status IN ('accepted', 'rejected', 'withdrawn')),
  reason text CHECK (length(reason) <= 500),
  decided_by text NOT NULL CHECK (length(decided_by) BETWEEN 1 AND 200),
  decided_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  UNIQUE (org_id, group_id),
  FOREIGN KEY (org_id, return_id) REFERENCES tax_return (org_id, return_id),
  CHECK ((source = 'proposal') = (source_ref IS NOT NULL AND source_version IS NOT NULL)),
  CHECK (status NOT IN ('rejected', 'withdrawn') OR length(btrim(coalesce(reason, ''))) > 0),
  CHECK (source = 'proposal' OR status <> 'rejected'),
  CHECK (source = 'proposal' OR length(btrim(coalesce(evidence, ''))) > 0),
  CHECK (source = 'proposal' OR superseded_at IS NULL)
);
-- One LIVE answer per proposal and shown version: a retired (withdrawn) or superseded answer stays as evidence and does not block a new answer.
CREATE UNIQUE INDEX tax_adjustment_group_answer ON tax_adjustment_group (org_id, return_id, source_ref, source_version) WHERE source = 'proposal' AND status <> 'withdrawn' AND superseded_at IS NULL;
-- One operative answer per logical proposal.
CREATE UNIQUE INDEX tax_adjustment_group_operative ON tax_adjustment_group (org_id, return_id, source_ref) WHERE source = 'proposal' AND superseded_at IS NULL;
CREATE TABLE tax_adjustment (
  org_id bigint NOT NULL REFERENCES org (org_id),
  adjustment_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id bigint NOT NULL,
  return_id bigint NOT NULL,
  slot_key text NOT NULL CHECK (length(slot_key) BETWEEN 3 AND 400),
  mode text NOT NULL DEFAULT 'delta' CHECK (mode = 'delta'),
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0),
  m1_class text NOT NULL CHECK (m1_class IN ('meals_50', 'nondeductible', 'tax_exempt', 'method_timing', 'book_tax_depreciation', 'book_tax_gain', 'inventory', 'reclass', 'other')),
  UNIQUE (org_id, adjustment_id),
  FOREIGN KEY (org_id, group_id) REFERENCES tax_adjustment_group (org_id, group_id),
  FOREIGN KEY (org_id, return_id) REFERENCES tax_return (org_id, return_id)
);

-- §4.10 The COGS workpaper per (return, activity), with the inventory treatment stated apart from the valuation:
--   treatment   inventory_as_booked — purchases, labor, section 263A and other costs counted when incurred, as the books record them (an
--               accrual method's inventory, or a cash method's books-and-records inventory method); materials_and_supplies (non-incidental
--               materials and supplies, deducted when paid or used) and other — not reconstructed here: the reviewed path only;
--   valuation   method (cost, lower of cost or market, other) and the Form 1125-A line 9 flags kept as answered: LIFO, a write-down of
--               subnormal goods, a change in determining quantities, cost or valuations — any of them is reviewed-path only.
-- reconstruct: lines 2-5 from the cogs_input routings (an inventory account's movements classified by type), with tax beginning and
-- ending inventory entered here, apart from book Schedule L; reviewed: Form 1125-A lines 1-5 and 7 typed, with their source named. Book
-- COGS (cogs_tieout) is compared with line 8, never used as purchases.
CREATE TABLE tax_cogs_workpaper (
  org_id bigint NOT NULL REFERENCES org (org_id),
  workpaper_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  return_id bigint NOT NULL,
  activity_id bigint NOT NULL,
  path text NOT NULL CHECK (path IN ('reconstruct', 'reviewed')),
  treatment text NOT NULL CHECK (treatment IN ('inventory_as_booked', 'materials_and_supplies', 'other')),
  method text NOT NULL CHECK (method IN ('cost', 'lower_of_cost_or_market', 'other')),
  lifo boolean NOT NULL,
  subnormal_writedown boolean NOT NULL,
  valuation_changed boolean NOT NULL,
  begin_cents bigint,
  end_cents bigint,
  reviewed_lines jsonb,
  source_note text CHECK (length(source_note) <= 1000),
  reviewed_by text NOT NULL CHECK (length(reviewed_by) BETWEEN 1 AND 200),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, workpaper_id),
  UNIQUE (org_id, return_id, activity_id),
  FOREIGN KEY (org_id, return_id) REFERENCES tax_return (org_id, return_id),
  FOREIGN KEY (org_id, activity_id) REFERENCES tax_activity (org_id, activity_id),
  CHECK ((path = 'reviewed') = (reviewed_lines IS NOT NULL)),
  CHECK (path = 'reviewed' OR (treatment = 'inventory_as_booked' AND method <> 'other' AND NOT lifo AND NOT subnormal_writedown AND NOT valuation_changed)),
  CHECK (path = 'reconstruct' OR length(btrim(coalesce(source_note, ''))) > 0)
);
-- A person's classification of one inventory-account posting line (overrides the default by transaction type), tied to the transaction
-- version it was made at.
CREATE TABLE tax_cogs_movement (
  org_id bigint NOT NULL REFERENCES org (org_id),
  movement_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  return_id bigint NOT NULL,
  account_id bigint NOT NULL,
  txn_id bigint NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  class text NOT NULL CHECK (class IN ('purchase', 'return', 'transfer', 'adjustment', 'shrinkage', 'cost_of_sales')),
  txn_version text NOT NULL,
  reviewed_by text NOT NULL CHECK (length(reviewed_by) BETWEEN 1 AND 200),
  affected_domains text[] NOT NULL DEFAULT '{income}' CHECK (cardinality(affected_domains) >= 1 AND affected_domains <@ ARRAY['income', 'balance']::text[]),
  reason text CHECK (length(reason) <= 500),
  UNIQUE (org_id, movement_id),
  UNIQUE (org_id, return_id, account_id, txn_id, line_no),
  FOREIGN KEY (org_id, return_id) REFERENCES tax_return (org_id, return_id),
  FOREIGN KEY (org_id, account_id) REFERENCES account (org_id, account_id)
);

-- Scope (spec §11): every T3 row sits on a return of a company that files (never a disregarded company's own period: its books are computed on
-- the return that includes them); a transaction, an account or an activity it names belongs to that return's company (T3 computes standalone
-- returns; included books are stage T4). Writes are refused unless the period is open.
CREATE FUNCTION tax_check_t3_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; e bigint;
BEGIN
  SELECT entity_id, return_type, status INTO r FROM tax_return WHERE org_id = NEW.org_id AND return_id = NEW.return_id;
  IF r.return_type NOT IN ('form_1065', 'form_1120s') THEN RAISE EXCEPTION '%: stage T3 keeps workpapers for Form 1065 and Form 1120-S returns only', TG_TABLE_NAME; END IF;
  IF r.status <> 'open' THEN RAISE EXCEPTION '%: the period is %, not open', TG_TABLE_NAME, r.status; END IF;
  IF TG_TABLE_NAME IN ('book_entry_classification', 'cash_timing_review') THEN
    IF NEW.source_entity_id <> r.entity_id THEN RAISE EXCEPTION '%: stage T3 decides on the return''s own books only', TG_TABLE_NAME; END IF;
    IF NOT EXISTS (SELECT 1 FROM txn t WHERE t.org_id = NEW.org_id AND t.txn_id = NEW.txn_id AND t.entity_id = NEW.source_entity_id)
      THEN RAISE EXCEPTION '%: the transaction belongs to another company', TG_TABLE_NAME; END IF;
  ELSIF TG_TABLE_NAME = 'tax_cogs_workpaper' THEN
    SELECT return_entity_id INTO e FROM tax_activity WHERE org_id = NEW.org_id AND activity_id = NEW.activity_id;
    IF e IS DISTINCT FROM r.entity_id THEN RAISE EXCEPTION 'tax_cogs_workpaper: the activity belongs to another company''s return'; END IF;
  ELSIF TG_TABLE_NAME = 'tax_cogs_movement' THEN
    SELECT entity_id INTO e FROM account WHERE org_id = NEW.org_id AND account_id = NEW.account_id;
    IF e IS DISTINCT FROM r.entity_id THEN RAISE EXCEPTION 'tax_cogs_movement: the account belongs to another company'; END IF;
    IF NOT EXISTS (SELECT 1 FROM txn t WHERE t.org_id = NEW.org_id AND t.txn_id = NEW.txn_id AND t.entity_id = r.entity_id)
      THEN RAISE EXCEPTION 'tax_cogs_movement: the transaction belongs to another company'; END IF;
  ELSIF TG_TABLE_NAME = 'tax_adjustment' THEN
    IF NOT EXISTS (SELECT 1 FROM tax_adjustment_group g WHERE g.org_id = NEW.org_id AND g.group_id = NEW.group_id AND g.return_id = NEW.return_id)
      THEN RAISE EXCEPTION 'tax_adjustment: the line belongs to another return''s group'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER book_entry_classification_scope BEFORE INSERT OR UPDATE ON book_entry_classification FOR EACH ROW EXECUTE FUNCTION tax_check_t3_scope();
CREATE TRIGGER cash_timing_review_scope BEFORE INSERT OR UPDATE ON cash_timing_review FOR EACH ROW EXECUTE FUNCTION tax_check_t3_scope();
CREATE TRIGGER tax_manual_item_scope BEFORE INSERT OR UPDATE ON tax_manual_item FOR EACH ROW EXECUTE FUNCTION tax_check_t3_scope();
CREATE TRIGGER tax_adjustment_group_scope BEFORE INSERT OR UPDATE ON tax_adjustment_group FOR EACH ROW EXECUTE FUNCTION tax_check_t3_scope();
CREATE TRIGGER tax_adjustment_scope BEFORE INSERT OR UPDATE ON tax_adjustment FOR EACH ROW EXECUTE FUNCTION tax_check_t3_scope();
CREATE TRIGGER tax_cogs_workpaper_scope BEFORE INSERT OR UPDATE ON tax_cogs_workpaper FOR EACH ROW EXECUTE FUNCTION tax_check_t3_scope();
CREATE TRIGGER tax_cogs_movement_scope BEFORE INSERT OR UPDATE ON tax_cogs_movement FOR EACH ROW EXECUTE FUNCTION tax_check_t3_scope();

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON book_entry_classification FOR EACH ROW EXECUTE FUNCTION audit_row('classification_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON cash_timing_review FOR EACH ROW EXECUTE FUNCTION audit_row('review_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON tax_manual_item FOR EACH ROW EXECUTE FUNCTION audit_row('item_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON tax_adjustment_group FOR EACH ROW EXECUTE FUNCTION audit_row('group_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON tax_adjustment FOR EACH ROW EXECUTE FUNCTION audit_row('adjustment_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON tax_cogs_workpaper FOR EACH ROW EXECUTE FUNCTION audit_row('workpaper_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON tax_cogs_movement FOR EACH ROW EXECUTE FUNCTION audit_row('movement_id');
