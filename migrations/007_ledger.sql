-- Chart of accounts and the double-entry ledger (stage V1).

CREATE TABLE account (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  account_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  number text,
  type text NOT NULL CHECK (type IN ('bank', 'accounts_receivable', 'other_current_asset', 'inventory', 'fixed_asset', 'other_asset',
    'accounts_payable', 'credit_card', 'other_current_liability', 'long_term_liability', 'equity',
    'income', 'other_income', 'cost_of_goods_sold', 'expense', 'other_expense')),
  parent_id bigint,
  description text,
  system_key text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, account_id),
  UNIQUE (org_id, entity_id, name),
  UNIQUE (org_id, entity_id, number),
  UNIQUE (org_id, entity_id, system_key),
  CHECK (parent_id IS NULL OR parent_id <> account_id),
  CHECK (system_key IS NULL OR parent_id IS NULL),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id),
  FOREIGN KEY (org_id, parent_id) REFERENCES account (org_id, account_id)
);

ALTER TABLE item ADD COLUMN income_account_id bigint,
  ADD FOREIGN KEY (org_id, income_account_id) REFERENCES account (org_id, account_id);

-- Deposits have no customer. account_id: a sales receipt's deposit-to account, a deposit's bank account.
ALTER TABLE txn ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE txn DROP CONSTRAINT txn_type_check;
ALTER TABLE txn ADD CONSTRAINT txn_type_check CHECK (type IN ('invoice', 'payment', 'sales_receipt', 'credit_memo', 'late_fee', 'deposit'));
ALTER TABLE txn ADD CONSTRAINT txn_party_check CHECK ((type = 'deposit') = (customer_id IS NULL));
ALTER TABLE txn ADD COLUMN account_id bigint,
  ADD FOREIGN KEY (org_id, account_id) REFERENCES account (org_id, account_id);
ALTER TABLE txn ADD CONSTRAINT txn_deposit_account CHECK (type <> 'deposit' OR account_id IS NOT NULL);
CREATE INDEX txn_entity_type ON txn (org_id, entity_id, type, txn_date DESC);

-- What a deposit is made of: customer payments / sales receipts out of Undeposited Funds (source_txn_id),
-- or other funds credited to an account.
CREATE TABLE deposit_line (
  org_id bigint NOT NULL,
  deposit_txn_id bigint NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  source_txn_id bigint UNIQUE,
  account_id bigint,
  customer_id bigint,
  description text,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  PRIMARY KEY (deposit_txn_id, line_no),
  CHECK ((source_txn_id IS NULL) <> (account_id IS NULL)),
  FOREIGN KEY (org_id, deposit_txn_id) REFERENCES txn (org_id, txn_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, source_txn_id) REFERENCES txn (org_id, txn_id),
  FOREIGN KEY (org_id, account_id) REFERENCES account (org_id, account_id),
  FOREIGN KEY (org_id, customer_id) REFERENCES customer (org_id, customer_id)
);

-- One row per debit (positive) or credit (negative). Rewritten whenever its transaction changes.
CREATE TABLE posting (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  posting_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  txn_id bigint NOT NULL,
  line_no integer,
  account_id bigint NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0),
  txn_date date NOT NULL,
  customer_id bigint,
  project_id bigint,
  item_id bigint,
  memo text,
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id),
  FOREIGN KEY (org_id, txn_id) REFERENCES txn (org_id, txn_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, account_id) REFERENCES account (org_id, account_id),
  FOREIGN KEY (org_id, customer_id) REFERENCES customer (org_id, customer_id),
  FOREIGN KEY (org_id, project_id) REFERENCES project (org_id, project_id),
  FOREIGN KEY (org_id, item_id) REFERENCES item (org_id, item_id)
);
CREATE INDEX posting_account ON posting (account_id, txn_date, posting_id);
CREATE INDEX posting_txn ON posting (txn_id);

-- A transaction's postings must net to zero when the database transaction commits.
CREATE FUNCTION posting_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  t bigint := CASE WHEN TG_OP = 'DELETE' THEN OLD.txn_id ELSE NEW.txn_id END;
  s numeric;
BEGIN
  SELECT coalesce(sum(amount_cents), 0) INTO s FROM posting WHERE txn_id = t;
  IF s <> 0 THEN
    RAISE EXCEPTION 'postings for transaction % are out of balance by % cents', t, s USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER posting_balanced AFTER INSERT OR UPDATE OR DELETE ON posting
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION posting_balanced();
