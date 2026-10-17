// scripts/tax-reconcile-own-tax-ids.mjs — the one-time T2 transition (Codex t2-plan-r1 B9): every party that is one of our own companies
// gets its EIN authority settled (lib/tax/parties.js reconcileOwnCompanyTaxIds). Idempotent: a rerun changes nothing. Prints counts only,
// never an id. A conflict is listed by party number for an admin to settle on the Tax setup page; nothing is chosen silently.
// Usage: DATABASE_URL=... SETTINGS_KEY=... node scripts/tax-reconcile-own-tax-ids.mjs <org slug>
import { createPool } from '../lib/db.js';
import { reconcileOwnCompanyTaxIds } from '../lib/tax/parties.js';

const [slug] = process.argv.slice(2);
if (!slug) {
  console.error('usage: tax-reconcile-own-tax-ids <org slug>');
  process.exit(2);
}
const pool = createPool();
try {
  const { rows: [org] } = await pool.query('SELECT org_id FROM org WHERE slug = $1', [slug]);
  if (!org) throw new Error(`no org ${slug}`);
  const r = await reconcileOwnCompanyTaxIds(pool, { orgId: org.org_id, env: process.env });
  console.log(`company EIN only: ${r.companyOnly}; moved from the party: ${r.moved}; matching: ${r.matched}; conflicts: ${r.conflicts}`);
  const { rows } = await pool.query(`SELECT party_id FROM tax_party WHERE org_id = $1 AND kind = 'entity_in_org' AND own_tax_id_state = 'conflict' ORDER BY party_id`, [org.org_id]);
  if (rows.length) console.log(`conflicts to settle (party numbers): ${rows.map(x => x.party_id).join(', ')}`);
} catch (error) {
  console.error(`tax-reconcile-own-tax-ids: ${error.message}`);
  process.exitCode = 1;
} finally { await pool.end(); }
