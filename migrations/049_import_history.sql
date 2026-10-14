-- Stage B7, after the independent review (2026-10-13): imported QuickBooks history is a record of what QuickBooks had, so
-- it is kept as it was. It can be paid (an open invoice or bill takes payments and credits), scheduled, printed and
-- emailed, but its accounting content can't be edited, voided or deleted; a correction is a new transaction.
-- Bypass for maintenance (e.g. removing a whole imported company): SET LOCAL fb.import = 'on'.

-- A sale's cost of goods sold, which QuickBooks keeps inside the sale, is its own journal entry here, tied to the sale.
ALTER TABLE txn ADD COLUMN companion_of_txn_id bigint,
  ADD CONSTRAINT txn_companion FOREIGN KEY (org_id, companion_of_txn_id) REFERENCES txn (org_id, txn_id) ON DELETE CASCADE;
-- An imported payment or sales receipt still waiting in Undeposited Funds when the books were brought over.
ALTER TABLE txn ADD COLUMN import_undeposited boolean NOT NULL DEFAULT false;
-- Which of QuickBooks' settled invoices/bills each historical payment or credit paid isn't in its exports: those links are
-- rebuilt (oldest first, leaving exactly QuickBooks' open amounts open) and marked as rebuilt.
ALTER TABLE application ADD COLUMN source text CHECK (source IS NULL OR source = 'qbo_import');

CREATE FUNCTION imported_txn_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  -- Columns that may change on imported history: being paid, scheduled for payment, printed or queued.
  allowed text[] := ARRAY['open_cents', 'foreign_open_cents', 'updated_at', 'printed_at', 'print_later', 'send_later',
    'scheduled_pay_date', 'scheduled_account_id', 'scheduled_method', 'scheduled_by'];
BEGIN
  IF coalesce(current_setting('fb.import', true), '') = 'on' THEN RETURN coalesce(NEW, OLD); END IF;
  IF OLD.source = 'qbo_import' THEN
    IF TG_OP = 'DELETE' OR (to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed) THEN
      RAISE EXCEPTION 'Imported from QuickBooks: this transaction is part of the books brought over and can’t be changed or deleted. Record a correction as a new transaction.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER imported_txn_guard BEFORE UPDATE OR DELETE ON txn FOR EACH ROW EXECUTE FUNCTION imported_txn_guard();

-- Its lines (and a deposit's lines) are fixed too.
CREATE FUNCTION imported_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent bigint;
BEGIN
  IF coalesce(current_setting('fb.import', true), '') = 'on' THEN RETURN coalesce(NEW, OLD); END IF;
  -- txn_line has txn_id, deposit_line has deposit_txn_id (read by name: the trigger serves both tables).
  parent := coalesce(to_jsonb(OLD) ->> 'deposit_txn_id', to_jsonb(OLD) ->> 'txn_id')::bigint;
  IF TG_OP <> 'INSERT' AND EXISTS (SELECT 1 FROM txn WHERE txn_id = parent AND source = 'qbo_import') THEN
    RAISE EXCEPTION 'Imported from QuickBooks: this transaction is part of the books brought over and can’t be changed or deleted. Record a correction as a new transaction.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER imported_line_guard BEFORE UPDATE OR DELETE ON txn_line FOR EACH ROW EXECUTE FUNCTION imported_line_guard();
CREATE TRIGGER imported_deposit_line_guard BEFORE UPDATE OR DELETE ON deposit_line FOR EACH ROW EXECUTE FUNCTION imported_line_guard();

-- An application to or from imported history may be added (paying an open invoice) but a rebuilt one isn't removed.
CREATE FUNCTION imported_application_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- (An UPDATE must go ahead with NEW; returning OLD would silently undo it.)
  IF coalesce(current_setting('fb.import', true), '') = 'on' THEN RETURN coalesce(NEW, OLD); END IF;
  IF OLD.source = 'qbo_import' THEN
    RAISE EXCEPTION 'Imported from QuickBooks: this payment link is part of the books brought over and can’t be removed.' USING ERRCODE = 'P0001';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER imported_application_guard BEFORE UPDATE OR DELETE ON application FOR EACH ROW EXECUTE FUNCTION imported_application_guard();
