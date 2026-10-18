// test/tax-revision.test.js — working revisions, the dependency manifest and drift (spec §4.3, §5.9, §13 T3): a revision stores inputs,
// exact results (catalog field ids, cents as strings), everything consumed and the manifest of that same set; it is never changed or deleted
// and never final in this stage; drift tells an amount change from a provenance change (a re-posted entry, a payment re-applied between
// invoices, an older invoice edited, an earlier application posted again, an earlier period's decision made again, an adjustment's support)
// and from a structure change (a mapping, a statement-row label, the header, the activities) — and the old revision still explains its result
// (Codex t3-plan-r1 B12).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { t2Db, company, acct, je, period, bind, bindBalance, answerTypedItems, invoice, payment } from './tax-t3-fixtures.js';
import { takeWorkingRevision, listRevisions, getRevision, driftOf, driftBetween } from '../lib/tax/engine/revision.js';
import { openPeriod } from '../lib/tax/periods.js';

let t, pool, orgId, K, ret, A, extra;
before(async () => {
  t = await t2Db(); pool = t.pool; orgId = t.orgId;
  K = { orgId, entityId: await company(pool, orgId, 'Kapok Partners') };
  ret = await period(pool, K, 2025, 'form_1065', { taxMethod: 'cash' });
  A = {};
  for (const n of ['Checking', 'Services', 'Wages', 'Retained Earnings', 'Accounts Receivable (A/R)']) A[n] = await acct(pool, K, n);
  await je(pool, K, '2025-03-01', [[A.Wages, 10000], [A.Checking, -10000]]);
  A.inv1 = await invoice(pool, K, '2025-04-01', [[A.Services, 25000]]);
  A.inv2 = await invoice(pool, K, '2025-04-02', [[A.Services, 25000]]);
  A.pay = await payment(pool, K, '2025-04-10', 25000, A.Checking, [[A.inv1, 25000, '2025-04-10']]);
  await bindBalance(pool, K, ret, A.Checking, 'f1065.L.1');
  await bindBalance(pool, K, ret, A['Accounts Receivable (A/R)'], 'f1065.L.2a');
  await bind(pool, K, ret, A['Retained Earnings'], 'end', [{ treatment: 'input', destination: 'f1065.L.21' }]);
  await bind(pool, K, ret, A.Services, 'activity', [{ treatment: 'input', destination: 'f1065.p1.1a' }]);
  await bind(pool, K, ret, A.Wages, 'activity', [{ treatment: 'input', destination: 'f1065.p1.9' }]);
  await answerTypedItems(pool, K, ret);
});
after(async () => { await t.db.drop(); });

test('a working revision keeps inputs, exact results, the rows consumed and the manifest; numbers go up; nothing is changed, deleted or made final', async () => {
  const v1 = await takeWorkingRevision(pool, { ...K, returnId: ret, takenBy: 'tester' });
  const v2 = await takeWorkingRevision(pool, { ...K, returnId: ret, takenBy: 'tester' });
  assert.deepEqual([v1.revisionNo, v2.revisionNo], [1, 2]);
  const saved = await getRevision(pool, { ...K, returnId: ret, revisionNo: 1 });
  assert.equal(saved.kind, 'working');
  assert.equal(saved.results.schema, 'tax-books.results.v1');
  assert.deepEqual(saved.results.fields.find(f => f.key === 'f1065.p1.1a|activity'), { key: 'f1065.p1.1a|activity', fieldId: 'f1065.p1.1a', dims: {}, measurement: 'activity', cents: '25000', status: 'complete', reasons: [], providers: ['cash_layer'], rows: null });
  assert.ok(saved.source_detail.applications.some(a => a[1] === A.pay), 'every application read, with its endpoints');
  for (const k of ['engine', 'catalog', 'return', 'activities', 'partitions', 'transactions', 'documents', 'applications', 'cash', 'decisions', 'structure', 'manual', 'adjustments', 'classifications', 'cogs', 'openings']) assert.ok(k in saved.dependency_manifest, k);
  assert.equal((await listRevisions(pool, { ...K, returnId: ret })).length, 2);
  await assert.rejects(pool.query('UPDATE tax_return_revision SET taken_by = $2 WHERE revision_id = $1', [v1.revisionId, 'someone']), /never changed or deleted/);
  await assert.rejects(pool.query('DELETE FROM tax_return_revision WHERE revision_id = $1', [v1.revisionId]), /never changed or deleted/);
  await assert.rejects(pool.query(`INSERT INTO tax_return_revision (org_id, return_id, revision_no, kind, taken_by, catalog_hash, engine_version, inputs, results, source_detail, dependency_manifest)
    VALUES ($1,$2,9,'final','tester',$3,'x','{}','{}','{}','{}')`, [orgId, ret, saved.catalog_hash]), /finalization arrives with stage T4/);
  const later = Number(await openPeriod(pool, { ...K, year: 2026, actor: 'tester' }));
  await assert.rejects(takeWorkingRevision(pool, { ...K, returnId: later, takenBy: 'tester' }), /2026 forms are not in the app yet/);
});

test('drift: none right after; a payment re-applied from one invoice to an equal one is provenance drift with no amount drift; a new entry is amount drift', async () => {
  assert.deepEqual(await driftOf(pool, { ...K, returnId: ret }), { revisionNo: 2, takenAt: (await listRevisions(pool, { ...K, returnId: ret }))[0].taken_at, amount: [], provenance: [], structure: [], engine: false });
  await pool.query('UPDATE application SET charge_txn_id = $2 WHERE credit_txn_id = $1', [A.pay, A.inv2]);
  let d = await driftOf(pool, { ...K, returnId: ret });
  assert.deepEqual(d.amount, []);
  assert.ok(d.provenance.includes('applications'), 'the same income, recognized from another invoice');
  extra = await je(pool, K, '2025-06-01', [[A.Wages, 500], [A.Checking, -500]]);
  d = await driftOf(pool, { ...K, returnId: ret });
  assert.ok(d.amount.some(x => x.key === 'f1065.p1.9|activity' && x.was === '10000' && x.now === '10500'));
});

