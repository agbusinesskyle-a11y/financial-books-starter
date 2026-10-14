-- Forms, stage F5: QBO's deposit "Cash back" — part of what's being deposited kept as cash. The bank
-- gets the rest (txn.total_cents is the net deposit); the cash goes to the chosen account (petty cash, owner's draw ...).
ALTER TABLE txn
  ADD COLUMN cash_back_account_id bigint,
  ADD COLUMN cash_back_cents bigint NOT NULL DEFAULT 0 CHECK (cash_back_cents >= 0),
  ADD COLUMN cash_back_memo text,
  ADD CONSTRAINT txn_cash_back_account FOREIGN KEY (org_id, cash_back_account_id) REFERENCES account (org_id, account_id),
  ADD CONSTRAINT txn_cash_back_only_deposits CHECK (cash_back_cents = 0 OR (type = 'deposit' AND cash_back_account_id IS NOT NULL));
