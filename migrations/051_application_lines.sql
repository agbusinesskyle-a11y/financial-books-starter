-- Stage B7, review round 4 (2026-10-13): a link the importer rebuilds to another transaction's A/R or A/P line (a
-- journal entry, a refund check) names that line, so it settles only that line — an entry can have lines on both A/R
-- and A/P, or for several customers or vendors. NULL for a document, which is one side and one name throughout.
ALTER TABLE application ADD COLUMN credit_line_no integer, ADD COLUMN charge_line_no integer;