test('drift: an entry deleted and posted again with the same figures is provenance drift; a remapping is structure drift; an engine change is engine drift', async () => {
  await takeWorkingRevision(pool, { ...K, returnId: ret, takenBy: 'tester' });
  await pool.query('DELETE FROM posting WHERE txn_id = $1', [extra]);
  await pool.query('DELETE FROM txn WHERE txn_id = $1', [extra]);
  await je(pool, K, '2025-06-01', [[A.Wages, 500], [A.Checking, -500]]);
  let d = await driftOf(pool, { ...K, returnId: ret });
  assert.deepEqual(d.amount, []);
  assert.ok(d.provenance.includes('partitions') && d.provenance.includes('transactions'));
  await bind(pool, K, ret, A.Wages, 'activity', [{ treatment: 'statement_row', destination: 'f1065.p1.21' }]);
  d = await driftOf(pool, { ...K, returnId: ret });
  assert.ok(d.structure.includes('structure'));
  const saved = { results: { fields: [] }, manifest: { engine: 'tax-t3-0', catalog: 'x' } };
  assert.equal(driftBetween(saved, { results: { fields: [] }, manifest: { engine: 'tax-t3-1', catalog: 'x' } }).engine, true);
});

test('a revision freezes what it consumed (Codex t3-plan-r1 B12) — an older invoice a payment settles, earlier applications, an earlier period’s decision, labels, support, the header and the activities — and equal-total edits to any of them are drift', async () => {
  const { activity } = await import('./tax-t3-fixtures.js');
  const { cashRecognition, saveTimingReview, clearTimingReview } = await import('../lib/tax/cash.js');
  const { saveAdjustment, withdrawAdjustment } = await import('../lib/tax/adjustments.js');
  const C = { orgId, entityId: await company(pool, orgId, 'Kauri Partners') };
  const ret = await period(pool, C, 2025, 'form_1065', { taxMethod: 'cash' });
  const r24 = Number(await openPeriod(pool, { ...C, year: 2024, actor: 'tester' }));
  const B = {};
  for (const n of ['Checking', 'Services', 'Supplies & Materials', 'Retained Earnings', 'Accounts Receivable (A/R)']) B[n] = await acct(pool, C, n);
  await activity(pool, C, { name: 'Kauri trade' });
  const old = await invoice(pool, C, '2024-11-01', [[B.Services, 3000]]);
  await payment(pool, C, '2025-01-15', 3000, B.Checking, [[old, 3000, '2025-01-15']]);
  const i24 = await invoice(pool, C, '2024-10-01', [[B.Services, 2000]]);
  const p24 = await payment(pool, C, '2024-12-01', 1000, B.Checking, [[i24, 1000, '2024-12-01']]);
  await payment(pool, C, '2025-02-01', 1000, B.Checking, [[i24, 1000, '2025-02-01']]);
  const dep = await payment(pool, C, '2024-12-20', 1500, B.Checking);
  const later = await invoice(pool, C, '2025-03-01', [[B.Services, 1500]]);
  await pool.query('INSERT INTO application (org_id, credit_txn_id, charge_txn_id, amount_cents, applied_on) VALUES ($1,$2,$3,1500,$4)', [orgId, dep, later, '2025-03-01']);
  await je(pool, C, '2025-04-01', [[B['Supplies & Materials'], 400], [B.Checking, -400]]);
  await bindBalance(pool, C, ret, B.Checking, 'f1065.L.1');
  await bindBalance(pool, C, ret, B['Accounts Receivable (A/R)'], 'f1065.L.2a');
  await bind(pool, C, ret, B['Retained Earnings'], 'end', [{ treatment: 'input', destination: 'f1065.L.21' }]);
  await bind(pool, C, ret, B.Services, 'activity', [{ treatment: 'input', destination: 'f1065.p1.1a' }]);
  await bind(pool, C, ret, B['Supplies & Materials'], 'activity', [{ treatment: 'statement_row', destination: 'f1065.p1.21', rowLabel: 'Supplies' }]);
  await answerTypedItems(pool, C, ret);
  const R24 = { return_id: r24, entity_id: C.entityId, period_start: '2024-01-01', period_end: '2024-12-31', tax_method: 'cash' };
  const decideDeposit = async () => { const c = (await cashRecognition(pool, { orgId, ret: R24 })).candidates.find(x => x.txnId === dep);
    await saveTimingReview(pool, { ...C, returnId: r24, txnId: dep, kind: 'refundable_deposit', decision: 'exclude', expectTxnVersion: c.txnVersion, expectEventVersion: c.eventVersion, reviewedBy: 'tester', reason: 'Refundable until delivery' }); };
  await decideDeposit();
  const g = await saveAdjustment(pool, { ...C, returnId: ret, purpose: 'other', memo: 'Supplies returned', evidence: 'Receipt A', decidedBy: 'tester', lines: [{ slotKey: 'f1065.p1.21|activity', amount: '-1.00', m1Class: 'other' }] });
  const { rows: [then] } = await pool.query('SELECT txn_version($1) AS v', [old]);
  await takeWorkingRevision(pool, { ...C, returnId: ret, takenBy: 'tester' });
  const saved = await getRevision(pool, { ...C, returnId: ret, revisionNo: 1 });
  assert.equal(saved.results.fields.find(f => f.key === 'f1065.p1.1a|activity').cents, '5500', 'the older invoice, the second half of a 2024 invoice, the deposit applied in 2025');
  const drift = () => driftOf(pool, { ...C, returnId: ret });
  const quiet = async (group, kind = 'provenance') => { const d = await drift(); assert.deepEqual(d.amount, [], `${group}: equal totals`); assert.ok(d[kind].includes(group), `${group} drift: ${JSON.stringify(d)}`); };
  // 1. The older invoice the payment settles, edited without changing an amount.
  await pool.query(`UPDATE txn SET memo = 'reissued' WHERE txn_id = $1`, [old]);
  await quiet('transactions');
  // 2. A 2024 application (cumulative sharing reads it) posted again with the same figures.
  await pool.query('DELETE FROM application WHERE credit_txn_id = $1', [p24]);
  await pool.query('INSERT INTO application (org_id, credit_txn_id, charge_txn_id, amount_cents, applied_on) VALUES ($1,$2,$3,1000,$4)', [orgId, p24, i24, '2024-12-01']);
  await quiet('applications');
  // 3. The 2024 period's decision made again, the same way.
  const rv = (await cashRecognition(pool, { orgId, ret: R24 })).candidates.find(x => x.txnId === dep).review;
  await clearTimingReview(pool, { ...C, returnId: r24, reviewId: rv.review_id });
  await decideDeposit();
  await quiet('decisions');
  // 4. A statement row's label; 5. an adjustment's support (withdrawn and entered again with other evidence).
  await bind(pool, C, ret, B['Supplies & Materials'], 'activity', [{ treatment: 'statement_row', destination: 'f1065.p1.21', rowLabel: 'Office supplies' }]);
  await quiet('structure', 'structure');
  await withdrawAdjustment(pool, { ...C, returnId: ret, groupId: g, reason: 'Wrong receipt named', decidedBy: 'tester' });
  await saveAdjustment(pool, { ...C, returnId: ret, purpose: 'other', memo: 'Supplies returned', evidence: 'Receipt B', decidedBy: 'tester', lines: [{ slotKey: 'f1065.p1.21|activity', amount: '-1.00', m1Class: 'other' }] });
  await quiet('adjustments');
  // 6. The header and the activities.
  await pool.query(`UPDATE tax_activity SET name = 'Kauri wholesale' WHERE org_id = $1 AND return_entity_id = $2`, [orgId, C.entityId]);
  await quiet('activities', 'structure');
  await pool.query(`UPDATE entity SET name = 'Kauri Partners LP' WHERE org_id = $1 AND entity_id = $2`, [orgId, C.entityId]);
  await quiet('return', 'structure');
  // The old revision still explains the old result, unchanged.
  const again = await getRevision(pool, { ...C, returnId: ret, revisionNo: 1 });
  assert.deepEqual(again.source_detail, saved.source_detail);
  assert.ok(again.source_detail.transactions.some(([id, v]) => id === old && v === then.v), 'the older invoice as it was consumed');
  assert.ok(again.source_detail.documents.some(([id, legs]) => id === old && legs.some(l => l[0] === B.Services && l[2] === '-3000')), 'and its postings');
  assert.ok(again.source_detail.applications.some(a => a[1] === p24 && a[4] === '2024-12-01'), 'the 2024 application read for the cumulative share');
  assert.ok(again.inputs.decisions.some(d => d.txnId === dep && d.kind === 'refundable_deposit' && d.returnId === r24 && d.reason === 'Refundable until delivery'), 'the 2024 decision with its content');
  assert.equal(again.inputs.bindings.find(b => b.account_id === B['Supplies & Materials']).row_label, 'Supplies');
  assert.equal(again.inputs.adjustments.groups.find(x => x.id === g).evidence, 'Receipt A');
  assert.deepEqual([again.inputs.activities[0].name, again.inputs.header.company], ['Kauri trade', 'Kauri Partners']);
});

