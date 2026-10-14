-- Forms, stage F4: the rest of QBO's invoice / estimate / sales receipt / credit memo fields.
ALTER TABLE txn
  ADD COLUMN email_cc text,            -- copies for this transaction's email (default: the customer's Cc/Bcc)
  ADD COLUMN email_bcc text,
  ADD COLUMN bill_to text,             -- the Bill to address as shown on this document (editable; default: the customer's)
  ADD COLUMN ship_to text,
  ADD COLUMN ship_via text,
  ADD COLUMN ship_date date,
  ADD COLUMN tracking_no text,
  ADD COLUMN po_number text,           -- the customer's P.O. reference
  ADD COLUMN internal_note text,       -- never shown to the customer
  ADD COLUMN statement_memo text,      -- shown on statements instead of the transaction's memo
  ADD COLUMN print_later boolean NOT NULL DEFAULT false,
  ADD COLUMN send_later boolean NOT NULL DEFAULT false,
  ADD COLUMN accepted_by text,         -- estimates
  ADD COLUMN accepted_date date,
  ADD COLUMN deposit_request_percent numeric(5,2) CHECK (deposit_request_percent IS NULL OR (deposit_request_percent > 0 AND deposit_request_percent <= 100));
CREATE INDEX txn_print_later ON txn (org_id, entity_id) WHERE print_later;
CREATE INDEX txn_send_later ON txn (org_id, entity_id) WHERE send_later;
