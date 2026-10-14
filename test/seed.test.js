import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './harness.js';
import { generateSample, expectedSummary } from '../lib/seed/generate.js';
import { writeSample } from '../lib/data/seed.js';
import { getSummary } from '../lib/data/customers.js';

const AS_OF = '2026-10-12';
let db, sample, ids;
before(async () => {
  db = await freshDb();
  sample = generateSample({ asOf: AS_OF });
  ids = await writeSample(db.pool, sample);
});
after(async () => { await db.drop(); });

test('generator is deterministic', () => {
  assert.equal(JSON.stringify(generateSample({ asOf: AS_OF })), JSON.stringify(sample));
  assert.notEqual(JSON.stringify(generateSample({ asOf: AS_OF, seed: 7 })), JSON.stringify(sample));
});

test('open amounts reconcile with applications on both sides', () => {
  const appliedTo = new Map(), appliedFrom = new Map();
  for (const a of sample.applications) {
    assert.ok(a.amount_cents > 0);
    appliedTo.set(a.charge, (appliedTo.get(a.charge) ?? 0) + a.amount_cents);
    appliedFrom.set(a.credit, (appliedFrom.get(a.credit) ?? 0) + a.amount_cents);
  }
  for (const t of sample.txns) {
    if (t.voided) { assert.equal(t.total_cents, 0); assert.equal(t.open_cents, 0); assert.ok(!appliedTo.has(t.key)); continue; }
    if (t.type === 'invoice') {
      const lineTotal = sample.lines.filter(l => l.txn === t.key).reduce((s, l) => s + l.amount_cents, 0);
      assert.equal(t.total_cents, lineTotal, t.key);
      assert.equal(t.open_cents, t.total_cents - (appliedTo.get(t.key) ?? 0), t.key);
    }
    if (t.type === 'payment' || t.type === 'credit_memo') {
      assert.equal(t.open_cents, t.total_cents - (appliedFrom.get(t.key) ?? 0), t.key);
    }
    assert.ok(t.open_cents >= 0 && t.open_cents <= t.total_cents, t.key);
  }
});

test('sample covers every status the page must show', () => {
  const live = sample.txns.filter(t => !t.voided);
  assert.ok(live.some(t => t.type === 'invoice' && t.open_cents > 0 && t.due_date < AS_OF), 'overdue invoice');
  assert.ok(live.some(t => t.type === 'invoice' && t.open_cents > 0 && t.due_date >= AS_OF), 'invoice not yet due');
  assert.ok(live.some(t => t.type === 'invoice' && t.open_cents > 0 && t.open_cents < t.total_cents), 'partially paid invoice');
  assert.ok(live.some(t => t.type === 'invoice' && t.open_cents === 0), 'paid invoice');
  assert.ok(sample.txns.some(t => t.voided), 'voided invoice');
  assert.ok(live.some(t => t.type === 'payment' && t.open_cents > 0), 'unapplied payment');
  assert.ok(live.some(t => t.type === 'credit_memo'), 'credit memo');
  assert.ok(live.some(t => t.type === 'sales_receipt'), 'sales receipt');
  assert.ok(sample.customers.some(c => !c.active), 'inactive customer');
  assert.equal(new Set(sample.txns.filter(t => t.doc_number).map(t => t.doc_number)).size, sample.txns.filter(t => t.doc_number).length);
});

test('database matches the generator', async () => {
  const count = async table => Number((await db.pool.query(`SELECT count(*) FROM ${table} WHERE org_id = $1`, [ids.orgId])).rows[0].count);
  assert.equal(await count('customer'), sample.customers.length);
  assert.equal(await count('txn'), sample.txns.length + sample.deposits.length + sample.vendorDocs.length + sample.billPayments.length
    + sample.inventory.items.length + 2);
  assert.ok(sample.deposits.length > 10, 'older payments are banked');
  assert.equal(await count('txn_line'), sample.lines.length + sample.vendorDocs.reduce((n, d) => n + d.lines.length, 0)
    + sample.inventory.items.length + sample.inventory.purchaseOrder.lines.length + sample.inventory.itemReceipt.lines.length);
  assert.equal(await count('application'), sample.applications.length + sample.billPayments.reduce((n, p) => n + p.applies.length, 0));
  assert.equal(await count('activity_event'), sample.activity.length + sample.vendors.length + 2, 'plus the purchase order and item receipt');
  assert.equal(await count('vendor'), sample.vendors.length);
  for (const c of sample.customers) {
    const got = await getSummary(db.pool, { orgId: ids.orgId, customerId: ids.customers[c.key], today: AS_OF });
    assert.deepEqual(got, expectedSummary(sample, c.key, AS_OF), c.key);
  }
});

test('re-seeding replaces the org instead of duplicating it', async () => {
  const again = await writeSample(db.pool, sample);
  const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM org WHERE slug = 'sample'`);
  assert.equal(rows[0].n, 1);
  assert.notEqual(again.orgId, ids.orgId);
  ids = again;
});