test('the old revision renders its sources as they were (Codex t3-plan-r2 R2-8): a measured entry edited or deleted keeps its date, number, memo and party; a property or header fact changed without money is structure drift; an older entry behind a beginning balance is frozen and its edit is drift', async () => {
  const { activity } = await import('./tax-t3-fixtures.js');
  const C = { orgId, entityId: await company(pool, orgId, 'Kumquat Partners') };
  const ret = await period(pool, C, 2025, 'form_1065', { taxMethod: 'cash' });
  const B = {};
  for (const n of ['Checking', 'Services', 'Wages', 'Retained Earnings']) B[n] = await acct(pool, C, n);
  const prop = await activity(pool, C, { name: 'Kumquat warehouse', kind: 'rental', schedule: 'f8825' });
  await pool.query(`UPDATE tax_activity SET property = '{"address": "1 Sample Way", "type": 1, "fairRentalDays": 365}' WHERE activity_id = $1`, [prop]);
  const opening = await je(pool, C, '2024-06-01', [[B.Checking, 40000], [B.Services, -40000]]);
  const inv = await invoice(pool, C, '2025-03-01', [[B.Services, 25000]], { doc: 'INV-1001' });
  await pool.query(`UPDATE txn SET memo = 'March service, per contract' WHERE txn_id = $1`, [inv]);
  await payment(pool, C, '2025-03-20', 25000, B.Checking, [[inv, 25000, '2025-03-20']]);
  const wages = await je(pool, C, '2025-04-01', [[B.Wages, 9000], [B.Checking, -9000]], { memo: 'April payroll' });
  await bindBalance(pool, C, ret, B.Checking, 'f1065.L.1');
  await bind(pool, C, ret, B['Retained Earnings'], 'end', [{ treatment: 'input', destination: 'f1065.L.21' }]);
  await bindBalance(pool, C, ret, B['Retained Earnings'], 'f1065.L.21');
  await bind(pool, C, ret, B.Services, 'activity', [{ treatment: 'input', destination: 'f1065.p1.1a' }]);
  await bind(pool, C, ret, B.Wages, 'activity', [{ treatment: 'input', destination: 'f1065.p1.9' }]);
  await answerTypedItems(pool, C, ret);
  await takeWorkingRevision(pool, { ...C, returnId: ret, takenBy: 'tester' });
  const saved = await getRevision(pool, { ...C, returnId: ret, revisionNo: 1 });
  const ctxOf = id => saved.source_detail.contexts.find(x => x.id === id);
  assert.deepEqual([ctxOf(inv).type, ctxOf(inv).date, ctxOf(inv).number, ctxOf(inv).memo, ctxOf(inv).customer], ['invoice', '2025-03-01', 'INV-1001', 'March service, per contract', 'Sample customer']);
  assert.ok(Object.values(saved.source_detail.postings).flat().some(p => p[0] === wages && p[4] === '2025-04-01' && p[6] === 'April payroll'), 'a measured line with its date and memo');
  assert.ok(saved.source_detail.history[B.Checking].some(p => p[0] === opening && p[3] === '40000'), 'the older entry the beginning balance comes from');
  assert.deepEqual(saved.inputs.activities.find(a => a.activity_id === prop).property, { address: '1 Sample Way', type: 1, fairRentalDays: 365 });
  assert.equal(saved.inputs.header.final_return, false);
  const drift = () => driftOf(pool, { ...C, returnId: ret });
  const quiet = async (group, kind) => { const d = await drift(); assert.deepEqual(d.amount, [], group); assert.ok(d[kind].includes(group), `${group}: ${JSON.stringify(d)}`); };
  await pool.query(`UPDATE txn SET memo = 'reissued', doc_number = 'INV-1001A' WHERE txn_id = $1`, [inv]);
  await quiet('transactions', 'provenance');
  await pool.query(`UPDATE txn SET memo = 'moved in from savings' WHERE txn_id = $1`, [opening]);
  await quiet('history', 'provenance');
  await pool.query(`UPDATE tax_activity SET property = '{"address": "1 Sample Way", "type": 1, "fairRentalDays": 300}' WHERE activity_id = $1`, [prop]);
  await quiet('activities', 'structure');
  await pool.query('UPDATE tax_return SET final_return = true WHERE return_id = $1', [ret]);
  await quiet('return', 'structure');
  await pool.query('UPDATE tax_return SET final_return = false WHERE return_id = $1', [ret]);
  await pool.query('DELETE FROM posting WHERE txn_id = $1', [wages]);
  await pool.query('DELETE FROM txn WHERE txn_id = $1', [wages]);
  const again = await getRevision(pool, { ...C, returnId: ret, revisionNo: 1 });
  assert.deepEqual(again.source_detail, saved.source_detail, 'nothing in the old revision changes');
  assert.deepEqual([again.source_detail.contexts.find(x => x.id === wages).memo, again.source_detail.contexts.find(x => x.id === inv).number], ['April payroll', 'INV-1001'], 'the deleted entry and the old number are still there to show');
});

