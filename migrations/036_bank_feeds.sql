-- Bank feeds, stage B2: the link to ledgerline (the bank-facts service). Each company is linked to one ledgerline company
-- (entity); each of that company's ledgerline accounts is mapped once to a books account (or left out). A puller copies
-- the bank's transactions into bank_feed_item, keyed by ledgerline's stable transaction_id. Nothing here is written back to
-- ledgerline: it is read with a read-only role.

CREATE TABLE ledgerline_link (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  ll_entity_id uuid NOT NULL,
  ll_entity_name text NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  linked_by text NOT NULL,
  last_pull_at timestamptz,
  -- The newest ledgerline sync this company has pulled; a newer one means there is something to pull.
  last_seen_sync_at timestamptz,
  PRIMARY KEY (entity_id),
  UNIQUE (org_id, entity_id),
  UNIQUE (org_id, ll_entity_id),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id)
);

-- One row per ledgerline account owned by a linked company. books_account_id NULL with include = false means "don't bring
-- these in"; NULL with include = true means not mapped yet.
CREATE TABLE ledgerline_account (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  ll_account_id uuid NOT NULL,
  display_name text NOT NULL,
  institution_name text,
  mask text,
  kind text NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  connection_state text,
  verification_state text,
  -- Latest bank balance in the account's own orientation: money in the account, or owed on a card or loan.
  bank_balance_cents bigint,
  balance_as_of timestamptz,
  balance_stale boolean NOT NULL DEFAULT true,
  books_account_id bigint,
  include boolean NOT NULL DEFAULT true,
  start_date date,
  mapped_by text,
  mapped_at timestamptz,
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ll_account_id),
  UNIQUE (org_id, ll_account_id),
  FOREIGN KEY (org_id, entity_id) REFERENCES ledgerline_link (org_id, entity_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, books_account_id) REFERENCES account (org_id, account_id),
  CHECK (books_account_id IS NULL OR include)
);
-- A books account takes one bank feed.
CREATE UNIQUE INDEX ledgerline_account_books ON ledgerline_account (books_account_id) WHERE books_account_id IS NOT NULL;

-- Ledgerline's certified account-months (shown as "verified" and used by Reconcile in stage B6).
CREATE TABLE ledgerline_verified_month (
  org_id bigint NOT NULL,
  ll_account_id uuid NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  certified_at timestamptz NOT NULL,
  PRIMARY KEY (ll_account_id, period_start),
  FOREIGN KEY (org_id, ll_account_id) REFERENCES ledgerline_account (org_id, ll_account_id) ON DELETE CASCADE
);

-- The bank's transactions. amount_cents uses the bank sign: money into the account positive, money out negative (a card
-- purchase is negative, a card payment positive). review_state is what the books did with it (stage B3);
-- bank_state is what the bank says now; attention flags an item the books already used that the bank later removed or
-- changed.
CREATE TABLE bank_feed_item (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  item_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ll_transaction_id uuid NOT NULL,
  ll_account_id uuid NOT NULL,
  revision integer NOT NULL,
  pending boolean NOT NULL,
  posted_date date NOT NULL,
  authorized_date date,
  amount_cents bigint NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  description text NOT NULL DEFAULT '',
  original_description text,
  merchant_name text,
  category text,
  category_detail text,
  payment_channel text,
  check_number text,
  counterparties jsonb,
  scope text NOT NULL DEFAULT 'included',
  bank_state text NOT NULL DEFAULT 'active' CHECK (bank_state IN ('active', 'removed')),
  review_state text NOT NULL DEFAULT 'new' CHECK (review_state IN ('new', 'added', 'matched', 'excluded')),
  attention text CHECK (attention IN ('removed', 'changed')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, item_id),
  UNIQUE (org_id, ll_transaction_id),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id),
  FOREIGN KEY (org_id, ll_account_id) REFERENCES ledgerline_account (org_id, ll_account_id)
);
CREATE INDEX bank_feed_item_account ON bank_feed_item (ll_account_id, posted_date);
CREATE INDEX bank_feed_item_review ON bank_feed_item (entity_id, review_state, bank_state);

-- Every pull, for the Bank connections page.
CREATE TABLE bank_feed_pull (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  pull_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trigger text NOT NULL CHECK (trigger IN ('schedule', 'refresh', 'link')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'failed')),
  new_count integer NOT NULL DEFAULT 0,
  updated_count integer NOT NULL DEFAULT 0,
  removed_count integer NOT NULL DEFAULT 0,
  warning text,
  error text,
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id)
);
CREATE INDEX bank_feed_pull_entity ON bank_feed_pull (entity_id, started_at DESC);

-- Linking and mapping are audited (the items themselves are the bank's record, kept here with their own history fields).
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON ledgerline_link FOR EACH ROW EXECUTE FUNCTION audit_row('entity_id');
