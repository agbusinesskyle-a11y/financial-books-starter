// test/tax-classify.test.js — book entry classification (spec §4.12, §13.1 T3): a journal entry moving income or expense into equity is a
// candidate until a person decides; confirmed, its balanced closing subset is removed from every Tax Books measurement of the period with
// both legs (a genuine correction inside the same journal stays), the measurement names its new normalization (a dollar split saved on the
// books as posted turns stale), T1's packet boundary takes the current normalization only, and an entry changed after it was classified
// makes the decision stale (nothing removed).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { t2Db, company, acct, je, lineOf, period, bind, bindBalance } from './tax-t3-fixtures.js';
import { classifyEntry, closingCandidates, clearClassification, blockedByCandidates } from '../lib/tax/classify.js';
import { coverage, allocationOwners } from '../lib/tax/coverage.js';
import { currentPartition } from '../lib/tax/manifest.js';
import { toPacketParts } from '../lib/tax/partition.js';
import { assignPacket } from '../lib/tax/providers.js';
import { ValidationError } from '../lib/data/writes.js';

let t, pool, orgId, E, ret, A, closing;
const R = () => ({ return_id: ret, entity_id: E.entityId, period_start: '2025-01-01', period_end: '2025-12-31' });
const accountOf = async id => (await coverage(pool, { ...E, returnId: ret })).sources[0].accounts.find(a => a.accountId === id);
const candidate = async () => (await closingCandidates(pool, { orgId, ret: R() }))[0];
before(async () => {
  t = await t2Db(); pool = t.pool; orgId = t.orgId;
  E = { orgId, entityId: await company(pool, orgId, 'Elm Partners') };
  ret = await period(pool, E, 2025, 'form_1065', { taxMethod: 'accrual' });
  A = {};
  for (const n of ['Checking', 'Services', 'Wages', 'Retained Earnings', 'Prepaid Expenses']) A[n] = await acct(pool, E, n);
  await je(pool, E, '2025-02-01', [[A.Checking, 90000], [A.Services, -90000]]);
  await je(pool, E, '2025-03-01', [[A.Wages, 30000], [A.Checking, -30000]]);
  // A preparer's year-end entry: closes income and expense into retained earnings AND corrects a prepayment booked as cash (a mixed journal).
  closing = await je(pool, E, '2025-12-31', [[A.Services, 90000], [A.Wages, -30000], [A['Retained Earnings'], -60000], [A['Prepaid Expenses'], 5000], [A.Checking, -5000]], { memo: 'closing and correction' });
  await bindBalance(pool, E, ret, A.Checking, 'f1065.L.1');
  await bind(pool, E, ret, A.Wages, 'activity', [{ treatment: 'input', destination: 'f1065.p1.9' }]);
});
after(async () => { await t.db.drop(); });

test('a journal entry closing income and expense into equity is a candidate, with its balanced closing subset proposed; undecided, it blocks what it touches', async () => {
  const c = await candidate();
  assert.equal(c.txnId, closing);
  assert.equal(c.state, 'open');
  assert.deepEqual(c.proposed, [await lineOf(pool, closing, A.Services), await lineOf(pool, closing, A.Wages), await lineOf(pool, closing, A['Retained Earnings'])].sort((a, b) => a - b));
  assert.equal(c.balanced, true);
  assert.deepEqual([...blockedByCandidates([c]).keys()].sort((a, b) => a - b), [A.Services, A.Wages, A['Retained Earnings']].sort((a, b) => a - b), 'not the correction’s accounts');
  assert.equal((await accountOf(A.Services)).activity, 0n, 'as posted, the closing cancels the year’s income');
});

test('refused: an unbalanced subset, a line that is not income, expense or equity, the tax-only and opening classes, a changed entry', async () => {
  const c = await candidate(), [s, w, re] = c.proposed;
  const go = (extra = {}) => classifyEntry(pool, { ...E, returnId: ret, txnId: closing, cls: 'closing', lines: [s, w, re], expectTxnVersion: c.txnVersion, reviewedBy: 'tester', ...extra });
  await assert.rejects(go({ lines: [s, re] }), e => e instanceof ValidationError && /do not balance/.test(e.message));
  await assert.rejects(go({ lines: [s, w, re, await lineOf(pool, closing, A['Prepaid Expenses'])] }), /not an income, expense or equity line/);
  await assert.rejects(go({ cls: 'tax_only' }), /not classified in this stage/);
  await assert.rejects(go({ cls: 'opening' }), /not classified in this stage/);
  await assert.rejects(go({ expectTxnVersion: 'stale' }), /changed since the page was shown/);
  await assert.rejects(go({ reviewedBy: '' }), /Say who decided/);
});

