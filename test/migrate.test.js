import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './harness.js';
import { runMigrations } from '../lib/migrate.js';

let db;
before(async () => { db = await freshDb({ migrate: false }); });
after(async () => { await db.drop(); });

test('migrations apply once, then are skipped', async () => {
  const first = await runMigrations(db.pool);
  assert.ok(first.applied.includes('001_core.sql'));
  const second = await runMigrations(db.pool);
  assert.deepEqual(second.applied, []);
  assert.ok(second.skipped.includes('001_core.sql'));
});

test('core tables exist', async () => {
  const { rows } = await db.pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`);
  const names = rows.map(r => r.table_name);
  for (const t of ['org', 'entity', 'terms', 'item', 'customer', 'project', 'txn', 'txn_line', 'application', 'activity_event']) {
    assert.ok(names.includes(t), `missing table ${t}`);
  }
});

test('constraints reject bad rows', async () => {
  const { rows: [o] } = await db.pool.query(`INSERT INTO org (slug, name) VALUES ('t', 'T') RETURNING org_id`);
  const { rows: [e] } = await db.pool.query(`INSERT INTO entity (org_id, name) VALUES ($1, 'E') RETURNING entity_id`, [o.org_id]);
  const { rows: [c] } = await db.pool.query(
    `INSERT INTO customer (org_id, entity_id, display_name) VALUES ($1, $2, 'C') RETURNING customer_id`, [o.org_id, e.entity_id]);
  const insertTxn = (type, extra = {}) => db.pool.query(
    `INSERT INTO txn (org_id, entity_id, customer_id, type, txn_date, due_date, total_cents, open_cents)
     VALUES ($1, $2, $3, $4, '2026-10-01', $5, $6, $7) RETURNING txn_id`,
    [o.org_id, e.entity_id, c.customer_id, type, ('due' in extra ? extra.due : '2026-10-15'), extra.total ?? 100, extra.open ?? 100]);
  await assert.rejects(insertTxn('bogus'), /txn_type_check/);
  await assert.rejects(insertTxn('invoice', { open: 200 }), /check/);
  await assert.rejects(insertTxn('invoice', { due: null }), /check/);
  const inv = (await insertTxn('invoice')).rows[0].txn_id;
  const pay = (await insertTxn('payment', { due: null })).rows[0].txn_id;
  await assert.rejects(db.pool.query(
    `INSERT INTO application (org_id, credit_txn_id, charge_txn_id, amount_cents, applied_on) VALUES ($1, $2, $3, 0, '2026-10-02')`,
    [o.org_id, pay, inv]), /application_amount_cents_check/);
});
