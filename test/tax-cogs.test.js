// test/tax-cogs.test.js — the COGS workpaper provider (spec §4.10, §13 T3), both paths: reconstructed from the routed costs and an inventory
// account's classified movements (purchases and returns only; a journal entry waits for a person's class, and a class whose transaction
// changed since waits again — never the default), lines 2, 3, 4 and 5 each from its own inputs, tax inventories held apart from book
// Schedule L and book COGS kept beside line 8; reviewed lines typed from a named source; the inventory treatment stated apart from the
// valuation (Codex t3-plan-r1 B4: only inventory counted as booked, at a plain valuation, is reconstructed — on a cash-method return too:
// a part-paid bill, one paid in installments over later years and an unpaid labor cost are each counted once, when booked).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { t2Db, company, acct, je, period, activity, bind, bindBalance, rawTxn, importedJe, bill, billPayment } from './tax-t3-fixtures.js';
import { saveWorkpaper, classifyMovement, cogsResults } from '../lib/tax/cogs.js';
import { openPeriod } from '../lib/tax/periods.js';
import { coverage, routeAllocations } from '../lib/tax/coverage.js';

let t, pool, orgId, G, ret, act, A, jeTxn, billTxn;
// The workpaper reads the 2025 catalog's Form 1125-A for every year here (a 2026 period computes nothing in the engine, but its workpaper's arithmetic is the same).
const RET = (id, e, y, method = 'accrual') => ({ return_id: id, entity_id: e, return_type: 'form_1065', form_edition: 2025, period_start: `${y}-01-01`, period_end: `${y}-12-31`, tax_method: method });
const results = async (C, id, y, method) => { const cov = await coverage(pool, { ...C, returnId: id }); return cogsResults(pool, { orgId, ret: RET(id, C.entityId, y, method), cov, routed: routeAllocations(cov) }); };
const lines = e => ['1', '2', '3', '4', '7'].map(n => e.values[n]);
const reconstruct = (C, id, a, extra = {}) => saveWorkpaper(pool, { ...C, returnId: id, activityId: a, path: 'reconstruct', treatment: 'inventory_as_booked', method: 'cost', begin: '100.00', end: '250.00', reviewedBy: 'tester', ...extra });
before(async () => {
  t = await t2Db(); pool = t.pool; orgId = t.orgId;
  G = { orgId, entityId: await company(pool, orgId, 'Gum Traders') };
  ret = await period(pool, G, 2025, 'form_1065', { taxMethod: 'accrual' });
  act = await activity(pool, G, { name: 'Gum trade' });
  A = {};
  for (const n of ['Checking', 'Inventory Asset', 'Cost of Goods Sold', 'Inventory Shrinkage', 'Sales', 'Accounts Receivable (A/R)', 'Accounts Payable (A/P)']) A[n] = await acct(pool, G, n);
  A.Freight = await acct(pool, G, 'Freight In', 'cost_of_goods_sold');
  A.Labor = await acct(pool, G, 'Direct Labor', 'cost_of_goods_sold');
  A.Overhead = await acct(pool, G, 'Capitalized Overhead', 'cost_of_goods_sold');
  await importedJe(pool, G, '2024-06-01', [[A['Inventory Asset'], 10000], [A.Checking, -10000]]);
  billTxn = await rawTxn(pool, G, 'bill', '2025-02-01', [[A['Inventory Asset'], 60000], [A['Accounts Payable (A/P)'], -60000]]);
  await rawTxn(pool, G, 'invoice', '2025-03-01', [[A['Accounts Receivable (A/R)'], 100000], [A.Sales, -100000], [A['Cost of Goods Sold'], 40000], [A['Inventory Asset'], -40000]], { total: 100000 });
  await rawTxn(pool, G, 'inventory_adjustment', '2025-06-30', [[A['Inventory Shrinkage'], 1000], [A['Inventory Asset'], -1000]], { total: 1000, accountId: A['Inventory Shrinkage'] });
  jeTxn = await importedJe(pool, G, '2025-07-01', [[A['Inventory Asset'], 3000], [A.Checking, -3000]]);
  await je(pool, G, '2025-08-01', [[A.Freight, 2000], [A.Checking, -2000]]);
  await je(pool, G, '2025-08-02', [[A.Labor, 7000], [A.Checking, -7000]]);
  await je(pool, G, '2025-08-03', [[A.Overhead, 1500], [A.Checking, -1500]]);
  await bind(pool, G, ret, A['Inventory Asset'], 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.2', activityId: act }]);
  await bindBalance(pool, G, ret, A['Inventory Asset'], 'f1065.L.3');
  for (const [a, n] of [[A.Freight, '5'], [A.Labor, '3'], [A.Overhead, '4']]) await bind(pool, G, ret, a, 'activity', [{ treatment: 'cogs_input', destination: `f1125a.main.${n}`, activityId: act }]);
  for (const a of [A['Cost of Goods Sold'], A['Inventory Shrinkage']]) await bind(pool, G, ret, a, 'activity', [{ treatment: 'cogs_tieout', destination: 'f1125a.main.8', activityId: act }]);
});
after(async () => { await t.db.drop(); });

test('without a workpaper the activity’s lines are unknown; started, a journal entry on the inventory account waits for a person’s class', async () => {
  let e = (await results(G, ret, 2025)).get(act);
  assert.deepEqual([e.values['2'], e.values['8']], [null, undefined]);
  assert.match(e.reasons.join(' '), /start its COGS workpaper/);
  await reconstruct(G, ret, act);
  e = (await results(G, ret, 2025)).get(act);
  assert.deepEqual(e.movements.map(m => m.cls), ['purchase', 'cost_of_sales', 'shrinkage', null]);
  assert.equal(e.values['2'], null, 'purchases wait on the unclassified journal entry');
  assert.deepEqual([e.values['3'], e.values['4']], [7000n, 1500n], 'labor and section 263A do not wait on the inventory account');
  assert.match(e.reasons.join(' '), /Classify the journal entry/);
});

test('reconstructed: purchases are the classified purchases (never the whole inventory activity or book COGS); labor, section 263A and other costs each from its own inputs; book COGS beside line 8', async () => {
  const m = (await results(G, ret, 2025)).get(act).movements.find(x => x.txnId === jeTxn);
  await assert.rejects(classifyMovement(pool, { ...G, returnId: ret, accountId: A['Inventory Asset'], txnId: jeTxn, lineNo: m.lineNo, cls: 'purchase', expectTxnVersion: 'old', reviewedBy: 'tester' }), /changed since/);
  await classifyMovement(pool, { ...G, returnId: ret, accountId: A['Inventory Asset'], txnId: jeTxn, lineNo: m.lineNo, cls: 'purchase', expectTxnVersion: m.txnVersion, reviewedBy: 'tester' });
  const e = (await results(G, ret, 2025)).get(act);
  assert.deepEqual(lines(e), [10000n, 63000n, 7000n, 1500n, 25000n]);
  assert.deepEqual(e.values['5'], [{ label: 'Freight In', cents: 2000n }]);
  assert.deepEqual([e.tieout.known, e.tieout.cents], [true, 41000n]);
  assert.deepEqual(e.reasons, []);
});

test('a person’s class whose transaction changed since is never replaced by the default: the purchase waits until classified again (memo edit, then amount edit)', async () => {
  const mv = () => results(G, ret, 2025).then(x => x.get(act));
  const m = (await mv()).movements.find(x => x.txnId === billTxn);
  await classifyMovement(pool, { ...G, returnId: ret, accountId: A['Inventory Asset'], txnId: billTxn, lineNo: m.lineNo, cls: 'transfer', expectTxnVersion: m.txnVersion, reviewedBy: 'tester' });
  assert.equal((await mv()).values['2'], 3000n, 'the bill reviewed as a transfer is not a purchase');
  await pool.query(`UPDATE txn SET memo = 'edited' WHERE txn_id = $1`, [billTxn]);
  let e = await mv();
  assert.equal(e.values['2'], null, 'never back to the default "purchase"');
  assert.match(e.reasons.join(' '), /changed after it was classified as transfer: classify it again/);
  assert.equal(e.movements.find(x => x.txnId === billTxn).stale, true);
  await pool.query('UPDATE posting SET amount_cents = amount_cents * 2 WHERE txn_id = $1', [billTxn]);
  await pool.query('UPDATE txn SET total_cents = 120000 WHERE txn_id = $1', [billTxn]);
  e = await mv();
  assert.equal(e.values['2'], null, 'an amount edit too');
  const now = e.movements.find(x => x.txnId === billTxn);
  await classifyMovement(pool, { ...G, returnId: ret, accountId: A['Inventory Asset'], txnId: billTxn, lineNo: now.lineNo, cls: 'purchase', expectTxnVersion: now.txnVersion, reviewedBy: 'tester' });
  assert.equal((await mv()).values['2'], 123000n, 'classified again: counted at its new amount');
  await pool.query('UPDATE posting SET amount_cents = amount_cents / 2 WHERE txn_id = $1', [billTxn]);
  await pool.query('UPDATE txn SET total_cents = 60000 WHERE txn_id = $1', [billTxn]);
  const back = (await mv()).movements.find(x => x.txnId === billTxn);
  await classifyMovement(pool, { ...G, returnId: ret, accountId: A['Inventory Asset'], txnId: billTxn, lineNo: back.lineNo, cls: 'purchase', expectTxnVersion: back.txnVersion, reviewedBy: 'tester' });
});

test('the treatment and the valuation gate the paths: only inventory counted as booked at a plain valuation is reconstructed; anything else is typed from a named source', async () => {
  await assert.rejects(reconstruct(G, ret, act, { treatment: null }), /Choose the inventory treatment/);
  await assert.rejects(reconstruct(G, ret, act, { treatment: 'materials_and_supplies' }), /Only inventory counted as the books record it is reconstructed/);
  await assert.rejects(reconstruct(G, ret, act, { lifo: true }), /LIFO.*not reconstructed/);
  await assert.rejects(reconstruct(G, ret, act, { subnormalWritedown: true }), /not reconstructed/);
  await assert.rejects(reconstruct(G, ret, act, { method: 'other', sourceNote: 'specific identification' }), /not reconstructed/);
  const reviewed = extra => saveWorkpaper(pool, { ...G, returnId: ret, activityId: act, path: 'reviewed', treatment: 'inventory_as_booked', method: 'cost', reviewedBy: 'tester',
    reviewedLines: { '1': '100.00', '2': '640.00', '3': '70.00', '4': '15.00', '5': [{ label: 'Freight', amount: '20.00' }], '7': '250.00' }, sourceNote: 'Year-end inventory workpaper', ...extra });
  await assert.rejects(reviewed({ sourceNote: '' }), /Name the source of the reviewed lines/);
  await assert.rejects(reviewed({ reviewedLines: { '1': '100.00' } }), /Line 2/);
  await reviewed({ treatment: 'materials_and_supplies', lifo: true });
  const e = (await results(G, ret, 2025)).get(act);
  assert.deepEqual(lines(e), [10000n, 64000n, 7000n, 1500n, 25000n]);
  assert.deepEqual(e.values['5'], [{ label: 'Freight', cents: 2000n }]);
  assert.deepEqual([e.workpaper.treatment, e.workpaper.lifo], ['materials_and_supplies', true]);
  await reconstruct(G, ret, act);
});

test('cash method, inventory counted as booked: a part-paid bill, a bill paid in installments over the next two years and an unpaid labor cost are each counted once, when booked', async () => {
  const H = { orgId, entityId: await company(pool, orgId, 'Gum Cash Traders') };
  const h25 = await period(pool, H, 2025, 'form_1065', { taxMethod: 'cash' });
  const h26 = Number(await openPeriod(pool, { ...H, year: 2026, actor: 'tester' }));
  const h27 = Number(await openPeriod(pool, { ...H, year: 2027, actor: 'tester' }));
  const a = await activity(pool, H, { name: 'Cash gum trade' });
  const inv = await acct(pool, H, 'Inventory Asset'), bank = await acct(pool, H, 'Checking');
  const labor = await acct(pool, H, 'Direct Labor', 'cost_of_goods_sold'), over = await acct(pool, H, 'Capitalized Overhead', 'cost_of_goods_sold'), freight = await acct(pool, H, 'Freight In', 'cost_of_goods_sold');
  const partPaid = await bill(pool, H, '2025-03-01', [[inv, 8000]]);
  await billPayment(pool, H, '2025-04-01', 3000, bank, [[partPaid, 3000, '2025-04-01']]);
  const installments = await bill(pool, H, '2025-11-01', [[inv, 6000]]);
  await billPayment(pool, H, '2026-02-01', 2000, bank, [[installments, 2000, '2026-02-01']]);
  await billPayment(pool, H, '2027-02-01', 4000, bank, [[installments, 4000, '2027-02-01']]);
  await bill(pool, H, '2025-12-15', [[labor, 2500]]); // unpaid at the year end
  await bill(pool, H, '2025-06-01', [[over, 900], [freight, 300]]);
  for (const id of [h25, h26, h27]) {
    await bind(pool, H, id, inv, 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.2', activityId: a }]);
    for (const [acc, n] of [[labor, '3'], [over, '4'], [freight, '5']]) await bind(pool, H, id, acc, 'activity', [{ treatment: 'cogs_input', destination: `f1125a.main.${n}`, activityId: a }]);
    await saveWorkpaper(pool, { ...H, returnId: id, activityId: a, path: 'reconstruct', treatment: 'inventory_as_booked', method: 'cost', begin: '0', end: '0', reviewedBy: 'tester' });
  }
  const y = async (id, yr) => (await results(H, id, yr, 'cash')).get(a);
  const e25 = await y(h25, 2025), e26 = await y(h26, 2026), e27 = await y(h27, 2027);
  assert.deepEqual([e25.values['2'], e25.values['3'], e25.values['4'], e25.values['5']], [14000n, 2500n, 900n, [{ label: 'Freight In', cents: 300n }]], 'every cost when booked: part paid, unpaid or not');
  assert.deepEqual([e26.values['2'], e26.values['3'], e26.values['4']], [0n, 0n, 0n], 'the installments of 2026 add nothing');
  assert.deepEqual([e27.values['2'], e27.values['3'], e27.values['4']], [0n, 0n, 0n], 'nor those of 2027');
});
