import { createPool } from '../../lib/db.js';
import { isPractice, checkBooksMode } from '../../lib/domain/practice.js';
import { runMigrations } from '../../lib/migrate.js';
import { ensureLedger } from '../../lib/data/ledger.js';

// A mistyped BOOKS_MODE stops everything before the database is touched.
checkBooksMode();
const pool = createPool();
try {
  const { applied, skipped } = await runMigrations(pool);
  console.log(`migrate: applied ${applied.length} skipped ${skipped.length}${applied.length ? ` (${applied.join(', ')})` : ''}`);
  const ledger = await ensureLedger(pool, { repair: !isPractice() });
  console.log(`ledger: ${ledger.entities} companies checked, ${ledger.reposted} transactions posted`);
  if (ledger.missing) console.warn(`ledger: practice copy — ${ledger.missing} transaction(s) have no postings; not repaired automatically. Run the repair deliberately.`);
} catch (error) {
  console.error(`migrate failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
