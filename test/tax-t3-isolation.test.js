// test/tax-t3-isolation.test.js — T3's reach (spec §11, §12): nothing T3 does writes to the ledger (postings, transactions and applications
// hash the same after every T3 write and computation); forged ids of another company or organization are refused by the modules.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { t2Db, company, acct, je, period, activity, bind, bindBalance, compute, answerTypedItems, invoice, payment } from './tax-t3-fixtures.js';
import { saveManualItem } from '../lib/tax/manual.js';
import { saveAdjustment, answerProposal } from '../lib/tax/adjustments.js';
import { classifyEntry, closingCandidates } from '../lib/tax/classify.js';
import { saveTimingReview, cashRecognition } from '../lib/tax/cash.js';
import { saveWorkpaper } from '../lib/tax/cogs.js';
import { takeWorkingRevision, driftOf } from '../lib/tax/engine/revision.js';
import { computeIn } from '../lib/tax/engine/compute.js';

let t, pool, orgId, M, ret, A, other, cand;
before(async () => {
  t = await t2Db(); pool = t.pool; orgId = t.orgId;
  M = { orgId, entityId: await company(pool, orgId, 'Maple Partners') };
  ret = await period(pool, M, 2025, 'form_1065', { taxMethod: 'cash' });
  A = {};
  for (const n of ['Checking', 'Services', 'Meals', 'Retained Earnings', 'Accounts Receivable (A/R)']) A[n] = await acct(pool, M, n);
  A.act = await activity(pool, M, { name: 'Maple trade' });
  A.inv = await invoice(pool, M, '2025-02-01', [[A.Services, 40000]]);
  A.adv = await payment(pool, M, '2025-12-20', 9000, A.Checking);
  await payment(pool, M, '2025-02-10', 40000, A.Checking, [[A.inv, 40000, '2025-02-10']]);
  await je(pool, M, '2025-03-01', [[A.Meals, 2000], [A.Checking, -2000]]);
  A.close = await je(pool, M, '2025-12-31', [[A.Meals, -2000], [A['Retained Earnings'], 2000]]);
  await bindBalance(pool, M, ret, A.Checking, 'f1065.L.1');
  await bind(pool, M, ret, A['Retained Earnings'], 'end', [{ treatment: 'input', destination: 'f1065.L.21' }]);
  await bind(pool, M, ret, A.Services, 'activity', [{ treatment: 'input', destination: 'f1065.p1.1a' }]);
  await bind(pool, M, ret, A.Meals, 'activity', [{ treatment: 'statement_row', destination: 'f1065.p1.21' }]);
  await answerTypedItems(pool, M, ret);
  const { rows: [o] } = await pool.query(`INSERT INTO org (slug, name) VALUES ('t3_iso', 'Isolation Sample Org') RETURNING org_id`);
  other = { orgId: Number(o.org_id) };
  other.entityId = await company(pool, other.orgId, 'Other Org Partners');
  other.ret = await period(pool, other, 2025, 'form_1065');
  other.bank = await acct(pool, other, 'Checking');
  other.txn = await je(pool, other, '2025-02-01', [[other.bank, 100], [await acct(pool, other, 'Services'), -100]]);
  other.act = await activity(pool, other, { name: 'Other trade' });
});
after(async () => { await t.db.drop(); });

// Every posting (id, transaction, account, cents, date), every transaction's version, and every application with BOTH its endpoints (the
// credit and the charge it applies to), its amount and date (Codex t3-r1 note 3).
const ledgerHash = async () => (await pool.query(`SELECT
  md5(coalesce((SELECT string_agg(posting_id || ':' || txn_id || ':' || account_id || ':' || amount_cents || ':' || txn_date, ',' ORDER BY posting_id) FROM posting), '')) AS postings,
  md5(coalesce((SELECT string_agg(txn_id || ':' || txn_version(txn_id), ',' ORDER BY txn_id) FROM txn), '')) AS txns,
  md5(coalesce((SELECT string_agg(application_id || ':' || credit_txn_id || ':' || charge_txn_id || ':' || amount_cents || ':' || applied_on, ',' ORDER BY application_id) FROM application), '')) AS applications`)).rows[0];

