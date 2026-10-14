-- Applications (review fixes after Reports R5):
-- 1. Each application of a payment or credit to a charge is its own dated row. Applying more of the same payment to the
--    same invoice later used to add into the first row and keep the first date, so cash-basis income and as-of aging
--    put the later part on the earlier date.
-- 2. An application can't be dated before the payment/credit or the charge it connects (it would reduce an invoice
--    before the money existed, or before the invoice did). Enforced for every writer, and existing rows are corrected.
ALTER TABLE application DROP CONSTRAINT application_credit_txn_id_charge_txn_id_key;
CREATE INDEX application_credit ON application (credit_txn_id);

CREATE FUNCTION application_date() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.applied_on := GREATEST(NEW.applied_on,
    (SELECT txn_date FROM txn WHERE txn_id = NEW.credit_txn_id), (SELECT txn_date FROM txn WHERE txn_id = NEW.charge_txn_id));
  RETURN NEW;
END $$;
CREATE TRIGGER application_date BEFORE INSERT OR UPDATE ON application FOR EACH ROW EXECUTE FUNCTION application_date();

UPDATE application a SET applied_on = applied_on
 WHERE applied_on < GREATEST((SELECT txn_date FROM txn WHERE txn_id = a.credit_txn_id), (SELECT txn_date FROM txn WHERE txn_id = a.charge_txn_id));
