// scripts/tax-baseline-import.mjs — import one baseline payload JSON (spec §4.3) for one company. The payload lives OUTSIDE the
// repo: it holds a filed return's figures. Importing the same payload again creates nothing; changed content needs a new
// payloadVersion (lib/tax/baselines.js refuses otherwise).
// Usage: DATABASE_URL=... node scripts/tax-baseline-import.mjs <org slug> <entity id> <payload.json>
import { readFile } from 'node:fs/promises';
import { createPool } from '../lib/db.js';
import { importBaseline } from '../lib/tax/baselines.js';

const [slug, entityArg, file] = process.argv.slice(2);
if (!slug || !entityArg || !file || !/^\d{1,18}$/.test(entityArg)) {
  console.error('usage: tax-baseline-import <org slug> <entity id> <payload.json>');
  process.exit(2);
}
const entityId = Number(entityArg);
const pool = createPool();
try {
  const { rows: [org] } = await pool.query('SELECT org_id FROM org WHERE slug = $1', [slug]);
  if (!org) throw new Error(`no org ${slug}`);
  const { rows: [entity] } = await pool.query('SELECT name FROM entity WHERE org_id = $1 AND entity_id = $2', [org.org_id, entityId]);
  if (!entity) throw new Error(`no company ${entityId} in org ${slug}`);
  const payload = JSON.parse(await readFile(file, 'utf8'));
  const r = await importBaseline(pool, { orgId: org.org_id, entityId, payload, actor: 'baseline import' });
  console.log(r.created ? `imported baseline ${r.baselineId} for ${entity.name} (${payload.facts.length} facts)` : `already imported as baseline ${r.baselineId} for ${entity.name}`);
} catch (error) {
  console.error(`tax-baseline-import: ${error.message}`);
  process.exitCode = 1;
} finally { await pool.end(); }
