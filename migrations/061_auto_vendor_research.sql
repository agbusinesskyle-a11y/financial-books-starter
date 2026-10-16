-- Bank review v3, stage S5: vendor research runs on its own after a pull for money-out lines nothing else
-- recognizes. A call is reserved (status 'pending') before the AI provider is asked, under the company lock, so the daily
-- limit holds and two pulls never pay for the same payee twice; a failed call counts toward the limit and the payee isn't
-- tried again for a week.
ALTER TABLE vendor_research DROP CONSTRAINT vendor_research_status_check;
ALTER TABLE vendor_research ADD CONSTRAINT vendor_research_status_check CHECK (status IN ('pending', 'done', 'failed'));
ALTER TABLE vendor_research ADD COLUMN auto boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX vendor_research_in_flight ON vendor_research (entity_id, payee_key) WHERE status = 'pending';
CREATE INDEX vendor_research_auto_day ON vendor_research (entity_id, created_at) WHERE auto;

-- Every automatic call, kept apart from the bank lines (which can be deleted when a feed is unmapped): the daily limit and
-- the week-long wait for a payee are counted here, so nothing resets them.
CREATE TABLE vendor_research_attempt (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  attempt_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payee_key text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id)
);
CREATE INDEX vendor_research_attempt_day ON vendor_research_attempt (entity_id, at);
CREATE INDEX vendor_research_attempt_key ON vendor_research_attempt (entity_id, payee_key, at);
-- The amount of the line a research was about: its category carries to another line of the payee only for a like amount.
ALTER TABLE vendor_research ADD COLUMN amount_cents bigint;
-- Exactly what the researched line said (bank text, merchant, amount): its own research applies to it only while it still says so.
ALTER TABLE vendor_research ADD COLUMN context text;
