import { createPool } from '../lib/db.js';
import { checkDemoMode } from '../lib/domain/demo.js';
import { resetDemo } from '../lib/data/demo.js';

// The public demo's nightly reset (lib/data/demo.js): wipes the database and rebuilds the sample books as of today, in one
// transaction. Needs DEMO_MODE=1, and refuses any database that isn't empty or already a clean demo — it can't wipe books.
//   DEMO_MODE=1 npm run demo-reset            # rebuild now (the nightly cron job)
//   DEMO_MODE=1 npm run demo-reset -- --if-new  # build only on a new, empty database (the demo app's start command)
// Exits non-zero on any failure, leaving the database as it was.
const ifNew = process.argv.includes('--if-new');
let pool;
try {
  if (checkDemoMode() !== 'demo') throw new Error('demo-reset only runs with DEMO_MODE=1.');
  pool = createPool();
  await resetDemo(pool, { ifNew, log: console.log });
} catch (error) {
  console.error(`demo-reset failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool?.end();
}
