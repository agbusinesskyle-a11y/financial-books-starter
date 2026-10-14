-- Forms, stage F3: QBO's "Add subtotal" and "Add text" lines on sales forms. They show on the form and the PDF but post
-- nothing (amount 0); a subtotal line shows the sum of the lines above it since the last subtotal.
ALTER TABLE txn_line ADD COLUMN kind text NOT NULL DEFAULT 'item' CHECK (kind IN ('item', 'subtotal', 'text'));
ALTER TABLE txn_line ADD CONSTRAINT txn_line_kind_amount CHECK (kind = 'item' OR (amount_cents = 0 AND item_id IS NULL AND account_id IS NULL));