test('confirmed: both legs of the closing subset leave the measurement, the correction stays, and the measurement names its normalization', async () => {
  const c = await candidate();
  await classifyEntry(pool, { ...E, returnId: ret, txnId: closing, cls: 'closing', lines: c.proposed, expectTxnVersion: c.txnVersion, reviewedBy: 'tester' });
  assert.equal((await candidate()).state, 'decided');
  const services = await accountOf(A.Services), wages = await accountOf(A.Wages), re = await accountOf(A['Retained Earnings']), prepaid = await accountOf(A['Prepaid Expenses']);
  assert.deepEqual([services.activity, wages.activity, re?.activity ?? 0n, prepaid.end], [-90000n, 30000n, 0n, 5000n]);
  assert.match(services.normalization, /^closings:[0-9a-f]{32}$/);
  assert.notEqual(services.versions.activity, (await accountOf(A.Checking)).versions.activity);
});

test('the T1 packet boundary takes the return’s current normalization: a packet built on the books as posted is refused, the current one is published', async () => {
  await bind(pool, E, ret, A.Services, 'activity', [{ treatment: 'input', destination: 'f1065.p1.1a' }]);
  const cov = await coverage(pool, { ...E, returnId: ret });
  const services = cov.sources[0].accounts.find(a => a.accountId === A.Services);
  const cur = await currentPartition(pool, { orgId, returnId: ret, sourceEntityId: E.entityId, accountId: A.Services, measurement: 'activity' });
  assert.equal(cur.measured.normalization, services.normalization);
  const owners = allocationOwners(cov);
  const parts = toPacketParts(services.results.activity, { provider: 'books', ownerOf: x => owners.get(`${E.entityId}/${A.Services}/activity/${x.kind}:${x.id}`), measured: cur.measured, lines: cur.lines, approved: cur.approved });
  const request = { returnId: ret, revisionContext: 'working', slots: ['f1065.p1.1a|activity'], period: { start: '2025-01-01', end: '2025-12-31' }, method: 'accrual', bookBasis: 'accrual' };
  const packet = { providerKind: 'books', schemaVersion: 1, sourceVersion: 'books@t3', sourceRefs: parts.sourceRefs, completeness: 'complete', review: { state: 'unreviewed' },
    values: [{ slotKey: 'f1065.p1.1a|activity', amountCents: (-parts.cents).toString() }], relatedOutputs: [], consumedSlices: parts.consumedSlices };
  await assert.rejects(assignPacket(pool, { ...E, returnId: ret, request, packet: { ...packet, sourceRefs: parts.sourceRefs.map(x => ({ ...x, normalization: 'as_posted' })) } }), /rebuild it from the current measurement/);
  await assignPacket(pool, { ...E, returnId: ret, request, packet });
  await pool.query('DELETE FROM tax_provider_assignment WHERE org_id = $1 AND return_id = $2', [orgId, ret]);
});

test('a dollar split saved on the books as posted turns stale once a closing changes the normalization, and is saved again', async () => {
  await clearClassification(pool, { ...E, returnId: ret, txnId: closing });
  const asPosted = await accountOf(A.Wages);
  await bind(pool, E, ret, A.Wages, 'activity', [{ treatment: 'input', destination: 'f1065.p1.9', amount: '100.00' }, { treatment: 'statement_row', destination: 'f1065.p1.21', amount: '-100.00' }], { split: 'amounts', expectVersion: asPosted.results.activity.base });
  const c = await candidate();
  await classifyEntry(pool, { ...E, returnId: ret, txnId: closing, cls: 'closing', lines: c.proposed, expectTxnVersion: c.txnVersion, reviewedBy: 'tester' });
  assert.equal((await accountOf(A.Wages)).results.activity.status, 'stale');
  await bind(pool, E, ret, A.Wages, 'activity', [{ treatment: 'input', destination: 'f1065.p1.9' }]);
  assert.equal((await accountOf(A.Wages)).results.activity.status, 'complete');
});

test('an entry changed after it was classified: the decision is stale and removes nothing', async () => {
  await je(pool, E, '2025-12-31', [[A.Services, 90000], [A.Wages, -30000], [A['Retained Earnings'], -60000], [A['Prepaid Expenses'], 6000], [A.Checking, -6000]], { memo: 'closing and correction', txnId: closing });
  assert.equal((await candidate()).state, 'stale');
  const services = await accountOf(A.Services);
  assert.deepEqual([services.activity, services.normalization], [0n, 'as_posted']);
});

