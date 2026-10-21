// Empty a copy's books only after matching its carry-over file and a newer custom-format dump.
// Usage: DATABASE_URL=... node scripts/clear-books.mjs --carry-over <file> --dump <file> --rehearsed <receipt.json> [--apply]
// Org, migrations, users, invites and all audit history survive. Dry run is the default.
import pg from 'pg';
import { refuseDemoDatabase } from '../lib/data/demo.js';
import { fingerprint, decodePayload, tableCounts } from '../lib/rebuild/dump.js';
import { open, readFile, stat } from 'node:fs/promises';
import { parseArgs, isDeepStrictEqual, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { validateCarryStructure, validateCarryCounts } from '../lib/rebuild/carry-validation.js';
import { IMPORTER_TABLES, KEPT_TABLES, TRANSIENT_TABLES, CARRIED_TABLES, classifyTables } from '../lib/rebuild/tables.js';

let options;
try {
  options = parseArgs({ options: { 'carry-over': { type: 'string' }, dump: { type: 'string' }, rehearsed: { type: 'string' }, apply: { type: 'boolean' } } }).values;
  if (!options['carry-over'] || !options.dump || !process.env.DATABASE_URL) throw new Error('usage');
} catch {
  console.error('usage: clear-books --carry-over <file> --dump <file> --rehearsed <receipt.json> [--apply]; DATABASE_URL is required');
  process.exit(2);
}

const tables = [...IMPORTER_TABLES, ...TRANSIENT_TABLES, ...CARRIED_TABLES];
const quote = name => '"' + name.replaceAll('"', '""') + '"';
const count = async (db, table) => Number((await db.query(`SELECT count(*) AS n FROM public.${quote(table)}`)).rows[0].n);
let db;
try {
  db = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  await db.connect();
  await refuseDemoDatabase(db);
  const content = await readFile(options['carry-over'], 'utf8');
  let data;
  try { data = JSON.parse(content); } catch { throw new Error('Could not parse carry-over JSON.'); }
  validateCarryStructure(data);
  await db.query('BEGIN');
  // Coordinate with migrations; the operator must freeze writes before save/dump, through clear/copy.
  await db.query('SELECT pg_advisory_xact_lock(74120001)');
  const unknown = await classifyTables(db);
  if (unknown.length) throw new Error(`unclassified tables: ${unknown.join(', ')}`);
  if (options.apply) await db.query(`LOCK TABLE ${[...tables, ...KEPT_TABLES].map(t => `public.${quote(t)}`).join(', ')} IN ACCESS EXCLUSIVE MODE`);
  const orgs = (await db.query('SELECT org_id, slug, ledgerline_org_id FROM org ORDER BY org_id')).rows;
  if (orgs.length !== 1 || orgs[0].slug !== data.orgSlug) throw new Error(`carry-over is for org “${data.orgSlug}”, not this database.`);
  const companyNames = (await db.query('SELECT name FROM entity')).rows.map(c => c.name).sort();
  if (!isDeepStrictEqual(companyNames, data.companies.map(c => c.name).sort())) throw new Error('carry-over company names do not match this database.');
  await validateCarryCounts(db, data);

  const dump = await open(options.dump, 'r');
  try {
    const header = Buffer.alloc(5);
    const { bytesRead } = await dump.read(header, 0, 5, 0);
    const dumpStat = await dump.stat();
    if (bytesRead !== 5 || header.toString('ascii') !== 'PGDMP') throw new Error('dump must be a PostgreSQL custom-format file (PGDMP).');
    if (dumpStat.mtimeMs <= (await stat(options['carry-over'])).mtimeMs) throw new Error('dump must be newer than the carry-over file.');
    if (dumpStat.mtimeMs <= Date.parse(data.savedAt)) throw new Error('dump mtime must be later than carry-over savedAt.');
  } finally { await dump.close(); }
  let toc;
  try {
    ({ stdout: toc } = await promisify(execFile)(process.env.PG_RESTORE || (process.platform === 'win32'
      ? 'C:/tools/pgsql18/bin/pg_restore.exe' : 'pg_restore'), ['-l', options.dump], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }));
  } catch { throw new Error('pg_restore -l could not validate the dump archive.'); }
  const database = (await db.query('SELECT current_database() AS name')).rows[0].name;
  if (toc.match(/^;\s+dbname:\s+(.+)$/m)?.[1].trim() !== database) throw new Error('dump archive database does not match the target database.');
  const created = toc.match(/^; Archive created at (.+)$/m)?.[1].trim();
  if (!created || !Number.isFinite(Date.parse(created)) || Date.parse(created) < Math.floor(Date.parse(data.savedAt) / 1000) * 1000) {
    throw new Error('dump archive creation must be newer than the carry-over snapshot.');
  }
  const archivedTables = new Set([...toc.matchAll(/^\d+;\s+\d+\s+\d+\s+TABLE public (\S+) /gm)].map(m => m[1]));
  const archivedData = new Set([...toc.matchAll(/^\d+;\s+\d+\s+\d+\s+TABLE DATA public (\S+) /gm)].map(m => m[1]));
  const publicTables = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.map(r => r.tablename);
  if (publicTables.some(t => !archivedTables.has(t) || !archivedData.has(t))) throw new Error('dump archive does not list all target tables and their data.');

  await decodePayload(options.dump);
  if (!options.rehearsed) throw new Error('--rehearsed <receipt.json> from dump-rehearse is required.');
  let receipt;
  try { receipt = JSON.parse(await readFile(options.rehearsed,'utf8')); }
  catch { throw new Error('Could not read rehearsal receipt.'); }
  if (receipt.version !== 1 || receipt.tool !== 'dump-rehearse' || receipt.database !== database
    || !/^fb_test_[a-f0-9]+$/.test(receipt.rehearsalDatabase) || !Number.isFinite(Date.parse(receipt.rehearsedAt))
    || Date.parse(receipt.rehearsedAt) < Date.parse(created) || Date.parse(receipt.rehearsedAt) > Date.now()) {
    throw new Error('Rehearsal receipt identity/time is invalid.');
  }
  const checked = await fingerprint(options.dump);
  if (receipt.sha256 !== checked.sha256 || receipt.size !== checked.size) throw new Error('Rehearsal receipt sha256/size does not match current dump bytes.');
  if (!isDeepStrictEqual(receipt.tableCounts,await tableCounts(db))) throw new Error('Rehearsal receipt table counts do not match the current target snapshot.');

  for (const table of tables) console.log(`${table} ${await count(db, table)}`);
  if (!options.apply) {
    await db.query('ROLLBACK');
    console.log('Dry run — nothing changed. Run again with --apply to clear the books.');
  } else {
    const before = new Map();
    for (const table of KEPT_TABLES) before.set(table, await count(db, table));
    if (!isDeepStrictEqual(checked,await fingerprint(options.dump))) throw new Error('Dump sha256 changed before clear.');
    await db.query(`TRUNCATE ${tables.map(t => `public.${quote(t)}`).join(', ')} RESTART IDENTITY CASCADE`);
    for (const [table, n] of before) if (await count(db, table) !== n) throw new Error(`${table} changed during the clear.`);
    const after = (await db.query('SELECT org_id, slug, ledgerline_org_id FROM org ORDER BY org_id')).rows;
    if (!isDeepStrictEqual(after, orgs)) throw new Error('org or ledgerline_org_id changed during the clear.');
    await db.query('COMMIT');
    console.log(`cleared ${tables.length} tables`);
  }
} catch (error) {
  if (db) await db.query('ROLLBACK').catch(() => {});
  const message = error.message.replaceAll(process.env.DATABASE_URL || '\0', '<database URL>');
  console.error(`clear-books: ${message}`);
  process.exitCode = 1;
} finally { if (db) await db.end(); }
