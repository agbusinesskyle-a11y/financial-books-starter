// test/rebuild-tables.test.js — every public table is classified, and a migrated database has nothing unclassified.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './harness.js';
import { IMPORTER_TABLES, KEPT_TABLES, TRANSIENT_TABLES, CARRIED_TABLES, classifyTables } from '../lib/rebuild/tables.js';

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.drop(); });

test('the four sets are disjoint and name real tables', async () => {
  const sets = [IMPORTER_TABLES, KEPT_TABLES, TRANSIENT_TABLES, CARRIED_TABLES];
  const all = sets.flat();
  assert.equal(new Set(all).size, all.length, 'a table is listed twice');
  const { rows } = await db.pool.query("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'");
  const real = new Set(rows.map(r => r.relname));
  for (const t of all) assert.ok(real.has(t), `${t} is not a table`);
  assert.deepEqual(IMPORTER_TABLES, ['entity', 'terms', 'account', 'customer', 'vendor', 'txn', 'txn_line', 'deposit_line', 'posting', 'application', 'import_batch']);
  assert.deepEqual(KEPT_TABLES, ['org', 'schema_migrations', 'app_user', 'user_invite', 'audit_log', 'demo_marker']);
});

test('a freshly migrated database has no unclassified table', async () => {
  const unclassified = await classifyTables(db.pool);
  assert.deepEqual(unclassified, []);
});

test('integration credentials and external links are carried, never discarded', () => {
  for (const table of ['api_token', 'external_ref', 'integration_setting']) {
    assert.ok(CARRIED_TABLES.includes(table), table);
    assert.ok(!TRANSIENT_TABLES.includes(table), table);
  }
});
