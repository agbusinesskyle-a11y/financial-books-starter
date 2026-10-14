-- Reports R5b: the cash flow planner's own items (money expected in or out that isn't an invoice or bill yet) and the
-- balance the company doesn't want to drop below.
CREATE TABLE cash_plan_item (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  item_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  start_date date NOT NULL,
  repeat text NOT NULL DEFAULT 'none' CHECK (repeat IN ('none', 'weekly', 'monthly')),
  end_date date,
  created_by text,
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id)
);
CREATE TABLE cash_plan_setting (
  org_id bigint NOT NULL,
  entity_id bigint NOT NULL,
  threshold_cents bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, entity_id),
  FOREIGN KEY (org_id, entity_id) REFERENCES entity (org_id, entity_id)
);
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON cash_plan_item FOR EACH ROW EXECUTE FUNCTION audit_row('item_id');
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON cash_plan_setting FOR EACH ROW EXECUTE FUNCTION audit_row('entity_id');
