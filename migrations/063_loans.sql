-- Loans page: which accounts it lists and the other side of a loan between two companies of the organization.
-- loan_list: 'show' or 'hide' overrides the page's own rule (every long-term liability, and other liability or asset accounts
-- named like a loan); NULL follows the rule.
ALTER TABLE account ADD COLUMN loan_list text CHECK (loan_list IN ('show', 'hide'));
-- The same loan in another company's books (the lender's receivable for a borrower's payable, or the other way round), set
-- by a person on the Loans page; never guessed from names. Kept on both accounts, each naming the other: the key below makes
-- the other account name this one back (checked at commit, so both are set in one transaction), and the unique index lets
-- only one account name any account, so a loan has exactly one counterpart and pairings can't chain (A→B, B→C).
-- Same organization by the key; another company, checked on save.
ALTER TABLE account ADD COLUMN loan_other_account_id bigint,
  ADD CONSTRAINT account_loan_pair_key UNIQUE (org_id, account_id, loan_other_account_id),
  ADD CONSTRAINT account_loan_pair_back FOREIGN KEY (org_id, loan_other_account_id, account_id)
    REFERENCES account (org_id, account_id, loan_other_account_id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT account_loan_pair_other CHECK (loan_other_account_id IS DISTINCT FROM account_id);
CREATE UNIQUE INDEX account_loan_other ON account (loan_other_account_id) WHERE loan_other_account_id IS NOT NULL;
