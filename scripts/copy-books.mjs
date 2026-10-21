// Copy an importer-built reference into empty books, preserving ids and appending audit history.
// Usage: node scripts/copy-books.mjs <source url file> <target admin url file> --companies <json file> --exports <folder> [--apply]
// URL file contents are never printed. Stop the app for the entire clear/copy/carry-over window.
import pg from 'pg';
import { refuseDemoDatabase } from '../lib/data/demo.js';
import { readFile } from 'node:fs/promises';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { companyExports, importEvidence } from '../lib/rebuild/import-evidence.js';
import { readExportEvidence, exportEvidence } from '../lib/rebuild/export-evidence.js';
import { missingPostings, childCompleteness } from '../lib/rebuild/integrity.js';
import { IMPORTER_TABLES, KEPT_TABLES, TRANSIENT_TABLES, CARRIED_TABLES, classifyTables } from '../lib/rebuild/tables.js';

let args;
try {
  args = parseArgs({ allowPositionals: true, options: { apply: { type: 'boolean' }, companies: { type: 'string' }, exports: {type:'string'} } });
  if (args.positionals.length !== 2 || !args.values.companies || !args.values.exports) throw new Error('usage');
} catch {
  console.error('usage: copy-books <source url file> <target admin url file> --companies <json file> --exports <folder> [--apply]');
  process.exit(2);
}