test('the earlier income and expense behind retained earnings are frozen too (Codex t3-plan-r3 R3-4): an invoice and a bill of the year before, paid then, their receivable and payable at zero and out of coverage', async () => {
  const { bill, billPayment } = await import('./tax-t3-fixtures.js');
  const C = { orgId, entityId: await company(pool, orgId, 'Kiwi Partners') };
  const ret = await period(pool, C, 2025, 'form_1065', { taxMethod: 'accrual' });
  const B = {};
  for (const n of ['Checking', 'Services', 'Utilities', 'Retained Earnings']) B[n] = await acct(pool, C, n);
  const old = await invoice(pool, C, '2024-05-01', [[B.Services, 7000]], { doc: 'INV-2024-7' });
  await pool.query(`UPDATE txn SET memo = 'May consulting' WHERE txn_id = $1`, [old]);
  await payment(pool, C, '2024-06-01', 7000, B.Checking, [[old, 7000, '2024-06-01']]);
  const oldBill = await bill(pool, C, '2024-07-01', [[B.Utilities, 2000]]);
  await billPayment(pool, C, '2024-07-15', 2000, B.Checking, [[oldBill, 2000, '2024-07-15']]);
  await je(pool, C, '2025-03-01', [[B.Checking, 1000], [B.Services, -1000]]);
  await bindBalance(pool, C, ret, B.Checking, 'f1065.L.1');
  await bindBalance(pool, C, ret, B['Retained Earnings'], 'f1065.L.21');
  await bind(pool, C, ret, B.Services, 'activity', [{ treatment: 'input', destination: 'f1065.p1.1a' }]);
  await answerTypedItems(pool, C, ret);
  const r0 = await (await import('../lib/tax/engine/compute.js')).computeReturn(pool, { ...C, returnId: ret });
  assert.ok(!r0.cov.sources[0].accounts.some(a => a.name === 'Accounts Receivable (A/R)'), 'the receivable is at zero, untouched this year: out of coverage');
  await takeWorkingRevision(pool, { ...C, returnId: ret, takenBy: 'tester' });
  const saved = await getRevision(pool, { ...C, returnId: ret, revisionNo: 1 });
  const inc = saved.source_detail.historyIncome;
  assert.ok(inc.some(([a, t, , d, c]) => a === B.Services && t === old && d === '2024-05-01' && c === '-7000'), 'the old invoice’s income line');
  assert.ok(inc.some(([a, t, , , c]) => a === B.Utilities && t === oldBill && c === '2000'), 'the old bill’s expense line');
  const ctx = saved.source_detail.contexts.find(x => x.id === old);
  assert.deepEqual([ctx.number, ctx.memo, ctx.customer], ['INV-2024-7', 'May consulting', 'Sample customer']);
  await pool.query(`UPDATE txn SET memo = 'May consulting, reissued', doc_number = 'INV-2024-7A' WHERE txn_id = $1`, [old]);
  const d = await driftOf(pool, { ...C, returnId: ret });
  assert.deepEqual(d.amount, []);
  assert.ok(d.provenance.includes('history'), JSON.stringify(d));
  await pool.query('DELETE FROM application WHERE charge_txn_id = $1', [old]);
  await pool.query('DELETE FROM posting WHERE txn_id = $1', [old]);
  await pool.query('DELETE FROM txn WHERE txn_id = $1', [old]);
  const again = await getRevision(pool, { ...C, returnId: ret, revisionNo: 1 });
  assert.deepEqual(again.source_detail.contexts.find(x => x.id === old).number, 'INV-2024-7', 'the old revision still shows it as it was');
});

