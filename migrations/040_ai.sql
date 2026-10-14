-- AI, stage B5. Settings → AI: which provider the organization uses (Claude directly, or OpenRouter to pick any model),
-- its API key (encrypted with SETTINGS_KEY), and the model for each job. Off until someone connects a provider.
CREATE TABLE ai_settings (
  org_id bigint PRIMARY KEY REFERENCES org (org_id),
  provider text NOT NULL DEFAULT 'off' CHECK (provider IN ('off', 'anthropic', 'openrouter')),
  api_key_enc text,
  models jsonb NOT NULL DEFAULT '{}',
  web_search boolean NOT NULL DEFAULT true,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON ai_settings FOR EACH ROW EXECUTE FUNCTION audit_row('org_id');

-- Every call to a provider: what for, which model, how much it used, and whether it worked.
CREATE TABLE ai_call (
  org_id bigint NOT NULL REFERENCES org (org_id),
  entity_id bigint,
  call_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  searches integer NOT NULL DEFAULT 0,
  ok boolean NOT NULL,
  error text,
  actor text NOT NULL
);
CREATE INDEX ai_call_org_at ON ai_call (org_id, at DESC);

-- Vendor research on a bank item the books don't recognize: who the business really is, an existing vendor or a new one,
-- and a category — with reasons and sources. A person accepts or rejects it; nothing posts on its own.
CREATE TABLE vendor_research (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  research_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id bigint NOT NULL,
  payee_key text NOT NULL,
  call_id bigint REFERENCES ai_call (call_id),
  status text NOT NULL CHECK (status IN ('done', 'failed')),
  proposal jsonb,
  sources jsonb NOT NULL DEFAULT '[]',
  error text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decision text CHECK (decision IN ('accepted', 'rejected')),
  decided_by text,
  decided_at timestamptz,
  vendor_id bigint,
  UNIQUE (org_id, research_id),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id),
  FOREIGN KEY (org_id, item_id) REFERENCES bank_feed_item (org_id, item_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, vendor_id) REFERENCES vendor (org_id, vendor_id)
);
CREATE INDEX vendor_research_key ON vendor_research (entity_id, payee_key, created_at DESC);
