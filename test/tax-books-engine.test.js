// test/tax-books-engine.test.js — book balances (spec §5.2, §13.1 T3): the exact BigInt measurements agree with lib/reports/statements.js
// (which adds Numbers) within the safe range; beginnings tie to the predecessor through reviewed openings, ACCOUNT BY ACCOUNT (Codex
// t3-plan-r1 B8) — unknown without one, zero for a verified first year, a line one account opens on tied on its own, a line several
// accounts open on only through an approved allocation (offsetting errors under one line are found), each allocation applied in its fact's
// own sign (a row-only liability baseline stays a credit), an allocation to an account the return does not map there — or one reviewed
// against another books beginning — unresolved, never skipped; and an accrual return's all-events gate (B2): accrual entries by shape, a
// bill selected for a related-party or economic-performance review, an exclusion as an engine adjustment and an M-1 difference, a decision
// on a bill whose amount or memo changed afterwards shown and unresolved until made again; no cash layer at all.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { t2Db, company, acct, je, period, bind, bindBalance, compute, valueOf, errorsOf, answerTypedItems, bill, scheduleLFacts } from './tax-t3-fixtures.js';
import { ledgerLines } from '../lib/reports/ledger-data.js';
import { trialBalance, profitAndLoss } from '../lib/reports/statements.js';
import { measureAccounts } from '../lib/tax/measure.js';
import { coverage } from '../lib/tax/coverage.js';
import { bookNetIncome, confirmOpeningBooks } from '../lib/tax/engine/books.js';
import { importBaseline, bridgeOpening } from '../lib/tax/baselines.js';
import { setPredecessor, saveProfile, openPeriod, verifyInitial } from '../lib/tax/periods.js';
import { saveTimingReview, accrualTiming } from '../lib/tax/cash.js';

let t, pool, orgId, I, ret, A;
before(async () => {
  t = await t2Db(); pool = t.pool; orgId = t.orgId;
  I = { orgId, entityId: await company(pool, orgId, 'Ivy Partners') };
  ret = await period(pool, I, 2025, 'form_1065', { taxMethod: 'accrual' });
  A = {};
  for (const n of ['Checking', 'Services', 'Wages', 'Retained Earnings', 'Utilities', 'Payroll Liabilities']) A[n] = await acct(pool, I, n);
  await je(pool, I, '2024-05-01', [[A.Checking, 100000], [A.Services, -100000]]);
  await je(pool, I, '2025-05-01', [[A.Checking, 40000], [A.Services, -40000]]);
  await je(pool, I, '2025-06-01', [[A.Wages, 15000], [A.Checking, -15000]]);
  await bindBalance(pool, I, ret, A.Checking, 'f1065.L.1');
  await bindBalance(pool, I, ret, A['Retained Earnings'], 'f1065.L.21');
  await bind(pool, I, ret, A.Services, 'activity', [{ treatment: 'input', destination: 'f1065.p1.1a' }]);
  await bind(pool, I, ret, A.Wages, 'activity', [{ treatment: 'input', destination: 'f1065.p1.9' }]);
  await answerTypedItems(pool, I, ret);
});
after(async () => { await t.db.drop(); });

test('the exact measurements agree with statements.js’s trial balance and profit and loss within the safe range', async () => {
  const m = await measureAccounts(pool, { orgId, sourceEntityId: I.entityId, periodStart: '2025-01-01', periodEnd: '2025-12-31', returnId: ret });
  const { rows: accounts } = await pool.query('SELECT account_id, name, number, type, parent_id, active FROM account WHERE org_id = $1 AND entity_id = $2', [orgId, I.entityId]);
  const accts = accounts.map(a => ({ ...a, account_id: Number(a.account_id) }));
  const lines = await ledgerLines(pool, { orgId, entityId: I.entityId, to: '2025-12-31' });
  const retained = accts.find(a => a.name === 'Retained Earnings').account_id;
  const tb = trialBalance({ accounts: accts, lines, asOf: '2025-12-31', retainedAccountId: retained, show: 'all' });
  for (const row of tb.rows.filter(r => r.kind === 'account')) {
    const x = m.get(row.accountId), want = BigInt(row.values[0] - row.values[1]);
    if (x.pl) assert.equal(x.activity, want, row.label);
    else if (row.accountId === retained) assert.equal(x.end, want, 'retained earnings at the year end before this year’s income');
    else assert.equal(x.end, want, row.label);
  }
  const pl = profitAndLoss({ accounts: accts, lines: lines.filter(l => l.date >= '2025-01-01'), columns: [{ from: '2025-01-01', to: '2025-12-31' }] });
  assert.equal(bookNetIncome(await coverage(pool, { ...I, returnId: ret })), BigInt(pl.totals.netIncome[0]));
});

