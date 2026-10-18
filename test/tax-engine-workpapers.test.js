// test/tax-engine-workpapers.test.js — the workpapers through the engine (spec §5.4, §5.5, §13.1 T3): an undecided closing blocks what it
// touches and a confirmed one leaves net income and retained earnings whole (a January 1 closing of last year too); COGS against book COGS on
// the M-1; typed items unresolved, entered, not applicable, and a typed value replacing the books; a meals proposal that leaves its line
// unresolved until answered, applies with its M-1 row, and waits again when its amount changes; a person's adjustment and a reclass on the
// M-1; K-1s received waiting for stage T4; cash-basis books.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { t2Db, company, acct, je, period, activity, bind, bindBalance, compute, valueOf, errorsOf, answerTypedItems, rawTxn, importedJe, invoice, payment, bill, billPayment } from './tax-t3-fixtures.js';
import { classifyEntry, closingCandidates } from '../lib/tax/classify.js';
import { saveWorkpaper } from '../lib/tax/cogs.js';
import { saveManualItem, clearManualItem } from '../lib/tax/manual.js';
import { saveAdjustment, withdrawAdjustment, answerProposal } from '../lib/tax/adjustments.js';
import { cashRecognition, saveTimingReview, accrualTiming } from '../lib/tax/cash.js';
import { computeIn } from '../lib/tax/engine/compute.js';
import { assignProvider } from '../lib/tax/providers.js';
import { saveInterest } from '../lib/tax/ownership.js';
import { saveParty } from '../lib/tax/parties.js';

let t, pool, orgId;
before(async () => { t = await t2Db(); pool = t.pool; orgId = t.orgId; });
after(async () => { await t.db.drop(); });
const expectAll = (r, want) => { for (const [k, v] of Object.entries(want)) assert.equal(valueOf(r, k), v, k); };
const R = (C, ret, extra = {}) => ({ return_id: ret, entity_id: C.entityId, period_start: '2025-01-01', period_end: '2025-12-31', ...extra });

test('closings: undecided, the accounts the entry touches are unknown; confirmed, net income and retained earnings stand, never doubled; a January 1 closing of last year too', async () => {
  const E = { orgId, entityId: await company(pool, orgId, 'Elm Partners') };
  const ret = await period(pool, E, 2025, 'form_1065', { taxMethod: 'accrual' });
  const A = {};
  for (const n of ['Checking', 'Services', 'Wages', 'Retained Earnings', 'Prepaid Expenses']) A[n] = await acct(pool, E, n);
  await je(pool, E, '2024-06-01', [[A.Checking, 20000], [A.Services, -20000]]);
  const jan1 = await je(pool, E, '2025-01-01', [[A.Services, 20000], [A['Retained Earnings'], -20000]], { memo: 'close last year' });
  await je(pool, E, '2025-02-01', [[A.Checking, 90000], [A.Services, -90000]]);
  await je(pool, E, '2025-03-01', [[A.Wages, 30000], [A.Checking, -30000]]);
  const dec31 = await je(pool, E, '2025-12-31', [[A.Services, 90000], [A.Wages, -30000], [A['Retained Earnings'], -60000], [A['Prepaid Expenses'], 5000], [A.Checking, -5000]], { memo: 'closing and correction' });
  await bindBalance(pool, E, ret, A.Checking, 'f1065.L.1');
  await bind(pool, E, ret, A['Prepaid Expenses'], 'end', [{ treatment: 'statement_row', destination: 'f1065.L.6' }]);
  await bindBalance(pool, E, ret, A['Retained Earnings'], 'f1065.L.21');
  await bind(pool, E, ret, A['Retained Earnings'], 'activity', [{ treatment: 'not_tax', memo: 'closing entries only' }]);
  await bind(pool, E, ret, A.Services, 'activity', [{ treatment: 'input', destination: 'f1065.p1.1a' }]);
  await bind(pool, E, ret, A.Wages, 'activity', [{ treatment: 'input', destination: 'f1065.p1.9' }]);
  await answerTypedItems(pool, E, ret);
  let r = await compute(pool, E, ret);
  assert.equal(valueOf(r, 'f1065.p1.9|activity'), null, 'touched by an undecided closing');
  assert.equal(valueOf(r, 'f1065.anal.1|activity'), null);
  assert.equal(errorsOf(r, 'closing_candidate').length, 2);
  for (const txnId of [jan1, dec31]) {
    const c = (await closingCandidates(pool, { orgId, ret: R(E, ret) })).find(x => x.txnId === txnId);
    await classifyEntry(pool, { ...E, returnId: ret, txnId, cls: 'closing', lines: c.proposed, expectTxnVersion: c.txnVersion, reviewedBy: 'tester' });
  }
  r = await compute(pool, E, ret);
  expectAll(r, { 'f1065.p1.1a|activity': 90000n, 'f1065.p1.9|activity': 30000n, 'f1065.anal.1|activity': 60000n, 'f1065.m1.1|activity': 60000n, 'f1065.L.6|end': 5000n,
    'f1065.L.1|end': 75000n, 'f1065.L.21|begin': 20000n, 'f1065.L.21|end': 80000n, 'f1065.L.14|end': 80000n, 'f1065.L.22|end': 80000n });
  assert.equal(r.bridge.residual, '0');
});

