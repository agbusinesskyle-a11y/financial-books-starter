// test/tax-t3-golden.test.js — the T3 golden scope (spec §12) on SAMPLE companies with hand-written expectations: a standalone Form 1065 on
// accrual books with inventory, a closing entry, a predecessor baseline, a meals proposal and a preparer's adjustment with its support; an
// initial cash-method Form 1065 with receivables and a December advance; a cash-method Form 1120-S with officer compensation and a penalty.
// Page 1, Schedule K, Schedule L at both dates, M-1 and Form 1125-A, every one exact, and the results the T5 printing slice reads. (The
// comparison with the filed 2025 returns runs on the practice copy at stage close; no real figure is in the repository.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { t2Db, company, acct, je, period, activity, bind, bindBalance, compute, valueOf, errorsOf, answerTypedItems, importedJe, rawTxn, billPayment, invoice, payment, expense, deposit, cardPayment, scheduleLFacts } from './tax-t3-fixtures.js';
import { saveProfile, openPeriod, verifyInitial, setPredecessor } from '../lib/tax/periods.js';
import { importBaseline } from '../lib/tax/baselines.js';
import { classifyEntry, closingCandidates } from '../lib/tax/classify.js';
import { saveManualItem } from '../lib/tax/manual.js';
import { saveAdjustment, answerProposal } from '../lib/tax/adjustments.js';
import { saveWorkpaper } from '../lib/tax/cogs.js';
import { cashRecognition, saveTimingReview } from '../lib/tax/cash.js';
import { computeIn } from '../lib/tax/engine/compute.js';
import { resultsJson } from '../lib/tax/engine/revision.js';
import { party } from './tax-t2-fixtures.js';
import { saveInterest } from '../lib/tax/ownership.js';

let t, pool, orgId;
before(async () => { t = await t2Db(); pool = t.pool; orgId = t.orgId; });
after(async () => { await t.db.drop(); });
const expectAll = (r, want) => { for (const [k, v] of Object.entries(want)) assert.equal(valueOf(r, k), v, k); };
const baseline = async (C, returnType, given) => { const facts = await scheduleLFacts(returnType, given); return importBaseline(pool, { ...C, payload: { importKey: 'filed-2024-sample', payloadVersion: 1, kind: 'imported_filed', returnType, formEdition: 2024, bookBasis: 'accrual',
  consolidationPolicy: 'inclusion_edges', sourcePeriodStart: '2024-01-01', sourcePeriodEnd: '2024-12-31', sourceDocument: { hash: 'sha256:sample', pages: '1-5' }, extractionStatus: 'verified',
  facts: facts.map(([fieldId, cents]) => ({ factKind: 'schedule_l_end', fieldId, measurement: 'end', effectiveOn: '2024-12-31', amountCents: String(cents), state: 'known', provenance: { page: 4 }, reviewStatus: 'verified' })) }, actor: 'tester' }); };

