-- Stage B7, review round 5 (2026-10-14): links made before 051 have no line number, and the open-items report only
-- subtracts a link from a journal entry/check/expense line it names — so an old link would leave its document closed and
-- reopen the other side. Name the line where there's only one it can be (one A/R or A/P line on that transaction);
-- anything else can't be worked out from what's stored, and guessing would misstate balances, so stop and say to rebuild.
-- Imported links are locked (049/050); this only adds the line number, as the importer would have.
SELECT set_config('fb.import', 'on', true);

CREATE TEMP TABLE app_doc_type (type text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO app_doc_type VALUES ('invoice'), ('late_fee'), ('payment'), ('credit_memo'), ('bill'), ('item_receipt'), ('bill_payment'), ('vendor_credit');

CREATE TEMP TABLE app_only_line ON COMMIT DROP AS
SELECT p.txn_id, min(p.line_no) AS line_no
  FROM posting p JOIN account a ON a.account_id = p.account_id AND a.system_key IN ('ar', 'ap')
 GROUP BY p.txn_id HAVING count(DISTINCT p.line_no) = 1;

UPDATE application ap SET credit_line_no = o.line_no
  FROM txn t, app_only_line o
 WHERE ap.credit_line_no IS NULL AND t.txn_id = ap.credit_txn_id AND o.txn_id = t.txn_id
   AND t.type NOT IN (SELECT type FROM app_doc_type);
UPDATE application ap SET charge_line_no = o.line_no
  FROM txn t, app_only_line o
 WHERE ap.charge_line_no IS NULL AND t.txn_id = ap.charge_txn_id AND o.txn_id = t.txn_id
   AND t.type NOT IN (SELECT type FROM app_doc_type);

DO $$
DECLARE n integer; orgs text;
BEGIN
  SELECT count(*), string_agg(DISTINCT ap.org_id::text, ', ') INTO n, orgs
    FROM application ap
    JOIN txn c ON c.txn_id = ap.credit_txn_id JOIN txn d ON d.txn_id = ap.charge_txn_id
   WHERE (ap.credit_line_no IS NULL AND c.type NOT IN (SELECT type FROM app_doc_type))
      OR (ap.charge_line_no IS NULL AND d.type NOT IN (SELECT type FROM app_doc_type));
  IF n > 0 THEN
    RAISE EXCEPTION '% links to journal entries, checks or expenses (org %) were made before line numbers and can''t be '
      'matched to a single A/R or A/P line; re-import those companies from their QuickBooks exports, then migrate again', n, orgs;
  END IF;
END $$;
