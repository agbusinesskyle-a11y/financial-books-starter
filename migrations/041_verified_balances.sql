-- Reconcile with ledgerline, stage B6: each verified month keeps its statement's opening and closing balance (in the
-- account's own orientation: money in the account, or owed on a card or loan).
ALTER TABLE ledgerline_verified_month ADD COLUMN opening_cents bigint, ADD COLUMN closing_cents bigint;
