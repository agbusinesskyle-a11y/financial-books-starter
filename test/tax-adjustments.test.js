// test/tax-adjustments.test.js — adjustments and proposals (spec §4.6): rule proposals in exact cents (an account named for meals only at
// 50 percent, toward zero; entertainment only at 100 percent; meals and entertainment booked together at 100 percent with the reason —
// Codex t3-plan-r1 B15; fines and penalties at 100 percent; the nondeductible part moved to Schedule K's nondeductible-expense line); a
// person's adjustment is a delta with its M-1 class and its support, never on a computed or engine line, every dimension of its slot this
// return's (B9: another company's, another organization's, a nonexistent or an out-of-period activity or owner interest is refused); a
// reclass nets to zero on the return's income; a withdrawal keeps the record with its reason.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { t2Db, company, period, activity } from './tax-t3-fixtures.js';
import { party } from './tax-t2-fixtures.js';
import { saveInterest } from '../lib/tax/ownership.js';
import { proposalsFor, saveAdjustment, withdrawAdjustment, listAdjustments } from '../lib/tax/adjustments.js';

let t, pool, orgId, H, ret;
before(async () => {
  t = await t2Db(); pool = t.pool; orgId = t.orgId;
  H = { orgId, entityId: await company(pool, orgId, 'Hawthorn Partners') };
  ret = await period(pool, H, 2025, 'form_1065', { taxMethod: 'accrual' });
});
after(async () => { await t.db.drop(); });

test('proposals: meals at half (toward zero), entertainment in full, the two booked together in full with the reason, fines in full, each moving the nondeductible part to Schedule K; nothing for income or a negative amount', () => {
  const R = rt => ({ return_type: rt, form_edition: 2025 });
  const p = proposalsFor(R('form_1065'), [
    { slotKey: 'f1065.p1.21|activity', accountId: 1, accountName: 'Meals', cents: 9001n, version: 'v1' },
    { slotKey: 'f1065.p1.21|activity', accountId: 2, accountName: 'Fines and Penalties', cents: 1000n, version: 'v2' },
    { slotKey: 'f1065.p1.1a|activity', accountId: 3, accountName: 'Meals income', cents: 500n, version: 'v3' },
    { slotKey: 'f1065.p1.21|activity', accountId: 4, accountName: 'Entertainment', cents: -200n, version: 'v4' },
  ]);
  assert.deepEqual(p.map(x => [x.purpose, x.lines.map(l => [l.slotKey, l.cents, l.m1Class])]), [
    ['meals_50', [['f1065.p1.21|activity', -4500n, 'meals_50'], ['f1065.k.18c|activity', 4500n, 'meals_50']]],
    ['penalties', [['f1065.p1.21|activity', -1000n, 'nondeductible'], ['f1065.k.18c|activity', 1000n, 'nondeductible']]],
  ]);
  assert.equal(p[0].key, 'meals_50:1:f1065.p1.21|activity');
  assert.notEqual(proposalsFor(R('form_1065'), [{ slotKey: 'f1065.p1.21|activity', accountId: 1, accountName: 'Meals', cents: 9002n, version: 'v1' }])[0].version, p[0].version, 'a new amount is a new version');
  assert.equal(proposalsFor(R('form_1120s'), [{ slotKey: 'f1120s.p1.20|activity', accountId: 1, accountName: 'Meals', cents: 100n, version: 'v' }])[0].lines[1].slotKey, 'f1120s.k.16c|activity');
  // Entertainment is never given the meals fraction: entertainment only in full; meals and entertainment together in full, saying so.
  const e = proposalsFor(R('form_1065'), [
    { slotKey: 'f1065.p1.21|activity', accountId: 5, accountName: 'Entertainment', cents: 10000n, version: 'v5' },
    { slotKey: 'f1065.p1.21|activity', accountId: 6, accountName: 'Meals & Entertainment', cents: 10000n, version: 'v6' },
    { slotKey: 'f1065.p1.21|activity', accountId: 7, accountName: 'Client entertaining', cents: 3000n, version: 'v7' },
  ]);
  assert.deepEqual(e.map(x => [x.accountName, x.lines.map(l => l.cents), x.cls]), [['Entertainment', [-10000n, 10000n], 'meals_50'], ['Meals & Entertainment', [-10000n, 10000n], 'meals_50'], ['Client entertaining', [-3000n, 3000n], 'meals_50']]);
  assert.match(e[0].why, /^Entertainment is not deductible/);
  assert.match(e[1].why, /booked together.*reject this and enter the meals part/);
});