// Preserve dates and full timestamp precision when round-tripping through pg parameters.
for (const oid of [1082, 1114, 1184]) pg.types.setTypeParser(oid, value => value);
const quote = name => '"' + name.replaceAll('"', '""') + '"';
const table = name => `public.${quote(name)}`;
const count = async (db, name) => Number((await db.query(`SELECT count(*) AS n FROM ${table(name)}`)).rows[0].n);
const copied = [...IMPORTER_TABLES, 'audit_log'];
const all = [...IMPORTER_TABLES, ...KEPT_TABLES, ...TRANSIENT_TABLES, ...CARRIED_TABLES];
const clients = [], urls = [];
let source, target;
try {
  for (const file of args.positionals) {
    const url = (await readFile(file, 'utf8')).trim();
    urls.push(url);
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    clients.push(client);
    await client.connect();
    await refuseDemoDatabase(client);
  }
  const companies = await companyExports(args.values.companies), expected=companies.map(c=>c.fbName).sort();
  [source, target] = clients;
  await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await target.query('BEGIN');
  await target.query('SELECT pg_advisory_xact_lock(74120001)');
  for (const [label, db] of [['source', source], ['target', target]]) {
    const unknown = await classifyTables(db);
    if (unknown.length) throw new Error(`${label} has unclassified tables: ${unknown.join(', ')}`);
  }
  if (args.values.apply) await target.query(`LOCK TABLE ${all.map(table).join(', ')} IN ACCESS EXCLUSIVE MODE`);
  const migrations = async db => (await db.query('SELECT name FROM schema_migrations ORDER BY name')).rows;
  if (!isDeepStrictEqual(await migrations(source), await migrations(target))) throw new Error('schema_migrations name sets differ');

  const refusals = (await importEvidence(source, expected)).errors;
  if (refusals.length) throw new Error(refusals.join('\n'));
  const exports = await readExportEvidence(args.values.exports,companies);
  const sourceUnbalanced = Number((await source.query('SELECT count(*) AS n FROM (SELECT txn_id FROM posting GROUP BY txn_id HAVING sum(amount_cents) <> 0) x')).rows[0].n);
  if (sourceUnbalanced) refusals.push(`source unbalanced transactions: ${sourceUnbalanced}`);
  refusals.push(...(await exportEvidence(source,exports)).errors, ...(await childCompleteness(source)).errors);
  const missing = await missingPostings(source);
  if (missing) refusals.push(`source transactions missing postings: ${missing}`);
  if (!await count(source, 'entity')) refusals.push('source has zero companies');
  const uncovered = Number((await source.query(`SELECT count(*) AS n FROM entity e WHERE NOT EXISTS
    (SELECT 1 FROM import_batch b WHERE b.org_id=e.org_id AND b.entity_id=e.entity_id)`)).rows[0].n);
  if (uncovered) refusals.push(`source entities without import_batch: ${uncovered}`);
  for (const name of ['txn', 'application']) {
    const native = Number((await source.query(`SELECT count(*) AS n FROM ${table(name)} WHERE source IS DISTINCT FROM 'qbo_import'`)).rows[0].n);
    if (native) refusals.push(`source has non-import ${name} rows: ${native}`);
  }
  for (const name of IMPORTER_TABLES) if (await count(target, name)) refusals.push(`target already has rows in ${name}`);
  for (const name of CARRIED_TABLES) if (await count(source, name)) refusals.push(`source has practice-only state in ${name}`);
  if (refusals.length) throw new Error(refusals.join('\n'));
  // Kept org ids must still mean the same tenant; copying never renumbers or replaces them.
  const orgs = (await source.query('SELECT org_id, slug FROM org ORDER BY org_id')).rows;
  const targetOrgs = (await target.query('SELECT org_id, slug FROM org ORDER BY org_id')).rows;
  if (orgs.some(o => !targetOrgs.some(t => t.org_id === o.org_id && t.slug === o.slug))) throw new Error('source org ids and slugs do not match the target');

  const columns = async (db, name) => (await db.query(`SELECT column_name, data_type, udt_name, is_identity, is_generated
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [name])).rows;
  const counts = new Map(), layouts = new Map();
  for (const name of copied) {
    const cols = await columns(source, name);
    if (!isDeepStrictEqual(cols, await columns(target, name))) throw new Error(`column layouts differ for ${name}`);
    layouts.set(name, cols.filter(c => c.is_generated === 'NEVER' && !(name === 'audit_log' && c.is_identity === 'YES')));
    counts.set(name, await count(source, name));
    console.log(`${name} ${counts.get(name)}`);
  }
  if (!args.values.apply) {
    console.log('Dry run — nothing changed. Run again with --apply to copy the books.');
  } else {
    const auditBefore = await count(target, 'audit_log');
    await target.query("SET LOCAL session_replication_role = 'replica'");
    for (const name of copied) {
      const cols = layouts.get(name), names = cols.map(c => quote(c.column_name)).join(', ');
      const rows = (await source.query(`SELECT ${names} FROM ${table(name)}`)).rows;
      const batch = Math.max(1, Math.floor(30000 / cols.length));
      for (let i = 0; i < rows.length; i += batch) {
        const params = [];
        const values = rows.slice(i, i + batch).map(row => `(${cols.map(c => {
          let value = row[c.column_name];
          if (value !== null && ['json', 'jsonb'].includes(c.data_type)) value = JSON.stringify(value);
          params.push(value);
          return `$${params.length}`;
        }).join(', ')})`).join(', ');
        await target.query(`INSERT INTO ${table(name)} (${names}) ${name === 'audit_log' ? '' : 'OVERRIDING SYSTEM VALUE '}VALUES ${values}`, params);
      }
    }
    for (const [name, expected] of counts) {
      if (await count(target, name) !== expected + (name === 'audit_log' ? auditBefore : 0)) throw new Error(`row count differs for ${name}`);
    }
    const unbalanced = Number((await target.query('SELECT count(*) AS n FROM (SELECT txn_id FROM posting GROUP BY txn_id HAVING sum(amount_cents) <> 0) x')).rows[0].n);
    if (unbalanced) throw new Error(`unbalanced transactions: ${unbalanced}`);
    const targetErrors=[...(await importEvidence(target,expected)).errors,
      ...(await exportEvidence(target,exports)).errors,...(await childCompleteness(target)).errors];
    if(targetErrors.length) throw new Error(targetErrors.join('\n'));
    // Replica mode bypasses RI triggers: check composite keys, including references to kept orgs
    // and empty carried tables, as well as every constraint between the copied tables.
    const fks = (await target.query(`SELECT f.conname, child.relname AS child, parent.relname AS parent,
        array_agg(ca.attname::text ORDER BY k.ord) AS child_cols, array_agg(pa.attname::text ORDER BY k.ord) AS parent_cols
      FROM pg_constraint f JOIN pg_class child ON child.oid = f.conrelid JOIN pg_namespace cn ON cn.oid = child.relnamespace
      JOIN pg_class parent ON parent.oid = f.confrelid JOIN pg_namespace pn ON pn.oid = parent.relnamespace
      CROSS JOIN LATERAL unnest(f.conkey, f.confkey) WITH ORDINALITY k(cid, pid, ord)
      JOIN pg_attribute ca ON ca.attrelid = child.oid AND ca.attnum = k.cid
      JOIN pg_attribute pa ON pa.attrelid = parent.oid AND pa.attnum = k.pid
      WHERE f.contype = 'f' AND cn.nspname = 'public' AND pn.nspname = 'public' AND child.relname = ANY($1::text[])
      GROUP BY f.oid, f.conname, child.relname, parent.relname ORDER BY child.relname, f.conname`, [copied])).rows;
    for (const fk of fks) {
      const present = fk.child_cols.map(c => `c.${quote(c)} IS NOT NULL`).join(' AND ');
      const equal = fk.child_cols.map((c, i) => `p.${quote(fk.parent_cols[i])} = c.${quote(c)}`).join(' AND ');
      const n = Number((await target.query(`SELECT count(*) AS n FROM ${table(fk.child)} c WHERE ${present}
        AND NOT EXISTS (SELECT 1 FROM ${table(fk.parent)} p WHERE ${equal})`)).rows[0].n);
      if (n) throw new Error(`foreign key ${fk.child}.${fk.conname}: ${n} rows without a parent`);
    }
    // Do this last: setval (unlike table writes) is not undone by ROLLBACK.
    const identities = (await target.query(`SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND is_identity = 'YES' ORDER BY table_name, column_name`)).rows;
    for (const { table_name: name, column_name: col } of identities) {
      await target.query(`SELECT setval(pg_get_serial_sequence($1, $2), greatest(coalesce(max(${quote(col)}), 0), 1), count(*) > 0) FROM ${table(name)}`, [table(name), col]);
    }
    await target.query('COMMIT');
    console.log('copied and verified');
  }
} catch (error) {
  // Log controlled refusals; low-level pg/file errors can embed connection credentials or row content.
  const message = error.code ? `operation failed (${error.code})` : urls.reduce((s, url) => s.replaceAll(url, '<database URL>'), error.message);
  console.error(`copy-books: ${message}`);
  process.exitCode = 1;
} finally {
  for (const client of clients) {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}
