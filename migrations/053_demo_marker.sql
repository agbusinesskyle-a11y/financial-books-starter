-- Public demo (DEMO_MODE=1, lib/domain/demo.js): the mark that says "this database is a throwaway demo". Only
-- `npm run demo-reset` writes it, right after wiping the database and rebuilding the sample books, and it refuses to wipe
-- a database that has data but no mark. The app, migrations and jobs refuse to run in demo mode without the mark (and
-- refuse to run as normal books with it), so real books and the demo can never be mixed up. Empty in real books.
CREATE TABLE demo_marker (
  only_row boolean PRIMARY KEY DEFAULT true CHECK (only_row),
  database_name text NOT NULL,
  org_slug text NOT NULL CHECK (org_slug = 'sample'),
  companies integer NOT NULL CHECK (companies > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  reset_at timestamptz NOT NULL DEFAULT now()
);
