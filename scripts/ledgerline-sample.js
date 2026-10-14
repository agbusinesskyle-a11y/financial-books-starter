import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { createPool } from '../lib/db.js';
import { buildSampleFeed, writeLedgerlineSample } from '../lib/bankfeed/sample.js';

// Builds a sample bank-data database (a ledgerline-compatible schema, see BANK-FEED-CONTRACT.md) from the sample books,
// so you can try bank feeds without any bank connection:
//   npm run seed
//   npm run bank-sample -- --admin-url postgres://postgres@127.0.0.1:5432/postgres [--org sample] [--db-name ledgerline_sample] [--role bank_reader]
// It creates database `ledgerline_sample` on that server if it's missing, (re)writes its schemas from the first company
// of the books --org (default "sample" — the bank items are made from those books' own bank activity), and creates or
// refreshes a read-only login role `bank_reader` for it (--db-name / --role pick other names). Then put the two printed lines in .env and start the app with
// APP_ORG=sample. Sample data only.
const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const adminUrl = opt('admin-url') ?? process.env.DATABASE_URL;
const orgSlug = opt('org') ?? 'sample';
const dbName = opt('db-name') ?? 'ledgerline_sample';
const role = opt('role') ?? 'bank_reader';
if (!/^[a-z_][a-z0-9_]*$/.test(dbName) || !/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error('--db-name and --role are lowercase letters, digits and _.');
const pool = createPool({ ...process.env, ALLOW_SUPERUSER: '1' });
const target = new URL(adminUrl);
target.pathname = `/${dbName}`;
target.search = '';
try {
  const { rows: [e] } = await pool.query(`SELECT e.org_id, e.entity_id FROM entity e JOIN org o ON o.org_id = e.org_id WHERE o.slug = $1
    ORDER BY e.entity_id LIMIT 1`, [orgSlug]);
  if (!e) throw new Error(`no books named “${orgSlug}”. Run npm run seed first.`);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (!rowCount) await admin.query(`CREATE DATABASE ${dbName}`);
  } finally { await admin.end(); }
  const asOf = new Date().toISOString().slice(0, 10);
  const feed = await buildSampleFeed(pool, { orgId: e.org_id, entityId: e.entity_id, asOf });
  const ll = new pg.Client({ connectionString: target.toString() });
  await ll.connect();
  const password = randomBytes(18).toString('base64url');
  try {
    await writeLedgerlineSample(ll, feed);
    // The read-only role Financial Books connects as (what your own bank-data database needs too).
    const exists = (await ll.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount > 0;
    await ll.query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}'`);
    await ll.query(`GRANT CONNECT ON DATABASE ${dbName} TO ${role};
      GRANT USAGE ON SCHEMA core, verify, serve TO ${role};
      GRANT SELECT ON ALL TABLES IN SCHEMA core, verify, serve TO ${role};
      ALTER ROLE ${role} SET default_transaction_read_only = on;`);
  } finally { await ll.end(); }
  const reader = new URL(target);
  reader.username = role;
  reader.password = password;
  console.log(`${dbName}: ${feed.accounts.length} accounts, ${feed.items.length} bank items. Add to .env (local sample only):`);
  console.log(`LEDGERLINE_URL=${reader.toString()}`);
  console.log(`LEDGERLINE_ORG_ID=${feed.org}`);
} catch (error) {
  console.error(`bank-sample failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
