import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './harness.js';
import { generateSample } from '../lib/seed/generate.js';
import { writeSample } from '../lib/data/seed.js';
import { ValidationError } from '../lib/data/writes.js';
import { transactionsPdf, sendTransaction } from '../lib/data/messages.js';
import { createLogMailer as createMailer } from '../lib/mail/index.js';

const TODAY = '2026-10-12';
let db, ids, scope;
before(async () => {
  db = await freshDb();
  ids = await writeSample(db.pool, generateSample({ asOf: TODAY }));
  scope = { orgId: ids.orgId, entityId: ids.entityId };
});
after(async () => { await db.drop(); });

const pick = async (customer, type) => (await db.pool.query(
  `SELECT txn_id FROM txn WHERE customer_id = $1 AND type = $2 AND voided_at IS NULL ORDER BY txn_date DESC LIMIT 3`, [ids.customers[customer], type])).rows.map(r => r.txn_id);
const pageCount = pdf => (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;

test('single and combined PDFs', async () => {
  const [inv] = await pick('redriver', 'invoice');
  const one = await transactionsPdf(db.pool, { ...scope, txnIds: [inv] });
  assert.equal(one.subarray(0, 5).toString(), '%PDF-');
  assert.equal(pageCount(one), 1);
  const three = [...await pick('redriver', 'invoice'), ...await pick('redriver', 'payment')];
  const many = await transactionsPdf(db.pool, { ...scope, txnIds: three });
  assert.ok(pageCount(many) >= three.length);
  await assert.rejects(transactionsPdf(db.pool, { ...scope, txnIds: [999999999] }), ValidationError);
});

test('send records a message and activity', async () => {
  const [inv] = await pick('prairie', 'invoice');
  const status = await sendTransaction(db.pool, createMailer({}), { ...scope, txnId: inv, actor: 'tester' });
  assert.equal(status, 'logged');
  const m = await db.pool.query('SELECT to_addr, status, subject FROM message WHERE related_txn_id = $1', [inv]);
  assert.equal(m.rowCount, 1);
  assert.equal(m.rows[0].to_addr, 'orders@prairiecreekfeed.example');
  assert.match(m.rows[0].subject, /^Invoice INV-\d+ from Sample Feed Co\.$/);
  const a = await db.pool.query(`SELECT summary FROM activity_event WHERE txn_id = $1 AND kind = 'invoice_sent' AND actor = 'tester'`, [inv]);
  assert.equal(a.rowCount, 1);
});

test('send needs an email and a live transaction', async () => {
  const [inv] = await pick('hilltop', 'invoice');
  await db.pool.query('UPDATE customer SET email = NULL WHERE customer_id = $1', [ids.customers.hilltop]);
  await assert.rejects(sendTransaction(db.pool, createMailer({}), { ...scope, txnId: inv, actor: 'tester' }), /no email address/);
  const voided = (await db.pool.query(`SELECT txn_id FROM txn WHERE voided_at IS NOT NULL LIMIT 1`)).rows[0].txn_id;
  await assert.rejects(sendTransaction(db.pool, createMailer({}), { ...scope, txnId: voided, actor: 'tester' }), /voided/);
});

test('a failing mailer is recorded as failed', async () => {
  const [inv] = await pick('crosstimbers', 'invoice');
  const broken = { from: 'x@y', async send() { throw new Error('smtp down'); } };
  assert.equal(await sendTransaction(db.pool, broken, { ...scope, txnId: inv, actor: 'tester' }), 'failed');
  const m = await db.pool.query('SELECT status, error FROM message WHERE related_txn_id = $1', [inv]);
  assert.deepEqual(m.rows[0], { status: 'failed', error: 'smtp down' });
});
