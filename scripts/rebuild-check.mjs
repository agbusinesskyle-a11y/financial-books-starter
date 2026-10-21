// Read-only yardstick for a rebuilt copy: ledger, month-end open items, postings, sequences and import evidence.
// Usage: node scripts/rebuild-check.mjs <url file> <as-of YYYY-MM-DD> [--out <json>] --companies <json file> --exports <folder>
import pg from 'pg';
import { refuseDemoDatabase } from '../lib/data/demo.js';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { ledgerCheck } from '../lib/data/ledger.js';
import { openItems } from '../lib/reports/receivables.js';
import { isIsoDate } from '../lib/domain/dates.js';
import { IMPORTER_TABLES } from '../lib/rebuild/tables.js';
import { companyExports, importEvidence } from '../lib/rebuild/import-evidence.js';
import { readExportEvidence, exportEvidence } from '../lib/rebuild/export-evidence.js';
import { missingPostings, childCompleteness } from '../lib/rebuild/integrity.js';

let args;
try {
  args = parseArgs({ allowPositionals: true, options: { out: { type: 'string' }, companies: { type: 'string' }, exports:{type:'string'} } });
  if (args.positionals.length !== 2 || !isIsoDate(args.positionals[1]) || !args.values.companies || !args.values.exports) throw new Error('usage');
} catch {
  console.error('usage: rebuild-check <url file> <as-of YYYY-MM-DD> [--out <json>] --companies <json file> --exports <folder>');
  process.exit(2);
}
const [urlFile, asOf] = args.positionals;
const quote = name => '"' + name.replaceAll('"', '""') + '"';
const monthEnds = date => {
  const dates = [];
  for (let d = new Date('2025-12-31T00:00:00Z'); d.toISOString().slice(0, 10) < date;) {
    dates.push(d.toISOString().slice(0, 10));
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 0));
  }
  return [...dates, date];
};
let db, url;
try {
  url = (await readFile(urlFile, 'utf8')).trim();
  db = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await db.connect();
  await refuseDemoDatabase(db);
  const companies=await companyExports(args.values.companies);
  const exports=await readExportEvidence(args.values.exports,companies);
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await db.query("SET LOCAL statement_timeout = '60s'");
  const database = (await db.query('SELECT current_database() AS name')).rows[0].name;
  const out = { database, asOf, checks: [], periodChecks: [], cards: [], state: [], imports: [], counts: {}, sources: [], sequences: [], unbalancedTransactions: 0 };
  const entities = (await db.query('SELECT org_id, entity_id, name FROM entity ORDER BY entity_id')).rows;
  if (!entities.length) throw new Error('cannot certify books with zero companies');
  if (!Number((await db.query('SELECT count(*) AS n FROM txn')).rows[0].n)) throw new Error('cannot certify books with zero transactions');
  for (const entity of entities) {
    const scope = { orgId: entity.org_id, entityId: entity.entity_id };
    out.checks.push({ company: entity.name, ...await ledgerCheck(db, scope) });
    for (const end of monthEnds(asOf)) for (const side of ['ar', 'ap']) {
      const items = await openItems(db, { ...scope, side, asOf: end });
      const { rows: [row] } = await db.query(`SELECT coalesce(sum(p.amount_cents), 0)::bigint AS balance
        FROM posting p JOIN account a ON a.account_id = p.account_id
        WHERE p.org_id = $1 AND p.entity_id = $2 AND a.system_key = $3 AND p.txn_date <= $4`, [scope.orgId, scope.entityId, side, end]);
      const total = items.reduce((sum, item) => sum + item.open, 0);
      const ledger = row.balance * (side === 'ap' ? -1 : 1);
      out.periodChecks.push({ company: entity.name, asOf: end, side, items: items.length, total_cents: total, ledger_cents: ledger, difference_cents: total - ledger });
    }
  }
  out.cards = (await db.query(`SELECT e.name AS company, a.account_id, a.name, a.active, pa.name AS parent,
      coalesce(sum(p.amount_cents), 0)::text AS signed_balance_cents
    FROM account a JOIN entity e USING (entity_id) LEFT JOIN account pa ON pa.account_id = a.parent_id
    LEFT JOIN posting p ON p.account_id = a.account_id WHERE a.type = 'credit_card'
    GROUP BY e.name, a.account_id, pa.name ORDER BY e.name, a.account_id`)).rows;
  for (const name of IMPORTER_TABLES) out.counts[name] = (await db.query(`SELECT count(*)::bigint AS n FROM public.${quote(name)}`)).rows[0].n;
  out.sources = (await db.query('SELECT source, count(*)::bigint AS n FROM txn GROUP BY source ORDER BY source NULLS FIRST')).rows;
  out.state = (await db.query(`SELECT 'txns' AS label, count(*)::bigint AS n FROM txn
    UNION ALL SELECT 'imported_txns', count(*) FROM txn WHERE source = 'qbo_import'
    UNION ALL SELECT 'postings', count(*) FROM posting UNION ALL SELECT 'applications', count(*) FROM application
    UNION ALL SELECT 'accounts', count(*) FROM account UNION ALL SELECT 'customers', count(*) FROM customer
    UNION ALL SELECT 'vendors', count(*) FROM vendor
    UNION ALL SELECT 'opening_balance_txns', count(*) FROM txn WHERE system_kind = 'opening_balance'`)).rows;
  out.importEvidence = await importEvidence(db, companies.map(c=>c.fbName).sort());
  out.exportEvidence = await exportEvidence(db,exports);
  out.childCompleteness = await childCompleteness(db);
  out.imports = (await db.query(`SELECT b.company_name, b.created_at, b.summary->>'transactions' AS transactions,
      b.summary->>'from' AS "from", b.summary->>'to' AS "to", b.summary->>'omitted' AS omitted,
      b.summary->>'renamedAccounts' AS renamed, b.summary->'acceptedMismatches' AS accepted, b.parity->>'trialBalance' AS trial_balance
    FROM import_batch b ORDER BY b.batch_id`)).rows;
  out.unbalancedTransactions = (await db.query('SELECT count(*)::bigint AS n FROM (SELECT txn_id FROM posting GROUP BY txn_id HAVING sum(amount_cents) <> 0) x')).rows[0].n;
  out.missingPostings = await missingPostings(db);
  const identities = (await db.query(`SELECT c.table_name, c.column_name, format('%I.%I', ns.nspname, s.relname) AS sequence
    FROM information_schema.columns c
    JOIN pg_class s ON s.oid = pg_get_serial_sequence(format('%I.%I', c.table_schema, c.table_name), c.column_name)::regclass
    JOIN pg_namespace ns ON ns.oid = s.relnamespace
    WHERE c.table_schema = 'public' AND c.is_identity = 'YES' ORDER BY c.table_name, c.column_name`)).rows;
  for (const { table_name: table, column_name: column, sequence } of identities) {
    const maxId = (await db.query(`SELECT coalesce(max(${quote(column)}), 0)::bigint AS n FROM public.${quote(table)}`)).rows[0].n;
    const { last_value: lastValue, is_called: isCalled } = (await db.query(`SELECT last_value, is_called FROM ${sequence}`)).rows[0];
    out.sequences.push({ table, column, sequence, maxId, lastValue, isCalled, ok: lastValue >= maxId && (isCalled || lastValue > maxId) });
  }
  await db.query('ROLLBACK');
  if (args.values.out) await writeFile(args.values.out, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(out, null, 2));
  for (const check of out.checks) console.log(`${check.company} balanced: ${check.balanced}`);
  const nonzero = out.periodChecks.filter(check => check.difference_cents !== 0).length;
  const behind = out.sequences.filter(sequence => !sequence.ok).length;
  console.log(`period comparisons: ${out.periodChecks.length} nonzero: ${nonzero}`);
  console.log(`unbalanced transactions: ${out.unbalancedTransactions}`);
  console.log(`transactions missing postings: ${out.missingPostings}`);
  console.log(`identity sequences: ${out.sequences.length} behind: ${behind}`);
  if (out.checks.some(check => !check.balanced || !check.arMatches || !check.apMatches || !check.inventoryMatches)
    || out.importEvidence.errors.length || out.exportEvidence.errors.length || out.childCompleteness.errors.length
    || nonzero || behind || out.unbalancedTransactions || out.missingPostings) process.exitCode = 1;
} catch (error) {
  const message = error.code ? `operation failed (${error.code})` : error.message.replaceAll(url || '\0', '<database URL>');
  console.error(`rebuild-check: ${message}`);
  process.exitCode = 1;
} finally {
  if (db) {
    await db.query('ROLLBACK').catch(() => {});
    await db.end();
  }
}