test('openings: without a predecessor they are unknown; a verified first year begins at zero', async () => {
  let r = await compute(pool, I, ret);
  assert.deepEqual(errorsOf(r).map(c => c.code), ['openings_unknown']);
  const N = { orgId, entityId: await company(pool, orgId, 'Ivy New Co') };
  await saveProfile(pool, { ...N, fields: { returnType: 'form_1065', taxMethodDefault: 'accrual', bookBasisDefault: 'accrual', yearEndMonth: 12, dateStarted: '2025-01-01' }, reason: 'test', actor: 'tester' });
  const nRet = Number(await openPeriod(pool, { ...N, year: 2025, initial: true, actor: 'tester' }));
  await verifyInitial(pool, { ...N, returnId: nRet, verifiedBy: 'tester', evidence: 'Certificate of formation' });
  const nb = await acct(pool, N, 'Checking'), ns = await acct(pool, N, 'Services');
  await je(pool, N, '2025-03-01', [[nb, 5000], [ns, -5000]]);
  await bindBalance(pool, N, nRet, nb, 'f1065.L.1');
  await bind(pool, N, nRet, await acct(pool, N, 'Retained Earnings'), 'end', [{ treatment: 'input', destination: 'f1065.L.21' }]);
  await bind(pool, N, nRet, ns, 'activity', [{ treatment: 'input', destination: 'f1065.p1.1a' }]);
  await answerTypedItems(pool, N, nRet);
  r = await compute(pool, N, nRet);
  assert.deepEqual(errorsOf(r).map(c => c.code), [], 'a verified first year with nothing before it');
});

test('a predecessor baseline: each Schedule L line ties to last year’s filed ending; an approved bridge replaces the books beginning only at the amount it was reviewed against', async () => {
  const facts = (await scheduleLFacts('form_1065', [['f1065.L.1', '120000'], ['f1065.L.21', '120000']])).map(([fieldId, amountCents]) => ({ factKind: 'schedule_l_end', fieldId, measurement: 'end', effectiveOn: '2024-12-31', amountCents: String(amountCents), state: 'known',
    provenance: { page: 4 }, reviewStatus: 'verified' }));
  const b = await importBaseline(pool, { ...I, payload: { importKey: 'filed-2024', payloadVersion: 1, kind: 'imported_filed', returnType: 'form_1065', formEdition: 2024, bookBasis: 'accrual', consolidationPolicy: 'inclusion_edges',
    sourcePeriodStart: '2024-01-01', sourcePeriodEnd: '2024-12-31', sourceDocument: { hash: 'sha256:sample', pages: '1-5' }, extractionStatus: 'verified', facts }, actor: 'tester' });
  await setPredecessor(pool, { ...I, returnId: ret, baselineId: b.baselineId });
  let r = await compute(pool, I, ret);
  assert.deepEqual(errorsOf(r, 'openings_unexplained').map(c => c.message.slice(0, 4)), ['Cash', 'Part'], 'the books begin at 1,000.00; the filed return ended at 1,200.00');
  const { rows: fs } = await pool.query(`SELECT fact_id, field_id FROM baseline_fact WHERE baseline_id = $1`, [b.baselineId]);
  const fid = id => Number(fs.find(f => f.field_id === id).fact_id);
  await bridgeOpening(pool, { ...I, returnId: ret, factId: fid('f1065.L.1'), rows: [{ accountId: A.Checking, allocatedCents: '120000', explanation: 'Deposit in transit recorded by the preparer' }], approvedBy: 'tester' });
  await bridgeOpening(pool, { ...I, returnId: ret, factId: fid('f1065.L.21'), rows: [{ accountId: A['Retained Earnings'], allocatedCents: '120000', explanation: 'Same adjustment' }], approvedBy: 'tester' });
  r = await compute(pool, I, ret);
  assert.equal(errorsOf(r, 'openings_stale').length, 2, 'the books amount the difference was reviewed against is not recorded yet');
  for (const f of ['f1065.L.1', 'f1065.L.21']) await confirmOpeningBooks(pool, { ...I, returnId: ret, factId: fid(f), reviewedBy: 'tester' });
  r = await compute(pool, I, ret);
  for (const [k, v] of Object.entries({ 'f1065.L.1|begin': 120000n, 'f1065.L.21|begin': 120000n, 'f1065.L.1|end': 145000n, 'f1065.L.21|end': 145000n, 'f1065.L.14|end': 145000n, 'f1065.L.22|end': 145000n,
    'f1065.anal.1|activity': 25000n })) assert.equal(valueOf(r, k), v, k);
  assert.deepEqual(errorsOf(r).map(c => c.code), [], 'reviewed openings tie line by line');
  // The books beginning changes (a late 2024 entry): the reviewed difference no longer applies.
  await je(pool, I, '2024-12-15', [[A.Checking, 500], [A.Services, -500]]);
  r = await compute(pool, I, ret);
  assert.ok(errorsOf(r, 'openings_stale').length);
});