test('T3 does not write to the ledger: each write path exercised here (a closing classified and cleared, a timing review saved and cleared, a typed item saved and cleared, an adjustment added and withdrawn, a proposal answered, a COGS workpaper saved, a movement classified and cleared, a working revision, drift) leaves postings, transactions and applications as they were', async () => {
  const { clearClassification } = await import('../lib/tax/classify.js');
  const { clearTimingReview } = await import('../lib/tax/cash.js');
  const { clearManualItem } = await import('../lib/tax/manual.js');
  const { withdrawAdjustment, listAdjustments } = await import('../lib/tax/adjustments.js');
  const { classifyMovement, clearMovement } = await import('../lib/tax/cogs.js');
  const { rawTxn } = await import('./tax-t3-fixtures.js');
  // An inventory purchase routed to the workpaper, so a movement class is among the writes.
  A.inv = await acct(pool, M, 'Inventory Asset');
  A.purchase = await rawTxn(pool, M, 'bill', '2025-05-01', [[A.inv, 3000], [await acct(pool, M, 'Accounts Payable (A/P)'), -3000]]);
  await bind(pool, M, ret, A.inv, 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.2', activityId: A.act }]);
  const before = await ledgerHash();
  const S = { ...M, returnId: ret };
  const R = { return_id: ret, entity_id: M.entityId, period_start: '2025-01-01', period_end: '2025-12-31', tax_method: 'cash' };
  const each = async () => { assert.deepEqual(await ledgerHash(), before); };
  cand = (await closingCandidates(pool, { orgId, ret: R }))[0];
  await classifyEntry(pool, { ...S, txnId: A.close, cls: 'closing', lines: cand.proposed, expectTxnVersion: cand.txnVersion, reviewedBy: 'tester' });
  await clearClassification(pool, { ...S, txnId: A.close });
  await classifyEntry(pool, { ...S, txnId: A.close, cls: 'closing', lines: cand.proposed, expectTxnVersion: cand.txnVersion, reviewedBy: 'tester' });
  await each();
  const adv = (await cashRecognition(pool, { orgId, ret: R })).candidates.find(c => c.txnId === A.adv);
  await saveTimingReview(pool, { ...S, txnId: A.adv, kind: 'refundable_deposit', decision: 'exclude', expectTxnVersion: adv.txnVersion, expectEventVersion: adv.eventVersion, reviewedBy: 'tester' });
  const saved = (await cashRecognition(pool, { orgId, ret: R })).candidates.find(c => c.txnId === A.adv);
  await clearTimingReview(pool, { ...S, reviewId: saved.review.review_id });
  await saveTimingReview(pool, { ...S, txnId: A.adv, kind: 'refundable_deposit', decision: 'exclude', expectTxnVersion: adv.txnVersion, expectEventVersion: adv.eventVersion, reviewedBy: 'tester' });
  await each();
  await saveManualItem(pool, { ...S, itemKey: 'f1065.p1.16a|activity', status: 'entered', amount: '10.00', enteredBy: 'tester' });
  await clearManualItem(pool, { ...S, itemKey: 'f1065.p1.16a|activity' });
  await saveManualItem(pool, { ...S, itemKey: 'f1065.p1.16a|activity', status: 'entered', amount: '10.00', enteredBy: 'tester' });
  await each();
  await saveAdjustment(pool, { ...S, purpose: 'other', memo: 'Sample', evidence: 'Sample workpaper', lines: [{ slotKey: 'f1065.p1.21|activity', amount: '1.00', m1Class: 'other' }], decidedBy: 'tester' });
  const g = (await listAdjustments(pool, { orgId, returnId: ret })).find(x => x.source === 'person');
  await withdrawAdjustment(pool, { ...S, groupId: g.group_id, reason: 'Sample withdrawal', decidedBy: 'tester' });
  await saveAdjustment(pool, { ...S, purpose: 'other', memo: 'Sample', evidence: 'Sample workpaper', lines: [{ slotKey: 'f1065.p1.21|activity', amount: '1.00', m1Class: 'other' }], decidedBy: 'tester' });
  await each();
  let r = await compute(pool, M, ret);
  for (const p of r.proposals) await answerProposal(pool, { ...S, key: p.key, version: p.version, decision: 'accept', decidedBy: 'tester', compute: computeIn });
  await saveWorkpaper(pool, { ...S, activityId: A.act, path: 'reconstruct', treatment: 'inventory_as_booked', method: 'cost', begin: '0', end: '0', reviewedBy: 'tester' });
  r = await compute(pool, M, ret);
  const m = r.cogs.get(A.act).movements.find(x => x.txnId === A.purchase);
  await classifyMovement(pool, { ...S, accountId: A.inv, txnId: A.purchase, lineNo: m.lineNo, cls: 'transfer', expectTxnVersion: m.txnVersion, reviewedBy: 'tester', reason: 'Sample transfer' });
  await clearMovement(pool, { ...S, accountId: A.inv, txnId: A.purchase, lineNo: m.lineNo });
  await each();
  await takeWorkingRevision(pool, { ...S, takenBy: 'tester' });
  await driftOf(pool, S);
  await compute(pool, M, ret);
  await each();
});

test('forged ids of another company or organization are refused by the modules', async () => {
  const S = { ...M, returnId: ret };
  await assert.rejects(classifyEntry(pool, { ...S, txnId: other.txn, cls: 'normal', expectTxnVersion: 'x', reviewedBy: 'tester' }), /not a journal entry of this period/);
  await assert.rejects(saveTimingReview(pool, { ...S, txnId: other.txn, kind: 'related_party_accrual', decision: 'exclude', expectTxnVersion: 'x', reviewedBy: 'tester' }), /not found in this company’s books/);
  await assert.rejects(saveWorkpaper(pool, { ...S, activityId: other.act, path: 'reconstruct', treatment: 'inventory_as_booked', method: 'cost', reviewedBy: 'tester' }), /Activity not found on this return/);
  await assert.rejects(saveManualItem(pool, { ...M, returnId: other.ret, itemKey: 'f1065.p1.6|activity', status: 'not_applicable', enteredBy: 'tester' }), /Period not found/);
  await assert.rejects(saveManualItem(pool, { ...other, returnId: ret, itemKey: 'f1065.p1.6|activity', status: 'not_applicable', enteredBy: 'tester' }), /Period not found|Company not found/);
  assert.equal(await compute(pool, { orgId: other.orgId, entityId: M.entityId }, ret), null);
  // A destination naming another company's activity (same organization or another), or none at all, is refused (Codex t3-plan-r1 B9).
  const R = { return_id: ret, entity_id: M.entityId, period_start: '2025-01-01', period_end: '2025-12-31', tax_method: 'cash' };
  const adv = (await cashRecognition(pool, { orgId, ret: R })).candidates.find(c => c.txnId === A.adv);
  const sibling = { orgId, entityId: await company(pool, orgId, 'Maple Sibling Partners') };
  await period(pool, sibling, 2025, 'form_1065');
  const siblingAct = await activity(pool, sibling, { name: 'Sibling rental', kind: 'rental', schedule: 'f8825' });
  for (const a of [siblingAct, other.act, 999999999]) {
    await assert.rejects(saveTimingReview(pool, { ...S, txnId: A.adv, kind: 'unrestricted_advance', decision: 'include', slotKey: `f8825.main.2a|activity=act:${a}|activity`, amount: '90.00',
      expectTxnVersion: adv.txnVersion, expectEventVersion: adv.eventVersion, reviewedBy: 'tester' }), /is not an activity of this company/);
    await assert.rejects(saveAdjustment(pool, { ...S, purpose: 'other', memo: 'Sample', evidence: 'Sample workpaper', decidedBy: 'tester', lines: [{ slotKey: `f8825.main.3|activity=act:${a}|activity`, amount: '1.00', m1Class: 'other' }] }), /is not an activity of this company/);
  }
});
