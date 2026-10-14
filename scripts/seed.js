import { createPool } from '../lib/db.js';
import { generateSample } from '../lib/seed/generate.js';
import { writeSample } from '../lib/data/seed.js';
import { todayIn } from '../lib/domain/dates.js';

// Replaces the "sample" org with freshly generated books as of today (or SEED_AS_OF=YYYY-MM-DD).
const asOf = process.env.SEED_AS_OF || todayIn('America/Chicago');
const pool = createPool();
try {
  const sample = generateSample({ asOf });
  const ids = await writeSample(pool, sample);
  console.log(`seed: org ${ids.orgId} as of ${asOf}: ${sample.customers.length} customers, ${sample.txns.length} transactions, ` +
    `${sample.applications.length} applications, ${sample.activity.length} activity events`);
} catch (error) {
  console.error(`seed failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