test('a preparer-numbered entry in the middle of the year is a candidate too (CJE, AJE, RJE — Codex t3-plan-r1 B16): a balanced closing subset is removed, a genuine correction stays as posted', async () => {
  const { PREPARER_NUMBER } = await import('../lib/tax/classify.js');
  assert.ok(!PREPARER_NUMBER.source.includes('\u0008'), 'the pattern holds the two characters \b, never a backspace');
  assert.deepEqual(['CJE-1', 'AJE 2', 'rje3', 'CPA 4', 'ADJ-5', 'JE-9', 'Ajen supplies', 'CJEX'].map(s => PREPARER_NUMBER.test(s)), [true, true, true, true, true, false, false, false]);
  const P = { orgId, entityId: await company(pool, orgId, 'Elm Midyear Partners') };
  const pRet = await period(pool, P, 2025, 'form_1065', { taxMethod: 'accrual' });
  const B = {};
  for (const n of ['Checking', 'Services', 'Wages', 'Retained Earnings']) B[n] = await acct(pool, P, n);
  await je(pool, P, '2025-02-01', [[B.Checking, 50000], [B.Services, -50000]]);
  await je(pool, P, '2025-03-01', [[B.Wages, 9000], [B.Checking, -9000]]);
  const numbered = async (date, legs, doc) => { const id = await je(pool, P, date, legs); await pool.query('UPDATE txn SET doc_number = $2 WHERE txn_id = $1', [id, doc]); return id; };
  const cje = await numbered('2025-06-30', [[B.Services, 20000], [B['Retained Earnings'], -20000]], 'CJE-1');
  const aje = await numbered('2025-07-15', [[B.Wages, 3000], [B['Retained Earnings'], -3000]], 'AJE 2');
  const rje = await numbered('2025-08-01', [[B['Retained Earnings'], 1000], [B.Services, -1000]], 'RJE3');
  await numbered('2025-09-01', [[B.Wages, 500], [B['Retained Earnings'], -500]], 'JE-9');
  const RP = { return_id: pRet, entity_id: P.entityId, period_start: '2025-01-01', period_end: '2025-12-31' };
  const cands = await closingCandidates(pool, { orgId, ret: RP });
  assert.deepEqual(cands.map(c => c.txnId).sort((a, b) => a - b), [cje, aje, rje].sort((a, b) => a - b), 'midyear preparer entries are candidates; an ordinary entry number is not');
  for (const [id, cls] of [[cje, 'closing'], [rje, 'closing'], [aje, 'correction']]) {
    const c = cands.find(x => x.txnId === id);
    assert.equal(c.balanced, true);
    await classifyEntry(pool, { ...P, returnId: pRet, txnId: id, cls, lines: cls === 'closing' ? c.proposed : [], expectTxnVersion: c.txnVersion, reviewedBy: 'tester' });
  }
  const accts = (await coverage(pool, { ...P, returnId: pRet })).sources[0].accounts;
  const of = id => accts.find(a => a.accountId === id);
  assert.equal(of(B.Services).activity, -50000n, 'both closings removed with both legs: the year’s services stand whole');
  assert.equal(of(B.Wages).activity, 12500n, 'the correction (and the ordinary entry) stay as posted');
  assert.equal(of(B['Retained Earnings']).activity, -3500n, 'only the kept entries’ equity legs remain');
});

