-- Public demo: the demo mark also names the database by its internal id, so a copy restored onto another server under the
-- same name doesn't pass for the demo it was copied from (lib/data/demo.js readMarker). Empty in real books.
ALTER TABLE demo_marker ADD COLUMN database_oid oid;
