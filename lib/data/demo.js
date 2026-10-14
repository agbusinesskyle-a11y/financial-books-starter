import { withTransaction } from '../db.js';
import { runMigrations } from '../migrate.js';
import { DEMO_ORG, checkDemoMode, isDemo } from '../domain/demo.js';
import { todayIn } from '../domain/dates.js';
import { generateSample } from '../seed/generate.js';
import { writeSampleIn } from './seed.js';

// The public demo's safety interlock and its nightly reset (lib/domain/demo.js, migrations/053_demo_marker.sql).
//
// A database is a demo database only when both hold:
//   1. it carries the demo mark (the one row in demo_marker, naming this very database), which nothing but resetDemo()
//      writes — and resetDemo() writes it only right after wiping a database that was empty or already a clean demo;
//   2. it holds nothing a demo never makes: books other than the sample, QuickBooks imports, users or invitations, an
//      email server, AI, texted receipts, bank connections, online payments, or any stored secret (every …_enc column).
// DEMO_MODE=1 (the app, migrations, jobs) runs only on a demo database; normal books refuse to run on a marked one; and
// the reset refuses to wipe anything else. So real books can't be opened to the public, nor wiped, by a wrong setting.

const KEEP = new Set(['schema_migrations', 'demo_marker']);
const RESET_LOCK = 74_120_053; // advisory lock id for "financial-books demo reset"
const ident = name => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unexpected table or column name: ${name}`);
  return `"${name}"`;
};
const tableExists = async (db, table) => (await db.query('SELECT to_regclass($1) AS t', [`public.${table}`])).rows[0].t !== null;
const count = async (db, sql, params = []) => Number((await db.query(sql, params)).rows[0].n);

// Every table holding books data: all of the public schema except the migration list and the demo mark.
async function dataTables(db) {
  const { rows } = await db.query(`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname`);
  return rows.map(r => r.name).filter(n => !KEEP.has(n));
}

// The demo mark, with `here`: it names this database (a restored copy elsewhere doesn't count). Null when unmarked.
export async function readMarker(db) {
  if (!(await tableExists(db, 'demo_marker'))) return null;
  const { rows } = await db.query('SELECT *, database_name = current_database() AS here FROM demo_marker');
  return rows[0] ?? null;
}

// Things a demo never has: [table, condition, what it means].
const NEVER_IN_DEMO = [
  ['import_batch', '', 'QuickBooks imports'],
  ['txn', 'WHERE source IS NOT NULL', 'imported transactions'],
  ['app_user', '', 'users'],
  ['user_invite', '', 'invitations'],
  ['email_settings', "WHERE mode = 'smtp'", 'an email server set up'],
  ['ai_settings', "WHERE provider <> 'off'", 'AI connected'],
  ['sms_settings', 'WHERE enabled OR account_sid IS NOT NULL OR phone IS NOT NULL', 'texted receipts set up'],
  ['sms_sender', '', 'texted-receipt senders'],
  ['org', 'WHERE ledgerline_org_id IS NOT NULL', 'a bank-data tenant assigned'],
  ['ledgerline_link', '', 'bank connections'],
  ['bank_feed_item', '', 'bank feed transactions'],
  ['payments_settings', 'WHERE enabled', 'online payments turned on'],
];

// Every reason this database is not a demo database the public may open; empty when it is one.
export async function demoProblems(db) {
  const problems = [];
  const marker = await readMarker(db);
  if (!marker) problems.push('it has no demo mark, so it wasn’t made by npm run demo-reset');
  else if (!marker.here) problems.push(`its demo mark names another database ("${marker.database_name}"), so it’s a copy`);
  if (!(await tableExists(db, 'org'))) return [...problems, 'it has no books tables'];
  const slugs = (await db.query('SELECT slug FROM org ORDER BY slug')).rows.map(r => r.slug);
  const others = slugs.filter(s => s !== DEMO_ORG);
  if (others.length) problems.push(`it has books other than the sample (${others.length}: ${others.slice(0, 3).map(s => `"${s}"`).join(', ')}${others.length > 3 ? ', …' : ''})`);
  if (!slugs.includes(DEMO_ORG)) problems.push('it has no sample books');
  const companies = await count(db, 'SELECT count(*) AS n FROM entity');
  if (marker && companies !== marker.companies) problems.push(`it has ${companies} companies, but the demo was built with ${marker.companies}`);
  for (const [table, where, what] of NEVER_IN_DEMO) {
    if (!(await tableExists(db, table))) continue;
    const n = await count(db, `SELECT count(*) AS n FROM ${ident(table)} ${where}`);
    if (n) problems.push(`it has ${what} (${n})`);
  }
  // Stored secrets: mail and AI passwords, Twilio tokens, authenticators, tax IDs, bank details — every …_enc column.
  const { rows: secretColumns } = await db.query(`SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND right(column_name, 4) = '_enc' ORDER BY table_name, column_name`);
  for (const c of secretColumns) {
    const n = await count(db, `SELECT count(*) AS n FROM ${ident(c.table_name)} WHERE ${ident(c.column_name)} IS NOT NULL`);
    if (n) problems.push(`it has stored secrets (${c.table_name}.${c.column_name}: ${n})`);
  }
  return problems;
}

export class DemoRefused extends Error {}

export async function assertDemoDatabase(db) {
  const problems = await demoProblems(db);
  if (problems.length) {
    throw new DemoRefused(`DEMO_MODE=1 refused: this database is not a demo database —\n  - ${problems.join('\n  - ')}\n` +
      'A demo runs only on a database made by `npm run demo-reset` (on a new, empty database).');
  }
}

// Run by the app, migrations and jobs before they touch anything: a demo only on a demo database, and normal books never
// on a demo database (it's wiped every night).
export async function guardDatabase(db, env = process.env) {
  if (isDemo(env)) return assertDemoDatabase(db);
  if (await readMarker(db)) {
    throw new DemoRefused('This database is a public demo that `npm run demo-reset` wipes every night (it carries the demo mark). ' +
      'Don’t keep books in it: point DATABASE_URL at your own database, or set DEMO_MODE=1 to run the demo.');
  }
}

// 'empty' (no data in any books table, or no tables yet), 'demo' (marked for this database), 'copy' (marked for another
// database) or 'books' (data, no mark).
export async function databaseState(db) {
  const marker = await readMarker(db);
  if (marker) return marker.here ? 'demo' : 'copy';
  for (const t of await dataTables(db)) {
    if ((await db.query(`SELECT EXISTS (SELECT 1 FROM ${ident(t)}) AS x`)).rows[0].x) return 'books';
  }
  return 'empty';
}

async function checkWipeable(db) {
  const state = await databaseState(db);
  if (state === 'books') {
    throw new DemoRefused('demo-reset refused: this database has data but no demo mark — it may be real books. Nothing was changed. ' +
      'Run the demo on a new, empty database.');
  }
  if (state === 'copy') throw new DemoRefused('demo-reset refused: this database carries another database’s demo mark (a restored copy?). Nothing was changed.');
  if (state === 'demo') {
    // A demo that now holds something a demo can't make got it from outside the app: look before anything is wiped.
    const problems = (await demoProblems(db));
    if (problems.length) {
      throw new DemoRefused(`demo-reset refused: this demo database holds things a demo never makes —\n  - ${problems.join('\n  - ')}\nNothing was changed; look at it by hand.`);
    }
  }
  return state;
}

// Wipes the database's books data and rebuilds the sample company as of `asOf` (default: today), then writes the demo
// mark — all in one transaction, so a failure leaves yesterday's demo as it was. Only with DEMO_MODE=1, and only on an
// empty database or a clean demo database. ifNew: build only on an empty database; a demo database is left alone.
// Returns { state, built, asOf, companies, customers, transactions }.
export async function resetDemo(pool, { env = process.env, asOf = env.SEED_AS_OF || todayIn('America/Chicago'), ifNew = false, log = () => {}, attempts = 3 } = {}) {
  if (checkDemoMode(env) !== 'demo') throw new DemoRefused('demo-reset only runs with DEMO_MODE=1.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error(`The date to build the sample as of must be YYYY-MM-DD, not ${JSON.stringify(asOf)}.`);
  const first = await checkWipeable(pool);
  if (ifNew && first === 'demo') { log('demo-reset: already a demo database; left as it is (--if-new)'); return { state: first, built: false }; }
  // Bring the tables up to date (an empty database has none yet). Only ever on an empty or demo database.
  const { applied } = await runMigrations(pool);
  if (applied.length) log(`demo-reset: applied ${applied.length} migration(s)`);
  for (let attempt = 1; ; attempt++) {
    try {
      return await withTransaction(pool, async tx => {
        await tx.query('SELECT pg_advisory_xact_lock($1)', [RESET_LOCK]);
        await tx.query("SET LOCAL lock_timeout = '20s'");
        // Checked again inside the lock: nothing may have changed in between.
        const state = await checkWipeable(tx);
        if (ifNew && state === 'demo') return { state, built: false };
        await tx.query("SELECT set_config('app.actor', 'demo reset', true)");
        await tx.query(`TRUNCATE ${(await dataTables(tx)).map(ident).join(', ')} RESTART IDENTITY CASCADE`);
        const sample = generateSample({ asOf });
        if (sample.org.slug !== DEMO_ORG) throw new Error(`The sample's books are "${sample.org.slug}", not "${DEMO_ORG}".`);
        await writeSampleIn(tx, sample);
        const companies = await count(tx, 'SELECT count(*) AS n FROM entity');
        await tx.query(`INSERT INTO demo_marker (database_name, org_slug, companies) VALUES (current_database(), $1, $2)
          ON CONFLICT (only_row) DO UPDATE SET database_name = EXCLUDED.database_name, org_slug = EXCLUDED.org_slug,
            companies = EXCLUDED.companies, reset_at = now()`, [DEMO_ORG, companies]);
        const problems = await demoProblems(tx);
        if (problems.length) throw new Error(`the rebuilt demo failed its own check: ${problems.join('; ')}`);
        const result = { state, built: true, asOf, companies, customers: sample.customers.length, transactions: sample.txns.length };
        log(`demo-reset: ${state === 'empty' ? 'built' : 'rebuilt'} the sample books as of ${asOf}: ${result.customers} customers, ${result.transactions} transactions`);
        return result;
      });
    } catch (error) {
      // The app holds locks for a moment while it saves; a deadlock or lock wait just means "try again shortly".
      if (attempt < attempts && ['40P01', '55P03', '40001'].includes(error?.code)) {
        log(`demo-reset: busy (${error.code}); trying again`);
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        continue;
      }
      throw error;
    }
  }
}

// For the tools that put real books into a database (new-books, import-qbo): never into a demo database.
export async function refuseDemoDatabase(db, env = process.env) {
  if (isDemo(env)) throw new DemoRefused('This doesn’t run with DEMO_MODE=1: a demo holds only the sample books.');
  await guardDatabase(db, env);
}
