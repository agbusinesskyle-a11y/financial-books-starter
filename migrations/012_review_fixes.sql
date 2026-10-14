-- Fixes from the V2–V5 review.

-- Bank details that arrived through an "Ask vendor for info" link must be confirmed (e.g. by phone) before paying.
ALTER TABLE vendor
  ADD COLUMN bank_changed_at timestamptz,
  ADD COLUMN bank_verified boolean NOT NULL DEFAULT true;

-- A vendor credit applied to a bill as part of a bill payment remembers that payment, so voiding or deleting the
-- payment also takes the credit back off the bill.
ALTER TABLE application ADD COLUMN via_txn_id bigint,
  ADD FOREIGN KEY (org_id, via_txn_id) REFERENCES txn (org_id, txn_id) ON DELETE SET NULL (via_txn_id);
CREATE INDEX application_via ON application (via_txn_id) WHERE via_txn_id IS NOT NULL;
