-- Stage B7, review round 2 (2026-10-13): imported history's lines are fixed in every direction — no line can be added to
-- an imported transaction, or moved into or out of one (migration 049 guarded only changes to existing lines).
-- The importer (and any deliberate maintenance) sets fb.import = 'on' for its own transaction.
CREATE OR REPLACE FUNCTION imported_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_parent bigint;
  new_parent bigint;
BEGIN
  IF coalesce(current_setting('fb.import', true), '') = 'on' THEN RETURN coalesce(NEW, OLD); END IF;
  -- txn_line has txn_id, deposit_line has deposit_txn_id (read by name: the trigger serves both tables).
  IF TG_OP <> 'INSERT' THEN old_parent := coalesce(to_jsonb(OLD) ->> 'deposit_txn_id', to_jsonb(OLD) ->> 'txn_id')::bigint; END IF;
  IF TG_OP <> 'DELETE' THEN new_parent := coalesce(to_jsonb(NEW) ->> 'deposit_txn_id', to_jsonb(NEW) ->> 'txn_id')::bigint; END IF;
  IF EXISTS (SELECT 1 FROM txn WHERE txn_id IN (old_parent, new_parent) AND source = 'qbo_import') THEN
    RAISE EXCEPTION 'Imported from QuickBooks: this transaction is part of the books brought over and can’t be changed or deleted. Record a correction as a new transaction.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
DROP TRIGGER imported_line_guard ON txn_line;
DROP TRIGGER imported_deposit_line_guard ON deposit_line;
CREATE TRIGGER imported_line_guard BEFORE INSERT OR UPDATE OR DELETE ON txn_line FOR EACH ROW EXECUTE FUNCTION imported_line_guard();
CREATE TRIGGER imported_deposit_line_guard BEFORE INSERT OR UPDATE OR DELETE ON deposit_line FOR EACH ROW EXECUTE FUNCTION imported_line_guard();

-- Same for payment links: one may be added to imported history (paying an open invoice), but a rebuilt one is never
-- changed or removed. (Re-stated so the function's UPDATE path keeps the new row — see 049.)
CREATE OR REPLACE FUNCTION imported_application_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('fb.import', true), '') = 'on' THEN RETURN coalesce(NEW, OLD); END IF;
  IF OLD.source = 'qbo_import' THEN
    RAISE EXCEPTION 'Imported from QuickBooks: this payment link is part of the books brought over and can’t be removed.' USING ERRCODE = 'P0001';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
