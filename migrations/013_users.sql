-- Settings S1: people who sign in, their invites, and the company's legal details and logo.

CREATE TABLE app_user (
  org_id bigint NOT NULL REFERENCES org,
  user_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'standard', 'customers', 'vendors', 'reports')),
  can_approve_bills boolean NOT NULL DEFAULT false,
  password_hash text,
  totp_enc text,
  last_totp_counter bigint NOT NULL DEFAULT -1,
  -- Bumped when sign-in is reset, so sessions from the old password end at once.
  signin_version integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  invited_by text,
  UNIQUE (org_id, user_id),
  CHECK ((password_hash IS NULL) = (totp_enc IS NULL))
);
CREATE UNIQUE INDEX app_user_email ON app_user (org_id, lower(email));

-- One-time links that let an invited person set their password and authenticator. Only the hash is kept.
CREATE TABLE user_invite (
  org_id bigint NOT NULL,
  invite_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL,
  token_hash text NOT NULL UNIQUE,
  -- The authenticator secret shown on the setup page, kept so the QR code stays the same on reload.
  totp_pending_enc text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_by text,
  FOREIGN KEY (org_id, user_id) REFERENCES app_user (org_id, user_id) ON DELETE CASCADE
);
CREATE INDEX user_invite_user ON user_invite (user_id);

ALTER TABLE entity
  ADD COLUMN legal_name text,
  ADD COLUMN ein_enc text,
  ADD COLUMN ein_last4 text,
  ADD COLUMN business_type text,
  ADD COLUMN website text,
  ADD COLUMN customer_email text,
  ADD COLUMN customer_address jsonb,
  ADD COLUMN logo bytea,
  ADD COLUMN logo_type text CHECK (logo_type IN ('image/png', 'image/jpeg')),
  ADD CHECK ((logo IS NULL) = (logo_type IS NULL));
