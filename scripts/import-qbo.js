import { createPool } from '../lib/db.js';
import { readQboExport } from '../lib/import/qbo-read.js';
import { importQboCompany } from '../lib/import/qbo-import.js';

// Stage B7: node --env-file=.env scripts/import-qbo.js <export folder> [--org <slug, default APP_ORG>] --company "<name>" [--tz America/Denver]
//   [--accept "<QuickBooks account name>|A/R open items|A/P open items" (repeatable)] [--check]
// Imports one QuickBooks Online company (see lib/import/qbo-read.js for the folder). Every account must equal QuickBooks'
// Trial Balance and the open items its aging reports, or nothing is imported and the command fails — unless that
// difference is accepted by name (and it is then recorded on the import). --check reads the folder and stops.
const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : null; };
const accept = args.flatMap((a, i) => (a === '--accept' ? [args[i + 1]] : []));
const dir = args[0];
const pool = createPool();
try {
  const data = await readQboExport(dir);
  console.log(`read: ${data.accounts.length} accounts, ${data.customers.length} customers, ${data.vendors.length} vendors, ${data.employees.length} employees, `
    + `${data.txns.length} transactions (${data.txns[0]?.date} – ${data.txns.at(-1)?.date}), ${data.openItems.length} open items`);
  if (args.includes('--check')) process.exit(0);
  const slug = opt('org') ?? process.env.APP_ORG;
  if (!/^[a-z0-9_]+$/.test(slug ?? '')) throw new Error('Give the books’ short name with --org (or set APP_ORG).');
  // A first import into new books creates the organization too.
  const { rows: [org] } = await pool.query(`INSERT INTO org (slug, name) VALUES ($1, $2) ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
    RETURNING org_id`, [slug, opt('company') ?? slug]);
  const r = await importQboCompany(pool, { orgId: Number(org.org_id), companyName: opt('company'), timeZone: opt('tz') ?? 'America/Chicago', data, actor: 'qbo-import',
    acceptMismatches: accept });
  const s = r.summary;
  console.log(`imported into company ${r.entityId}: ${s.transactions} transactions ${JSON.stringify(s.byType)}`);
  console.log(`  as journal entries (shape didn't fit): ${JSON.stringify(s.savedAsJournalEntries)}`);
  console.log(`  omitted (no amounts): ${s.omitted}; numbers moved to memo: ${s.numbersMovedToMemo}; accounts renamed: ${s.renamedAccounts}`);
  console.log(`  trial balance: ${r.parity.length ? `${r.parity.length} accepted difference(s): ${s.acceptedMismatches.join('; ')}` : 'every account matches QuickBooks to the penny'}`);
  const o = s.openItems;
  console.log(`  open items: A/R ${(o.ar.open / 100).toFixed(2)} (QuickBooks ${(o.ar.qbo / 100).toFixed(2)}), A/P ${(o.ap.open / 100).toFixed(2)} (QuickBooks ${(o.ap.qbo / 100).toFixed(2)}); `
    + `${o.links} payment links rebuilt (${o.linksToOtherTransactions} to journal entries or checks, ${o.linksByAmount + o.linksForReview} matched by amount only — listed for review); ${o.unmatched} not found${o.ambiguous ? `; ${o.ambiguous} ambiguous` : ''}`);
  if (r.subledger.unmatched.length) console.log(`    ${r.subledger.unmatched.join('\n    ')}`);
  if (s.undeposited.balance) console.log(`  Undeposited Funds ${(s.undeposited.balance / 100).toFixed(2)}: ${s.undeposited.waiting} payment(s) left waiting${s.undeposited.unexplained ? `, ${(s.undeposited.unexplained / 100).toFixed(2)} not explained` : ''}`);
} catch (error) {
  console.error(`import failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
