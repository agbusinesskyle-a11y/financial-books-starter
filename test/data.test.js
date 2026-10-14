import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './harness.js';
import { generateSample } from '../lib/seed/generate.js';
import { writeSample } from '../lib/data/seed.js';
import { listCustomers, getCustomer, getSummary } from '../lib/data/customers.js';
import { listTransactions, getTransaction } from '../lib/data/transactions.js';
import { listActivity } from '../lib/data/activity.js';
import { parseTxnFilters } from '../lib/domain/filters.js';

const TODAY = '2026-10-12';
let db, ids, sample;
const f = (q = {}) => parseTxnFilters(q, TODAY);
const list = (key, q, pageSize) => listTransactions(db.pool, { orgId: ids.orgId, customerId: ids.customers[key], filters: f(q), today: TODAY, pageSize });

before(async () => {
  db = await freshDb();
  sample = generateSample({ asOf: TODAY });
  ids = await writeSample(db.pool, sample);
});
after(async () => { await db.drop(); });

test('listCustomers: all, search, wildcard-safe', async () => {
  const all = await listCustomers(db.pool, { orgId: ids.orgId, entityId: ids.entityId });
  assert.equal(all.length, sample.customers.length);
  assert.equal(all.at(-1).active, false, 'inactive sorted last');
  const byEmail = await listCustomers(db.pool, { orgId: ids.orgId, entityId: ids.entityId, search: 'hilltopdairy' });
  assert.deepEqual(byEmail.map(c => c.display_name), ['Hilltop Dairy']);
  const pct = await listCustomers(db.pool, { orgId: ids.orgId, entityId: ids.entityId, search: '%' });
  assert.equal(pct.length, 0, '% is literal, not a wildcard');
  const rr = all.find(c => c.display_name === 'Red River Farm & Ranch');
  const s = await getSummary(db.pool, { orgId: ids.orgId, customerId: rr.customer_id, today: TODAY });
  assert.equal(rr.open_cents, s.openCents);
});

test('getCustomer is scoped to the organization and the company', async () => {
  const id = ids.customers.redriver;
  assert.equal((await getCustomer(db.pool, { orgId: ids.orgId, entityId: ids.entityId, id })).display_name, 'Red River Farm & Ranch');
  assert.equal(await getCustomer(db.pool, { orgId: ids.orgId + 999, entityId: ids.entityId, id }), null);
  assert.equal(await getCustomer(db.pool, { orgId: ids.orgId, entityId: ids.entityId + 999, id }), null, 'another company');
  assert.equal(await getCustomer(db.pool, { orgId: ids.orgId, entityId: ids.entityId, id: NaN }), null);
});

test('summary: slow payer is overdue', async () => {
  const s = await getSummary(db.pool, { orgId: ids.orgId, customerId: ids.customers.redriver, today: TODAY });
  assert.ok(s.overdueCents > 0 && s.openCents >= s.overdueCents);
});

test('type, status, date filters', async () => {
  const pays = await list('redriver', { type: 'payment' }, 0);
  assert.ok(pays.rows.length > 0 && pays.rows.every(r => r.type === 'payment'));
  const overdue = await list('redriver', { status: 'overdue' }, 0);
  assert.ok(overdue.rows.length > 0 && overdue.rows.every(r => r.open_cents > 0 && r.due_date < TODAY));
  const voided = await list('prairie', { status: 'voided' }, 0);
  assert.equal(voided.rows.length, 1);
  assert.ok(voided.rows[0].voided_at);
  const paid = await list('prairie', { status: 'paid' }, 0);
  assert.ok(paid.rows.every(r => r.open_cents === 0 && !r.voided_at));
  const lastMonth = await list('redriver', { date: 'last_month' }, 0);
  assert.ok(lastMonth.rows.length > 0 && lastMonth.rows.every(r => r.txn_date >= '2026-09-01' && r.txn_date <= '2026-09-30'));
  const custom = await list('redriver', { date: 'custom', from: '2026-09-01', to: '2026-09-01' }, 0);
  assert.ok(custom.rows.every(r => r.txn_date === '2026-09-01'));
});

test('sorting and paging', async () => {
  const asc = await list('redriver', { sort: 'amount', dir: 'asc' }, 0);
  for (let i = 1; i < asc.rows.length; i++) assert.ok(asc.rows[i - 1].total_cents <= asc.rows[i].total_cents);
  const desc = await list('redriver', {}, 0);
  for (let i = 1; i < desc.rows.length; i++) assert.ok(desc.rows[i - 1].txn_date >= desc.rows[i].txn_date);
  const p1 = await list('redriver', {}, 50);
  const p2 = await list('redriver', { page: '2' }, 50);
  assert.equal(p1.rows.length, 50);
  assert.equal(p1.total, desc.rows.length);
  assert.equal(p2.total, desc.rows.length);
  assert.notEqual(p1.rows[0].txn_id, p2.rows[0].txn_id);
  const past = await list('redriver', { page: '999' }, 50);
  assert.equal(past.rows.length, 0);
  assert.equal(past.total, desc.rows.length);
});

test('getTransaction returns lines and applications from both sides', async () => {
  const pay = (await list('redriver', { type: 'payment', status: 'paid' }, 1)).rows[0];
  const t = await getTransaction(db.pool, { orgId: ids.orgId, id: pay.txn_id });
  assert.ok(t.applications.length > 0 && t.applications.every(a => a.type === 'invoice'));
  assert.equal(t.applications.reduce((s, a) => s + a.amount_cents, 0), t.total_cents);
  const inv = await getTransaction(db.pool, { orgId: ids.orgId, id: t.applications[0].txn_id });
  assert.ok(inv.lines.length > 0);
  assert.ok(inv.applications.some(a => a.txn_id === pay.txn_id));
  assert.equal(await getTransaction(db.pool, { orgId: ids.orgId + 999, id: pay.txn_id }), null);
});

test('activity feed newest first', async () => {
  const a = await listActivity(db.pool, { orgId: ids.orgId, customerId: ids.customers.prairie, limit: 500 });
  assert.ok(a.length > 0);
  for (let i = 1; i < a.length; i++) assert.ok(a[i - 1].occurred_at >= a[i].occurred_at);
  assert.ok(a.some(e => e.kind === 'txn_voided'));
});