test('sample retail partnership (accrual Form 1065): inventory and COGS, a closing entry, a baseline, a meals proposal and a supported adjustment', async () => {
  const C = { orgId, entityId: await company(pool, orgId, 'Sample Retail Partners') };
  const ret = await period(pool, C, 2025, 'form_1065', { taxMethod: 'accrual' });
  const store = await activity(pool, C, { name: 'Sample retail store' });
  const A = {};
  for (const n of ['Checking', 'Inventory Asset', 'Cost of Goods Sold', 'Sales', 'Accounts Receivable (A/R)', 'Accounts Payable (A/P)', 'Furniture and Equipment', 'Accumulated Depreciation', 'Depreciation',
    'Meals', 'Rent & Lease', 'Wages', 'Loan Payable', 'Retained Earnings']) A[n] = await acct(pool, C, n);
  await importedJe(pool, C, '2024-12-31', [[A.Checking, 300000], [A['Inventory Asset'], 50000], [A['Furniture and Equipment'], 80000], [A['Accumulated Depreciation'], -16000], [A['Loan Payable'], -100000], [A['Retained Earnings'], -314000]]);
  const b = await baseline(C, 'form_1065', [['f1065.L.1', 300000], ['f1065.L.3', 50000], ['f1065.L.9a', 80000], ['f1065.L.9b', 16000], ['f1065.L.19b', 100000], ['f1065.L.21', 314000]]);
  await setPredecessor(pool, { ...C, returnId: ret, baselineId: b.baselineId });
  const purchase = await rawTxn(pool, C, 'bill', '2025-02-01', [[A['Inventory Asset'], 120000], [A['Accounts Payable (A/P)'], -120000]]);
  await billPayment(pool, C, '2025-03-01', 120000, A.Checking, [[purchase, 120000, '2025-03-01']]);
  const sale = await rawTxn(pool, C, 'invoice', '2025-06-01', [[A['Accounts Receivable (A/R)'], 400000], [A.Sales, -400000], [A['Cost of Goods Sold'], 110000], [A['Inventory Asset'], -110000]], { total: 400000 });
  await payment(pool, C, '2025-07-01', 350000, A.Checking, [[sale, 350000, '2025-07-01']]);
  await je(pool, C, '2025-04-01', [[A['Rent & Lease'], 36000], [A.Checking, -36000]]);
  await je(pool, C, '2025-05-01', [[A.Wages, 90000], [A.Checking, -90000]]);
  await je(pool, C, '2025-05-02', [[A.Meals, 6000], [A.Checking, -6000]]);
  await je(pool, C, '2025-12-30', [[A.Depreciation, 16000], [A['Accumulated Depreciation'], -16000]]);
  await je(pool, C, '2025-08-01', [[A['Loan Payable'], 20000], [A.Checking, -20000]]);
  const close = await je(pool, C, '2025-12-31', [[A.Sales, 400000], [A['Cost of Goods Sold'], -110000], [A['Rent & Lease'], -36000], [A.Wages, -90000], [A.Meals, -6000], [A.Depreciation, -16000], [A['Retained Earnings'], -142000]], { memo: 'CJE closing' });
  const R = { return_id: ret, entity_id: C.entityId, period_start: '2025-01-01', period_end: '2025-12-31' };
  const c = (await closingCandidates(pool, { orgId, ret: R })).find(x => x.txnId === close);
  await classifyEntry(pool, { ...C, returnId: ret, txnId: close, cls: 'closing', lines: c.proposed, expectTxnVersion: c.txnVersion, reviewedBy: 'tester' });
  for (const [a, d] of [[A.Checking, 'f1065.L.1'], [A['Accounts Receivable (A/R)'], 'f1065.L.2a'], [A['Inventory Asset'], 'f1065.L.3'], [A['Furniture and Equipment'], 'f1065.L.9a'], [A['Accumulated Depreciation'], 'f1065.L.9b'],
    [A['Loan Payable'], 'f1065.L.19b'], [A['Retained Earnings'], 'f1065.L.21']]) await bindBalance(pool, C, ret, a, d);
  await bind(pool, C, ret, A['Accounts Payable (A/P)'], 'activity', [{ treatment: 'not_tax', memo: 'bills paid within the year' }]);
  await bind(pool, C, ret, A['Inventory Asset'], 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.2', activityId: store }]);
  await bind(pool, C, ret, A['Cost of Goods Sold'], 'activity', [{ treatment: 'cogs_tieout', destination: 'f1125a.main.8', activityId: store }]);
  for (const [a, d, tr] of [[A.Sales, 'f1065.p1.1a', 'input'], [A['Rent & Lease'], 'f1065.p1.13', 'input'], [A.Wages, 'f1065.p1.9', 'input'], [A.Meals, 'f1065.p1.21', 'statement_row'], [A.Depreciation, 'f1065.p1.16a', 'manual_feed']]) {
    await bind(pool, C, ret, a, 'activity', [{ treatment: tr, destination: d }]);
  }
  await saveManualItem(pool, { ...C, returnId: ret, itemKey: 'f1065.p1.16a|activity', status: 'entered', amount: '160.00', enteredBy: 'tester' });
  await answerTypedItems(pool, C, ret);
  await saveWorkpaper(pool, { ...C, returnId: ret, activityId: store, path: 'reconstruct', treatment: 'inventory_as_booked', method: 'cost', begin: '500.00', end: '600.00', sourceNote: 'Year-end count', reviewedBy: 'tester' });
  await saveAdjustment(pool, { ...C, returnId: ret, purpose: 'other', memo: 'Year-end bonus accrued, paid within 2½ months', evidence: 'Preparer’s entry 3; payroll register for February', decidedBy: 'tester',
    lines: [{ slotKey: 'f1065.p1.9|activity', amount: '50.00', m1Class: 'other' }] });
  let r = await compute(pool, C, ret);
  for (const p of r.proposals) await answerProposal(pool, { ...C, returnId: ret, key: p.key, version: p.version, decision: 'accept', decidedBy: 'tester', compute: computeIn });
  r = await compute(pool, C, ret);
  const act = `activity=act:${store}`;
  expectAll(r, {
    [`f1125a.main.1|${act}|activity`]: 50000n, [`f1125a.main.2|${act}|activity`]: 120000n, [`f1125a.main.6|${act}|activity`]: 170000n, [`f1125a.main.7|${act}|activity`]: 60000n, [`f1125a.main.8|${act}|activity`]: 110000n,
    'f1065.p1.1a|activity': 400000n, 'f1065.p1.2|activity': 110000n, 'f1065.p1.3|activity': 290000n, 'f1065.p1.8|activity': 290000n, 'f1065.p1.9|activity': 95000n, 'f1065.p1.13|activity': 36000n,
    'f1065.p1.16c|activity': 16000n, 'f1065.p1.21|activity': 3000n, 'f1065.p1.22|activity': 150000n, 'f1065.p1.23|activity': 140000n,
    'f1065.k.1|activity': 140000n, 'f1065.k.18c|activity': 3000n, 'f1065.anal.1|activity': 140000n,
    'f1065.L.1|begin': 300000n, 'f1065.L.3|begin': 50000n, 'f1065.L.9b|begin': 16000n, 'f1065.L.14|begin': 414000n, 'f1065.L.21|begin': 314000n, 'f1065.L.22|begin': 414000n,
    'f1065.L.1|end': 378000n, 'f1065.L.2a|end': 50000n, 'f1065.L.3|end': 60000n, 'f1065.L.9b|end': 32000n, 'f1065.L.14|end': 536000n, 'f1065.L.19b|end': 80000n, 'f1065.L.21|end': 456000n, 'f1065.L.22|end': 536000n,
    'f1065.m1.1|activity': 142000n, 'f1065.m1.4b|activity': 3000n, 'f1065.m1.7b|activity': 5000n, 'f1065.m1.9|activity': 140000n,
  });
  assert.equal(r.bridge.residual, '0');
  assert.deepEqual(errorsOf(r), [], 'complete for this stage: every check passes');
  const out = resultsJson(r);
  assert.deepEqual(out.fields.find(f => f.key === 'f1065.p1.21|activity').rows, [{ label: 'Meals', cents: '6000' }, { label: 'Nondeductible part: Meals', cents: '-3000' }], 'the rows add up to the line');
  assert.equal(out.fields.find(f => f.key === 'f1065.p1.23|activity').cents, '140000');
});

test('sample start-up partnership (initial, cash-method Form 1065): unpaid invoices excluded, a December advance included once, a card purchase and its repayment', async () => {
  const C = { orgId, entityId: await company(pool, orgId, 'Sample Startup Partners') };
  await saveProfile(pool, { ...C, fields: { returnType: 'form_1065', taxMethodDefault: 'cash', bookBasisDefault: 'accrual', yearEndMonth: 12, dateStarted: '2025-01-01' }, reason: 'test', actor: 'tester' });
  const ret = Number(await openPeriod(pool, { ...C, year: 2025, initial: true, actor: 'tester' }));
  await verifyInitial(pool, { ...C, returnId: ret, verifiedBy: 'tester', evidence: 'Certificate of formation' });
  const A = {};
  for (const n of ['Checking', 'Services', 'Supplies & Materials', 'Credit Card', 'Retained Earnings', 'Accounts Receivable (A/R)']) A[n] = await acct(pool, C, n);
  const inv1 = await invoice(pool, C, '2025-03-01', [[A.Services, 50000]]);
  await payment(pool, C, '2025-04-01', 50000, A.Checking, [[inv1, 50000, '2025-04-01']]);
  await invoice(pool, C, '2025-11-01', [[A.Services, 20000]]);
  const adv = await payment(pool, C, '2025-12-28', 8000, A.Checking);
  await expense(pool, C, '2025-05-01', A['Credit Card'], [[A['Supplies & Materials'], 3000]]);
  await cardPayment(pool, C, '2025-06-01', A.Checking, A['Credit Card'], 3000);
  await deposit(pool, C, '2025-06-05', A.Checking, [[A.Services, 2500]]);
  await bindBalance(pool, C, ret, A.Checking, 'f1065.L.1');
  await bindBalance(pool, C, ret, A['Accounts Receivable (A/R)'], 'f1065.L.2a');
  await bind(pool, C, ret, A['Credit Card'], 'activity', [{ treatment: 'not_tax', memo: 'charged and repaid within the year' }]);
  await bind(pool, C, ret, A['Retained Earnings'], 'end', [{ treatment: 'input', destination: 'f1065.L.21' }]);
  await bind(pool, C, ret, A.Services, 'activity', [{ treatment: 'input', destination: 'f1065.p1.1a' }]);
  await bind(pool, C, ret, A['Supplies & Materials'], 'activity', [{ treatment: 'statement_row', destination: 'f1065.p1.21' }]);
  await answerTypedItems(pool, C, ret);
  const R = { return_id: ret, entity_id: C.entityId, period_start: '2025-01-01', period_end: '2025-12-31', tax_method: 'cash' };
  const a = (await cashRecognition(pool, { orgId, ret: R })).candidates.find(x => x.txnId === adv);
  await saveTimingReview(pool, { ...C, returnId: ret, txnId: adv, kind: 'unrestricted_advance', decision: 'include', slotKey: 'f1065.p1.1a|activity', amount: '80.00', expectTxnVersion: a.txnVersion, expectEventVersion: a.eventVersion, reviewedBy: 'tester' });
  const r = await compute(pool, C, ret);
  expectAll(r, {
    'f1065.p1.1a|activity': 60500n, 'f1065.p1.21|activity': 3000n, 'f1065.p1.23|activity': 57500n, 'f1065.anal.1|activity': 57500n,
    'f1065.L.1|begin': 0n, 'f1065.L.14|begin': 0n, 'f1065.L.1|end': 57500n, 'f1065.L.2a|end': 12000n, 'f1065.L.14|end': 69500n, 'f1065.L.21|end': 69500n, 'f1065.L.22|end': 69500n,
    'f1065.m1.1|activity': 69500n, 'f1065.m1.6b|activity': 12000n, 'f1065.m1.9|activity': 57500n,
  });
  assert.deepEqual(r.bridge.rows.map(x => [x.line, x.label, x.cents]), [['6b', 'Cash method timing: Gross receipts or sales', '12000']]);
  assert.deepEqual(errorsOf(r), []);
});

test('sample services corporation (cash-method Form 1120-S): officer compensation per shareholder, a penalty kept out of income, a baseline that ties', async () => {
  const C = { orgId, entityId: await company(pool, orgId, 'Sample Services Corp') };
  const ret = await period(pool, C, 2025, 'form_1120s', { taxMethod: 'cash' });
  const owner = await party(pool, orgId, 'Sample Shareholder');
  await saveInterest(pool, { ...C, fields: { partyId: owner, role: 'shareholder', from: '2020-01-01', to: null, profit: '1/1', loss: '1/1', capital: '1/1' }, actor: 'tester' });
  const A = {};
  for (const n of ['Checking', 'Services', 'Wages', 'Insurance', 'Retained Earnings']) A[n] = await acct(pool, C, n);
  A.Fines = await acct(pool, C, 'Fines and Penalties', 'expense');
  await je(pool, C, '2024-06-01', [[A.Checking, 30000], [A.Services, -30000]]);
  const b = await baseline(C, 'form_1120s', [['f1120s.L.1', 30000], ['f1120s.L.24', 30000]]);
  await setPredecessor(pool, { ...C, returnId: ret, baselineId: b.baselineId });
  await deposit(pool, C, '2025-03-15', A.Checking, [[A.Services, 200000]]);
  await je(pool, C, '2025-04-01', [[A.Wages, 60000], [A.Checking, -60000]]);
  await expense(pool, C, '2025-05-01', A.Checking, [[A.Insurance, 12000]]);
  await expense(pool, C, '2025-06-01', A.Checking, [[A.Fines, 1000]]);
  await bindBalance(pool, C, ret, A.Checking, 'f1120s.L.1');
  await bindBalance(pool, C, ret, A['Retained Earnings'], 'f1120s.L.24');
  await bind(pool, C, ret, A.Services, 'activity', [{ treatment: 'input', destination: 'f1120s.p1.1a' }]);
  await bind(pool, C, ret, A.Wages, 'activity', [{ treatment: 'input', destination: 'f1120s.p1.7', interestPartyId: owner }]);
  for (const a of [A.Insurance, A.Fines]) await bind(pool, C, ret, a, 'activity', [{ treatment: 'statement_row', destination: 'f1120s.p1.20' }]);
  await answerTypedItems(pool, C, ret);
  let r = await compute(pool, C, ret);
  for (const p of r.proposals) await answerProposal(pool, { ...C, returnId: ret, key: p.key, version: p.version, decision: 'accept', decidedBy: 'tester', compute: computeIn });
  r = await compute(pool, C, ret);
  const { rows: [i] } = await pool.query('SELECT interest_id FROM ownership_interest WHERE org_id = $1 AND entity_id = $2', [orgId, C.entityId]);
  expectAll(r, {
    'f1120s.p1.1a|activity': 200000n, [`f1120s.p1.7|interest=i:${i.interest_id}|activity`]: 60000n, 'f1120s.p1.20|activity': 12000n, 'f1120s.p1.21|activity': 72000n, 'f1120s.p1.22|activity': 128000n,
    'f1120s.k.1|activity': 128000n, 'f1120s.k.16c|activity': 1000n, 'f1120s.k.18|activity': 128000n,
    'f1120s.L.1|begin': 30000n, 'f1120s.L.24|begin': 30000n, 'f1120s.L.1|end': 157000n, 'f1120s.L.24|end': 157000n, 'f1120s.L.15|end': 157000n, 'f1120s.L.27|end': 157000n,
    'f1120s.m1.1|activity': 127000n, 'f1120s.m1.3c|activity': 1000n, 'f1120s.m1.8|activity': 128000n,
  });
  assert.deepEqual(r.fields.find(f => f.key === 'f1120s.p1.20|activity').rows, [{ label: 'Insurance', cents: '12000' }, { label: 'Fines and Penalties', cents: '1000' }, { label: 'Nondeductible part: Fines and Penalties', cents: '-1000' }]);
  assert.equal(r.bridge.residual, '0');
  assert.deepEqual(errorsOf(r), []);
});
