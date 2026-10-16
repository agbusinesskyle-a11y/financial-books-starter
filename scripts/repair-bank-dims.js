import { createPool, withTransaction } from '../lib/db.js';
import { repost } from '../lib/data/ledger.js';
import { lockEntity } from '../lib/data/writes.js';
import { refuseDemoDatabase } from '../lib/data/demo.js';

// Bank review v2: node --env-file=.env scripts/repair-bank-dims.js [--apply]
// Before BR-1, a bank item added with a class or location (from a rule) put it on the transaction but not on its postings,
// so reports by class and location left it out. This lists every transaction a bank item added whose class or location
// is on the transaction but missing from any of its postings; --apply writes their postings again (company by company,
// under the company lock). Amounts and accounts don't change — only the class/location tags on the postings.
const apply = process.argv.includes('--apply');
const pool = createPool();
try {
  // Not for the public demo (DEMO_MODE=1, or a database demo-reset made): it has no bank feeds to repair.
  await refuseDemoDatabase(pool);
  const { rows } = await pool.query(`
    SELECT t.org_id, t.entity_id, t.txn_id, t.type, t.txn_date, t.class_id, t.location_id
      FROM txn t
     WHERE EXISTS (SELECT 1 FROM bank_feed_link k WHERE k.txn_id = t.txn_id AND k.how = 'added')
       AND (t.class_id IS NOT NULL OR t.location_id IS NOT NULL)
       AND EXISTS (SELECT 1 FROM posting p WHERE p.txn_id = t.txn_id
                    AND ((t.location_id IS NOT NULL AND p.location_id IS DISTINCT FROM t.location_id)
                      OR (t.class_id IS NOT NULL AND p.class_id IS NULL)))
     ORDER BY t.org_id, t.entity_id, t.txn_id`);
  console.log(`${rows.length} bank-added transaction(s) with a class or location missing from their postings.`);
  for (const r of rows) console.log(`  company ${r.entity_id}: ${r.type} ${r.txn_id} on ${r.txn_date} (class ${r.class_id ?? '—'}, location ${r.location_id ?? '—'})`);
  if (apply && rows.length) {
    const byCompany = Map.groupBy(rows, r => `${r.org_id}|${r.entity_id}`);
    for (const list of byCompany.values()) {
      await withTransaction(pool, async tx => {
        await lockEntity(tx, list[0].org_id, list[0].entity_id);
        for (const r of list) await repost(tx, r.org_id, r.txn_id);
      });
    }
    console.log('Postings written again.');
  } else if (rows.length) console.log('Dry run — nothing changed. Run again with --apply to fix them.');
} finally {
  await pool.end();
}
