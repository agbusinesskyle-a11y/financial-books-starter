-- Per-company email settings (Settings → Email). One row per entity; no row means "record only".
-- mode 'record': Send records the message and emails nobody. mode 'smtp': sent through the company's
-- own mail server (Gmail/Workspace app password, Outlook, Postmark, Resend, ... all speak SMTP).
-- The SMTP password is AES-256-GCM encrypted with SETTINGS_KEY from the server environment.
CREATE TABLE email_settings (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  mode text NOT NULL DEFAULT 'record' CHECK (mode IN ('record', 'smtp')),
  from_name text,
  from_email text,
  reply_to text,
  smtp_host text,
  smtp_port integer CHECK (smtp_port BETWEEN 1 AND 65535),
  smtp_security text NOT NULL DEFAULT 'starttls' CHECK (smtp_security IN ('tls', 'starttls')),
  smtp_user text,
  smtp_password_enc text,
  last_test_at timestamptz,
  last_test_ok boolean,
  last_test_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, entity_id),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id),
  CHECK (mode = 'record' OR (from_email IS NOT NULL AND smtp_host IS NOT NULL AND smtp_port IS NOT NULL))
);