test('every dimension of an adjustment’s slot is this return’s (Codex t3-plan-r1 B9): another company’s, another organization’s, a nonexistent or an out-of-period activity, an owner interest not this period’s, a T4 owner or a K-1 source are refused', async () => {
  const S = { ...H, returnId: ret };
  const add = slotKey => saveAdjustment(pool, { ...S, purpose: 'other', memo: 'Sample', evidence: 'Sample workpaper', decidedBy: 'tester', lines: [{ slotKey, amount: '10.00', m1Class: 'other' }] });
  const mine = await activity(pool, H, { name: 'Hawthorn trade' });
  const ended = await activity(pool, H, { name: 'Hawthorn old trade', from: '2018-01-01', to: '2023-12-31' });
  const O = { orgId, entityId: await company(pool, orgId, 'Hawthorn Other Co') };
  await period(pool, O, 2025, 'form_1065', { taxMethod: 'accrual' });
  const theirs = await activity(pool, O, { name: 'Other trade' });
  const { rows: [o] } = await pool.query(`INSERT INTO org (slug, name) VALUES ('t3_adj_other', 'Adjustment Sample Org') RETURNING org_id`);
  const X = { orgId: Number(o.org_id), entityId: await company(pool, Number(o.org_id), 'Foreign Partners') };
  const foreign = await activity(pool, X, { name: 'Foreign trade' });
  const cogs3 = a => `f1125a.main.3|activity=act:${a}|activity`;
  await assert.rejects(add(cogs3(theirs)), /is not an activity of this company/);
  await assert.rejects(add(cogs3(foreign)), /is not an activity of this company/);
  await assert.rejects(add(cogs3(999999999)), /is not an activity of this company/);
  await assert.rejects(add(cogs3(ended)), /not in effect in this period/);
  await assert.rejects(add('f1065.p1.10|interest=i:999999999|activity'), /not an owner’s interest in this company/);
  await assert.rejects(add('f1065.p1.10|interest=i:t4|activity'), /stage T4/);
  await assert.rejects(add('f1065.k.5|k1_source=k1:1|activity'), /K-1 source \(stage T4\)/);
  const partner = await party(pool, orgId, 'Sample Partner Hawthorn');
  await saveInterest(pool, { ...H, fields: { partyId: partner, role: 'general_partner', from: '2025-07-01', to: null, profit: '1/2', loss: '1/2', capital: '1/2' }, actor: 'tester' });
  const { rows: [i] } = await pool.query('SELECT interest_id FROM ownership_interest WHERE org_id = $1 AND entity_id = $2', [orgId, H.entityId]);
  await assert.rejects(add(`f1065.p1.10|interest=i:${i.interest_id}|activity`), /changes during the period/, 'an interest that starts mid-year is not this period’s selected interest');
  await add(cogs3(mine));
  await pool.query('DELETE FROM tax_adjustment WHERE return_id = $1', [ret]);
  await pool.query('DELETE FROM tax_adjustment_group WHERE return_id = $1', [ret]);
});

test('a person’s adjustment states its support and never lands on a computed or engine line; a reclass nets to zero; withdrawn with a reason', async () => {
  const S = { ...H, returnId: ret };
  const add = extra => saveAdjustment(pool, { ...S, purpose: 'other', memo: 'Unrecorded accrued wages (preparer’s entry 4)', evidence: 'Payroll register, January', decidedBy: 'tester',
    lines: [{ slotKey: 'f1065.p1.9|activity', amount: '50.00', m1Class: 'method_timing' }], ...extra });
  await assert.rejects(add({ evidence: '' }), /support/);
  await assert.rejects(add({ memo: ' ' }), /Say what the adjustment does/);
  await assert.rejects(add({ lines: [{ slotKey: 'f1065.p1.23|activity', amount: '50.00', m1Class: 'other' }] }), /computed field|not a slot/);
  await assert.rejects(add({ lines: [{ slotKey: 'books.ni.total|activity', amount: '50.00', m1Class: 'other' }] }), /computed by the engine/);
  await assert.rejects(add({ lines: [{ slotKey: 'f1065.p1.9|activity', amount: '0', m1Class: 'other' }] }), /nonzero amount/);
  await assert.rejects(add({ lines: [{ slotKey: 'f1065.p1.9|activity', amount: '5', m1Class: 'plug' }] }), /Schedule M-1/);
  await assert.rejects(add({ purpose: 'elimination' }), /stage T4/);
  await assert.rejects(add({ purpose: 'reclass', lines: [{ slotKey: 'f1065.p1.9|activity', amount: '50.00', m1Class: 'reclass' }, { slotKey: 'f1065.p1.11|activity', amount: '-40.00', m1Class: 'reclass' }] }), /without changing the return’s income/);
  await assert.rejects(add({ lines: [{ slotKey: 'f1065.p1.9|activity', amount: '50.00', m1Class: 'reclass' }] }), /only a reclassification uses that class/);
  const g = await add();
  await saveAdjustment(pool, { ...S, purpose: 'reclass', memo: 'Repairs booked as wages', evidence: 'Invoice 112', decidedBy: 'tester',
    lines: [{ slotKey: 'f1065.p1.9|activity', amount: '-20.00', m1Class: 'reclass' }, { slotKey: 'f1065.p1.11|activity', amount: '20.00', m1Class: 'reclass' }] });
  await assert.rejects(withdrawAdjustment(pool, { ...S, groupId: g, reason: '', decidedBy: 'tester' }), /Say why/);
  await withdrawAdjustment(pool, { ...S, groupId: g, reason: 'Booked in January after all', decidedBy: 'tester' });
  await assert.rejects(withdrawAdjustment(pool, { ...S, groupId: g, reason: 'again', decidedBy: 'tester' }), /not an accepted adjustment/);
  const list = await listAdjustments(pool, { orgId, returnId: ret });
  assert.deepEqual(list.map(x => [x.purpose, x.status, x.lines.map(l => l.cents)]), [['other', 'withdrawn', [5000n]], ['reclass', 'accepted', [-2000n, 2000n]]]);
});
