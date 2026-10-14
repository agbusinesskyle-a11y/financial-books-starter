-- Fixes from the S1–S6 review: a foreign invoice keeps its discount and shipping in its own currency, so re-saving it
-- doesn't move the total by rounding.
ALTER TABLE txn ADD COLUMN foreign_discount_cents bigint, ADD COLUMN foreign_shipping_cents bigint;
