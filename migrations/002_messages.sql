-- Outbound and hand-logged inbound messages: transaction sends, statement sends, Conversations.
CREATE TABLE message (
  org_id bigint NOT NULL,
  message_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id bigint NOT NULL,
  direction text NOT NULL CHECK (direction IN ('out', 'in')),
  subject text,
  body text NOT NULL DEFAULT '',
  to_addr text,
  from_addr text,
  related_txn_id bigint,
  status text NOT NULL CHECK (status IN ('logged', 'sent', 'failed')),
  error text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, customer_id) REFERENCES customer (org_id, customer_id),
  FOREIGN KEY (org_id, related_txn_id) REFERENCES txn (org_id, txn_id) ON DELETE SET NULL (related_txn_id)
);
CREATE INDEX message_customer_time ON message (org_id, customer_id, occurred_at DESC, message_id DESC);