test('COGS through the engine: line 8 from the workpaper, page 1 line 2 from line 8, and the book vs tax inventory difference on the M-1', async () => {
  const G = { orgId, entityId: await company(pool, orgId, 'Gum Traders') };
  const ret = await period(pool, G, 2025, 'form_1065', { taxMethod: 'accrual' });
  const act = await activity(pool, G, { name: 'Gum trade' });
  const A = {};
  for (const n of ['Checking', 'Inventory Asset', 'Cost of Goods Sold', 'Inventory Shrinkage', 'Sales', 'Accounts Receivable (A/R)', 'Accounts Payable (A/P)', 'Retained Earnings']) A[n] = await acct(pool, G, n);
  A.Freight = await acct(pool, G, 'Freight In', 'cost_of_goods_sold');
  await importedJe(pool, G, '2024-06-01', [[A['Inventory Asset'], 10000], [A.Checking, -10000]]);
  await rawTxn(pool, G, 'bill', '2025-02-01', [[A['Inventory Asset'], 63000], [A['Accounts Payable (A/P)'], -63000]]);
  await rawTxn(pool, G, 'invoice', '2025-03-01', [[A['Accounts Receivable (A/R)'], 100000], [A.Sales, -100000], [A['Cost of Goods Sold'], 40000], [A['Inventory Asset'], -40000]], { total: 100000 });
  await rawTxn(pool, G, 'inventory_adjustment', '2025-06-30', [[A['Inventory Shrinkage'], 1000], [A['Inventory Asset'], -1000]], { total: 1000, accountId: A['Inventory Shrinkage'] });
  await je(pool, G, '2025-08-01', [[A.Freight, 2000], [A.Checking, -2000]]);
  await bind(pool, G, ret, A['Inventory Asset'], 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.2', activityId: act }]);
  for (const [a, d] of [[A['Inventory Asset'], 'f1065.L.3'], [A.Checking, 'f1065.L.1'], [A['Retained Earnings'], 'f1065.L.21']]) await bindBalance(pool, G, ret, a, d);
  await bind(pool, G, ret, A['Accounts Receivable (A/R)'], 'end', [{ treatment: 'input', destination: 'f1065.L.2a' }]);
  await bind(pool, G, ret, A['Accounts Payable (A/P)'], 'end', [{ treatment: 'input', destination: 'f1065.L.15' }]);
  await bind(pool, G, ret, A.Freight, 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.5', activityId: act }]);
  for (const a of [A['Cost of Goods Sold'], A['Inventory Shrinkage']]) await bind(pool, G, ret, a, 'activity', [{ treatment: 'cogs_tieout', destination: 'f1125a.main.8', activityId: act }]);
  await bind(pool, G, ret, A.Sales, 'activity', [{ treatment: 'input', destination: 'f1065.p1.1a' }]);
  await answerTypedItems(pool, G, ret);
  let r = await compute(pool, G, ret);
  assert.equal(valueOf(r, `f1125a.main.8|activity=act:${act}|activity`), null, 'no workpaper yet');
  assert.equal(valueOf(r, 'f1065.p1.23|activity'), null);
  await saveWorkpaper(pool, { ...G, returnId: ret, activityId: act, path: 'reconstruct', treatment: 'inventory_as_booked', method: 'cost', begin: '100.00', end: '250.00', reviewedBy: 'tester' });
  r = await compute(pool, G, ret);
  expectAll(r, { [`f1125a.main.6|activity=act:${act}|activity`]: 75000n, [`f1125a.main.8|activity=act:${act}|activity`]: 50000n, 'f1065.p1.2|activity': 50000n, 'f1065.p1.23|activity': 50000n,
    'f1065.m1.1|activity': 57000n, 'f1065.m1.7b|activity': 7000n, 'f1065.m1.9|activity': 50000n, 'f1065.L.3|end': 32000n });
  assert.deepEqual(r.bridge.rows.map(x => [x.line, x.cls, x.cents]), [['7b', 'inventory', '7000']]);
  assert.equal(r.bridge.residual, '0');
});

test('typed items, proposals and adjustments through the engine', async () => {
  const H = { orgId, entityId: await company(pool, orgId, 'Hazel Partners') };
  const ret = await period(pool, H, 2025, 'form_1065', { taxMethod: 'accrual' });
  const A = {};
  for (const n of ['Checking', 'Services', 'Meals', 'Wages', 'Retained Earnings']) A[n] = await acct(pool, H, n);
  await je(pool, H, '2025-02-01', [[A.Checking, 100000], [A.Services, -100000]]);
  await je(pool, H, '2025-03-01', [[A.Meals, 9001], [A.Checking, -9001]]);
  await je(pool, H, '2025-04-01', [[A.Wages, 20000], [A.Checking, -20000]]);
  await bindBalance(pool, H, ret, A.Checking, 'f1065.L.1');
  await bind(pool, H, ret, A['Retained Earnings'], 'end', [{ treatment: 'input', destination: 'f1065.L.21' }]);
  await bind(pool, H, ret, A.Services, 'activity', [{ treatment: 'input', destination: 'f1065.p1.1a' }]);
  await bind(pool, H, ret, A.Meals, 'activity', [{ treatment: 'statement_row', destination: 'f1065.p1.21' }]);
  await bind(pool, H, ret, A.Wages, 'activity', [{ treatment: 'input', destination: 'f1065.p1.9' }]);
  const S = { ...H, returnId: ret };
  // Typed items: unresolved until answered; an entered zero is zero; not applicable is zero; clearing makes it unresolved again.
  await answerTypedItems(pool, H, ret, { except: ['f1065.p1.16a|activity'] });
  let r = await compute(pool, H, ret);
  assert.equal(valueOf(r, 'f1065.p1.16a|activity'), null);
  assert.ok(errorsOf(r, 'manual_open').some(c => c.itemKey === 'f1065.p1.16a|activity'));
  await saveManualItem(pool, { ...S, itemKey: 'f1065.p1.16a|activity', status: 'entered', amount: '0', enteredBy: 'tester' });
  assert.equal(valueOf(await compute(pool, H, ret), 'f1065.p1.16a|activity'), 0n);
  await clearManualItem(pool, { ...S, itemKey: 'f1065.p1.16a|activity' });
  assert.equal(valueOf(await compute(pool, H, ret), 'f1065.p1.16a|activity'), null);
  await saveManualItem(pool, { ...S, itemKey: 'f1065.p1.16a|activity', status: 'not_applicable', enteredBy: 'tester' });
  // The meals proposal: unanswered, its lines are unknown; refusals; accepted, half moves to nondeductible expenses, M-1 line 4b.
  r = await compute(pool, H, ret);
  const p = r.proposals.find(x => x.purpose === 'meals_50');
  assert.equal(valueOf(r, 'f1065.p1.21|activity'), null);
  assert.equal(valueOf(r, 'f1065.k.18c|activity'), null);
  assert.ok(errorsOf(r, 'proposal_open').length);
  await assert.rejects(answerProposal(pool, { ...S, key: p.key, version: p.version, decision: 'reject', decidedBy: 'tester', compute: computeIn }), /Say why/);
  await assert.rejects(answerProposal(pool, { ...S, key: p.key, version: 'old', decision: 'accept', decidedBy: 'tester', compute: computeIn }), /changed since the page was shown/);
  await answerProposal(pool, { ...S, key: p.key, version: p.version, decision: 'accept', decidedBy: 'tester', compute: computeIn });
  await assert.rejects(answerProposal(pool, { ...S, key: p.key, version: p.version, decision: 'accept', decidedBy: 'tester', compute: computeIn }), /already answered/);
  r = await compute(pool, H, ret);
  expectAll(r, { 'f1065.p1.21|activity': 4501n, 'f1065.k.18c|activity': 4500n, 'f1065.p1.23|activity': 75499n, 'f1065.m1.1|activity': 70999n, 'f1065.m1.4b|activity': 4500n, 'f1065.m1.9|activity': 75499n });
  assert.equal(r.bridge.residual, '0');
  // More meals booked: the answer no longer matches, the line waits again; removed, the answer applies again.
  const more = await je(pool, H, '2025-05-01', [[A.Meals, 1000], [A.Checking, -1000]]);
  r = await compute(pool, H, ret);
  assert.equal(valueOf(r, 'f1065.p1.21|activity'), null);
  assert.ok(r.checks.some(c => c.code === 'stale_answer'));
  await pool.query('DELETE FROM posting WHERE txn_id = $1', [more]);
  await pool.query('DELETE FROM txn WHERE txn_id = $1', [more]);
  assert.equal(valueOf(await compute(pool, H, ret), 'f1065.p1.21|activity'), 4501n);
  // A person's adjustment (a deduction the books do not carry: M-1 line 7b) and a reclass (no M-1 difference); withdrawn, gone.
  const g = await saveAdjustment(pool, { ...S, purpose: 'other', memo: 'Accrued wages', evidence: 'Payroll register', decidedBy: 'tester', lines: [{ slotKey: 'f1065.p1.9|activity', amount: '50.00', m1Class: 'method_timing' }] });
  await saveAdjustment(pool, { ...S, purpose: 'reclass', memo: 'Repairs booked as wages', evidence: 'Invoice 112', decidedBy: 'tester',
    lines: [{ slotKey: 'f1065.p1.9|activity', amount: '-20.00', m1Class: 'reclass' }, { slotKey: 'f1065.p1.11|activity', amount: '20.00', m1Class: 'reclass' }] });
  r = await compute(pool, H, ret);
  expectAll(r, { 'f1065.p1.9|activity': 23000n, 'f1065.p1.11|activity': 2000n, 'f1065.m1.7b|activity': 5000n });
  assert.equal(r.bridge.residual, '0');
  await withdrawAdjustment(pool, { ...S, groupId: g, reason: 'Booked after all', decidedBy: 'tester' });
  assert.equal(valueOf(await compute(pool, H, ret), 'f1065.p1.9|activity'), 18000n);
  // A slot T1 gave the manual provider takes the typed value; the books routed there are an M-1 difference of their own.
  await assignProvider(pool, { ...S, slotKey: 'f1065.p1.1a|activity', providerKind: 'manual', schemaVersion: 1, sourceRef: { reason: 'reviewed receipts' }, sourceVersion: 'manual:receipts@1' });
  assert.equal(valueOf(await compute(pool, H, ret), 'f1065.p1.1a|activity'), null);
  await saveManualItem(pool, { ...S, itemKey: 'f1065.p1.1a|activity', status: 'entered', amount: '1010.00', enteredBy: 'tester' });
  r = await compute(pool, H, ret);
  assert.equal(valueOf(r, 'f1065.p1.1a|activity'), 101000n);
  assert.ok(r.bridge.rows.some(x => x.line === '2' && x.cents === '1000'));
  assert.equal(r.bridge.residual, '0');
  // A company that holds an interest in another of ours receives a K-1: the K-1 lines wait for stage T4.
  const P = { orgId, entityId: await company(pool, orgId, 'Hazel Payer') };
  await period(pool, P, 2025, 'form_1065', { taxMethod: 'accrual' });
  await saveParty(pool, { orgId, fields: { kind: 'entity_in_org', name: 'Hazel Partners (as owner)', taxId: '', entityId: H.entityId }, env: {} });
  const { rows: [pt] } = await pool.query('SELECT party_id FROM tax_party WHERE org_id = $1 AND entity_id = $2', [orgId, H.entityId]);
  await saveInterest(pool, { ...P, fields: { partyId: pt.party_id, role: 'general_partner', from: '2020-01-01', to: null, profit: '1/2', loss: '1/2', capital: '1/2' }, actor: 'tester' });
  r = await compute(pool, H, ret);
  assert.equal(valueOf(r, 'f1065.p1.4|activity'), null);
  assert.match(errorsOf(r, 'k1_inflows')[0].message, /stage T4/);
});

test('cash-basis books: Schedule L and net income per books on the cash basis, the return’s income from the cash layer, a reviewed advance as an M-1 timing row; accrual-method returns on them refused', async () => {
  const N = { orgId, entityId: await company(pool, orgId, 'Nutmeg Partners') };
  const ret = await period(pool, N, 2025, 'form_1065', { taxMethod: 'cash', bookBasis: 'cash' });
  const A = {};
  for (const n of ['Checking', 'Services', 'Utilities', 'Retained Earnings', 'Accounts Receivable (A/R)', 'Accounts Payable (A/P)']) A[n] = await acct(pool, N, n);
  const old = await invoice(pool, N, '2024-10-01', [[A.Services, 30000]]);
  await payment(pool, N, '2024-11-01', 10000, A.Checking, [[old, 10000, '2024-11-01']]);
  await payment(pool, N, '2025-02-01', 20000, A.Checking, [[old, 20000, '2025-02-01']]);
  const inv = await invoice(pool, N, '2025-03-01', [[A.Services, 70000]]);
  await payment(pool, N, '2025-04-01', 70000, A.Checking, [[inv, 70000, '2025-04-01']]);
  await invoice(pool, N, '2025-12-01', [[A.Services, 9000]]);
  const adv = await payment(pool, N, '2025-12-29', 4000, A.Checking);
  const b = await bill(pool, N, '2025-05-01', [[A.Utilities, 6000]]);
  await billPayment(pool, N, '2025-05-20', 6000, A.Checking, [[b, 6000, '2025-05-20']]);
  await bill(pool, N, '2025-12-15', [[A.Utilities, 1500]]);
  await bindBalance(pool, N, ret, A.Checking, 'f1065.L.1');
  await bindBalance(pool, N, ret, A['Accounts Receivable (A/R)'], 'f1065.L.2a');
  await bind(pool, N, ret, A['Accounts Payable (A/P)'], 'end', [{ treatment: 'input', destination: 'f1065.L.15' }]);
  await bindBalance(pool, N, ret, A['Retained Earnings'], 'f1065.L.21');
  await bind(pool, N, ret, A.Services, 'activity', [{ treatment: 'input', destination: 'f1065.p1.1a' }]);
  await bind(pool, N, ret, A.Utilities, 'activity', [{ treatment: 'statement_row', destination: 'f1065.p1.21' }]);
  await answerTypedItems(pool, N, ret);
  let r = await compute(pool, N, ret);
  expectAll(r, { 'f1065.p1.1a|activity': 90000n, 'f1065.p1.21|activity': 6000n, 'f1065.anal.1|activity': 84000n, 'f1065.m1.1|activity': 84000n,
    'f1065.L.1|begin': 10000n, 'f1065.L.21|begin': 10000n, 'f1065.L.1|end': 98000n, 'f1065.L.2a|end': -4000n, 'f1065.L.15|end': 0n, 'f1065.L.21|end': 94000n, 'f1065.L.14|end': 94000n, 'f1065.L.22|end': 94000n });
  assert.equal(r.bridge.residual, '0');
  const c = (await cashRecognition(pool, { orgId, ret: R(N, ret, { tax_method: 'cash' }) })).candidates.find(x => x.txnId === adv);
  await saveTimingReview(pool, { ...N, returnId: ret, txnId: adv, kind: 'unrestricted_advance', decision: 'include', slotKey: 'f1065.p1.1a|activity', amount: '40.00', expectTxnVersion: c.txnVersion, expectEventVersion: c.eventVersion, reviewedBy: 'tester' });
  r = await compute(pool, N, ret);
  expectAll(r, { 'f1065.p1.1a|activity': 94000n, 'f1065.m1.1|activity': 84000n, 'f1065.m1.2|activity': 4000n, 'f1065.m1.9|activity': 88000n });
  assert.equal(r.bridge.residual, '0');
  assert.deepEqual(errorsOf(r).map(x => x.code), ['openings_unknown']);
  const O = { orgId, entityId: await company(pool, orgId, 'Nutmeg Accrual') };
  const oRet = await period(pool, O, 2025, 'form_1065', { taxMethod: 'accrual', bookBasis: 'cash' });
  assert.match((await compute(pool, O, oRet)).refused, /accrual-method return on cash-basis books/);
});

test('entertainment is never given the meals fraction (Codex t3-plan-r1 B15): accepted, an entertainment-only account loses its whole deduction to Schedule K’s nondeductible line and M-1 line 4b; booked with meals, rejected, the split is the person’s own adjustment', async () => {
  const Y = { orgId, entityId: await company(pool, orgId, 'Yew Partners') };
  const ret = await period(pool, Y, 2025, 'form_1065', { taxMethod: 'accrual' });
  const bank = await acct(pool, Y, 'Checking'), svc = await acct(pool, Y, 'Services');
  const ent = await acct(pool, Y, 'Entertainment', 'expense'), mixed = await acct(pool, Y, 'Meals & Entertainment', 'expense');
  await je(pool, Y, '2025-02-01', [[bank, 100000], [svc, -100000]]);
  await je(pool, Y, '2025-03-01', [[ent, 10000], [bank, -10000]]);
  await je(pool, Y, '2025-03-02', [[mixed, 4000], [bank, -4000]]);
  await bindBalance(pool, Y, ret, bank, 'f1065.L.1');
  await bind(pool, Y, ret, await acct(pool, Y, 'Retained Earnings'), 'end', [{ treatment: 'input', destination: 'f1065.L.21' }]);
  await bind(pool, Y, ret, svc, 'activity', [{ treatment: 'input', destination: 'f1065.p1.1a' }]);
  for (const a of [ent, mixed]) await bind(pool, Y, ret, a, 'activity', [{ treatment: 'statement_row', destination: 'f1065.p1.21' }]);
  await answerTypedItems(pool, Y, ret);
  const S = { ...Y, returnId: ret };
  let r = await compute(pool, Y, ret);
  const pe = r.proposals.find(p => p.accountName === 'Entertainment'), pm = r.proposals.find(p => p.accountName === 'Meals & Entertainment');
  assert.deepEqual([pe.lines[0].cents, pm.lines[0].cents], [-10000n, -4000n], 'in full: no meals fraction read from a name');
  await answerProposal(pool, { ...S, key: pe.key, version: pe.version, decision: 'accept', decidedBy: 'tester', compute: computeIn });
  await answerProposal(pool, { ...S, key: pm.key, version: pm.version, decision: 'reject', reason: 'Split from the receipts: 2,500 meals, 1,500 entertainment', decidedBy: 'tester', compute: computeIn });
  await saveAdjustment(pool, { ...S, purpose: 'meals_50', memo: 'Meals at half, entertainment in full', evidence: 'Receipts file 2025', decidedBy: 'tester',
    lines: [{ slotKey: 'f1065.p1.21|activity', amount: '-27.50', m1Class: 'meals_50' }, { slotKey: 'f1065.k.18c|activity', amount: '27.50', m1Class: 'meals_50' }] });
  r = await compute(pool, Y, ret);
  expectAll(r, { 'f1065.p1.21|activity': 1250n, 'f1065.k.18c|activity': 12750n, 'f1065.p1.23|activity': 98750n, 'f1065.m1.1|activity': 86000n, 'f1065.m1.4b|activity': 12750n, 'f1065.m1.9|activity': 98750n });
  assert.equal(r.bridge.residual, '0');
  assert.deepEqual(errorsOf(r, 'proposal_open'), []);
});

test('an accrual exclusion reaches only the slot whose owner takes the book amount (Codex t3-plan-r1 B7): the books’ line by one engine adjustment; a typed line beside it not at all; a COGS input less the workpaper’s input — one causal M-1 difference each', async () => {
  const Z = { orgId, entityId: await company(pool, orgId, 'Zelkova Partners') };
  const ret = await period(pool, Z, 2025, 'form_1065', { taxMethod: 'accrual' });
  const act = await activity(pool, Z, { name: 'Zelkova trade' });
  const bank = await acct(pool, Z, 'Checking'), svc = await acct(pool, Z, 'Services'), rent = await acct(pool, Z, 'Rent & Lease'), dep = await acct(pool, Z, 'Depreciation');
  const accrued = await acct(pool, Z, 'Payroll Liabilities'), labor = await acct(pool, Z, 'Direct Labor', 'cost_of_goods_sold');
  await je(pool, Z, '2025-02-01', [[bank, 100000], [svc, -100000]]);
  const jes = [];
  for (const a of [[rent, 3000], [dep, 1000], [labor, 2000]]) jes.push(await je(pool, Z, '2025-12-31', [a, [accrued, -a[1]]]));
  await bindBalance(pool, Z, ret, bank, 'f1065.L.1');
  await bind(pool, Z, ret, accrued, 'end', [{ treatment: 'statement_row', destination: 'f1065.L.17' }]);
  await bind(pool, Z, ret, await acct(pool, Z, 'Retained Earnings'), 'end', [{ treatment: 'input', destination: 'f1065.L.21' }]);
  await bind(pool, Z, ret, svc, 'activity', [{ treatment: 'input', destination: 'f1065.p1.1a' }]);
  await bind(pool, Z, ret, rent, 'activity', [{ treatment: 'input', destination: 'f1065.p1.13' }]);
  await bind(pool, Z, ret, dep, 'activity', [{ treatment: 'manual_feed', destination: 'f1065.p1.16a' }]);
  await bind(pool, Z, ret, labor, 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.3', activityId: act }]);
  await saveWorkpaper(pool, { ...Z, returnId: ret, activityId: act, path: 'reconstruct', treatment: 'inventory_as_booked', method: 'cost', begin: '0', end: '0', reviewedBy: 'tester' });
  await answerTypedItems(pool, Z, ret, { except: ['f1065.p1.16a|activity'] });
  await saveManualItem(pool, { ...Z, returnId: ret, itemKey: 'f1065.p1.16a|activity', status: 'entered', amount: '0', enteredBy: 'tester' });
  const RZ = { return_id: ret, entity_id: Z.entityId, period_start: '2025-01-01', period_end: '2025-12-31', tax_method: 'accrual' };
  for (const id of jes) {
    const c = (await accrualTiming(pool, { orgId, ret: RZ })).candidates.find(x => x.txnId === id);
    await saveTimingReview(pool, { ...Z, returnId: ret, txnId: id, kind: 'imported_accrual_je', decision: 'exclude', expectTxnVersion: c.txnVersion, expectEventVersion: c.eventVersion, reviewedBy: 'tester' });
  }
  const r = await compute(pool, Z, ret);
  expectAll(r, { 'f1065.p1.13|activity': 0n, 'f1065.p1.16a|activity': 0n, [`f1125a.main.3|activity=act:${act}|activity`]: 0n, 'f1065.p1.2|activity': 0n, 'f1065.anal.1|activity': 100000n, 'f1065.m1.1|activity': 94000n, 'f1065.m1.9|activity': 100000n });
  assert.deepEqual(r.deltas.map(d => [d.slotKey, d.cents, d.source]), [['f1065.p1.13|activity', '-3000', 'engine']], 'one engine adjustment: on the line the books own, never the typed line or the workpaper');
  assert.deepEqual(r.bridge.rows.map(x => [x.line, x.cents, x.cls]).sort(), [['4a', '1000', 'book_tax_depreciation'], ['4c', '2000', 'inventory'], ['4c', '3000', 'method_timing']]);
  assert.equal(r.bridge.residual, '0');
});

test('an exclusion of an attributed line comes out of its COGS input ONCE, beside the account’s other allocations (Codex t3-plan-r2 R2-3): the same line, another line, stale', async () => {
  const { attributeLine } = await import('../lib/tax/bindings.js');
  const { measureLines } = await import('../lib/tax/measure.js');
  const X = { orgId, entityId: await company(pool, orgId, 'Xylem Partners') };
  const ret = await period(pool, X, 2025, 'form_1065', { taxMethod: 'accrual' });
  const act = await activity(pool, X, { name: 'Xylem trade' });
  const bank = await acct(pool, X, 'Checking'), svc = await acct(pool, X, 'Services'), accrued = await acct(pool, X, 'Payroll Liabilities'), labor = await acct(pool, X, 'Direct Labor', 'cost_of_goods_sold');
  await je(pool, X, '2025-02-01', [[bank, 100000], [svc, -100000]]);
  await je(pool, X, '2025-03-01', [[labor, 3000], [bank, -3000]]);
  const accrual = await je(pool, X, '2025-12-31', [[labor, 2000], [accrued, -2000]]);
  await bindBalance(pool, X, ret, bank, 'f1065.L.1');
  await bind(pool, X, ret, accrued, 'end', [{ treatment: 'statement_row', destination: 'f1065.L.17' }]);
  await bind(pool, X, ret, await acct(pool, X, 'Retained Earnings'), 'end', [{ treatment: 'input', destination: 'f1065.L.21' }]);
  await bind(pool, X, ret, svc, 'activity', [{ treatment: 'input', destination: 'f1065.p1.1a' }]);
  await bind(pool, X, ret, labor, 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.3', activityId: act }]);
  const line = async (txnId, destination) => {
    const l = (await measureLines(pool, { orgId, sourceEntityId: X.entityId, accountIds: [labor], periodStart: '2025-01-01', periodEnd: '2025-12-31', returnId: ret })).get(labor).find(x => x.txnId === txnId);
    return attributeLine(pool, { ...X, returnId: ret, sourceEntityId: X.entityId, accountId: labor, txnId, lineNo: l.lineNo, expectTxnVersion: l.txnVersion, target: { treatment: 'cogs_input', destination, activityId: act }, actor: 'tester' });
  };
  await line(accrual, 'f1125a.main.3');
  await saveWorkpaper(pool, { ...X, returnId: ret, activityId: act, path: 'reconstruct', treatment: 'inventory_as_booked', method: 'cost', begin: '0', end: '0', reviewedBy: 'tester' });
  await answerTypedItems(pool, X, ret);
  const RX = { return_id: ret, entity_id: X.entityId, period_start: '2025-01-01', period_end: '2025-12-31', tax_method: 'accrual' };
  const c = (await accrualTiming(pool, { orgId, ret: RX })).candidates.find(x => x.txnId === accrual);
  await saveTimingReview(pool, { ...X, returnId: ret, txnId: accrual, kind: 'imported_accrual_je', decision: 'exclude', expectTxnVersion: c.txnVersion, expectEventVersion: c.eventVersion, reviewedBy: 'tester' });
  const k = n => `f1125a.main.${n}|activity=act:${act}|activity`;
  let r = await compute(pool, X, ret);
  expectAll(r, { [k(3)]: 3000n, 'f1065.p1.2|activity': 3000n, 'f1065.m1.1|activity': 95000n, 'f1065.m1.9|activity': 97000n });
  assert.deepEqual(r.bridge.rows.map(x => [x.line, x.cents, x.cls]), [['4c', '2000', 'inventory']], 'one causal difference: the excluded 2,000');
  // The line attributed to another COGS line (section 263A): out of that line, the labor line untouched.
  const { rows: [att] } = await pool.query('SELECT binding_line_id FROM tax_binding_line WHERE return_id = $1', [ret]);
  const { removeAttribution } = await import('../lib/tax/bindings.js');
  await removeAttribution(pool, { ...X, returnId: ret, sourceEntityId: X.entityId, bindingLineId: Number(att.binding_line_id) });
  await line(accrual, 'f1125a.main.4');
  r = await compute(pool, X, ret);
  expectAll(r, { [k(3)]: 3000n, [k(4)]: 0n, 'f1065.m1.9|activity': 97000n });
  // The excluded entry edited: its exclusion is stale and the line it feeds unknown.
  await pool.query(`UPDATE txn SET memo = 'accrued labor, revised' WHERE txn_id = $1`, [accrual]);
  r = await compute(pool, X, ret);
  assert.equal(valueOf(r, k(4)), null);
});

test('timing decisions and nondeductibility proposals together (Codex t3-plan-r2 R2-4, R2-5): a proposal is computed after the exclusion, its answer turns stale when the exclusion or the account changes, and a fully excluded penalty proposes nothing — both forms', async () => {
  const Y = { orgId, entityId: await company(pool, orgId, 'Yarrow Partners') };
  const ret = await period(pool, Y, 2025, 'form_1065', { taxMethod: 'accrual' });
  const bank = await acct(pool, Y, 'Checking'), svc = await acct(pool, Y, 'Services'), meals = await acct(pool, Y, 'Meals'), accrued = await acct(pool, Y, 'Payroll Liabilities');
  await je(pool, Y, '2025-02-01', [[bank, 100000], [svc, -100000]]);
  await je(pool, Y, '2025-03-01', [[meals, 4000], [bank, -4000]]);
  const accrual = await je(pool, Y, '2025-12-31', [[meals, 10000], [accrued, -10000]]);
  await bindBalance(pool, Y, ret, bank, 'f1065.L.1');
  await bind(pool, Y, ret, accrued, 'end', [{ treatment: 'statement_row', destination: 'f1065.L.17' }]);
  await bind(pool, Y, ret, await acct(pool, Y, 'Retained Earnings'), 'end', [{ treatment: 'input', destination: 'f1065.L.21' }]);
  await bind(pool, Y, ret, svc, 'activity', [{ treatment: 'input', destination: 'f1065.p1.1a' }]);
  await bind(pool, Y, ret, meals, 'activity', [{ treatment: 'statement_row', destination: 'f1065.p1.21' }]);
  await answerTypedItems(pool, Y, ret);
  const S = { ...Y, returnId: ret };
  const RY = { return_id: ret, entity_id: Y.entityId, period_start: '2025-01-01', period_end: '2025-12-31', tax_method: 'accrual' };
  const accept = async () => { const p = (await compute(pool, Y, ret)).proposals.find(x => x.accountName.startsWith('Meals') || x.accountName === 'Entertainment'); await answerProposal(pool, { ...S, key: p.key, version: p.version, decision: 'accept', decidedBy: 'tester', compute: computeIn }); return p; };
  const p1 = await accept();
  assert.equal(p1.lines[0].cents, -7000n, 'half of 14,000 before any timing decision');
  // The accrual excluded: the proposal is half of the 4,000 left; the old answer no longer applies.
  const c = (await accrualTiming(pool, { orgId, ret: RY })).candidates.find(x => x.txnId === accrual);
  await saveTimingReview(pool, { ...S, txnId: accrual, kind: 'imported_accrual_je', decision: 'exclude', expectTxnVersion: c.txnVersion, expectEventVersion: c.eventVersion, reviewedBy: 'tester' });
  let r = await compute(pool, Y, ret);
  const p2 = r.proposals.find(x => x.accountName === 'Meals');
  assert.deepEqual([p2.lines[0].cents, p2.answer?.fresh ?? false, valueOf(r, 'f1065.p1.21|activity')], [-2000n, false, null]);
  await assert.rejects(answerProposal(pool, { ...S, key: p1.key, version: p1.version, decision: 'accept', decidedBy: 'tester', compute: computeIn }), /changed since the page was shown/);
  await accept();
  r = await compute(pool, Y, ret);
  expectAll(r, { 'f1065.p1.21|activity': 2000n, 'f1065.k.18c|activity': 2000n, 'f1065.m1.1|activity': 86000n, 'f1065.m1.4b|activity': 2000n, 'f1065.m1.9|activity': 98000n });
  assert.deepEqual(r.bridge.rows.map(x => [x.line, x.cents, x.cls]).sort(), [['4b', '2000', 'meals_50'], ['4c', '10000', 'method_timing']]);
  // The timing decision cleared: the first version (14,000 → 7,000) is computed again, but its old answer was superseded by the second one
  // (Codex t3-r3 R3-2: history never decides again) — the proposal waits, its lines unresolved, until answered now; then it applies once.
  const { clearTimingReview } = await import('../lib/tax/cash.js');
  await clearTimingReview(pool, { ...S, reviewId: (await accrualTiming(pool, { orgId, ret: RY })).candidates.find(x => x.txnId === accrual).review.review_id });
  r = await compute(pool, Y, ret);
  const back = r.proposals.find(x => x.accountName === 'Meals');
  assert.deepEqual([back.version === p1.version, back.answer?.fresh ?? false, valueOf(r, 'f1065.p1.21|activity')], [true, false, null], 'the restored version waits for a current answer');
  await accept();
  r = await compute(pool, Y, ret);
  expectAll(r, { 'f1065.p1.21|activity': 7000n, 'f1065.k.18c|activity': 7000n });
  // Renamed Entertainment (no posting or mapping changed): a new proposal — the 50 percent answer is stale, never applied as the 100 percent one.
  await pool.query(`UPDATE account SET name = 'Entertainment' WHERE account_id = $1`, [meals]);
  r = await compute(pool, Y, ret);
  const p3 = r.proposals.find(x => x.accountName === 'Entertainment');
  assert.deepEqual([p3.lines[0].cents, p3.answer?.fresh ?? false, valueOf(r, 'f1065.p1.21|activity')], [-14000n, false, null]);
  await accept();
  expectAll(await compute(pool, Y, ret), { 'f1065.p1.21|activity': 0n, 'f1065.k.18c|activity': 14000n });
  await pool.query(`UPDATE account SET name = 'Meals & Entertainment' WHERE account_id = $1`, [meals]);
  r = await compute(pool, Y, ret);
  assert.equal(r.proposals.find(x => x.accountName === 'Meals & Entertainment').answer?.fresh ?? false, false, 'meals → mixed: a new decision too');
  // Form 1120-S: a penalty accrued and fully excluded proposes nothing.
  const Z = { orgId, entityId: await company(pool, orgId, 'Yarrow Corp') };
  const zRet = await period(pool, Z, 2025, 'form_1120s', { taxMethod: 'accrual' });
  const zb = await acct(pool, Z, 'Checking'), zs = await acct(pool, Z, 'Services'), fines = await acct(pool, Z, 'Fines and Penalties', 'expense'), za = await acct(pool, Z, 'Payroll Liabilities');
  await je(pool, Z, '2025-02-01', [[zb, 50000], [zs, -50000]]);
  const fine = await je(pool, Z, '2025-12-31', [[fines, 3000], [za, -3000]]);
  await bindBalance(pool, Z, zRet, zb, 'f1120s.L.1');
  await bind(pool, Z, zRet, za, 'end', [{ treatment: 'statement_row', destination: 'f1120s.L.18' }]);
  await bind(pool, Z, zRet, await acct(pool, Z, 'Retained Earnings'), 'end', [{ treatment: 'input', destination: 'f1120s.L.24' }]);
  await bind(pool, Z, zRet, zs, 'activity', [{ treatment: 'input', destination: 'f1120s.p1.1a' }]);
  await bind(pool, Z, zRet, fines, 'activity', [{ treatment: 'statement_row', destination: 'f1120s.p1.20' }]);
  await answerTypedItems(pool, Z, zRet);
  assert.equal((await compute(pool, Z, zRet)).proposals.length, 1, 'the accrued penalty is proposed while it is deducted');
  const RZ = { return_id: zRet, entity_id: Z.entityId, period_start: '2025-01-01', period_end: '2025-12-31', tax_method: 'accrual' };
  const fc = (await accrualTiming(pool, { orgId, ret: RZ })).candidates.find(x => x.txnId === fine);
  await saveTimingReview(pool, { ...Z, returnId: zRet, txnId: fine, kind: 'imported_accrual_je', decision: 'exclude', expectTxnVersion: fc.txnVersion, expectEventVersion: fc.eventVersion, reviewedBy: 'tester' });
  r = await compute(pool, Z, zRet);
  assert.deepEqual([r.proposals.length, valueOf(r, 'f1120s.p1.20|activity'), valueOf(r, 'f1120s.k.16c|activity')], [0, 0n, 0n], 'fully excluded: nothing deducted, nothing proposed');
  assert.equal(r.bridge.residual, '0');
});

test('an adjustment lands once, on its target’s provider result (Codex t3-plan-r2 R2-11): an unstarted COGS activity is unknown, never a zero base; a completed zero workpaper takes it', async () => {
  const V = { orgId, entityId: await company(pool, orgId, 'Vervain Partners') };
  const ret = await period(pool, V, 2025, 'form_1065', { taxMethod: 'accrual' });
  const act = await activity(pool, V, { name: 'Vervain trade' });
  const bank = await acct(pool, V, 'Checking'), svc = await acct(pool, V, 'Services');
  await je(pool, V, '2025-02-01', [[bank, 100000], [svc, -100000]]);
  await bindBalance(pool, V, ret, bank, 'f1065.L.1');
  await bind(pool, V, ret, await acct(pool, V, 'Retained Earnings'), 'end', [{ treatment: 'input', destination: 'f1065.L.21' }]);
  await bind(pool, V, ret, svc, 'activity', [{ treatment: 'input', destination: 'f1065.p1.1a' }]);
  await answerTypedItems(pool, V, ret);
  const k = n => `f1125a.main.${n}|activity=act:${act}|activity`;
  await saveAdjustment(pool, { ...V, returnId: ret, purpose: 'other', memo: 'Labor capitalized', evidence: 'Payroll allocation', decidedBy: 'tester', lines: [{ slotKey: k(3), amount: '100.00', m1Class: 'inventory' }] });
  let r = await compute(pool, V, ret);
  assert.deepEqual([valueOf(r, k(3)), valueOf(r, k(8)), valueOf(r, 'f1065.p1.2|activity')], [null, null, null], 'no workpaper: no provider result to adjust');
  assert.ok(errorsOf(r, 'adjustment_target').length);
  assert.equal(r.applicability.facts.deductsCogs, 'unknown');
  await saveWorkpaper(pool, { ...V, returnId: ret, activityId: act, path: 'reconstruct', treatment: 'inventory_as_booked', method: 'cost', reviewedBy: 'tester' });
  r = await compute(pool, V, ret);
  assert.equal(valueOf(r, k(8)), null, 'unfinished (no inventories): still unknown');
  await saveWorkpaper(pool, { ...V, returnId: ret, activityId: act, path: 'reconstruct', treatment: 'inventory_as_booked', method: 'cost', begin: '0', end: '0', reviewedBy: 'tester' });
  r = await compute(pool, V, ret);
  expectAll(r, { [k(3)]: 10000n, [k(8)]: 10000n, 'f1065.p1.2|activity': 10000n });
  assert.equal(r.applicability.facts.deductsCogs, true);
  assert.deepEqual(errorsOf(r, 'adjustment_target'), []);
});

test('a classified closing whose lines are deleted still blocks the accounts it decided: their fields are unknown, never back to their default (Codex t3-plan-r3 R3-1)', async () => {
  const P = { orgId, entityId: await company(pool, orgId, 'Elm Deleted Partners') };
  const pRet = await period(pool, P, 2025, 'form_1065', { taxMethod: 'accrual' });
  const B = {};
  for (const n of ['Checking', 'Services', 'Retained Earnings']) B[n] = await acct(pool, P, n);
  await je(pool, P, '2025-02-01', [[B.Checking, 50000], [B.Services, -50000]]);
  const RP = { return_id: pRet, entity_id: P.entityId, period_start: '2025-01-01', period_end: '2025-12-31' };
  let c;
  await bindBalance(pool, P, pRet, B.Checking, 'f1065.L.1');
  await bindBalance(pool, P, pRet, B['Retained Earnings'], 'f1065.L.21');
  await bind(pool, P, pRet, B.Services, 'activity', [{ treatment: 'input', destination: 'f1065.p1.1a' }]);
  await answerTypedItems(pool, P, pRet);
  const close2 = await je(pool, P, '2025-12-31', [[B.Services, 50000], [B['Retained Earnings'], -50000]]);
  c = (await closingCandidates(pool, { orgId, ret: RP })).find(x => x.txnId === close2);
  await classifyEntry(pool, { ...P, returnId: pRet, txnId: close2, cls: 'closing', lines: c.proposed, expectTxnVersion: c.txnVersion, reviewedBy: 'tester' });
  assert.equal(valueOf(await compute(pool, P, pRet), 'f1065.p1.1a|activity'), 50000n);
  await pool.query('DELETE FROM posting WHERE txn_id = $1', [close2]);
  const r = await compute(pool, P, pRet);
  assert.equal(r.candidates.find(x => x.txnId === close2).state, 'stale');
  assert.equal(valueOf(r, 'f1065.p1.1a|activity'), null, 'the deleted closing’s income account is unknown, not 50,000 again by default');
  assert.equal(r.fields.find(f => f.key === 'f1065.p1.1a|activity').status, 'unresolved');
});

test('a saved movement class no posting matches any more holds the workpaper until cleared, never back to the default (Codex t3-plan-r4 R4-3): the line renumbered, moved to another inventory account, redated out of the period, deleted', async () => {
  const { classifyMovement, clearMovement } = await import('../lib/tax/cogs.js');
  const keys = act => [`f1125a.main.2|activity=act:${act}|activity`, `f1125a.main.8|activity=act:${act}|activity`, 'f1065.p1.2|activity'];
  for (const [change, cleared] of [['renumbered', 10000n], ['moved', 10000n], ['redated', 0n], ['deleted', 0n]]) {
    const G = { orgId, entityId: await company(pool, orgId, `Sorrel ${change} Traders`) };
    const ret = await period(pool, G, 2025, 'form_1065', { taxMethod: 'accrual' });
    const act = await activity(pool, G, { name: 'Sorrel trade' });
    const A = {};
    for (const n of ['Checking', 'Inventory Asset', 'Sales', 'Accounts Payable (A/P)', 'Retained Earnings']) A[n] = await acct(pool, G, n);
    const { rows: [{ type }] } = await pool.query('SELECT type FROM account WHERE account_id = $1', [A['Inventory Asset']]);
    A.Second = await acct(pool, G, 'Inventory Held Elsewhere', type);
    await je(pool, G, '2025-01-15', [[A.Checking, 50000], [A.Sales, -50000]]);
    const billTxn = await rawTxn(pool, G, 'bill', '2025-02-01', [[A['Inventory Asset'], 10000], [A['Accounts Payable (A/P)'], -10000]]);
    for (const inv of [A['Inventory Asset'], A.Second]) {
      await bind(pool, G, ret, inv, 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.2', activityId: act }]);
      await bindBalance(pool, G, ret, inv, 'f1065.L.3');
    }
    for (const [a, d] of [[A.Checking, 'f1065.L.1'], [A['Retained Earnings'], 'f1065.L.21'], [A['Accounts Payable (A/P)'], 'f1065.L.15']]) await bindBalance(pool, G, ret, a, d);
    await bind(pool, G, ret, A.Sales, 'activity', [{ treatment: 'input', destination: 'f1065.p1.1a' }]);
    await answerTypedItems(pool, G, ret);
    await saveWorkpaper(pool, { ...G, returnId: ret, activityId: act, path: 'reconstruct', treatment: 'inventory_as_booked', method: 'cost', begin: '0', end: '0', reviewedBy: 'tester' });
    let r = await compute(pool, G, ret);
    expectAll(r, Object.fromEntries(keys(act).map(k => [k, 10000n])));
    const m = r.cogs.get(act).movements.find(x => x.txnId === billTxn);
    await classifyMovement(pool, { ...G, returnId: ret, accountId: A['Inventory Asset'], txnId: billTxn, lineNo: m.lineNo, cls: 'transfer', expectTxnVersion: m.txnVersion, reviewedBy: 'tester' });
    r = await compute(pool, G, ret);
    expectAll(r, Object.fromEntries(keys(act).map(k => [k, 0n])));
    // The bill edited so that no posting matches the saved class any more.
    if (change === 'renumbered') await pool.query('UPDATE posting SET line_no = line_no + 1 WHERE txn_id = $1', [billTxn]);
    if (change === 'moved') await pool.query('UPDATE posting SET account_id = $2 WHERE txn_id = $1 AND account_id = $3', [billTxn, A.Second, A['Inventory Asset']]);
    if (change === 'redated') { await pool.query(`UPDATE txn SET txn_date = '2026-02-01', due_date = '2026-02-01' WHERE txn_id = $1`, [billTxn]); await pool.query(`UPDATE posting SET txn_date = '2026-02-01' WHERE txn_id = $1`, [billTxn]); }
    if (change === 'deleted') { await pool.query('DELETE FROM posting WHERE txn_id = $1', [billTxn]); await pool.query('DELETE FROM txn WHERE txn_id = $1', [billTxn]); }
    r = await compute(pool, G, ret);
    for (const k of keys(act)) assert.deepEqual([valueOf(r, k), r.fields.find(f => f.key === k)?.status], [null, 'unresolved'], `${change}: ${k}`);
    for (const k of ['f1065.p1.8|activity', 'f1065.p1.23|activity']) assert.equal(valueOf(r, k), null, `${change}: ${k}`);
    const gone = r.cogs.get(act).movements.find(x => x.gone);
    assert.deepEqual([gone?.txnId, gone?.lineNo, gone?.was, gone?.saved?.class], [billTxn, m.lineNo, 'transfer', 'transfer'], `${change}: the saved class stays listed`);
    assert.ok(errorsOf(r, 'cogs').some(e => /no longer matches a posting of this period: clear the class/.test(e.message)), `${change}: with what to do`);
    if (change === 'renumbered' || change === 'moved') assert.equal(r.cogs.get(act).movements.find(x => x.txnId === billTxn && !x.gone).cls, 'purchase', `${change}: the line as it is now has its default, but the workpaper waits`);
    await clearMovement(pool, { ...G, returnId: ret, accountId: A['Inventory Asset'], txnId: billTxn, lineNo: m.lineNo });
    r = await compute(pool, G, ret);
    expectAll(r, Object.fromEntries(keys(act).map(k => [k, cleared])));
    assert.ok(!r.cogs.get(act).movements.some(x => x.gone), `${change}: cleared`);
    if (cleared) {
      // Classified again as it is now: a transfer once more, so no purchase — counted once, never twice.
      const now = r.cogs.get(act).movements.find(x => x.txnId === billTxn);
      await classifyMovement(pool, { ...G, returnId: ret, accountId: now.accountId, txnId: billTxn, lineNo: now.lineNo, cls: 'transfer', expectTxnVersion: now.txnVersion, reviewedBy: 'tester' });
      expectAll(await compute(pool, G, ret), Object.fromEntries(keys(act).map(k => [k, 0n])));
    }
  }
});

test('a saved movement class is reconciled even when its old input cannot be measured (Codex t3-plan-r5 R5-4): the old inventory account split or its dollar split stale, the line renumbered, moved onto another activity’s inventory, deleted — two activities; the replacement never takes the default', async () => {
  const { classifyMovement, clearMovement } = await import('../lib/tax/cogs.js');
  const k = (n, act) => `f1125a.main.${n}|activity=act:${act}|activity`;
  const status = (r, key) => { const f = r.fields.find(x => x.key === key); return [f?.cents ?? null, f?.status ?? null]; };
  for (const incomplete of ['split', 'stale']) for (const [change, after] of [['renumbered', [10000n, 0n]], ['moved', [0n, 10000n]], ['deleted', [0n, 0n]]]) {
    const what = `${incomplete} ${change}`;
    const G = { orgId, entityId: await company(pool, orgId, `Tupelo ${incomplete} ${change} Traders`) };
    const ret = await period(pool, G, 2025, 'form_1065', { taxMethod: 'accrual' });
    const one = await activity(pool, G, { name: 'Tupelo retail' }), two = await activity(pool, G, { name: 'Tupelo wholesale' });
    const A = {};
    for (const n of ['Checking', 'Inventory Asset', 'Sales', 'Accounts Payable (A/P)', 'Retained Earnings']) A[n] = await acct(pool, G, n);
    const { rows: [{ type }] } = await pool.query('SELECT type FROM account WHERE account_id = $1', [A['Inventory Asset']]);
    A.B = await acct(pool, G, 'Wholesale Inventory', type);
    await je(pool, G, '2025-01-15', [[A.Checking, 50000], [A.Sales, -50000]]);
    const billTxn = await rawTxn(pool, G, 'bill', '2025-02-01', [[A['Inventory Asset'], 10000], [A['Accounts Payable (A/P)'], -10000]]);
    const single = () => bind(pool, G, ret, A['Inventory Asset'], 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.2', activityId: one }]);
    await single();
    await bind(pool, G, ret, A.B, 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.2', activityId: two }]);
    for (const inv of [A['Inventory Asset'], A.B]) await bindBalance(pool, G, ret, inv, 'f1065.L.3');
    for (const [a, d] of [[A.Checking, 'f1065.L.1'], [A['Retained Earnings'], 'f1065.L.21'], [A['Accounts Payable (A/P)'], 'f1065.L.15']]) await bindBalance(pool, G, ret, a, d);
    await bind(pool, G, ret, A.Sales, 'activity', [{ treatment: 'input', destination: 'f1065.p1.1a' }]);
    await answerTypedItems(pool, G, ret);
    for (const act of [one, two]) await saveWorkpaper(pool, { ...G, returnId: ret, activityId: act, path: 'reconstruct', treatment: 'inventory_as_booked', method: 'cost', begin: '0', end: '0', reviewedBy: 'tester' });
    let r = await compute(pool, G, ret);
    const m = r.cogs.get(one).movements.find(x => x.txnId === billTxn);
    await classifyMovement(pool, { ...G, returnId: ret, accountId: A['Inventory Asset'], txnId: billTxn, lineNo: m.lineNo, cls: 'transfer', expectTxnVersion: m.txnVersion, reviewedBy: 'tester', reason: 'Goods moved from the warehouse' });
    expectAll(await compute(pool, G, ret), { [k(2, one)]: 0n, [k(2, two)]: 0n, 'f1065.p1.2|activity': 0n });
    // The old input made incomplete: split across two lines by share, or by dollars (stale once the account's activity changes).
    if (incomplete === 'split') await bind(pool, G, ret, A['Inventory Asset'], 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.2', activityId: one, share: '1/2' }, { treatment: 'cogs_input', destination: 'f1125a.main.4', activityId: one, share: '1/2' }], { split: 'shares' });
    else await bind(pool, G, ret, A['Inventory Asset'], 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.2', activityId: one, amount: '60.00' }, { treatment: 'cogs_input', destination: 'f1125a.main.4', activityId: one, amount: '40.00' }], { split: 'amounts' });
    if (change === 'renumbered') await pool.query('UPDATE posting SET line_no = line_no + 1 WHERE txn_id = $1', [billTxn]);
    if (change === 'moved') await pool.query('UPDATE posting SET account_id = $2 WHERE txn_id = $1 AND account_id = $3', [billTxn, A.B, A['Inventory Asset']]);
    if (change === 'deleted') { await pool.query('DELETE FROM posting WHERE txn_id = $1', [billTxn]); await pool.query('DELETE FROM txn WHERE txn_id = $1', [billTxn]); }
    r = await compute(pool, G, ret);
    // The activity the class reaches: the old account's (always), and the replacement's (moved): purchases, line 8 and page 1 line 2 unknown.
    for (const act of change === 'moved' ? [one, two] : [one]) for (const n of [2, 8]) assert.deepEqual(status(r, k(n, act)), [null, 'unresolved'], `${what}: ${k(n, act)}`);
    assert.deepEqual(status(r, 'f1065.p1.2|activity'), [null, 'unresolved'], `${what}: page 1 line 2`);
    if (change !== 'moved') assert.deepEqual(status(r, k(2, two)), ['0', 'complete'], `${what}: the unrelated activity keeps its known purchases`);
    const shown = [...r.cogs.values()].flatMap(e => e.movements).filter(x => x.gone && x.saved?.class === 'transfer');
    assert.ok(shown.length, `${what}: the saved class is listed (with Clear)`);
    assert.deepEqual([shown[0].saved.reason, shown[0].saved.domains], ['Goods moved from the warehouse', ['income']], `${what}: the saved record, whole`);
    assert.ok(r.cogsClasses.some(c => c.class === 'transfer' && !c.matched), `${what}: frozen whole, whatever the workpaper could measure`);
    if (change === 'moved') assert.equal(r.cogs.get(two).movements.find(x => x.txnId === billTxn && !x.gone).cls, 'purchase', `${what}: the replacement has its default, but its line waits`);
    // Cleared, and the mapping repaired: the replacement counts once.
    await clearMovement(pool, { ...G, returnId: ret, accountId: A['Inventory Asset'], txnId: billTxn, lineNo: m.lineNo });
    await single();
    r = await compute(pool, G, ret);
    expectAll(r, { [k(2, one)]: after[0], [k(2, two)]: after[1], 'f1065.p1.2|activity': after[0] + after[1] });
    assert.deepEqual(r.cogsClasses, [], `${what}: cleared`);
  }
});

// Round 6 (Codex t3-plan-r6): the balance and page-1 lines each form uses for a COGS company, and the inventory account type.
const COGS_L = { form_1065: { cash: 'f1065.L.1', inv: 'f1065.L.3', ap: 'f1065.L.15', re: 'f1065.L.21', sales: 'f1065.p1.1a', cogs: 'f1065.p1.2', suffix: 'Partners' },
  form_1120s: { cash: 'f1120s.L.1', inv: 'f1120s.L.3', ap: 'f1120s.L.16', re: 'f1120s.L.24', sales: 'f1120s.p1.1a', cogs: 'f1120s.p1.2', suffix: 'Corp' } };
const kOf = (n, act) => `f1125a.main.${n}|activity=act:${act}|activity`;
const statusOf = (r, key) => { const x = r.fields.find(f => f.key === key); return [x?.cents ?? null, x?.status ?? null]; };
// A trading company with three activities: retail (inventory account A), wholesale (inventory account B and an income-statement cost) and
// parts (labor only, the unrelated control). → { G, ret, one, two, three, A, billTxn, single }
async function tradingCo(name, rt) {
  const L = COGS_L[rt];
  const G = { orgId, entityId: await company(pool, orgId, `${name} ${L.suffix}`) };
  const ret = await period(pool, G, 2025, rt, { taxMethod: 'accrual' });
  const one = await activity(pool, G, { name: `${name} retail` }), two = await activity(pool, G, { name: `${name} wholesale` }), three = await activity(pool, G, { name: `${name} parts` });
  const A = {};
  for (const n of ['Checking', 'Inventory Asset', 'Sales', 'Accounts Payable (A/P)', 'Retained Earnings', 'Cost of Goods Sold']) A[n] = await acct(pool, G, n);
  const { rows: [{ type }] } = await pool.query('SELECT type FROM account WHERE account_id = $1', [A['Inventory Asset']]);
  A.B = await acct(pool, G, 'Wholesale Inventory', type);
  A.Freight = await acct(pool, G, 'Freight In', 'cost_of_goods_sold');
  A.Labor = await acct(pool, G, 'Direct Labor', 'cost_of_goods_sold');
  await je(pool, G, '2025-01-15', [[A.Checking, 50000], [A.Sales, -50000]]);
  const billTxn = await rawTxn(pool, G, 'bill', '2025-02-01', [[A['Inventory Asset'], 10000], [A['Accounts Payable (A/P)'], -10000]]);
  await je(pool, G, '2025-03-01', [[A.Labor, 7000], [A.Checking, -7000]]);
  const single = () => bind(pool, G, ret, A['Inventory Asset'], 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.2', activityId: one }]);
  await single();
  await bind(pool, G, ret, A.B, 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.2', activityId: two }]);
  await bind(pool, G, ret, A.Freight, 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.5', activityId: two }]);
  await bind(pool, G, ret, A.Labor, 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.3', activityId: three }]);
  await bind(pool, G, ret, A['Cost of Goods Sold'], 'activity', [{ treatment: 'cogs_tieout', destination: 'f1125a.main.8', activityId: one }]);
  for (const inv of [A['Inventory Asset'], A.B]) await bindBalance(pool, G, ret, inv, L.inv);
  for (const [a, d] of [[A.Checking, L.cash], [A['Retained Earnings'], L.re], [A['Accounts Payable (A/P)'], L.ap]]) await bindBalance(pool, G, ret, a, d);
  await bind(pool, G, ret, A.Sales, 'activity', [{ treatment: 'input', destination: L.sales }]);
  await answerTypedItems(pool, G, ret);
  for (const act of [one, two, three]) await saveWorkpaper(pool, { ...G, returnId: ret, activityId: act, path: 'reconstruct', treatment: 'inventory_as_booked', method: 'cost', begin: '0', end: '0', reviewedBy: 'tester' });
  return { G, ret, one, two, three, A, billTxn, single, L };
}
const incompleteOld = async ({ G, ret, one, A }, old) => {
  if (old === 'shares') await bind(pool, G, ret, A['Inventory Asset'], 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.2', activityId: one, share: '1/2' }, { treatment: 'cogs_input', destination: 'f1125a.main.4', activityId: one, share: '1/2' }], { split: 'shares' });
  if (old === 'amounts') await bind(pool, G, ret, A['Inventory Asset'], 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.2', activityId: one, amount: '60.00' }, { treatment: 'cogs_input', destination: 'f1125a.main.4', activityId: one, amount: '40.00' }], { split: 'amounts' });
};

test('a saved movement class is reconciled against its transaction’s postings as they are NOW (Codex t3-plan-r6 R6-2): the cost moved to an income-statement COGS input of another activity; the line split with its identity kept — a complete, a share-split and a stale dollar-split old input; the unrelated activity stays known; both forms', async () => {
  const { classifyMovement, clearMovement } = await import('../lib/tax/cogs.js');
  for (const rt of ['form_1065', 'form_1120s']) for (const change of ['moved', 'split']) for (const old of ['complete', 'shares', 'amounts']) {
    const what = `${rt} ${change} ${old}`;
    const T = await tradingCo(`Rowan ${change} ${old}`, rt), { G, ret, one, two, three, A, billTxn, L } = T;
    let r = await compute(pool, G, ret);
    const m = r.cogs.get(one).movements.find(x => x.txnId === billTxn);
    await classifyMovement(pool, { ...G, returnId: ret, accountId: A['Inventory Asset'], txnId: billTxn, lineNo: m.lineNo, cls: 'transfer', expectTxnVersion: m.txnVersion, reviewedBy: 'tester' });
    expectAll(await compute(pool, G, ret), { [kOf(2, one)]: 0n, [kOf(2, two)]: 0n, [kOf(5, two)]: 0n, [kOf(3, three)]: 7000n, [`${L.cogs}|activity`]: 7000n });
    await incompleteOld(T, old);
    if (change === 'moved') await pool.query('UPDATE posting SET account_id = $2 WHERE txn_id = $1 AND account_id = $3', [billTxn, A.Freight, A['Inventory Asset']]);
    else await pool.query(`BEGIN; UPDATE posting SET amount_cents = 5000 WHERE txn_id = ${billTxn} AND account_id = ${A['Inventory Asset']};
      INSERT INTO posting (org_id, entity_id, txn_id, line_no, account_id, amount_cents, txn_date) SELECT org_id, entity_id, txn_id, 3, ${A.B}, 5000, txn_date FROM posting WHERE txn_id = ${billTxn} AND account_id = ${A['Inventory Asset']}; COMMIT;`);
    r = await compute(pool, G, ret);
    const held = change === 'moved' ? [kOf(2, one), kOf(8, one), kOf(5, two), kOf(8, two)] : [kOf(2, one), kOf(8, one), kOf(2, two), kOf(8, two)];
    for (const k of [...held, `${L.cogs}|activity`]) assert.deepEqual(statusOf(r, k), [null, 'unresolved'], `${what}: ${k}`);
    assert.deepEqual([statusOf(r, kOf(3, three)), statusOf(r, kOf(8, three))], [['7000', 'complete'], ['7000', 'complete']], `${what}: the unrelated activity keeps its amounts`);
    // Split with a complete old input, the old line still matches (stale); otherwise (moved, or an old input that cannot be measured) it is unmatched.
    assert.ok(r.cogsClasses.some(c => c.class === 'transfer' && c.stale && (change === 'split' && old === 'complete' ? c.matched : !c.matched)), `${what}: the saved class is frozen whole`);
    assert.ok([...r.cogs.values()].some(e => e.movements.some(x => x.saved?.class === 'transfer' && (x.gone || x.stale))), `${what}: and listed`);
    assert.ok(errorsOf(r, 'cogs').some(e => /transfer/.test(e.message)), `${what}: with what to do`);
    // Cleared, the old mapping repaired: the replacement counts once.
    await clearMovement(pool, { ...G, returnId: ret, accountId: A['Inventory Asset'], txnId: billTxn, lineNo: m.lineNo });
    await T.single();
    r = await compute(pool, G, ret);
    if (change === 'moved') expectAll(r, { [kOf(2, one)]: 0n, [kOf(5, two)]: 10000n, [kOf(8, two)]: 10000n, [`${L.cogs}|activity`]: 17000n });
    else expectAll(r, { [kOf(2, one)]: 5000n, [kOf(2, two)]: 5000n, [`${L.cogs}|activity`]: 17000n });
    assert.deepEqual(r.cogsClasses, [], `${what}: cleared`);
  }
});

test('a saved class whose workpaper is reviewed, or whose account is only compared with line 8, is kept but not needed (Codex t3-plan-r6 R6-4): unchanged or stale, it holds nothing — the reviewed amount and the other reconstructions stay known; back to a reconstruction, freshness applies again; both forms', async () => {
  const { classifyMovement, clearMovement } = await import('../lib/tax/cogs.js');
  for (const rt of ['form_1065', 'form_1120s']) {
    const what = rt;
    const T = await tradingCo('Medlar', rt), { G, ret, one, two, three, A, billTxn, L } = T;
    let r = await compute(pool, G, ret);
    const m = r.cogs.get(one).movements.find(x => x.txnId === billTxn);
    await classifyMovement(pool, { ...G, returnId: ret, accountId: A['Inventory Asset'], txnId: billTxn, lineNo: m.lineNo, cls: 'transfer', expectTxnVersion: m.txnVersion, reviewedBy: 'tester', reason: 'Stock moved between stores' });
    // A class on the book COGS account (compared with line 8, never purchases): a comparison only.
    const sale = await rawTxn(pool, G, 'invoice', '2025-04-01', [[await acct(pool, G, 'Accounts Receivable (A/R)'), 20000], [A.Sales, -20000], [A['Cost of Goods Sold'], 8000], [A['Inventory Asset'], -8000]], { total: 20000 });
    const { rows: [cogsLine] } = await pool.query('SELECT line_no FROM posting WHERE txn_id = $1 AND account_id = $2', [sale, A['Cost of Goods Sold']]);
    await classifyMovement(pool, { ...G, returnId: ret, accountId: A['Cost of Goods Sold'], txnId: sale, lineNo: Number(cogsLine.line_no), cls: 'cost_of_sales', expectTxnVersion: (await compute(pool, G, ret)).cogs.get(one).movements.find(x => x.txnId === sale).txnVersion, reviewedBy: 'tester' });
    const reviewed = () => saveWorkpaper(pool, { ...G, returnId: ret, activityId: one, path: 'reviewed', treatment: 'inventory_as_booked', method: 'cost', reviewedLines: { '1': '0', '2': '250.00', '3': '0', '4': '0', '5': [], '7': '0' }, sourceNote: 'The count sheets', reviewedBy: 'tester' });
    const reconstruct = () => saveWorkpaper(pool, { ...G, returnId: ret, activityId: one, path: 'reconstruct', treatment: 'inventory_as_booked', method: 'cost', begin: '0', end: '0', reviewedBy: 'tester' });
    const knownAll = (r, retail, tag) => { expectAll(r, { [kOf(2, one)]: retail, [kOf(2, two)]: 0n, [kOf(3, three)]: 7000n, [kOf(8, three)]: 7000n, [`${L.cogs}|activity`]: retail + 7000n }); assert.equal(errorsOf(r, 'cogs').length, 0, `${tag}: nothing waits`); };
    knownAll(await compute(pool, G, ret), 0n, `${what}, reconstructed`);
    for (const version of ['unchanged', 'stale']) {
      await reviewed();
      if (version === 'stale') await pool.query(`UPDATE txn SET memo = 'edited ${version}' WHERE txn_id = $1`, [billTxn]);
      r = await compute(pool, G, ret);
      knownAll(r, 25000n, `${what}, reviewed, ${version}`);
      const kept = r.cogs.get(one).movements.find(x => x.saved?.class === 'transfer');
      assert.deepEqual([kept?.gone, kept?.notNeeded, kept?.saved?.reason], [true, true, 'Stock moved between stores'], `${what}, reviewed, ${version}: kept and listed (with Clear)`);
      assert.deepEqual(r.cogsClasses.filter(c => !c.matched).map(c => c.class).sort(), ['cost_of_sales', 'transfer'], `${what}, reviewed, ${version}: frozen whole`);
      await reconstruct();
      r = await compute(pool, G, ret);
      if (version === 'unchanged') knownAll(r, 0n, `${what}, reconstructed again`);
      else {
        assert.deepEqual(statusOf(r, kOf(2, one)), [null, 'unresolved'], `${what}: back to a reconstruction, the stale class waits`);
        assert.deepEqual([statusOf(r, kOf(2, two)), statusOf(r, kOf(3, three))], [['0', 'complete'], ['7000', 'complete']], `${what}: the others stay known`);
      }
    }
    await clearMovement(pool, { ...G, returnId: ret, accountId: A['Inventory Asset'], txnId: billTxn, lineNo: m.lineNo });
    expectAll(await compute(pool, G, ret), { [kOf(2, one)]: 10000n, [`${L.cogs}|activity`]: 17000n });
  }
});

test('a replacement COGS input is held even when the old destination needs no class (Codex t3-plan-r7 R7-1): a classified line moved to another activity’s inventory or income-statement input while its old workpaper is reviewed, or its old account only compared with line 8; the reviewed amount and the unrelated activity stay known; both forms', async () => {
  const { classifyMovement, clearMovement } = await import('../lib/tax/cogs.js');
  for (const rt of ['form_1065', 'form_1120s']) for (const oldPath of ['reviewed', 'comparison']) for (const to of ['inventory', 'cost']) {
    const what = `${rt} old ${oldPath}, moved to ${to}`;
    const T = await tradingCo(`Quince ${oldPath} ${to}`, rt), { G, ret, one, two, three, A, billTxn, L } = T;
    let r = await compute(pool, G, ret);
    // The classified line: the inventory bill (its workpaper then typed from a review), or a bill posted to book COGS — an expense account the
    // workpaper only compares with line 8 (a balance account cannot be routed that way) — classified before anything moves.
    const cogsBill = oldPath === 'comparison' ? await rawTxn(pool, G, 'bill', '2025-02-02', [[A['Cost of Goods Sold'], 10000], [A['Accounts Payable (A/P)'], -10000]]) : null;
    const src = cogsBill ?? billTxn, oldAcc = cogsBill ? A['Cost of Goods Sold'] : A['Inventory Asset'];
    const { rows: [ln] } = await pool.query('SELECT line_no, txn_version(txn_id) AS v FROM posting WHERE txn_id = $1 AND account_id = $2', [src, oldAcc]);
    const m = { lineNo: Number(ln.line_no), txnVersion: ln.v };
    await classifyMovement(pool, { ...G, returnId: ret, accountId: oldAcc, txnId: src, lineNo: m.lineNo, cls: 'transfer', expectTxnVersion: m.txnVersion, reviewedBy: 'tester', reason: 'Stock moved between stores' });
    if (oldPath === 'reviewed') await saveWorkpaper(pool, { ...G, returnId: ret, activityId: one, path: 'reviewed', treatment: 'inventory_as_booked', method: 'cost', reviewedLines: { '1': '0', '2': '250.00', '3': '0', '4': '0', '5': [], '7': '0' }, sourceNote: 'The count sheets', reviewedBy: 'tester' });
    const retail = oldPath === 'reviewed' ? 25000n : 10000n; // reviewed purchases, or the inventory bill's default purchase (the class is on the COGS account)
    const knownRest = (r, tag) => { expectAll(r, { [kOf(2, one)]: retail, [kOf(3, three)]: 7000n, [kOf(8, three)]: 7000n }); assert.ok(!errorsOf(r, 'cogs').some(e => /Quince retail/.test(e.message) && /transfer/.test(e.message)), `${tag}: the old destination waits on nothing`); };
    knownRest(await compute(pool, G, ret), `${what}, before the move`);
    expectAll(await compute(pool, G, ret), { [kOf(2, two)]: 0n, [kOf(5, two)]: 0n });
    await pool.query('UPDATE posting SET account_id = $2 WHERE txn_id = $1 AND account_id = $3', [src, to === 'inventory' ? A.B : A.Freight, oldAcc]);
    r = await compute(pool, G, ret);
    knownRest(r, what);
    for (const k of [kOf(to === 'inventory' ? 2 : 5, two), kOf(8, two), `${L.cogs}|activity`]) assert.deepEqual(statusOf(r, k), [null, 'unresolved'], `${what}: ${k}`);
    assert.ok(r.cogs.get(two).movements.some(x => x.gone && x.saved?.class === 'transfer' && x.saved.reason === 'Stock moved between stores'), `${what}: the saved class is listed where the replacement lands (with Clear)`);
    assert.ok(r.cogsClasses.some(c => c.class === 'transfer' && !c.matched && !c.present), `${what}: and frozen whole`);
    await clearMovement(pool, { ...G, returnId: ret, accountId: oldAcc, txnId: src, lineNo: m.lineNo });
    r = await compute(pool, G, ret);
    expectAll(r, { [kOf(to === 'inventory' ? 2 : 5, two)]: 10000n, [kOf(8, two)]: 10000n, [`${L.cogs}|activity`]: retail + 17000n });
    knownRest(r, `${what}, cleared`);
  }
});

test('a reviewed COGS workpaper keeps its typed lines whatever its old reconstruction inputs look like (Codex t3-plan-r7 R7-2): a stale dollar split on the old inventory input leaves purchases, line 8 and page 1 COGS known and claims no book slice; back to a reconstruction the input’s freshness is required again; both forms', async () => {
  for (const rt of ['form_1065', 'form_1120s']) {
    const what = rt;
    const T = await tradingCo('Damson', rt), { G, ret, one, two, three, A, billTxn, L } = T;
    // The retail inventory account routed by a dollar split (complete against the 10,000 bill), then more posted to it: stale.
    await bind(pool, G, ret, A['Inventory Asset'], 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.2', activityId: one, amount: '60.00' }, { treatment: 'cogs_input', destination: 'f1125a.main.4', activityId: one, amount: '40.00' }], { split: 'amounts' });
    await rawTxn(pool, G, 'bill', '2025-05-01', [[A['Inventory Asset'], 3000], [A['Accounts Payable (A/P)'], -3000]]);
    let r = await compute(pool, G, ret);
    assert.deepEqual(statusOf(r, kOf(2, one)), [null, 'unresolved'], `${what}: reconstructed, the stale split leaves purchases unknown`);
    await saveWorkpaper(pool, { ...G, returnId: ret, activityId: one, path: 'reviewed', treatment: 'inventory_as_booked', method: 'cost', reviewedLines: { '1': '0', '2': '250.00', '3': '0', '4': '0', '5': [], '7': '0' }, sourceNote: 'The count sheets', reviewedBy: 'tester' });
    r = await compute(pool, G, ret);
    expectAll(r, { [kOf(2, one)]: 25000n, [kOf(8, one)]: 25000n, [kOf(3, three)]: 7000n, [`${L.cogs}|activity`]: 32000n });
    assert.deepEqual(r.packets.find(p => p.values[0].slotKey === kOf(2, one))?.consumedSlices, [], `${what}: the reviewed packet claims no book slice`);
    assert.ok(errorsOf(r, 'coverage').length > 0, `${what}: the stale mapping stays visible`);
    await saveWorkpaper(pool, { ...G, returnId: ret, activityId: one, path: 'reconstruct', treatment: 'inventory_as_booked', method: 'cost', begin: '0', end: '0', reviewedBy: 'tester' });
    r = await compute(pool, G, ret);
    assert.deepEqual([statusOf(r, kOf(2, one)), statusOf(r, `${L.cogs}|activity`)], [[null, 'unresolved'], [null, 'unresolved']], `${what}: reconstructed again, the input must be fresh`);
    expectAll(r, { [kOf(3, three)]: 7000n });
  }
});
