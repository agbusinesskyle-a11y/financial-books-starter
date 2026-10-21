import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

export async function expectedCompanies(file) {
  return (await companyExports(file)).map(c => c.fbName).sort();
}

export async function companyExports(file) {
  const data = JSON.parse(await readFile(file, 'utf8'));
  const companies = Array.isArray(data) ? data.map(fbName => ({fbName})) : data?.companies;
  const names = companies?.map(c => c.fbName);
  if (!Array.isArray(names) || !names.length || names.some(n => typeof n !== 'string' || !n.trim())
    || new Set(names).size !== names.length) throw new Error('companies must contain unique, nonempty company names');
  const out = companies.map(c => ({fbName:c.fbName, slug:c.slug ?? c.fbName.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')}));
  if (out.some(c => typeof c.slug !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(c.slug))
    || new Set(out.map(c => c.slug.toLowerCase())).size !== out.length) throw new Error('companies must have unique, safe export slugs');
  return out;
}

// Call inside the caller's read-only snapshot. Native approved differences do not
// change the imported transaction population against which the batch is checked.
export async function importEvidence(db, expected) {
  const { rows } = await db.query(`SELECT e.name AS company,
    (SELECT count(*)::int FROM import_batch b WHERE b.org_id=e.org_id AND b.entity_id=e.entity_id) AS batches,
    (SELECT jsonb_agg(b.summary) FROM import_batch b WHERE b.org_id=e.org_id AND b.entity_id=e.entity_id) AS summaries,
    (SELECT count(*)::int FROM txn t WHERE t.org_id=e.org_id AND t.entity_id=e.entity_id AND t.source='qbo_import') AS transactions,
    (SELECT max(t.txn_date)::text FROM txn t WHERE t.org_id=e.org_id AND t.entity_id=e.entity_id AND t.source='qbo_import') AS "to"
    FROM entity e ORDER BY e.name`);
  const errors = [];
  if (expected && !isDeepStrictEqual(rows.map(r => r.company).sort(), expected)) errors.push('source companies do not exactly match --companies');
  for (const r of rows) {
    const summary = r.summaries?.[0];
    if (r.batches !== 1) errors.push(`import_batch for ${r.company}: expected one batch, found ${r.batches}`);
    else if (!Number.isSafeInteger(summary?.transactions) || summary.transactions !== r.transactions
      || !Object.hasOwn(summary, 'to') || summary.to !== r.to) {
      errors.push(`import_batch for ${r.company}: summary.transactions/to do not match current imported transactions`);
    }
  }
  return { companies: rows.map(({ summaries, ...r }) => r), errors };
}