test('a held decision is frozen with the revision whatever became of its source (Codex t3-plan-r4 R4-1, R4-3): a movement class whose line was renumbered, and a next period’s receipt date whose deposit was redated into this period', async () => {
  const { deposit, rawTxn, activity } = await import('./tax-t3-fixtures.js');
  const { saveWorkpaper, classifyMovement } = await import('../lib/tax/cogs.js');
  const { cashRecognition, saveTimingReview } = await import('../lib/tax/cash.js');
  const { computeReturn } = await import('../lib/tax/engine/compute.js');
  // A movement class.
  const G = { orgId, entityId: await company(pool, orgId, 'Sumac Traders') };
  const gRet = await period(pool, G, 2025, 'form_1065', { taxMethod: 'accrual' });
  const act = await activity(pool, G, { name: 'Sumac trade' });
  const inv = await acct(pool, G, 'Inventory Asset'), ap = await acct(pool, G, 'Accounts Payable (A/P)');
  const billTxn = await rawTxn(pool, G, 'bill', '2025-02-01', [[inv, 10000], [ap, -10000]]);
  await bind(pool, G, gRet, inv, 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.2', activityId: act }]);
  await saveWorkpaper(pool, { ...G, returnId: gRet, activityId: act, path: 'reconstruct', treatment: 'inventory_as_booked', method: 'cost', begin: '0', end: '0', reviewedBy: 'tester' });
  const m = (await computeReturn(pool, { ...G, returnId: gRet })).cogs.get(act).movements.find(x => x.txnId === billTxn);
  await classifyMovement(pool, { ...G, returnId: gRet, accountId: inv, txnId: billTxn, lineNo: m.lineNo, cls: 'transfer', expectTxnVersion: m.txnVersion, reviewedBy: 'tester' });
  await pool.query('UPDATE posting SET line_no = line_no + 1 WHERE txn_id = $1', [billTxn]);
  await takeWorkingRevision(pool, { ...G, returnId: gRet, takenBy: 'tester' });
  let saved = await getRevision(pool, { ...G, returnId: gRet, revisionNo: 1 });
  const frozen = saved.inputs.cogs.find(e => e.activityId === act).movements.find(x => x.gone);
  assert.deepEqual([frozen.txnId, frozen.lineNo, frozen.saved.class, frozen.saved.txnVersion], [billTxn, m.lineNo, 'transfer', m.txnVersion], 'the saved class, as it was decided');
  assert.equal(saved.results.fields.find(f => f.key === `f1125a.main.2|activity=act:${act}|activity`).status, 'unresolved');
  // A next period's receipt date.
  const C = { orgId, entityId: await company(pool, orgId, 'Sumac Partners') };
  const y25 = await period(pool, C, 2025, 'form_1065', { taxMethod: 'cash' });
  const y26 = Number(await openPeriod(pool, { ...C, year: 2026, actor: 'tester' }));
  const bank = await acct(pool, C, 'Checking'), svc = await acct(pool, C, 'Services');
  await bind(pool, C, y25, svc, 'activity', [{ treatment: 'input', destination: 'f1065.p1.1a' }]);
  const jan = await deposit(pool, C, '2026-01-04', bank, [[svc, 500]]);
  const r26 = await cashRecognition(pool, { orgId, ret: { return_id: y26, entity_id: C.entityId, period_start: '2026-01-01', period_end: '2026-12-31', tax_method: 'cash' } });
  const c = [...r26.candidates, ...r26.selectable.receipts].find(x => x.txnId === jan);
  await saveTimingReview(pool, { ...C, returnId: y26, txnId: jan, kind: 'receipt_date', decision: 'include', recognizeOn: '2025-12-30', expectTxnVersion: c.txnVersion, expectEventVersion: c.eventVersion, reviewedBy: 'tester' });
  await pool.query(`UPDATE txn SET txn_date = '2025-12-30' WHERE txn_id = $1`, [jan]);
  await pool.query(`UPDATE posting SET txn_date = '2025-12-30' WHERE txn_id = $1`, [jan]);
  await takeWorkingRevision(pool, { ...C, returnId: y25, takenBy: 'tester' });
  saved = await getRevision(pool, { ...C, returnId: y25, revisionNo: 1 });
  const d = saved.inputs.decisions.find(x => x.txnId === jan);
  assert.deepEqual([d?.returnId, d?.kind, d?.on], [y26, 'receipt_date', '2025-12-30'], 'the next period’s decision this period consumed');
  assert.equal(saved.results.fields.find(f => f.key === 'f1065.p1.1a|activity').status, 'unresolved');
});

test('a revision freezes the whole saved decision record and the holds it caused (Codex t3-plan-r5 R5-5): a deleted, unbound closing kept after the live decision is cleared; a new explanation with the same amounts is provenance drift and the old one stays', async () => {
  const { classifyEntry, closingCandidates, clearClassification } = await import('../lib/tax/classify.js');
  const P = { orgId, entityId: await company(pool, orgId, 'Catalpa Partners') };
  const pRet = await period(pool, P, 2025, 'form_1065', { taxMethod: 'accrual' });
  const B = { bank: await acct(pool, P, 'Checking'), svc: await acct(pool, P, 'Services'), re: await acct(pool, P, 'Retained Earnings'), ev: await acct(pool, P, 'Event Income', 'income') };
  await je(pool, P, '2025-02-01', [[B.bank, 50000], [B.svc, -50000]]);
  await bindBalance(pool, P, pRet, B.bank, 'f1065.L.1');
  await bindBalance(pool, P, pRet, B.re, 'f1065.L.21');
  await bind(pool, P, pRet, B.svc, 'activity', [{ treatment: 'input', destination: 'f1065.p1.1a' }]);
  await bind(pool, P, pRet, B.ev, 'activity', [{ treatment: 'statement_row', destination: 'f1065.p1.7' }]);
  await answerTypedItems(pool, P, pRet);
  const RP = { return_id: pRet, entity_id: P.entityId, period_start: '2025-01-01', period_end: '2025-12-31' };
  const classify = async (txnId, reason) => { const c = (await closingCandidates(pool, { orgId, ret: RP })).find(x => x.txnId === txnId);
    await classifyEntry(pool, { ...P, returnId: pRet, txnId, cls: 'closing', lines: c.proposed, expectTxnVersion: c.txnVersion, reviewedBy: 'tester', reason }); return c; };
  // A closing decided, then its entry deleted and its income account unbound (out of coverage): the saved decision alone names what it held.
  const close = await je(pool, P, '2025-12-31', [[B.ev, 2000], [B.re, -2000]]);
  const c = await classify(close, 'Year-end close per the preparer');
  await pool.query('DELETE FROM posting WHERE txn_id = $1', [close]);
  await pool.query('DELETE FROM txn WHERE txn_id = $1', [close]);
  await pool.query('DELETE FROM tax_binding WHERE org_id = $1 AND return_id = $2 AND account_id = $3', [orgId, pRet, B.ev]);
  const { revisionNo } = await takeWorkingRevision(pool, { ...P, returnId: pRet, takenBy: 'tester' });
  await clearClassification(pool, { ...P, returnId: pRet, txnId: close });
  const saved = await getRevision(pool, { ...P, returnId: pRet, revisionNo });
  const d = saved.inputs.classifications.find(x => x.txnId === close).decision;
  assert.deepEqual([d.class, d.lines, d.txnVersion, d.reason, d.by], ['closing', c.proposed, c.txnVersion, 'Year-end close per the preparer', 'tester'], 'the decision as saved');
  assert.deepEqual(d.accounts.map((id, i) => [id, d.domains[i]]).sort(), [[B.ev, 'income'], [B.re, 'balance']].sort(), 'the accounts it held, each with its saved domain');
  assert.ok(Number.isInteger(d.id));
  const held = saved.inputs.holds.filter(h => h.source === 'closing');
  assert.deepEqual(held.map(h => [h.accountId, h.domains]).sort(), [[B.ev, ['income']], [B.re, ['balance']]].sort(), 'the holds it caused, frozen');
  assert.ok(held.every(h => /changed after it was classified/.test(h.reason)));
  assert.ok(saved.dependency_manifest.holds, 'hashed');
  // An eligible closing decided again with a new explanation, the amounts unchanged: provenance drift; the earlier revision keeps the first.
  const close2 = await je(pool, P, '2025-12-31', [[B.svc, 1000], [B.re, -1000]]);
  await classify(close2, 'Closing entry, first explanation');
  const first = await takeWorkingRevision(pool, { ...P, returnId: pRet, takenBy: 'tester' });
  await classify(close2, 'Closing entry, explained again after review');
  const drift = await driftOf(pool, { ...P, returnId: pRet });
  assert.deepEqual(drift.amount, [], 'no amount moved');
  assert.ok(drift.provenance.includes('classifications'), JSON.stringify(drift));
  const kept = await getRevision(pool, { ...P, returnId: pRet, revisionNo: first.revisionNo });
  assert.equal(kept.inputs.classifications.find(x => x.txnId === close2).decision.reason, 'Closing entry, first explanation');
});

test('a prepayment decision an entry uses up is frozen whole with the revision (Codex t3-plan-r6 R6-1), unchanged source too; a change to the payment is provenance drift; after it is cleared the old revision still holds it', async () => {
  const { expense } = await import('./tax-t3-fixtures.js');
  const { cashRecognition, clearTimingReview } = await import('../lib/tax/cash.js');
  const C = { orgId, entityId: await company(pool, orgId, 'Alder Revision Partners') };
  const y25 = await period(pool, C, 2025, 'form_1065', { taxMethod: 'cash' });
  const y24 = Number(await openPeriod(pool, { ...C, year: 2024, actor: 'tester' }));
  const A = { bank: await acct(pool, C, 'Checking'), util: await acct(pool, C, 'Utilities'), prepaid: await acct(pool, C, 'Prepaid Expenses') };
  const paid = await expense(pool, C, '2024-11-01', A.bank, [[A.prepaid, 10000]]);
  const c = (await cashRecognition(pool, { orgId, ret: { return_id: y24, entity_id: C.entityId, period_start: '2024-01-01', period_end: '2024-12-31', tax_method: 'cash' } })).candidates.find(x => x.txnId === paid);
  const { rows: [saved] } = await pool.query(`INSERT INTO cash_timing_review (org_id, return_id, source_entity_id, txn_id, kind, decision, slot_key, cents, txn_version, event_version, affected_accounts, affected_domains, source_accounts, reviewed_by, reason)
    VALUES ($1,$2,$3,$4,'prepaid_expense','include','f1065.p1.21|activity',10000,$5,$6,'{}','{income}',$7,'tester','Insurance paid a year ahead') RETURNING review_id`, [orgId, y24, C.entityId, paid, c.txnVersion, c.eventVersion, [A.prepaid]]);
  await je(pool, C, '2025-02-01', [[A.util, 10000], [A.prepaid, -10000]]);
  await bind(pool, C, y25, A.util, 'activity', [{ treatment: 'statement_row', destination: 'f1065.p1.21' }]);
  const first = await takeWorkingRevision(pool, { ...C, returnId: y25, takenBy: 'tester' });
  const frozen = (await getRevision(pool, { ...C, returnId: y25, revisionNo: first.revisionNo })).inputs.decisions.find(d => d.id === Number(saved.review_id));
  assert.deepEqual([frozen?.returnId, frozen?.kind, frozen?.sources, frozen?.domains, frozen?.reason], [y24, 'prepaid_expense', [A.prepaid], ['income'], 'Insurance paid a year ahead'], 'the earlier decision this period consumed, whole, source unchanged');
  await pool.query(`UPDATE txn SET memo = 'edited' WHERE txn_id = $1`, [paid]);
  const d = await driftOf(pool, { ...C, returnId: y25 });
  assert.deepEqual(d.amount, [], 'the entry was already held: no amount moves');
  assert.ok(d.provenance.includes('cash') || d.provenance.includes('transactions'), JSON.stringify(d));
  await clearTimingReview(pool, { ...C, returnId: y24, reviewId: saved.review_id });
  const again = await getRevision(pool, { ...C, returnId: y25, revisionNo: first.revisionNo });
  assert.equal(again.inputs.decisions.find(x => x.id === Number(saved.review_id))?.reason, 'Insurance paid a year ahead', 'the old revision keeps the cleared decision');
  assert.ok((await driftOf(pool, { ...C, returnId: y25 })).amount.some(x => x.key === 'f1065.p1.21|activity' && x.was === null && x.now === '10000'), 'cleared: the deduction appears, as drift against the revision');
});

test('the payment behind a consumed prepayment decision is frozen as it is now, present or absent (Codex t3-plan-r7 R7-4): its current legs all outside coverage, its version, postings and context in the revision; an equal-amount edit is provenance drift; voided or deleted it is listed absent; cleared, the hold goes; both forms', async () => {
  const { expense, deposit } = await import('./tax-t3-fixtures.js');
  const { cashRecognition, clearTimingReview } = await import('../lib/tax/cash.js');
  const { computeReturn } = await import('../lib/tax/engine/compute.js');
  for (const [rt, f] of [['form_1065', { other: 'f1065.p1.21', prepaid: 'f1065.L.6', cash: 'f1065.L.1', re: 'f1065.L.21', sales: 'f1065.p1.1a', suffix: 'Partners' }], ['form_1120s', { other: 'f1120s.p1.20', prepaid: 'f1120s.L.6', cash: 'f1120s.L.1', re: 'f1120s.L.24', sales: 'f1120s.p1.1a', suffix: 'Corp' }]]) {
    for (const end of ['deleted', 'voided']) {
      const what = `${rt} ${end}`;
      const C = { orgId, entityId: await company(pool, orgId, `Larch ${end} ${f.suffix}`) };
      const y25 = await period(pool, C, 2025, rt, { taxMethod: 'cash' });
      const y24 = Number(await openPeriod(pool, { ...C, year: 2024, actor: 'tester' }));
      const A = { bank: await acct(pool, C, 'Checking'), old: await acct(pool, C, 'Old Bank', 'bank'), sales: await acct(pool, C, 'Services'), util: await acct(pool, C, 'Utilities'),
        prepaid: await acct(pool, C, 'Prepaid Expenses'), other: await acct(pool, C, 'Prepaid Insurance', 'other_current_asset'), re: await acct(pool, C, 'Retained Earnings') };
      await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 50000]]);
      const paid = await expense(pool, C, '2024-11-01', A.old, [[A.prepaid, 10000]]);
      await pool.query(`UPDATE txn SET memo = 'insurance, paid ahead' WHERE txn_id = $1`, [paid]);
      const c = (await cashRecognition(pool, { orgId, ret: { return_id: y24, entity_id: C.entityId, period_start: '2024-01-01', period_end: '2024-12-31', tax_method: 'cash' } })).candidates.find(x => x.txnId === paid);
      const { rows: [saved] } = await pool.query(`INSERT INTO cash_timing_review (org_id, return_id, source_entity_id, txn_id, kind, decision, slot_key, cents, txn_version, event_version, affected_accounts, affected_domains, source_accounts, reviewed_by, reason)
        VALUES ($1,$2,$3,$4,'prepaid_expense','include',$5,10000,$6,$7,'{}','{income}',$8,'tester','Insurance paid a year ahead') RETURNING review_id`, [orgId, y24, C.entityId, paid, `${f.other}|activity`, c.txnVersion, c.eventVersion, [A.prepaid]]);
      // The payment recategorized to another prepaid account, which is cleared back before this period: the old bank and that account end 2024
      // at zero with nothing in 2025 — out of this return's coverage — while a 2025 entry still uses the SAVED account.
      await pool.query('UPDATE posting SET account_id = $2 WHERE txn_id = $1 AND account_id = $3', [paid, A.other, A.prepaid]);
      await je(pool, C, '2024-12-20', [[A.old, 10000], [A.other, -10000]]);
      await je(pool, C, '2025-02-01', [[A.util, 10000], [A.prepaid, -10000]]);
      await bindBalance(pool, C, y25, A.bank, f.cash);
      await bindBalance(pool, C, y25, A.re, f.re);
      await bind(pool, C, y25, A.prepaid, 'end', [{ treatment: 'statement_row', destination: f.prepaid }]);
      await bind(pool, C, y25, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
      await bind(pool, C, y25, A.util, 'activity', [{ treatment: 'statement_row', destination: f.other }]);
      await answerTypedItems(pool, C, y25);
      let r = await computeReturn(pool, { ...C, returnId: y25 });
      assert.ok(!r.cov.sources[0].accounts.some(a => [A.old, A.other].includes(a.accountId)), `${what}: the payment's current accounts are outside coverage`);
      assert.deepEqual(r.fields.find(x => x.key === `${f.other}|activity`)?.status, 'unresolved', `${what}: the entry is held (the payment no longer pays into the saved account)`);
      const first = await takeWorkingRevision(pool, { ...C, returnId: y25, takenBy: 'tester' });
      const one = await getRevision(pool, { ...C, returnId: y25, revisionNo: first.revisionNo });
      const v1 = one.source_detail.transactions.find(([id]) => id === paid);
      assert.ok(v1 && v1[1], `${what}: the payment and its current version are frozen`);
      const ctx1 = one.source_detail.contexts.find(x => x.id === paid);
      assert.deepEqual([ctx1?.type, ctx1?.date, ctx1?.memo], ['expense', '2024-11-01', 'insurance, paid ahead'], `${what}: and its context as it is now`);
      assert.ok(one.source_detail.documents.some(([id, legs]) => id === paid && legs.some(([acc]) => acc === A.other)), `${what}: and its current postings`);
      assert.ok(one.inputs.decisions.some(d => d.id === Number(saved.review_id) && d.sources?.[0] === A.prepaid), `${what}: the original decision frozen separately`);
      await pool.query(`UPDATE txn SET memo = 'insurance, paid ahead (policy 2025)' WHERE txn_id = $1`, [paid]);
      const d = await driftOf(pool, { ...C, returnId: y25 });
      assert.deepEqual(d.amount, [], `${what}: an equal-amount edit moves no amount`);
      assert.ok(d.provenance.includes('transactions'), `${what}: ${JSON.stringify(d.provenance)}`);
      const second = await takeWorkingRevision(pool, { ...C, returnId: y25, takenBy: 'tester' });
      assert.equal((await getRevision(pool, { ...C, returnId: y25, revisionNo: first.revisionNo })).source_detail.contexts.find(x => x.id === paid).memo, 'insurance, paid ahead', `${what}: the old revision keeps the earlier context`);
      if (end === 'deleted') { await pool.query('DELETE FROM posting WHERE txn_id = $1', [paid]); await pool.query('DELETE FROM txn WHERE txn_id = $1', [paid]); }
      else await pool.query('UPDATE txn SET voided_at = now(), total_cents = 0, open_cents = 0 WHERE txn_id = $1', [paid]); // voided as the ledger records it (an expense has no customer void path)
      r = await computeReturn(pool, { ...C, returnId: y25 });
      assert.equal(r.fields.find(x => x.key === `${f.other}|activity`)?.status, 'unresolved', `${what}: still held`);
      const third = await takeWorkingRevision(pool, { ...C, returnId: y25, takenBy: 'tester' });
      const gone = await getRevision(pool, { ...C, returnId: y25, revisionNo: third.revisionNo });
      assert.ok(end === 'deleted' ? gone.source_detail.absent.includes(paid) : gone.source_detail.contexts.find(x => x.id === paid)?.voided === true, `${what}: its absence is explicit`);
      assert.ok(gone.source_detail.transactions.some(([id, v]) => id === paid && v === null), `${what}: no current version`);
      assert.notEqual(gone.dependency_manifest.transactions, (await getRevision(pool, { ...C, returnId: y25, revisionNo: second.revisionNo })).dependency_manifest.transactions, `${what}: hashed`);
      await clearTimingReview(pool, { ...C, returnId: y24, reviewId: saved.review_id });
      r = await computeReturn(pool, { ...C, returnId: y25 });
      assert.deepEqual([r.fields.find(x => x.key === `${f.other}|activity`)?.cents, r.fields.find(x => x.key === `${f.other}|activity`)?.status], ['10000', 'complete'], `${what}: cleared, deducted once`);
    }
  }
});

