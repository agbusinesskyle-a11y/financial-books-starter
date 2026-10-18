// scripts/tax-compare-baseline.mjs — compute one company's return for a year and set it beside the filed return imported as its baseline
// (spec §12; the T3 stage-close golden comparison). Writes every row (computed, filed, difference, grain, status, reasons) as JSON to --out,
// which must be OUTSIDE this repository (real figures never enter it); prints counts only. The baseline must be the return's own form and
// period. Facts kept per activity or owner are compared only through the explicit map in --resolve (a JSON file, also outside the
// repository: { "activity": { "<baseline key>": "act:<id>" }, "interest": { "<baseline key>": "i:<id>" } }); without it they are 'unmatched'.
// Usage: DATABASE_URL=... node scripts/tax-compare-baseline.mjs --org <slug> --entity <id> --year 2025 --out <file-outside-the-repository> [--baseline <id>] [--resolve <file>]
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createPool } from '../lib/db.js';
import { refuseDemoDatabase } from '../lib/data/demo.js';
import { computeReturn } from '../lib/tax/engine/compute.js';
import { resultsJson } from '../lib/tax/engine/revision.js';
import { compareWithBaseline, checkBaseline, outsideOf } from '../lib/tax/engine/compare.js';

const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = arg('out'), slug = arg('org'), entityId = Number(arg('entity')), year = Number(arg('year')), resolveFile = arg('resolve');
if (!out || !slug || !entityId || !year) { console.error('Usage: --org <slug> --entity <id> --year <yyyy> --out <file outside the repository> [--baseline <id>] [--resolve <file>]'); process.exit(2); }
if (!outsideOf(repo, out) || (resolveFile && !outsideOf(repo, resolveFile))) { console.error('Refused: --out and --resolve must be outside the repository (real figures never enter it).'); process.exit(2); }
const pool = createPool();
try {
  // The comparison reads filed figures: refuse demo mode and a demo database before reading any books or files.
  await refuseDemoDatabase(pool);
  const { rows: [o] } = await pool.query('SELECT org_id FROM org WHERE slug = $1', [slug]);
  if (!o) throw new Error('organization not found');
  const orgId = Number(o.org_id);
  const { rows: [ret] } = await pool.query('SELECT return_id FROM tax_return WHERE org_id = $1 AND entity_id = $2 AND period_end = $3::date', [orgId, entityId, `${year}-12-31`]);
  if (!ret) throw new Error(`no ${year} period for company ${entityId}`);
  const r = await computeReturn(pool, { orgId, entityId, returnId: Number(ret.return_id) });
  if (r.refused) throw new Error(r.refused);
  const cols = 'baseline_id, return_type, source_period_start::text AS source_period_start, source_period_end::text AS source_period_end';
  const { rows: [b] } = arg('baseline')
    ? await pool.query(`SELECT ${cols} FROM tax_baseline WHERE org_id = $1 AND entity_id = $2 AND baseline_id = $3`, [orgId, entityId, Number(arg('baseline'))])
    : await pool.query(`SELECT ${cols} FROM tax_baseline WHERE org_id = $1 AND entity_id = $2 AND kind IN ('imported_filed', 'corrected') AND source_period_end = $3::date ORDER BY payload_version DESC, baseline_id DESC LIMIT 1`,
      [orgId, entityId, `${year}-12-31`]);
  if (!b) throw new Error(`no filed baseline for ${year}`);
  checkBaseline(r.ret, b);
  const { rows: facts } = await pool.query(`SELECT fact_kind, field_id, measurement, state, amount_cents::text AS amount_cents, activity_key, interest_key, party_key, loan_key, asset_key, row_key
     FROM baseline_fact WHERE org_id = $1 AND baseline_id = $2`, [orgId, b.baseline_id]);
  const res = resultsJson(r), cmp = compareWithBaseline(res, facts, { resolve: resolveFile ? JSON.parse(readFileSync(resolveFile, 'utf8')) : {} });
  writeFileSync(out, JSON.stringify({ entityId, year, baselineId: Number(b.baseline_id), counts: cmp.counts, errors: res.checks.filter(c => c.level === 'error').map(c => c.message), rows: cmp.rows }, null, 2));
  console.log(JSON.stringify({ entityId, year, ...cmp.counts, errors: res.checks.filter(c => c.level === 'error').length }));
} finally { await pool.end(); }