test('an accrual return: accrual entries by shape, bills selected for a related-party or economic-performance review; excluded, each is an engine adjustment and an M-1 difference; a decision on an edited bill is unresolved until made again; no cash layer', async () => {
  const J = { orgId, entityId: await company(pool, orgId, 'Juniper Outlet') };
  const jRet = await period(pool, J, 2025, 'form_1065', { taxMethod: 'accrual' });
  const bank = await acct(pool, J, 'Checking'), sales = await acct(pool, J, 'Services'), util = await acct(pool, J, 'Utilities'), accrued = await acct(pool, J, 'Payroll Liabilities');
  const rent = await acct(pool, J, 'Rent & Lease'), repairs = await acct(pool, J, 'Repairs & Maintenance');
  await je(pool, J, '2025-04-01', [[bank, 50000], [sales, -50000]]);
  const accrual = await je(pool, J, '2025-12-31', [[util, 3000], [accrued, -3000]]);
  const related = await bill(pool, J, '2025-12-20', [[rent, 6000]]);
  const notPerformed = await bill(pool, J, '2025-12-28', [[repairs, 1200]]);
  await bindBalance(pool, J, jRet, bank, 'f1065.L.1');
  await bind(pool, J, jRet, accrued, 'end', [{ treatment: 'statement_row', destination: 'f1065.L.17' }]);
  await bind(pool, J, jRet, await acct(pool, J, 'Accounts Payable (A/P)'), 'end', [{ treatment: 'input', destination: 'f1065.L.15' }]);
  await bind(pool, J, jRet, await acct(pool, J, 'Retained Earnings'), 'end', [{ treatment: 'input', destination: 'f1065.L.21' }]);
  await bind(pool, J, jRet, sales, 'activity', [{ treatment: 'input', destination: 'f1065.p1.1a' }]);
  await bind(pool, J, jRet, util, 'activity', [{ treatment: 'statement_row', destination: 'f1065.p1.21' }]);
  await bind(pool, J, jRet, rent, 'activity', [{ treatment: 'input', destination: 'f1065.p1.13' }]);
  await bind(pool, J, jRet, repairs, 'activity', [{ treatment: 'input', destination: 'f1065.p1.11' }]);
  await answerTypedItems(pool, J, jRet);
  const RJ = { return_id: jRet, entity_id: J.entityId, period_start: '2025-01-01', period_end: '2025-12-31', tax_method: 'accrual' };
  let gate = await accrualTiming(pool, { orgId, ret: RJ });
  const c = gate.candidates.find(x => x.txnId === accrual);
  assert.ok(c && !gate.candidates.some(x => x.txnId === related), 'the accrual entry by shape; the bills are not guessed at');
  assert.deepEqual(gate.selectable.bills.map(b => b.txnId).sort((a, b) => a - b), [related, notPerformed].sort((a, b) => a - b), 'the bills unpaid at the year end can be selected');
  let r = await compute(pool, J, jRet);
  assert.equal(r.cash, null, 'an accrual return never runs the cash layer');
  assert.equal(valueOf(r, 'f1065.p1.21|activity'), 3000n, 'the book accrual stands until reviewed (a draft default)');
  assert.ok(errorsOf(r, 'timing_open').length);
  const save = (txnId, kind, ev, extra = {}) => saveTimingReview(pool, { ...J, returnId: jRet, txnId, kind, decision: 'exclude', expectTxnVersion: ev.txnVersion, expectEventVersion: ev.eventVersion, reviewedBy: 'tester', ...extra });
  await save(accrual, 'imported_accrual_je', c, { reason: 'Economic performance in 2026' });
  const relatedEv = gate.selectable.bills.find(b => b.txnId === related), laterEv = gate.selectable.bills.find(b => b.txnId === notPerformed);
  await assert.rejects(save(related, 'related_party_accrual', { ...relatedEv, eventVersion: 'old' }), /changed since the page was shown/);
  await save(related, 'related_party_accrual', relatedEv, { reason: 'Owed to a related party, unpaid' });
  await save(notPerformed, 'economic_performance', laterEv, { reason: 'The repair is done in January' });
  await assert.rejects(save(await je(pool, J, '2025-06-01', [[bank, 100], [accrued, -100]]), 'related_party_accrual', { txnVersion: 'x', eventVersion: 'x' }), /changed since the page was shown|no income or expense/);
  r = await compute(pool, J, jRet);
  for (const [k, x] of Object.entries({ 'f1065.p1.21|activity': 0n, 'f1065.p1.13|activity': 0n, 'f1065.p1.11|activity': 0n, 'f1065.p1.23|activity': 50000n, 'f1065.m1.1|activity': 39800n, 'f1065.m1.4c|activity': 10200n, 'f1065.m1.9|activity': 50000n }))
    assert.equal(valueOf(r, k), x, k);
  assert.equal(r.bridge.residual, '0');
  assert.deepEqual(errorsOf(r, 'timing_open'), []);
  gate = await accrualTiming(pool, { orgId, ret: RJ });
  assert.equal(gate.candidates.find(x => x.txnId === related).state, 'decided', 'a selected bill stays listed with its decision');
  // The related-party bill's amount is edited after the decision: still shown, stale, and its line unresolved — never deducted by default.
  await pool.query('UPDATE posting SET amount_cents = amount_cents * 2 WHERE txn_id = $1', [related]);
  await pool.query('UPDATE txn SET total_cents = 12000 WHERE txn_id = $1', [related]);
  r = await compute(pool, J, jRet);
  assert.equal(r.timing.candidates.find(x => x.txnId === related).state, 'stale');
  assert.equal(valueOf(r, 'f1065.p1.13|activity'), null);
  assert.ok(errorsOf(r, 'timing_open').some(x => x.txnId === related));
  let now = (await accrualTiming(pool, { orgId, ret: RJ })).candidates.find(x => x.txnId === related);
  await save(related, 'related_party_accrual', now);
  assert.equal(valueOf(await compute(pool, J, jRet), 'f1065.p1.13|activity'), 0n, 'decided again');
  // Only its memo edited: still a different transaction than the one decided — stale again.
  await pool.query(`UPDATE txn SET memo = 'rent, December' WHERE txn_id = $1`, [related]);
  r = await compute(pool, J, jRet);
  assert.equal(r.timing.candidates.find(x => x.txnId === related).state, 'stale');
  assert.equal(valueOf(r, 'f1065.p1.13|activity'), null);
  now = (await accrualTiming(pool, { orgId, ret: RJ })).candidates.find(x => x.txnId === related);
  await save(related, 'related_party_accrual', now);
  assert.equal(valueOf(await compute(pool, J, jRet), 'f1065.p1.13|activity'), 0n);
});