test('a revision freezes the raw legs of each closing candidate (Codex t3-r1 note 2): a mixed closing’s exact account and line amounts stay readable after the entry is replaced, though the normalized measurements never held them; the replacement is provenance drift', async () => {
  const { classifyEntry, closingCandidates } = await import('../lib/tax/classify.js');
  const W = { orgId, entityId: await company(pool, orgId, 'Willow Partners') };
  const wRet = await period(pool, W, 2025, 'form_1065', { taxMethod: 'accrual' });
  const B = { bank: await acct(pool, W, 'Checking'), svc: await acct(pool, W, 'Services'), wages: await acct(pool, W, 'Wages'), re: await acct(pool, W, 'Retained Earnings'), prepaid: await acct(pool, W, 'Prepaid Expenses') };
  await je(pool, W, '2025-02-01', [[B.bank, 90000], [B.svc, -90000]]);
  await je(pool, W, '2025-03-01', [[B.wages, 30000], [B.bank, -30000]]);
  // A mixed journal: the closing of income and expense into retained earnings, plus a genuine correction (a prepaid) that stays.
  const close = await je(pool, W, '2025-12-31', [[B.svc, 90000], [B.wages, -30000], [B.re, -60000], [B.prepaid, 5000], [B.bank, -5000]], { memo: 'closing and correction' });
  await bindBalance(pool, W, wRet, B.bank, 'f1065.L.1');
  await bind(pool, W, wRet, B.prepaid, 'end', [{ treatment: 'statement_row', destination: 'f1065.L.6' }]);
  await bindBalance(pool, W, wRet, B.re, 'f1065.L.21');
  await bind(pool, W, wRet, B.re, 'activity', [{ treatment: 'not_tax', memo: 'closing entries only' }]);
  await bind(pool, W, wRet, B.svc, 'activity', [{ treatment: 'input', destination: 'f1065.p1.1a' }]);
  await bind(pool, W, wRet, B.wages, 'activity', [{ treatment: 'input', destination: 'f1065.p1.9' }]);
  await answerTypedItems(pool, W, wRet);
  const RP = { return_id: wRet, entity_id: W.entityId, period_start: '2025-01-01', period_end: '2025-12-31' };
  const c = (await closingCandidates(pool, { orgId, ret: RP })).find(x => x.txnId === close);
  await classifyEntry(pool, { ...W, returnId: wRet, txnId: close, cls: 'closing', lines: c.proposed, expectTxnVersion: c.txnVersion, reviewedBy: 'tester' });
  const { revisionNo } = await takeWorkingRevision(pool, { ...W, returnId: wRet, takenBy: 'tester' });
  const saved = await getRevision(pool, { ...W, returnId: wRet, revisionNo });
  const frozen = saved.inputs.classifications.find(x => x.txnId === close);
  assert.deepEqual(frozen.legs.map(l => [l.lineNo, l.accountId, l.cents]).sort((a, b) => a[0] - b[0]), [[1, B.svc, '90000'], [2, B.wages, '-30000'], [3, B.re, '-60000'], [4, B.prepaid, '5000'], [5, B.bank, '-5000']], 'every raw leg, the correction too');
  assert.deepEqual(frozen.decision.lines, [1, 2, 3], 'the closing subset');
  assert.equal(frozen.date, '2025-12-31');
  assert.match(frozen.docNumber, /^JE-\d+$/, 'the entry’s number as it was');
  // The normalized postings the revision measured hold no closing leg: the frozen legs are the only record of the exact amounts.
  assert.ok(!(saved.source_detail.postings[String(B.svc)] ?? []).some(p => p[0] === close), 'the closing leg is not among the normalized postings');
  assert.ok(saved.dependency_manifest.classifications, 'hashed');
  // The entry replaced by one with other figures: the old revision still shows the legs as they were; the live manifest drifts.
  await pool.query('DELETE FROM posting WHERE txn_id = $1', [close]);
  await pool.query('DELETE FROM txn WHERE txn_id = $1', [close]);
  const again = await je(pool, W, '2025-12-31', [[B.svc, 90000], [B.wages, -30000], [B.re, -60000]], { memo: 'closing, posted again' });
  const c2 = (await closingCandidates(pool, { orgId, ret: RP })).find(x => x.txnId === again);
  await classifyEntry(pool, { ...W, returnId: wRet, txnId: again, cls: 'closing', lines: c2.proposed, expectTxnVersion: c2.txnVersion, reviewedBy: 'tester' });
  await (await import('../lib/tax/classify.js')).clearClassification(pool, { ...W, returnId: wRet, txnId: close });
  const kept = await getRevision(pool, { ...W, returnId: wRet, revisionNo });
  assert.equal(kept.inputs.classifications.find(x => x.txnId === close).legs.length, 5, 'the old revision keeps the replaced entry’s legs');
  const drift = await driftOf(pool, { ...W, returnId: wRet });
  assert.ok(drift.provenance.includes('classifications'), JSON.stringify(drift.provenance));
});