test('a classified entry keeps its decision whatever it becomes (Codex t3-plan-r2 R2-2): renumbered to an ordinary number it is still listed, stale, and blocks what it touches; deleted, it is still listed', async () => {
  const P = { orgId, entityId: await company(pool, orgId, 'Elm Renumbered Partners') };
  const pRet = await period(pool, P, 2025, 'form_1065', { taxMethod: 'accrual' });
  const B = {};
  for (const n of ['Checking', 'Services', 'Retained Earnings']) B[n] = await acct(pool, P, n);
  await je(pool, P, '2025-02-01', [[B.Checking, 50000], [B.Services, -50000]]);
  const cje = await je(pool, P, '2025-06-30', [[B.Services, 20000], [B['Retained Earnings'], -20000]]);
  await pool.query(`UPDATE txn SET doc_number = 'CJE-1' WHERE txn_id = $1`, [cje]);
  const RP = { return_id: pRet, entity_id: P.entityId, period_start: '2025-01-01', period_end: '2025-12-31' };
  const c = (await closingCandidates(pool, { orgId, ret: RP })).find(x => x.txnId === cje);
  await classifyEntry(pool, { ...P, returnId: pRet, txnId: cje, cls: 'closing', lines: c.proposed, expectTxnVersion: c.txnVersion, reviewedBy: 'tester' });
  assert.equal((await coverage(pool, { ...P, returnId: pRet })).sources[0].accounts.find(a => a.accountId === B.Services).activity, -50000n);
  await pool.query(`UPDATE txn SET doc_number = 'JE-77' WHERE txn_id = $1`, [cje]);
  let cands = await closingCandidates(pool, { orgId, ret: RP });
  const now = cands.find(x => x.txnId === cje);
  assert.equal(now?.state, 'stale', 'no longer a candidate by its number, still listed with its decision');
  assert.ok(blockedByCandidates(cands).has(B.Services), 'what it touches is unknown until it is classified again, never silently back in');
  await classifyEntry(pool, { ...P, returnId: pRet, txnId: cje, cls: 'closing', lines: now.proposed, expectTxnVersion: now.txnVersion, reviewedBy: 'tester' });
  assert.equal((await closingCandidates(pool, { orgId, ret: RP })).find(x => x.txnId === cje).state, 'decided', 'classified again as it is now');
  await pool.query('DELETE FROM posting WHERE txn_id = $1', [cje]);
  await pool.query('DELETE FROM txn WHERE txn_id = $1', [cje]);
  cands = await closingCandidates(pool, { orgId, ret: RP });
  assert.deepEqual([cands.find(x => x.txnId === cje)?.state, cands.find(x => x.txnId === cje)?.lines.length], ['stale', 0], 'a deleted entry’s decision is still shown, to be cleared');
});

test('a classified entry moved into the year before can only be cleared (Codex t3-plan-r3 R3-1): reconfirmation refused, no historical line removed from any measurement', async () => {
  const { measureAccounts, closingExclusions } = await import('../lib/tax/measure.js');
  const P = { orgId, entityId: await company(pool, orgId, 'Elm Moved Partners') };
  const pRet = await period(pool, P, 2025, 'form_1065', { taxMethod: 'accrual' });
  const B = {};
  for (const n of ['Checking', 'Services', 'Retained Earnings']) B[n] = await acct(pool, P, n);
  await je(pool, P, '2024-03-01', [[B.Checking, 30000], [B.Services, -30000]]);
  await je(pool, P, '2025-02-01', [[B.Checking, 50000], [B.Services, -50000]]);
  const close = await je(pool, P, '2025-12-31', [[B.Services, 10000], [B['Retained Earnings'], -10000]]);
  const RP = { return_id: pRet, entity_id: P.entityId, period_start: '2025-01-01', period_end: '2025-12-31' };
  let c = (await closingCandidates(pool, { orgId, ret: RP })).find(x => x.txnId === close);
  await classifyEntry(pool, { ...P, returnId: pRet, txnId: close, cls: 'closing', lines: c.proposed, expectTxnVersion: c.txnVersion, reviewedBy: 'tester' });
  await pool.query(`UPDATE txn SET txn_date = '2024-12-31' WHERE txn_id = $1`, [close]);
  await pool.query(`UPDATE posting SET txn_date = '2024-12-31' WHERE txn_id = $1`, [close]);
  c = (await closingCandidates(pool, { orgId, ret: RP })).find(x => x.txnId === close);
  assert.deepEqual([c.state, c.eligible], ['stale', false]);
  await assert.rejects(classifyEntry(pool, { ...P, returnId: pRet, txnId: close, cls: 'closing', lines: c.proposed, expectTxnVersion: c.txnVersion, reviewedBy: 'tester' }), /can only be cleared/);
  assert.deepEqual((await closingExclusions(pool, { orgId, returnId: pRet, sourceEntityId: P.entityId })).keys, [], 'no historical line is removed');
  const normalized = await measureAccounts(pool, { orgId, sourceEntityId: P.entityId, periodStart: '2025-01-01', periodEnd: '2025-12-31', returnId: pRet });
  const asPosted = await measureAccounts(pool, { orgId, sourceEntityId: P.entityId, periodStart: '2025-01-01', periodEnd: '2025-12-31' });
  assert.equal(normalized.get(B['Retained Earnings']).begin, asPosted.get(B['Retained Earnings']).begin, 'retained earnings begins as the books measure the history');
  assert.ok(blockedByCandidates(await closingCandidates(pool, { orgId, ret: RP })).has(B.Services), 'and it is blocked until cleared');
  await clearClassification(pool, { ...P, returnId: pRet, txnId: close });
});