// A filed baseline of Schedule L end facts (and row facts: [fieldId, cents, rowKey]).
const filed = async (C, given) => { const facts = await scheduleLFacts('form_1065', given); return importBaseline(pool, { ...C, payload: { importKey: `filed-2024-${C.entityId}`, payloadVersion: 1, kind: 'imported_filed', returnType: 'form_1065', formEdition: 2024, bookBasis: 'accrual',
  consolidationPolicy: 'inclusion_edges', sourcePeriodStart: '2024-01-01', sourcePeriodEnd: '2024-12-31', sourceDocument: { hash: 'sha256:sample', pages: '1-5' }, extractionStatus: 'verified',
  facts: facts.map(([fieldId, cents, rowKey = null]) => ({ factKind: 'schedule_l_end', fieldId, measurement: 'end', effectiveOn: '2024-12-31', amountCents: String(cents), state: 'known', rowKey, provenance: { page: 4 }, reviewStatus: 'verified' })) }, actor: 'tester' }); };
const factIds = async b => new Map((await pool.query('SELECT fact_id, field_id, row_key FROM baseline_fact WHERE baseline_id = $1', [b.baselineId])).rows.map(f => [`${f.field_id}${f.row_key ? `#${f.row_key}` : ''}`, Number(f.fact_id)]));

test('openings account by account: two accounts on one line need an allocation (a matching total is not a review — offsetting errors are found); a row-only liability keeps its credit sign', async () => {
  const K = { orgId, entityId: await company(pool, orgId, 'Kale Partners') };
  const kRet = await period(pool, K, 2025, 'form_1065', { taxMethod: 'accrual' });
  const A2 = {};
  for (const n of ['Checking', 'Services', 'Wages', 'Retained Earnings', 'Payroll Liabilities']) A2[n] = await acct(pool, K, n);
  A2.Savings = await acct(pool, K, 'Savings');
  await je(pool, K, '2024-03-01', [[A2.Checking, 70000], [A2.Services, -70000]]);
  await je(pool, K, '2024-03-02', [[A2.Savings, 30000], [A2.Services, -30000]]);
  await je(pool, K, '2024-12-31', [[A2.Wages, 2000], [A2['Payroll Liabilities'], -2000]]);
  await je(pool, K, '2025-05-01', [[A2.Checking, 5000], [A2.Services, -5000]]);
  for (const a of [A2.Checking, A2.Savings]) await bindBalance(pool, K, kRet, a, 'f1065.L.1');
  await bindBalance(pool, K, kRet, A2['Payroll Liabilities'], 'f1065.L.17', 'statement_row');
  await bindBalance(pool, K, kRet, A2['Retained Earnings'], 'f1065.L.21');
  await bind(pool, K, kRet, A2.Services, 'activity', [{ treatment: 'input', destination: 'f1065.p1.1a' }]);
  await answerTypedItems(pool, K, kRet);
  // Filed: cash 60,000 + 40,000 (the books have them the other way round, 70,000 and 30,000 — same total), accrued wages 2,500 (rows only), capital 97,500.
  const b = await filed(K, [['f1065.L.1', 100000], ['f1065.L.17', 2500, 'Accrued wages'], ['f1065.L.21', 97500]]);
  await setPredecessor(pool, { ...K, returnId: kRet, baselineId: b.baselineId });
  let r = await compute(pool, K, kRet);
  assert.ok(errorsOf(r, 'openings_unreviewed').some(c => /Cash: 2 accounts open on this line/.test(c.message)), 'a matching cash total is not an account-level review');
  const fid = await factIds(b);
  await bridgeOpening(pool, { ...K, returnId: kRet, factId: fid.get('f1065.L.1'), rows: [{ accountId: A2.Checking, allocatedCents: '60000', explanation: 'Bank statement' }, { accountId: A2.Savings, allocatedCents: '40000', explanation: 'Bank statement' }], approvedBy: 'tester' });
  await bridgeOpening(pool, { ...K, returnId: kRet, factId: fid.get('f1065.L.17#Accrued wages'), rows: [{ accountId: A2['Payroll Liabilities'], allocatedCents: '2500', explanation: 'Payroll register' }], approvedBy: 'tester' });
  await bridgeOpening(pool, { ...K, returnId: kRet, factId: fid.get('f1065.L.21'), rows: [{ accountId: A2['Retained Earnings'], allocatedCents: '97500', explanation: 'Filed capital' }], approvedBy: 'tester' });
  for (const k of ['f1065.L.1', 'f1065.L.17#Accrued wages', 'f1065.L.21']) await confirmOpeningBooks(pool, { ...K, returnId: kRet, factId: fid.get(k), reviewedBy: 'tester' });
  r = await compute(pool, K, kRet);
  for (const [k, v] of Object.entries({ 'f1065.L.1|begin': 100000n, 'f1065.L.17|begin': 2500n, 'f1065.L.21|begin': 97500n, 'f1065.L.14|begin': 100000n, 'f1065.L.22|begin': 100000n,
    'f1065.L.1|end': 105000n, 'f1065.L.17|end': 2500n, 'f1065.L.14|end': 105000n, 'f1065.L.22|end': 105000n })) assert.equal(valueOf(r, k), v, k);
  const cash = r.slots.find(s => s.key === 'f1065.L.1|begin');
  assert.deepEqual(cash.extras.map(x => x.ledgerCents).sort(), ['-10000', '10000'], 'each account’s reviewed opening replaces its own books beginning');
  assert.equal(r.slots.find(s => s.key === 'f1065.L.17|begin').extras[0].ledgerCents, '-500', 'the row fact is a credit like its line: 2,500 owed, not 2,500 owned');
  assert.deepEqual(errorsOf(r).filter(c => c.code.startsWith('openings')), []);
});

test('openings left unresolved, never skipped: an allocation to an account the books do not have or the return maps elsewhere, and one reviewed against another books beginning', async () => {
  const Q = { orgId, entityId: await company(pool, orgId, 'Quill Partners') };
  const qRet = await period(pool, Q, 2025, 'form_1065', { taxMethod: 'accrual' });
  const bank = await acct(pool, Q, 'Checking'), svc = await acct(pool, Q, 'Services'), re = await acct(pool, Q, 'Retained Earnings');
  const deposits = await acct(pool, Q, 'Deposits Held', 'other_current_asset');
  await je(pool, Q, '2024-03-01', [[bank, 70000], [svc, -70000]]);
  await je(pool, Q, '2025-05-01', [[bank, 5000], [svc, -5000]]);
  await bindBalance(pool, Q, qRet, bank, 'f1065.L.1');
  await bindBalance(pool, Q, qRet, re, 'f1065.L.21');
  await bind(pool, Q, qRet, svc, 'activity', [{ treatment: 'input', destination: 'f1065.p1.1a' }]);
  await answerTypedItems(pool, Q, qRet);
  const b = await filed(Q, [['f1065.L.1', 80000], ['f1065.L.6', 1000], ['f1065.L.21', 81000]]);
  await setPredecessor(pool, { ...Q, returnId: qRet, baselineId: b.baselineId });
  const fid = await factIds(b);
  for (const [k, accountId, cents] of [['f1065.L.1', bank, '80000'], ['f1065.L.6', deposits, '1000'], ['f1065.L.21', re, '81000']]) {
    await bridgeOpening(pool, { ...Q, returnId: qRet, factId: fid.get(k), rows: [{ accountId, allocatedCents: cents, explanation: 'Filed balance sheet' }], approvedBy: 'tester' });
    await confirmOpeningBooks(pool, { ...Q, returnId: qRet, factId: fid.get(k), reviewedBy: 'tester' });
  }
  let r = await compute(pool, Q, qRet);
  assert.ok(errorsOf(r, 'openings_unmapped').some(c => /Deposits Held: the reviewed opening gives it part of Other current assets, but its beginning balance is not mapped/.test(c.message)));
  for (const k of ['f1065.L.6|begin', 'f1065.L.6|end', 'f1065.L.14|begin', 'f1065.L.14|end']) assert.equal(valueOf(r, k), null, k);
  assert.equal(valueOf(r, 'f1065.L.1|begin'), 80000n, 'the other lines keep their reviewed openings');
  // An account the return maps to another line than its allocation's: unresolved.
  await bind(pool, Q, qRet, bank, 'begin', [{ treatment: 'statement_row', destination: 'f1065.L.6' }]);
  r = await compute(pool, Q, qRet);
  assert.ok(errorsOf(r, 'openings_unmapped').some(c => /Checking: the reviewed opening gives it part of Cash, but its beginning balance is mapped to Other current assets/.test(c.message)));
  assert.equal(valueOf(r, 'f1065.L.1|begin'), null);
  await bind(pool, Q, qRet, bank, 'begin', [{ treatment: 'input', destination: 'f1065.L.1' }]);
  // The books change after the allocation was reviewed: its line is unresolved.
  await je(pool, Q, '2024-12-15', [[bank, 500], [svc, -500]]);
  r = await compute(pool, Q, qRet);
  assert.ok(errorsOf(r, 'openings_stale').some(c => /^Checking: .*not the beginning now/.test(c.message)));
  for (const k of ['f1065.L.1|begin', 'f1065.L.1|end']) assert.equal(valueOf(r, k), null, k);
});

test('a reviewed bill moved into the year before is no longer this period’s: shown stale, never excluded here, and a decision on it is refused (Codex t3-plan-r2 R2-2)', async () => {
  const W = { orgId, entityId: await company(pool, orgId, 'Walnut Outlet') };
  const wRet = await period(pool, W, 2025, 'form_1065', { taxMethod: 'accrual' });
  const rent = await acct(pool, W, 'Rent & Lease');
  const related = await bill(pool, W, '2025-12-20', [[rent, 6000]]);
  const RW = { return_id: wRet, entity_id: W.entityId, period_start: '2025-01-01', period_end: '2025-12-31', tax_method: 'accrual' };
  const ev = (await accrualTiming(pool, { orgId, ret: RW })).selectable.bills.find(b => b.txnId === related);
  const save = (e, extra = {}) => saveTimingReview(pool, { ...W, returnId: wRet, txnId: related, kind: 'related_party_accrual', decision: 'exclude', expectTxnVersion: e.txnVersion, expectEventVersion: e.eventVersion, reviewedBy: 'tester', ...extra });
  await save(ev);
  await pool.query(`UPDATE txn SET txn_date = '2024-12-20', due_date = '2024-12-20' WHERE txn_id = $1`, [related]);
  await pool.query(`UPDATE posting SET txn_date = '2024-12-20' WHERE txn_id = $1`, [related]);
  const gate = await accrualTiming(pool, { orgId, ret: RW });
  const c = gate.candidates.find(x => x.txnId === related);
  assert.deepEqual([c.state, c.eventVersion], ['stale', null]);
  assert.deepEqual(gate.exclusions, [], 'never excluded against this return');
  assert.ok(gate.stale.some(s => s.txnId === related && /outside this period/.test(s.reason)));
  const { rows: [v] } = await pool.query('SELECT txn_version($1) AS v', [related]);
  await assert.rejects(save({ txnVersion: v.v, eventVersion: ev.eventVersion }), /clear it|no income or expense of this period/);
});

test('opening checks keep unknown state and prove both destinations (Codex t3-plan-r2 R2-6): a missing fact is unknown, an explicit zero known; an unknown row fact, accounts opening on one line without an allocation and a mismatch leave both columns unknown; a bridge is refused unless its account’s beginning and ending rows all reach the line', async () => {
  const fieldOf = (r, k) => r.fields.find(f => f.key === k);
  const M = { orgId, entityId: await company(pool, orgId, 'Maple Openings Partners') };
  const mRet = await period(pool, M, 2025, 'form_1065', { taxMethod: 'accrual' });
  const bank = await acct(pool, M, 'Checking'), savings = await acct(pool, M, 'Savings'), svc = await acct(pool, M, 'Services'), re = await acct(pool, M, 'Retained Earnings');
  const accrued = await acct(pool, M, 'Payroll Liabilities'), wages = await acct(pool, M, 'Wages');
  await je(pool, M, '2024-03-01', [[bank, 60000], [svc, -60000]]);
  await je(pool, M, '2024-03-02', [[savings, 40000], [svc, -40000]]);
  await je(pool, M, '2024-12-31', [[wages, 2000], [accrued, -2000]]);
  await je(pool, M, '2025-05-01', [[bank, 5000], [svc, -5000]]);
  for (const a of [bank, savings]) await bindBalance(pool, M, mRet, a, 'f1065.L.1');
  await bindBalance(pool, M, mRet, accrued, 'f1065.L.17', 'statement_row');
  await bindBalance(pool, M, mRet, re, 'f1065.L.21');
  await bind(pool, M, mRet, svc, 'activity', [{ treatment: 'input', destination: 'f1065.p1.1a' }]);
  await answerTypedItems(pool, M, mRet);
  // A baseline that omits L.6 (other current assets) and states the accrued wages as an unknown row; cash and capital as filed.
  const facts = (await scheduleLFacts('form_1065', [['f1065.L.1', 100000], ['f1065.L.21', 97000], ['f1065.L.6', null]]))
    .filter(([id]) => id !== 'f1065.L.6' && id !== 'f1065.L.17')
    .map(([fieldId, cents]) => ({ factKind: 'schedule_l_end', fieldId, measurement: 'end', effectiveOn: '2024-12-31', amountCents: String(cents), state: 'known', provenance: { page: 4 }, reviewStatus: 'verified' }));
  facts.push({ factKind: 'schedule_l_end', fieldId: 'f1065.L.17', measurement: 'end', effectiveOn: '2024-12-31', rowKey: 'Accrued wages', state: 'unknown', provenance: { page: 4 }, reviewStatus: 'verified' });
  const b = await importBaseline(pool, { ...M, payload: { importKey: 'filed-2024-openings', payloadVersion: 1, kind: 'imported_filed', returnType: 'form_1065', formEdition: 2024, bookBasis: 'accrual',
    consolidationPolicy: 'inclusion_edges', sourcePeriodStart: '2024-01-01', sourcePeriodEnd: '2024-12-31', sourceDocument: { hash: 'sha256:sample', pages: '1-5' }, extractionStatus: 'verified', facts }, actor: 'tester' });
  await setPredecessor(pool, { ...M, returnId: mRet, baselineId: b.baselineId });
  let r = await compute(pool, M, mRet);
  for (const k of ['f1065.L.6|begin', 'f1065.L.6|end']) assert.deepEqual([fieldOf(r, k)?.status, fieldOf(r, k)?.cents], ['unresolved', null], `${k}: a missing fact is never zero`);
  assert.ok(errorsOf(r, 'openings_unknown').some(c => /no amount for 1 line \(Other current assets\)/.test(c.message)));
  assert.equal(fieldOf(r, 'f1065.L.2a|begin')?.cents, '0', 'an explicit zero fact is a known zero');
  for (const k of ['f1065.L.17|begin', 'f1065.L.17|end']) assert.equal(valueOf(r, k), null, `${k}: an unknown fact leaves both columns unknown`);
  for (const k of ['f1065.L.1|begin', 'f1065.L.1|end']) assert.equal(valueOf(r, k), null, `${k}: two accounts, a matching total, no allocation — both columns unknown`);
  assert.equal(valueOf(r, 'f1065.L.21|begin'), null, 'a known mismatch (98,000 in the books, 97,000 filed) is unknown too');
  // A bridge whose account's ending balance goes elsewhere, or nowhere, is refused even when it equals the books (a zero difference).
  const fid = new Map((await pool.query('SELECT fact_id, field_id FROM baseline_fact WHERE baseline_id = $1 AND row_key IS NULL', [b.baselineId])).rows.map(f => [f.field_id, Number(f.fact_id)]));
  await bridgeOpening(pool, { ...M, returnId: mRet, factId: fid.get('f1065.L.1'), rows: [{ accountId: bank, allocatedCents: '60000', explanation: 'Statement' }, { accountId: savings, allocatedCents: '40000', explanation: 'Statement' }], approvedBy: 'tester' });
  await confirmOpeningBooks(pool, { ...M, returnId: mRet, factId: fid.get('f1065.L.1'), reviewedBy: 'tester' });
  r = await compute(pool, M, mRet);
  assert.equal(valueOf(r, 'f1065.L.1|begin'), 100000n, 'allocated to both accounts (equal to their books): reviewed');
  await bind(pool, M, mRet, savings, 'end', [{ treatment: 'statement_row', destination: 'f1065.L.6' }]);
  r = await compute(pool, M, mRet);
  assert.ok(errorsOf(r, 'openings_unmapped').some(c => /Savings: .*ending balance is mapped to Other current assets/.test(c.message)), 'a zero difference still proves both destinations');
  for (const k of ['f1065.L.1|begin', 'f1065.L.1|end']) assert.equal(valueOf(r, k), null, k);
  await bind(pool, M, mRet, savings, 'end', [{ treatment: 'not_tax', memo: 'held for a customer' }]);
  r = await compute(pool, M, mRet);
  assert.ok(errorsOf(r, 'openings_unmapped').some(c => /Savings: .*ending balance is mapped to no line/.test(c.message)), 'a row with no slot is no destination');
  await bind(pool, M, mRet, savings, 'end', [{ treatment: 'input', destination: 'f1065.L.1' }]);
  assert.equal(valueOf(await compute(pool, M, mRet), 'f1065.L.1|end'), 105000n);
});

test('an excluded accrual whose expense leg moves to a balance account, or whose entry is deleted: the expense it decided is unresolved, never deducted again by default (Codex t3-plan-r3 R3-2)', async () => {
  const Q = { orgId, entityId: await company(pool, orgId, 'Quassia Outlet') };
  const qRet = await period(pool, Q, 2025, 'form_1065', { taxMethod: 'accrual' });
  const bank = await acct(pool, Q, 'Checking'), sales = await acct(pool, Q, 'Services'), util = await acct(pool, Q, 'Utilities'), accrued = await acct(pool, Q, 'Payroll Liabilities');
  const prepaid = await acct(pool, Q, 'Prepaid Expenses');
  await je(pool, Q, '2025-04-01', [[bank, 50000], [sales, -50000]]);
  await je(pool, Q, '2025-05-01', [[util, 1000], [bank, -1000]]);
  const accrual = await je(pool, Q, '2025-12-31', [[util, 3000], [accrued, -3000]]);
  await bindBalance(pool, Q, qRet, bank, 'f1065.L.1');
  await bind(pool, Q, qRet, accrued, 'end', [{ treatment: 'statement_row', destination: 'f1065.L.17' }]);
  await bind(pool, Q, qRet, prepaid, 'end', [{ treatment: 'statement_row', destination: 'f1065.L.6' }]);
  await bind(pool, Q, qRet, await acct(pool, Q, 'Retained Earnings'), 'end', [{ treatment: 'input', destination: 'f1065.L.21' }]);
  await bind(pool, Q, qRet, sales, 'activity', [{ treatment: 'input', destination: 'f1065.p1.1a' }]);
  await bind(pool, Q, qRet, util, 'activity', [{ treatment: 'statement_row', destination: 'f1065.p1.21' }]);
  await answerTypedItems(pool, Q, qRet);
  const RQ = { return_id: qRet, entity_id: Q.entityId, period_start: '2025-01-01', period_end: '2025-12-31', tax_method: 'accrual' };
  const c = (await accrualTiming(pool, { orgId, ret: RQ })).candidates.find(x => x.txnId === accrual);
  await saveTimingReview(pool, { ...Q, returnId: qRet, txnId: accrual, kind: 'imported_accrual_je', decision: 'exclude', expectTxnVersion: c.txnVersion, expectEventVersion: c.eventVersion, reviewedBy: 'tester' });
  assert.equal(valueOf(await compute(pool, Q, qRet), 'f1065.p1.21|activity'), 1000n);
  await pool.query('UPDATE posting SET account_id = $2 WHERE txn_id = $1 AND account_id = $3', [accrual, prepaid, util]);
  let r = await compute(pool, Q, qRet);
  assert.ok(r.timing.stale.some(s => s.txnId === accrual && s.legs.length === 0 && s.accounts.includes(util)), 'stale, with what it decided');
  assert.deepEqual([valueOf(r, 'f1065.p1.21|activity'), r.fields.find(f => f.key === 'f1065.p1.21|activity').status], [null, 'unresolved'], 'the old expense line is unknown, not 1,000 as if decided');
  await pool.query('DELETE FROM posting WHERE txn_id = $1', [accrual]);
  await pool.query('DELETE FROM txn WHERE txn_id = $1', [accrual]);
  r = await compute(pool, Q, qRet);
  assert.equal(valueOf(r, 'f1065.p1.21|activity'), null, 'deleted: still unknown until the decision is cleared');
  const { clearTimingReview } = await import('../lib/tax/cash.js');
  await clearTimingReview(pool, { ...Q, returnId: qRet, reviewId: r.timing.candidates.find(x => x.txnId === accrual).review.review_id });
  assert.equal(valueOf(await compute(pool, Q, qRet), 'f1065.p1.21|activity'), 1000n);
});
