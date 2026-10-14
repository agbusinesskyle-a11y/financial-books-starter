-- Text-a-receipt, stage B8. An organization connects its own Twilio number; people it approves text a
-- receipt photo (and the company's name or nickname) to it. The receipt is read by the AI provider, waits for its bank or
-- card charge, and is matched — and added when everything lines up — with a text back saying what happened.

CREATE TABLE sms_settings (
  org_id bigint PRIMARY KEY REFERENCES org (org_id),
  enabled boolean NOT NULL DEFAULT false,
  account_sid text CHECK (account_sid IS NULL OR account_sid ~ '^AC[0-9a-f]{32}$'),
  auth_token_enc text,
  phone text UNIQUE CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{6,14}$'),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON sms_settings FOR EACH ROW EXECUTE FUNCTION audit_row('org_id');

-- Who may text receipts in, and for which companies.
CREATE TABLE sms_sender (
  org_id bigint NOT NULL REFERENCES org (org_id),
  sender_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  phone text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  all_companies boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, phone),
  UNIQUE (org_id, sender_id)
);
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON sms_sender FOR EACH ROW EXECUTE FUNCTION audit_row('sender_id');
CREATE TABLE sms_sender_company (
  org_id bigint NOT NULL,
  sender_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  PRIMARY KEY (sender_id, entity_id),
  FOREIGN KEY (org_id, sender_id) REFERENCES sms_sender (org_id, sender_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id) ON DELETE CASCADE
);

-- Short names people text for a company ("CF", "Sample Feed").
CREATE TABLE company_nickname (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  nickname text NOT NULL CHECK (length(btrim(nickname)) BETWEEN 1 AND 60),
  PRIMARY KEY (entity_id, nickname),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX company_nickname_org ON company_nickname (org_id, lower(nickname));

CREATE TABLE receipt (
  org_id bigint NOT NULL REFERENCES org (org_id),
  receipt_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_id bigint,
  sender_id bigint,
  from_phone text NOT NULL,
  message_sid text NOT NULL UNIQUE,
  body text,
  filename text,
  content_type text,
  content bytea,
  size_bytes integer CHECK (size_bytes IS NULL OR size_bytes BETWEEN 1 AND 10485760),
  -- received: stored, not read yet; needs_company: which company?; waiting: read, the charge hasn't come in;
  -- review: needs a person; added: in the books; rejected; failed: couldn't be read.
  status text NOT NULL CHECK (status IN ('received', 'needs_company', 'waiting', 'review', 'added', 'rejected', 'failed')),
  extracted jsonb,
  vendor_id bigint,
  account_id bigint,
  item_id bigint,
  txn_id bigint,
  note text,
  reply text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  decided_by text,
  UNIQUE (org_id, receipt_id),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id),
  FOREIGN KEY (org_id, sender_id) REFERENCES sms_sender (org_id, sender_id) ON DELETE SET NULL (sender_id),
  FOREIGN KEY (org_id, vendor_id) REFERENCES vendor (org_id, vendor_id),
  FOREIGN KEY (org_id, account_id) REFERENCES account (org_id, account_id),
  FOREIGN KEY (org_id, item_id) REFERENCES bank_feed_item (org_id, item_id) ON DELETE SET NULL (item_id),
  FOREIGN KEY (org_id, txn_id) REFERENCES txn (org_id, txn_id) ON DELETE SET NULL (txn_id)
);
CREATE INDEX receipt_entity ON receipt (org_id, entity_id, status, created_at DESC);
CREATE INDEX receipt_sender ON receipt (org_id, from_phone, created_at DESC);
