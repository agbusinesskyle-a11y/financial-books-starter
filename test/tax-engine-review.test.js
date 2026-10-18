// test/tax-engine-review.test.js — the engine after Codex's review of the built T3 stage (t3-r1): a pending owner reference is an unresolved
// member of its destination, never a dropped expense and complete totals (B1); per-owner Schedule L lines take the same predecessor-opening
// checks as every other line, on their actual instance keys (B2); an unresolved closing makes net income per books unknown, through the
// M-1, the bridge and retained earnings, while independent typed amounts stay known (B3); a reviewed COGS workpaper keeps its purchases beside
// a closing candidate on its old input (B4); an accepted proposal whose rule no longer matches stays visible and holds what it decided until
// withdrawn (B5). Each test runs on both forms and asserts every affected field's cents AND status, with unrelated controls known.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { t2Db, company, acct, je, period, activity, bind, bindBalance, compute, errorsOf, answerTypedItems, deposit, scheduleLFacts, expense, rawTxn } from './tax-t3-fixtures.js';
import { party } from './tax-t2-fixtures.js';
import { saveInterest } from '../lib/tax/ownership.js';
import { resolveReferences, copyForward, attributeLine } from '../lib/tax/bindings.js';
import { measureLines } from '../lib/tax/measure.js';
import { verifyInitial, saveProfile, openPeriod } from '../lib/tax/periods.js';
import { importBaseline, bridgeOpening } from '../lib/tax/baselines.js';
import { setPredecessor } from '../lib/tax/periods.js';
import { confirmOpeningBooks } from '../lib/tax/engine/books.js';
import { classifyEntry, closingCandidates, clearClassification } from '../lib/tax/classify.js';
import { takeWorkingRevision, getRevision } from '../lib/tax/engine/revision.js';
import { saveManualItem } from '../lib/tax/manual.js';
import { saveWorkpaper } from '../lib/tax/cogs.js';
import { answerProposal, withdrawAdjustment, listAdjustments } from '../lib/tax/adjustments.js';
import { computeIn } from '../lib/tax/engine/compute.js';
import { assignProvider } from '../lib/tax/providers.js';
import { saveActivity } from '../lib/tax/activities.js';

let t, pool, orgId;
before(async () => { t = await t2Db(); pool = t.pool; orgId = t.orgId; });
after(async () => { await t.db.drop(); });

const F = {
  form_1065: { sales: 'f1065.p1.1a', other: 'f1065.p1.21', rent: 'f1065.p1.13', dep: 'f1065.p1.16a', deductions: 'f1065.p1.22', ordinary: 'f1065.p1.23', k1: 'f1065.k.1', endpoint: 'f1065.anal.1', nondeductible: 'f1065.k.18c',
    m1: 'f1065.m1.1', cash: 'f1065.L.1', prepaid: 'f1065.L.6', re: 'f1065.L.21', assets: 'f1065.L.14', total: 'f1065.L.22', cogs: 'f1065.p1.2', suffix: 'Partners' },
  form_1120s: { sales: 'f1120s.p1.1a', other: 'f1120s.p1.20', rent: 'f1120s.p1.11', dep: 'f1120s.p1.14', deductions: 'f1120s.p1.21', ordinary: 'f1120s.p1.22', k1: 'f1120s.k.1', endpoint: 'f1120s.k.18', nondeductible: 'f1120s.k.16c',
    m1: 'f1120s.m1.1', cash: 'f1120s.L.1', prepaid: 'f1120s.L.6', re: 'f1120s.L.24', assets: 'f1120s.L.15', total: 'f1120s.L.27', cogs: 'f1120s.p1.2', suffix: 'Corp' },
};
const fieldOf = (r, k) => { const f = r.fields.find(x => x.key === k); return [f?.cents ?? null, f?.status ?? null]; };
const unknownField = (r, k, what) => assert.deepEqual(fieldOf(r, k), [null, 'unresolved'], `${what}: ${k}`);
const knownField = (r, k, cents, what) => assert.deepEqual(fieldOf(r, k), [String(cents), 'complete'], `${what}: ${k}`);
const dropTxn = async id => { await pool.query('DELETE FROM application WHERE credit_txn_id = $1 OR charge_txn_id = $1', [id]); await pool.query('DELETE FROM posting WHERE txn_id = $1', [id]); await pool.query('DELETE FROM txn WHERE txn_id = $1', [id]); };
const interestOf = async (C, owner) => Number((await pool.query('SELECT interest_id FROM ownership_interest WHERE org_id = $1 AND entity_id = $2 AND party_id = $3', [orgId, C.entityId, owner])).rows[0].interest_id);

test('a pending owner reference is an unresolved member of its destination, never a dropped amount (Codex t3-r1 B1): an officer-compensation expense and a shareholder loan mapped to an owner with no interest on file, a selected owner made ineligible and re-resolved, and a copied-forward default — the line, its placeholder and every dependent total unresolved with null cents; resolved, counted exactly once', async () => {
  const f = F.form_1120s;
  const setup = async (name, { interestFirst = false } = {}) => {
    const C = { orgId, entityId: await company(pool, orgId, `Oak ${name} Corp`) };
    const ret = await period(pool, C, 2025, 'form_1120s', { taxMethod: 'accrual' });
    const owner = await party(pool, orgId, `Sample Oak ${name} Owner`);
    if (interestFirst) await saveInterest(pool, { ...C, fields: { partyId: owner, role: 'shareholder', from: '2020-01-01', to: null, profit: '1/1', loss: '1/1', capital: '1/1' }, actor: 'tester' });
    const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), officer: await acct(pool, C, 'Officer Salaries', 'expense'), loan: await acct(pool, C, 'Loans to Shareholders', 'other_current_asset'), re: await acct(pool, C, 'Retained Earnings') };
    await je(pool, C, '2024-06-01', [[A.loan, 5000], [A.bank, -5000]]);
    await je(pool, C, '2024-06-02', [[A.bank, 20000], [A.sales, -20000]]);
    await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 50000]]);
    await je(pool, C, '2025-04-01', [[A.officer, 10000], [A.bank, -10000]]);
    await bindBalance(pool, C, ret, A.bank, f.cash);
    await bindBalance(pool, C, ret, A.re, f.re);
    await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
    return { C, ret, owner, A };
  };
  const bindOwner = async ({ C, ret, owner, A }, extra = {}) => {
    await bind(pool, C, ret, A.officer, 'activity', [{ treatment: 'input', destination: 'f1120s.p1.7', interestPartyId: owner }], extra);
    for (const m of ['begin', 'end']) await bind(pool, C, ret, A.loan, m, [{ treatment: 'input', destination: 'f1120s.L.7', interestPartyId: owner }], extra);
  };
  const pendingKeys = ['f1120s.p1.7|interest=i:pending|activity', 'f1120s.L.7|interest=i:pending|begin', 'f1120s.L.7|interest=i:pending|end'];
  const expectPending = (r, what) => {
    for (const k of pendingKeys) unknownField(r, k, `${what}: the placeholder`);
    for (const k of [`${f.deductions}|activity`, `${f.ordinary}|activity`, `${f.k1}|activity`, `${f.endpoint}|activity`, `${f.assets}|begin`, `${f.assets}|end`]) unknownField(r, k, `${what}: a dependent total`);
    knownField(r, `${f.sales}|activity`, 50000, `${what}: an independent line`);
    knownField(r, `${f.cash}|end`, 55000, `${what}: an independent balance`);
    assert.ok(!r.fields.some(x => x.fieldId === 'f1120s.p1.7' && x.status === 'complete'), `${what}: no complete officer-compensation member`);
    assert.ok(errorsOf(r, 'reference_pending').length > 0, `${what}: the pending reference is an error of its own`);
  };
  const expectResolved = (r, id, what) => {
    knownField(r, `f1120s.p1.7|interest=i:${id}|activity`, 10000, what);
    knownField(r, `${f.deductions}|activity`, 10000, `${what}: counted exactly once`);
    knownField(r, `${f.ordinary}|activity`, 40000, what);
    knownField(r, `f1120s.L.7|interest=i:${id}|begin`, 5000, what);
    knownField(r, `f1120s.L.7|interest=i:${id}|end`, 5000, what);
    knownField(r, `${f.assets}|end`, 60000, what);
    assert.ok(!r.fields.some(x => x.key.includes('i:pending')), `${what}: no placeholder left`);
  };
  // 1. The owner's interest is not on file when the mapping is saved: pending.
  const P = await setup('pending');
  await bindOwner(P);
  await answerTypedItems(pool, P.C, P.ret);
  let r = await compute(pool, P.C, P.ret);
  expectPending(r, 'pending from the start');
  await saveInterest(pool, { ...P.C, fields: { partyId: P.owner, role: 'shareholder', from: '2020-01-01', to: null, profit: '1/1', loss: '1/1', capital: '1/1' }, actor: 'tester' });
  await resolveReferences(pool, { ...P.C, returnId: P.ret });
  const pid = await interestOf(P.C, P.owner);
  expectResolved(await compute(pool, P.C, P.ret), pid, 'resolved');
  // 2. A selected owner made ineligible (the interest ends mid-year), then re-resolved so the slot is cleared.
  const S = await setup('selected', { interestFirst: true });
  await bindOwner(S);
  await answerTypedItems(pool, S.C, S.ret);
  const sid = await interestOf(S.C, S.owner);
  expectResolved(await compute(pool, S.C, S.ret), sid, 'selected');
  await pool.query(`UPDATE ownership_interest SET effective_to = '2025-06-30' WHERE interest_id = $1`, [sid]);
  r = await compute(pool, S.C, S.ret);
  for (const k of [`f1120s.p1.7|interest=i:${sid}|activity`, `${f.deductions}|activity`, `${f.ordinary}|activity`, `f1120s.L.7|interest=i:${sid}|begin`, `${f.assets}|end`]) unknownField(r, k, 'ineligible before re-resolution');
  knownField(r, `${f.sales}|activity`, 50000, 'ineligible before re-resolution');
  await resolveReferences(pool, { ...S.C, returnId: S.ret });
  expectPending(await compute(pool, S.C, S.ret), 'cleared by re-resolution');
  await pool.query('UPDATE ownership_interest SET effective_to = NULL WHERE interest_id = $1', [sid]);
  await resolveReferences(pool, { ...S.C, returnId: S.ret });
  expectResolved(await compute(pool, S.C, S.ret), sid, 'eligible again');
  // 3. A company default naming the owner, copied forward while the interest is not on file: pending, never dropped.
  const D = await setup('default');
  await bindOwner(D, { makeDefault: true });
  await pool.query('DELETE FROM tax_binding WHERE org_id = $1 AND return_id = $2 AND account_id = ANY($3::bigint[])', [orgId, D.ret, [D.A.officer, D.A.loan]]);
  const copied = await copyForward(pool, { ...D.C, returnId: D.ret, actor: 'tester' });
  assert.equal(copied.copied, 3, 'the three defaults are copied');
  await answerTypedItems(pool, D.C, D.ret);
  r = await compute(pool, D.C, D.ret);
  expectPending(r, 'copied forward');
  assert.ok(r.cov.sources[0].accounts.find(a => a.accountId === D.A.officer).bindings.every(b => b.slot_key === null), 'copied with the owner pending');
  await saveInterest(pool, { ...D.C, fields: { partyId: D.owner, role: 'shareholder', from: '2020-01-01', to: null, profit: '1/1', loss: '1/1', capital: '1/1' }, actor: 'tester' });
  await resolveReferences(pool, { ...D.C, returnId: D.ret });
  expectResolved(await compute(pool, D.C, D.ret), await interestOf(D.C, D.owner), 'copied and resolved');
});

test('per-owner Schedule L lines take the predecessor-opening checks on their actual instance keys (Codex t3-r1 B2): Form 1120-S loans to and from a shareholder — a mismatched, absent and unknown filed amount, a matching single-account control, two accounts without an allocation, an approved complete bridge, and an ending route moved to another line; both columns and the balance totals, with the check codes', async () => {
  const f = F.form_1120s;
  const C = { orgId, entityId: await company(pool, orgId, 'Hazel Loans Corp') };
  const ret = await period(pool, C, 2025, 'form_1120s', { taxMethod: 'accrual' });
  const owner = await party(pool, orgId, 'Sample Hazel Owner');
  await saveInterest(pool, { ...C, fields: { partyId: owner, role: 'shareholder', from: '2020-01-01', to: null, profit: '1/1', loss: '1/1', capital: '1/1' }, actor: 'tester' });
  const id = await interestOf(C, owner);
  const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), re: await acct(pool, C, 'Retained Earnings'),
    loanR: await acct(pool, C, 'Loans to Shareholders', 'other_current_asset'), loanR2: await acct(pool, C, 'Second Shareholder Loan', 'other_current_asset'), loanP: await acct(pool, C, 'Loans from Shareholders', 'other_current_liability') };
  await je(pool, C, '2024-06-01', [[A.loanR, 10000], [A.loanP, -10000]]);
  await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 5000]]);
  await bindBalance(pool, C, ret, A.bank, f.cash);
  await bindBalance(pool, C, ret, A.re, f.re);
  await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
  const ownerLine = async (account, destination) => { for (const m of ['begin', 'end']) await bind(pool, C, ret, account, m, [{ treatment: 'input', destination, interestPartyId: owner }]); };
  await ownerLine(A.loanR, 'f1120s.L.7');
  await ownerLine(A.loanP, 'f1120s.L.19');
  await answerTypedItems(pool, C, ret);
  let n = 0;
  const filed = async (given, { drop = [], unknown = [] } = {}) => {
    const facts = (await scheduleLFacts('form_1120s', given)).filter(([fid]) => !drop.includes(fid))
      .map(([fieldId, cents]) => ({ factKind: 'schedule_l_end', fieldId, measurement: 'end', effectiveOn: '2024-12-31', amountCents: unknown.includes(fieldId) ? null : String(cents), state: unknown.includes(fieldId) ? 'unknown' : 'known', provenance: { page: 4 }, reviewStatus: 'verified' }));
    n += 1;
    const b = await importBaseline(pool, { ...C, payload: { importKey: `filed-2024-hazel-${n}`, payloadVersion: 1, kind: 'imported_filed', returnType: 'form_1120s', formEdition: 2024, bookBasis: 'accrual', consolidationPolicy: 'inclusion_edges',
      sourcePeriodStart: '2024-01-01', sourcePeriodEnd: '2024-12-31', sourceDocument: { hash: 'sha256:sample', pages: '1-5' }, extractionStatus: 'verified', facts }, actor: 'tester' });
    await setPredecessor(pool, { ...C, returnId: ret, baselineId: b.baselineId });
    return b;
  };
  const L7 = m => `f1120s.L.7|interest=i:${id}|${m}`, L19 = m => `f1120s.L.19|interest=i:${id}|${m}`;
  const expectHeld = (r, what, code) => {
    for (const k of [L7('begin'), L7('end'), L19('begin'), L19('end'), `${f.assets}|begin`, `${f.assets}|end`, `${f.total}|begin`, `${f.total}|end`]) unknownField(r, k, what);
    knownField(r, `${f.sales}|activity`, 5000, `${what}: an independent line`);
    knownField(r, `${f.cash}|end`, 5000, `${what}: an independent balance line`);
    assert.ok(errorsOf(r, code).some(c => /Loans (to|from) shareholders/.test(c.message)), `${what}: ${code} names the owner lines (${errorsOf(r).map(c => c.code).join(',')})`);
    assert.ok(!r.fields.some(x => ['f1120s.L.7', 'f1120s.L.19'].includes(x.fieldId) && !Object.keys(x.dims).length), `${what}: no unscoped owner-line key is forced`);
  };
  // Mismatched: the books begin at 10,000 on each side, the filed return ended at 20,000.
  await filed([['f1120s.L.7', 20000], ['f1120s.L.19', 20000]]);
  expectHeld(await compute(pool, C, ret), 'mismatched', 'openings_unexplained');
  // Absent: the baseline says nothing about the owner lines (never zero).
  await filed([], { drop: ['f1120s.L.7', 'f1120s.L.19'] });
  expectHeld(await compute(pool, C, ret), 'absent', 'openings_unknown');
  // Unknown: the baseline states them as unknown.
  await filed([['f1120s.L.7', 0], ['f1120s.L.19', 0]], { unknown: ['f1120s.L.7', 'f1120s.L.19'] });
  expectHeld(await compute(pool, C, ret), 'unknown', 'openings_unknown');
  // Matching, one account per line: tied on its own.
  await filed([['f1120s.L.7', 10000], ['f1120s.L.19', 10000]]);
  let r = await compute(pool, C, ret);
  for (const [k, v] of [[L7('begin'), 10000], [L7('end'), 10000], [L19('begin'), 10000], [L19('end'), 10000], [`${f.assets}|begin`, 10000], [`${f.assets}|end`, 15000], [`${f.total}|begin`, 10000], [`${f.total}|end`, 15000]]) knownField(r, k, v, 'matching');
  assert.deepEqual(errorsOf(r).filter(c => c.code.startsWith('openings')), [], 'matching: no opening error');
  // Two accounts open on the owner's line 7: the filed total alone is no account-level review.
  await je(pool, C, '2024-06-02', [[A.loanR2, 5000], [A.loanP, -5000]]);
  await ownerLine(A.loanR2, 'f1120s.L.7');
  const b = await filed([['f1120s.L.7', 15000], ['f1120s.L.19', 15000]]);
  r = await compute(pool, C, ret);
  for (const k of [L7('begin'), L7('end'), `${f.assets}|begin`, `${f.assets}|end`]) unknownField(r, k, 'two accounts, no allocation');
  for (const [k, v] of [[L19('begin'), 15000], [L19('end'), 15000]]) knownField(r, k, v, 'two accounts: the other owner line ties on its own');
  assert.ok(errorsOf(r, 'openings_unreviewed').some(c => /Loans to shareholders/.test(c.message)), 'two accounts: an allocation is needed');
  // An approved, complete bridge allocating the filed amount to both accounts, with the books amounts recorded.
  const { rows: [fact] } = await pool.query(`SELECT fact_id FROM baseline_fact WHERE baseline_id = $1 AND field_id = 'f1120s.L.7' AND row_key IS NULL`, [b.baselineId]);
  await bridgeOpening(pool, { ...C, returnId: ret, factId: Number(fact.fact_id), rows: [{ accountId: A.loanR, allocatedCents: '10000', explanation: 'Loan statement' }, { accountId: A.loanR2, allocatedCents: '5000', explanation: 'Loan statement' }], approvedBy: 'tester' });
  await confirmOpeningBooks(pool, { ...C, returnId: ret, factId: Number(fact.fact_id), reviewedBy: 'tester' });
  r = await compute(pool, C, ret);
  for (const [k, v] of [[L7('begin'), 15000], [L7('end'), 15000], [`${f.assets}|begin`, 15000], [`${f.assets}|end`, 20000], [`${f.total}|end`, 20000]]) knownField(r, k, v, 'bridged');
  assert.deepEqual(errorsOf(r).filter(c => c.code.startsWith('openings')), [], 'bridged: no opening error');
  // The ending route of the first loan moved to line 8 while the filed amount does not match: a beginning hold is not bypassed by moving the ending destination.
  await pool.query('DELETE FROM opening_bridge WHERE org_id = $1 AND return_id = $2', [orgId, ret]);
  await filed([['f1120s.L.7', 25000], ['f1120s.L.19', 15000]]);
  await bind(pool, C, ret, A.loanR, 'end', [{ treatment: 'input', destination: 'f1120s.L.8' }]);
  r = await compute(pool, C, ret);
  for (const k of [L7('begin'), L7('end'), `${f.assets}|begin`, `${f.assets}|end`]) unknownField(r, k, 'ending route moved');
  for (const [k, v] of [[`${f.cash}|end`, 5000], [L19('begin'), 15000], [`${f.total}|begin`, 15000]]) knownField(r, k, v, 'ending route moved: the independent lines and the other side of the balance sheet');
  unknownField(r, 'f1120s.L.8|end', 'ending route moved: the books-fed replacement ending waits on the unexplained opening too (Codex t3-r4 R4-2)');
  assert.ok(errorsOf(r).some(c => c.code.startsWith('openings') && /Loans to shareholders/.test(c.message)), 'ending route moved: the owner line is named');
});

test('opening checks enumerate the ACTUAL owner-line instances (Codex t3-r2 R2-1): manual-provider owner lines against a zero predecessor and a matching control, a mixed bound-and-typed line, a two-owner bridge gone stale while the aggregate still matches, and an ending route moved away while a bridge exists — the real instances held in both columns with the totals, never an unscoped owner key', async () => {
  const f = F.form_1120s;
  const interest = async (C, name) => { const owner = await party(pool, orgId, name); await saveInterest(pool, { ...C, fields: { partyId: owner, role: 'shareholder', from: '2020-01-01', to: null, profit: '1/2', loss: '1/2', capital: '1/2' }, actor: 'tester' }); return { owner, id: await interestOf(C, owner) }; };
  const baseline = async (C, ret, given, n) => {
    const facts = (await scheduleLFacts('form_1120s', given)).map(([fieldId, cents]) => ({ factKind: 'schedule_l_end', fieldId, measurement: 'end', effectiveOn: '2024-12-31', amountCents: String(cents), state: 'known', provenance: { page: 4 }, reviewStatus: 'verified' }));
    const b = await importBaseline(pool, { ...C, payload: { importKey: `filed-2024-${n}`, payloadVersion: 1, kind: 'imported_filed', returnType: 'form_1120s', formEdition: 2024, bookBasis: 'accrual', consolidationPolicy: 'inclusion_edges',
      sourcePeriodStart: '2024-01-01', sourcePeriodEnd: '2024-12-31', sourceDocument: { hash: 'sha256:sample', pages: '1-5' }, extractionStatus: 'verified', facts }, actor: 'tester' });
    await setPredecessor(pool, { ...C, returnId: ret, baselineId: b.baselineId });
    return b;
  };
  const noUnscoped = (r, what) => assert.ok(!r.fields.some(x => ['f1120s.L.7', 'f1120s.L.19'].includes(x.fieldId) && !Object.keys(x.dims).length), `${what}: no unscoped owner-line key`);
  // A. Manual-provider owner lines (assigned, typed 10,000 each) against a predecessor stating zero: unresolved, both columns, with the totals.
  {
    const C = { orgId, entityId: await company(pool, orgId, 'Birch Typed Corp') };
    const ret = await period(pool, C, 2025, 'form_1120s', { taxMethod: 'accrual' });
    const { id } = await interest(C, 'Sample Birch Owner');
    const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), re: await acct(pool, C, 'Retained Earnings') };
    await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 5000]]);
    await bindBalance(pool, C, ret, A.bank, f.cash);
    await bindBalance(pool, C, ret, A.re, f.re);
    await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
    const keys = ['f1120s.L.7', 'f1120s.L.19'].flatMap(l => ['begin', 'end'].map(m => `${l}|interest=i:${id}|${m}`));
    for (const k of keys) await assignProvider(pool, { ...C, returnId: ret, slotKey: k, providerKind: 'manual', schemaVersion: 1, sourceRef: { reason: 'loan schedule' }, sourceVersion: 'manual:loans@1' });
    await answerTypedItems(pool, C, ret, { except: keys });
    for (const k of keys) await saveManualItem(pool, { ...C, returnId: ret, itemKey: k, status: 'entered', amount: '100.00', enteredBy: 'tester' });
    await baseline(C, ret, [], 'birch-zero');
    let r = await compute(pool, C, ret);
    for (const k of [...keys, `${f.assets}|begin`, `${f.assets}|end`, `${f.total}|begin`, `${f.total}|end`]) unknownField(r, k, 'typed owner lines, zero predecessor');
    knownField(r, `${f.cash}|end`, 5000, 'typed owner lines, zero predecessor: an independent line');
    assert.ok(errorsOf(r, 'openings_unexplained').some(c => /Loans (to|from) shareholders/.test(c.message)), 'typed owner lines: the mismatch is an error');
    noUnscoped(r, 'typed owner lines');
    await baseline(C, ret, [['f1120s.L.7', 10000], ['f1120s.L.19', 10000]], 'birch-match');
    r = await compute(pool, C, ret);
    for (const k of keys) knownField(r, k, 10000, 'typed owner lines, matching predecessor');
    knownField(r, `${f.assets}|begin`, 10000, 'typed owner lines, matching predecessor');
    assert.deepEqual(errorsOf(r).filter(c => c.code.startsWith('openings')), [], 'typed owner lines, matching: no opening error');
    // Mixed: a second owner's loan from the books on the same line; the filed total covers only the typed one — unresolved on both instances.
    const two = await interest(C, 'Sample Birch Second Owner');
    const loan = await acct(pool, C, 'Loans to Shareholders', 'other_current_asset');
    await je(pool, C, '2024-06-01', [[loan, 4000], [A.bank, -4000]]);
    for (const m of ['begin', 'end']) await bind(pool, C, ret, loan, m, [{ treatment: 'input', destination: 'f1120s.L.7', interestPartyId: two.owner }]);
    r = await compute(pool, C, ret);
    for (const k of [`f1120s.L.7|interest=i:${id}|begin`, `f1120s.L.7|interest=i:${two.id}|begin`, `f1120s.L.7|interest=i:${two.id}|end`, `${f.assets}|begin`]) unknownField(r, k, 'mixed bound and typed, filed total short');
    knownField(r, `f1120s.L.19|interest=i:${id}|begin`, 10000, 'mixed: the other owner line still ties');
    noUnscoped(r, 'mixed');
    await baseline(C, ret, [['f1120s.L.7', 14000], ['f1120s.L.19', 10000], ['f1120s.L.1', -4000]], 'birch-mixed');
    r = await compute(pool, C, ret);
    for (const [k, v] of [[`f1120s.L.7|interest=i:${id}|begin`, 10000], [`f1120s.L.7|interest=i:${two.id}|begin`, 4000], [`${f.assets}|begin`, 10000 + 4000 - 4000]]) knownField(r, k, v, 'mixed, filed total matching: tied instance by instance');
    assert.deepEqual(errorsOf(r).filter(c => c.code.startsWith('openings')), [], 'mixed, matching: no opening error');
  }
  // B. Two owners' loans bridged and confirmed, then a prior-period entry moves 2,000 between the accounts (the aggregate still 15,000): both
  //    real instances unresolved in both columns, the totals too, no unscoped key; and an ending route moved away while the bridge exists.
  {
    const C = { orgId, entityId: await company(pool, orgId, 'Birch Bridged Corp') };
    const ret = await period(pool, C, 2025, 'form_1120s', { taxMethod: 'accrual' });
    const one = await interest(C, 'Sample Birch Owner One'), two = await interest(C, 'Sample Birch Owner Two');
    const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), re: await acct(pool, C, 'Retained Earnings'), l1: await acct(pool, C, 'Loan to Owner One', 'other_current_asset'), l2: await acct(pool, C, 'Loan to Owner Two', 'other_current_asset') };
    await je(pool, C, '2024-06-01', [[A.l1, 10000], [A.bank, -10000]]);
    await je(pool, C, '2024-06-02', [[A.l2, 5000], [A.bank, -5000]]);
    await je(pool, C, '2024-06-03', [[A.bank, 20000], [A.sales, -20000]]);
    await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 5000]]);
    await bindBalance(pool, C, ret, A.bank, f.cash);
    await bindBalance(pool, C, ret, A.re, f.re);
    await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
    for (const [a, o] of [[A.l1, one], [A.l2, two]]) for (const m of ['begin', 'end']) await bind(pool, C, ret, a, m, [{ treatment: 'input', destination: 'f1120s.L.7', interestPartyId: o.owner }]);
    await answerTypedItems(pool, C, ret);
    const b = await baseline(C, ret, [['f1120s.L.7', 15000], ['f1120s.L.1', 5000], ['f1120s.L.24', 20000]], 'birch-bridged');
    const { rows: [fact] } = await pool.query(`SELECT fact_id FROM baseline_fact WHERE baseline_id = $1 AND field_id = 'f1120s.L.7' AND row_key IS NULL`, [b.baselineId]);
    await bridgeOpening(pool, { ...C, returnId: ret, factId: Number(fact.fact_id), rows: [{ accountId: A.l1, allocatedCents: '10000', explanation: 'Loan statements' }, { accountId: A.l2, allocatedCents: '5000', explanation: 'Loan statements' }], approvedBy: 'tester' });
    await confirmOpeningBooks(pool, { ...C, returnId: ret, factId: Number(fact.fact_id), reviewedBy: 'tester' });
    const k1 = m => `f1120s.L.7|interest=i:${one.id}|${m}`, k2 = m => `f1120s.L.7|interest=i:${two.id}|${m}`;
    let r = await compute(pool, C, ret);
    for (const [k, v] of [[k1('begin'), 10000], [k2('begin'), 5000], [k1('end'), 10000], [k2('end'), 5000], [`${f.assets}|begin`, 20000]]) knownField(r, k, v, 'bridged control');
    assert.deepEqual(errorsOf(r).filter(c => c.code.startsWith('openings')), [], 'bridged control: no opening error');
    const move = await je(pool, C, '2024-07-01', [[A.l1, 2000], [A.l2, -2000]]);
    r = await compute(pool, C, ret);
    for (const k of [k1('begin'), k2('begin'), k1('end'), k2('end'), `${f.assets}|begin`, `${f.assets}|end`]) unknownField(r, k, 'stale bridge, aggregate matching');
    knownField(r, `${f.cash}|end`, 10000, 'stale bridge: an independent line');
    knownField(r, `${f.total}|begin`, 20000, 'stale bridge: the other side of the balance sheet');
    assert.ok(errorsOf(r, 'openings_stale').length >= 1, 'stale bridge: the stale openings are errors');
    noUnscoped(r, 'stale bridge');
    await dropTxn(move);
    for (const k of [k1('begin'), k2('begin')]) knownField(await compute(pool, C, ret), k, k === k1('begin') ? 10000 : 5000, 'books restored: the bridge applies again');
    // The first loan's ending route moved to line 8 while the bridge exists: both measurements of its instance held, no unscoped key.
    await bind(pool, C, ret, A.l1, 'end', [{ treatment: 'input', destination: 'f1120s.L.8' }]);
    r = await compute(pool, C, ret);
    for (const k of [k1('begin'), k1('end'), k2('begin'), k2('end'), `${f.assets}|begin`, `${f.assets}|end`]) unknownField(r, k, 'ending route moved with a bridge');
    knownField(r, `${f.cash}|end`, 10000, 'ending route moved: an independent line');
    assert.ok(errorsOf(r, 'openings_unmapped').some(c => /Loan to Owner One/.test(c.message)), 'ending route moved: the account is named');
    noUnscoped(r, 'ending route moved');
  }
});

// A company with a 10,000 meals expense routed to the other-deductions statement, every typed item answered: the meals proposal is computed.
async function mealsCo(rt, name) {
  const f = F[rt];
  const C = { orgId, entityId: await company(pool, orgId, `${name} ${f.suffix}`) };
  const ret = await period(pool, C, 2025, rt, { taxMethod: 'accrual' });
  const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), meals: await acct(pool, C, 'Meals'), re: await acct(pool, C, 'Retained Earnings') };
  await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 50000]]);
  const mealsTxn = await je(pool, C, '2025-04-01', [[A.meals, 10000], [A.bank, -10000]]);
  await bindBalance(pool, C, ret, A.bank, f.cash);
  await bindBalance(pool, C, ret, A.re, f.re);
  await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
  await bind(pool, C, ret, A.meals, 'activity', [{ treatment: 'statement_row', destination: f.other }]);
  await answerTypedItems(pool, C, ret);
  const S = { ...C, returnId: ret };
  const rename = name => pool.query('UPDATE account SET name = $2 WHERE account_id = $1', [A.meals, name]);
  const answer = async (accountName, decision) => { const r = await compute(pool, C, ret); const p = r.proposals.find(x => x.accountName === accountName); assert.ok(p, `a proposal for ${accountName}`); await answerProposal(pool, { ...S, key: p.key, version: p.version, decision, reason: decision === 'reject' ? 'Reviewed: deductible in full' : null, decidedBy: 'tester', compute: computeIn }); return p; };
  return { C, ret, S, A, f, mealsTxn, rename, answer };
}
const expectFull = (r, f, what) => { knownField(r, `${f.other}|activity`, 10000, `${what}: the full deduction`); knownField(r, `${f.nondeductible}|activity`, 0, `${what}: nothing nondeductible`); knownField(r, `${f.ordinary}|activity`, 40000, what); assert.deepEqual(r.orphanAnswers ?? [], [], `${what}: no orphan`); };

test('a later answer supersedes an earlier acceptance even when no proposal is computed any more (Codex t3-r2 R2-2): accept v1, reject v2, then a neutral name — no orphan, the full deduction known; accept v1, accept v2, neutral name — only the current acceptance holds, and withdrawing it releases everything; both forms', async () => {
  for (const rt of ['form_1065', 'form_1120s']) {
    const f = F[rt];
    // 1. accept v1 → reject v2 → the rule stops matching: the rejection is the operative decision; nothing is revived.
    let T = await mealsCo(rt, 'Linden rejected');
    await T.answer('Meals', 'accept');
    await T.rename('Staff Meals');
    await T.answer('Staff Meals', 'reject');
    let r = await compute(pool, T.C, T.ret);
    expectFull(r, f, `${rt}: rejected v2`);
    assert.deepEqual(errorsOf(r, 'proposal_open'), [], `${rt}: v2 is answered`);
    await T.rename('Staff costs');
    r = await compute(pool, T.C, T.ret);
    expectFull(r, f, `${rt}: neutral after a rejection`);
    assert.deepEqual(errorsOf(r, 'proposal_orphan'), [], `${rt}: the superseded acceptance is history, not an orphan`);
    // 2. accept v1 → accept v2 → the rule stops matching: one orphan (the current acceptance); withdrawn, the old one does not take over.
    T = await mealsCo(rt, 'Linden twice');
    const v1 = await T.answer('Meals', 'accept');
    await T.rename('Staff Meals');
    const v2 = await T.answer('Staff Meals', 'accept');
    await T.rename('Staff costs');
    r = await compute(pool, T.C, T.ret);
    const groups = await listAdjustments(pool, { orgId, returnId: T.ret });
    const g1 = groups.find(g => g.source_version === v1.version), g2 = groups.find(g => g.source_version === v2.version);
    assert.deepEqual((r.orphanAnswers ?? []).map(g => g.group_id), [g2.group_id], `${rt}: only the current acceptance is an orphan`);
    for (const k of [`${f.other}|activity`, `${f.nondeductible}|activity`, `${f.ordinary}|activity`]) unknownField(r, k, `${rt}: held by the current acceptance`);
    await withdrawAdjustment(pool, { ...T.S, groupId: g2.group_id, reason: 'Not meals any more', decidedBy: 'tester' });
    r = await compute(pool, T.C, T.ret);
    expectFull(r, f, `${rt}: the current acceptance withdrawn`);
    assert.equal((await listAdjustments(pool, { orgId, returnId: T.ret })).find(g => g.group_id === g1.group_id)?.status, 'accepted', `${rt}: the superseded group is kept as history`);
  }
});

test('withdrawing an orphaned acceptance retires it, never rejects the proposal (Codex t3-r2 R2-3): accept, a neutral name, withdraw, then the exact original name — the proposal awaits an answer and its lines are unresolved; accepting applies once, rejecting releases; the retired answer stays readable with its lines; a genuine fresh rejection stays valid; both forms', async () => {
  for (const rt of ['form_1065', 'form_1120s']) for (const then of ['accept', 'reject']) {
    const what = `${rt}, then ${then}`;
    const T = await mealsCo(rt, `Maple ${then}`), { f } = T;
    const v1 = await T.answer('Meals', 'accept');
    await T.rename('Staff costs');
    let r = await compute(pool, T.C, T.ret);
    const orphan = (r.orphanAnswers ?? [])[0];
    assert.ok(orphan, `${what}: the acceptance is an orphan`);
    await withdrawAdjustment(pool, { ...T.S, groupId: orphan.group_id, reason: 'The account is not meals any more', decidedBy: 'tester' });
    r = await compute(pool, T.C, T.ret);
    expectFull(r, f, `${what}: withdrawn for the changed source`);
    const retired = (await listAdjustments(pool, { orgId, returnId: T.ret })).find(g => g.group_id === orphan.group_id);
    assert.deepEqual([retired.status, retired.reason, retired.lines.map(l => l.cents)], ['withdrawn', 'The account is not meals any more', [-5000n, 5000n]], `${what}: the retired answer is readable with its lines`);
    // The exact original source returns: nobody has answered THIS proposal — it waits, and its lines are not known.
    await T.rename('Meals');
    r = await compute(pool, T.C, T.ret);
    const again = r.proposals.find(x => x.accountName === 'Meals');
    assert.ok(again && again.version === v1.version, `${what}: the original proposal is computed again, same version`);
    assert.equal(again.answer, null, `${what}: a retired answer is no answer`);
    for (const k of [`${f.other}|activity`, `${f.nondeductible}|activity`, `${f.ordinary}|activity`]) unknownField(r, k, `${what}: waiting for a current decision`);
    assert.ok(errorsOf(r, 'proposal_open').length > 0 && errorsOf(r, 'proposal_orphan').length === 0, `${what}: waiting, not orphaned`);
    knownField(r, `${f.sales}|activity`, 50000, `${what}: an unrelated line`);
    // A current decision on the identical source version: saved (the retired row does not block it), applied once or released.
    await T.answer('Meals', then);
    r = await compute(pool, T.C, T.ret);
    if (then === 'accept') { knownField(r, `${f.other}|activity`, 5000, `${what}: applied once`); knownField(r, `${f.nondeductible}|activity`, 5000, `${what}: applied once`); knownField(r, `${f.ordinary}|activity`, 45000, what); }
    else expectFull(r, f, `${what}: released by a genuine rejection`);
    assert.deepEqual(errorsOf(r, 'proposal_open'), [], `${what}: answered`);
    assert.equal((await listAdjustments(pool, { orgId, returnId: T.ret })).find(g => g.group_id === orphan.group_id)?.status, 'withdrawn', `${what}: the retired answer is still there`);
  }
  // Control: a genuine fresh rejection stays the answer (not retired, not reopened).
  const T = await mealsCo('form_1065', 'Maple control');
  await T.answer('Meals', 'reject');
  const r = await compute(pool, T.C, T.ret);
  expectFull(r, T.f, 'control: rejected');
  assert.deepEqual([errorsOf(r, 'proposal_open'), r.proposals.find(x => x.accountName === 'Meals')?.answer?.status], [[], 'rejected'], 'control: a fresh rejection is the answer');
});

test('an unmapped expense leaves unknown only what can consume it (Codex t3-r2 R2-4): measured net income per books (M-1 line 1, the bridge) and a reviewed workpaper’s total stay known while page 1, ordinary income and the reconciliation wait; mapping the expense alone restores them; a confirmed closing stays in force throughout; both forms', async () => {
  for (const rt of ['form_1065', 'form_1120s']) {
    const f = F[rt], what = rt;
    const C = { orgId, entityId: await company(pool, orgId, `Spruce ${f.suffix}`) };
    const ret = await period(pool, C, 2025, rt, { taxMethod: 'accrual' });
    const one = await activity(pool, C, { name: 'Spruce retail' }), two = await activity(pool, C, { name: 'Spruce parts' });
    const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), re: await acct(pool, C, 'Retained Earnings'), cost: await acct(pool, C, 'Purchases', 'cost_of_goods_sold'), labor: await acct(pool, C, 'Direct Labor', 'cost_of_goods_sold'), util: await acct(pool, C, 'Utilities') };
    await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 50000]]);
    await je(pool, C, '2025-04-01', [[A.cost, 10000], [A.bank, -10000]]);
    await je(pool, C, '2025-04-02', [[A.labor, 7000], [A.bank, -7000]]);
    const close = await je(pool, C, '2025-12-31', [[A.re, 10000], [A.cost, -10000]], { memo: 'closing' });
    await bindBalance(pool, C, ret, A.bank, f.cash);
    await bindBalance(pool, C, ret, A.re, f.re);
    await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
    await bind(pool, C, ret, A.cost, 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.2', activityId: one }]);
    await bind(pool, C, ret, A.labor, 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.3', activityId: two }]);
    await answerTypedItems(pool, C, ret);
    await saveWorkpaper(pool, { ...C, returnId: ret, activityId: one, path: 'reviewed', treatment: 'inventory_as_booked', method: 'cost', reviewedLines: { '1': '0', '2': '250.00', '3': '0', '4': '0', '5': [], '7': '0' }, sourceNote: 'The count sheets', reviewedBy: 'tester' });
    await saveWorkpaper(pool, { ...C, returnId: ret, activityId: two, path: 'reconstruct', treatment: 'inventory_as_booked', method: 'cost', begin: '0', end: '0', reviewedBy: 'tester' });
    await classifyClosing(C, ret, close);
    let r = await compute(pool, C, ret);
    knownField(r, `${f.m1}|activity`, 33000, `${what}, complete`);
    knownField(r, kOf(8, one), 25000, `${what}, complete`);
    knownField(r, `${f.ordinary}|activity`, 18000, `${what}, complete`);
    // A utility paid, its tax mapping unanswered: the books are measured (27,000), the reviewed workpaper's total is its own; the tax totals wait.
    const util = await je(pool, C, '2025-06-01', [[A.util, 6000], [A.bank, -6000]]);
    r = await compute(pool, C, ret);
    knownField(r, `${f.m1}|activity`, 27000, `${what}, unmapped: M-1 line 1 is the measured book income`);
    assert.equal(r.bridge.bookNetIncome, '27000', `${what}, unmapped: the bridge's book amount`);
    knownField(r, kOf(8, one), 25000, `${what}, unmapped: the reviewed workpaper's total`);
    knownField(r, kOf(2, one), 25000, `${what}, unmapped: reviewed purchases`);
    knownField(r, `${f.sales}|activity`, 50000, `${what}, unmapped: an independent line`);
    for (const k of [`${f.cogs}|activity`, `${f.deductions}|activity`, `${f.ordinary}|activity`, `${f.k1}|activity`, `${f.endpoint}|activity`]) unknownField(r, k, `${what}, unmapped: a total the expense could reach`);
    assert.ok(errorsOf(r, 'coverage').length > 0, `${what}, unmapped: the mapping is the error`);
    assert.ok(r.candidates.find(c => c.txnId === close)?.state === 'decided', `${what}: the closing stays decided`);
    // Mapping the expense alone (no book amount or workpaper input changes) restores everything.
    await bind(pool, C, ret, A.util, 'activity', [{ treatment: 'statement_row', destination: f.other }]);
    r = await compute(pool, C, ret);
    knownField(r, `${f.m1}|activity`, 27000, `${what}, mapped`);
    knownField(r, kOf(8, one), 25000, `${what}, mapped`);
    knownField(r, `${f.ordinary}|activity`, 12000, `${what}, mapped`);
    assert.equal(r.bridge.residual, '0', `${what}, mapped: reconciled`);
    // The closing regression stands: the closing made stale, book income is unknown again whatever the mapping.
    await pool.query(`UPDATE txn SET memo = 'edited' WHERE txn_id = $1`, [close]);
    r = await compute(pool, C, ret);
    unknownField(r, `${f.m1}|activity`, `${what}, stale closing`);
    assert.equal(r.bridge.bookNetIncome, null, `${what}, stale closing: the bridge's book amount`);
    knownField(r, kOf(8, one), 25000, `${what}, stale closing: the reviewed total still stands`);
    await dropTxn(util);
  }
});

test('a failed opening check follows the account to its ACTUAL destinations (Codex t3-r3 R3-1): a nonzero approved difference, then the receivable’s ending route moved to line 8, removed, split, or routed to another owner’s instance — the replacement field null and unresolved with the old instance and the totals; restored, 20,000 exactly once; independent balances known', async () => {
  const f = F.form_1120s;
  const C = { orgId, entityId: await company(pool, orgId, 'Poplar Openings Corp') };
  const ret = await period(pool, C, 2025, 'form_1120s', { taxMethod: 'accrual' });
  const mk = async name => { const owner = await party(pool, orgId, name); await saveInterest(pool, { ...C, fields: { partyId: owner, role: 'shareholder', from: '2020-01-01', to: null, profit: '1/2', loss: '1/2', capital: '1/2' }, actor: 'tester' }); return { owner, id: await interestOf(C, owner) }; };
  const one = await mk('Sample Poplar Owner One'), two = await mk('Sample Poplar Owner Two');
  const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), re: await acct(pool, C, 'Retained Earnings'), loanR: await acct(pool, C, 'Loans to Shareholders', 'other_current_asset'), loanP: await acct(pool, C, 'Loans from Shareholders', 'other_current_liability') };
  await je(pool, C, '2024-06-01', [[A.loanR, 10000], [A.loanP, -10000]]);
  await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 5000]]);
  await bindBalance(pool, C, ret, A.bank, f.cash);
  await bindBalance(pool, C, ret, A.re, f.re);
  await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
  const ownerRoute = (account, destination, o) => [{ treatment: 'input', destination, interestPartyId: o.owner }];
  for (const m of ['begin', 'end']) { await bind(pool, C, ret, A.loanR, m, ownerRoute(A.loanR, 'f1120s.L.7', one)); await bind(pool, C, ret, A.loanP, m, ownerRoute(A.loanP, 'f1120s.L.19', one)); }
  await answerTypedItems(pool, C, ret);
  const facts = (await scheduleLFacts('form_1120s', [['f1120s.L.7', 20000], ['f1120s.L.19', 20000]])).map(([fieldId, cents]) => ({ factKind: 'schedule_l_end', fieldId, measurement: 'end', effectiveOn: '2024-12-31', amountCents: String(cents), state: 'known', provenance: { page: 4 }, reviewStatus: 'verified' }));
  const b = await importBaseline(pool, { ...C, payload: { importKey: 'filed-2024-poplar', payloadVersion: 1, kind: 'imported_filed', returnType: 'form_1120s', formEdition: 2024, bookBasis: 'accrual', consolidationPolicy: 'inclusion_edges',
    sourcePeriodStart: '2024-01-01', sourcePeriodEnd: '2024-12-31', sourceDocument: { hash: 'sha256:sample', pages: '1-5' }, extractionStatus: 'verified', facts }, actor: 'tester' });
  await setPredecessor(pool, { ...C, returnId: ret, baselineId: b.baselineId });
  const fid = new Map((await pool.query('SELECT fact_id, field_id FROM baseline_fact WHERE baseline_id = $1 AND row_key IS NULL', [b.baselineId])).rows.map(x => [x.field_id, Number(x.fact_id)]));
  for (const [l, a] of [['f1120s.L.7', A.loanR], ['f1120s.L.19', A.loanP]]) {
    await bridgeOpening(pool, { ...C, returnId: ret, factId: fid.get(l), rows: [{ accountId: a, allocatedCents: '20000', explanation: 'Accrued interest recorded by the preparer' }], approvedBy: 'tester' });
    await confirmOpeningBooks(pool, { ...C, returnId: ret, factId: fid.get(l), reviewedBy: 'tester' });
  }
  const k7 = (m, o = one) => `f1120s.L.7|interest=i:${o.id}|${m}`, k19 = m => `f1120s.L.19|interest=i:${one.id}|${m}`;
  const control = (r, what) => {
    for (const [k, v] of [[k7('begin'), 20000], [k7('end'), 20000], [k19('begin'), 20000], [k19('end'), 20000], [`${f.assets}|begin`, 20000], [`${f.assets}|end`, 25000], [`${f.total}|end`, 25000]]) knownField(r, k, v, what);
    assert.deepEqual(errorsOf(r).filter(c => c.code.startsWith('openings')), [], `${what}: no opening error`);
    assert.ok(!r.fields.some(x => x.fieldId === 'f1120s.L.8' && x.status === 'complete' && x.cents !== '0'), `${what}: nothing on line 8`);
  };
  control(await compute(pool, C, ret), 'control: the reviewed difference applied');
  const restore = () => bind(pool, C, ret, A.loanR, 'end', ownerRoute(A.loanR, 'f1120s.L.7', one));
  const heldOld = (r, what) => {
    for (const k of [k7('begin'), k7('end'), `${f.assets}|begin`, `${f.assets}|end`]) unknownField(r, k, what);
    for (const [k, v] of [[k19('begin'), 20000], [k19('end'), 20000], [`${f.cash}|end`, 5000]]) knownField(r, k, v, `${what}: independent balances`);
    assert.ok(errorsOf(r, 'openings_unmapped').some(c => /Loans to Shareholders/.test(c.message)), `${what}: the account is named`);
  };
  // 1. The ending route moved to line 8: the replacement field carries no raw 10,000 — it is unresolved with the old instance.
  await bind(pool, C, ret, A.loanR, 'end', [{ treatment: 'input', destination: 'f1120s.L.8' }]);
  let r = await compute(pool, C, ret);
  heldOld(r, 'moved to line 8');
  unknownField(r, 'f1120s.L.8|end', 'moved to line 8: the replacement field');
  await restore();
  control(await compute(pool, C, ret), 'restored after the move');
  // 2. The ending route removed: no destination at all for the ending — held, and the account is uncovered.
  await pool.query(`DELETE FROM tax_binding WHERE org_id = $1 AND return_id = $2 AND account_id = $3 AND measurement = 'end'`, [orgId, ret, A.loanR]);
  r = await compute(pool, C, ret);
  heldOld(r, 'ending route removed');
  await restore();
  control(await compute(pool, C, ret), 'restored after the removal');
  // 3. The ending split by share between the owner's line 7 and line 8: both destinations unresolved.
  await bind(pool, C, ret, A.loanR, 'end', [{ treatment: 'input', destination: 'f1120s.L.7', interestPartyId: one.owner, share: '1/2' }, { treatment: 'input', destination: 'f1120s.L.8', share: '1/2' }], { split: 'shares' });
  r = await compute(pool, C, ret);
  heldOld(r, 'ending split');
  unknownField(r, 'f1120s.L.8|end', 'ending split: the line 8 share');
  await restore();
  control(await compute(pool, C, ret), 'restored after the split');
  // 4. The ending routed to line 7 of the OTHER owner: that replacement instance is unresolved too.
  await bind(pool, C, ret, A.loanR, 'end', ownerRoute(A.loanR, 'f1120s.L.7', two));
  r = await compute(pool, C, ret);
  heldOld(r, 'replacement owner instance');
  unknownField(r, k7('end', two), 'replacement owner instance: the other owner’s ending');
  await restore();
  control(await compute(pool, C, ret), 'restored after the replacement instance: 20,000 once');
});

test('one operative-answer rule for candidates and orphans (Codex t3-r3 R3-2): accept v1, accept v2, neutral name, withdraw v2, restore v1 — the proposal awaits, amounts null; accept or reject through the API, once, with the history kept; accept v1, reject v2, restore v1 — waits; a current unchanged rejection stays fresh; both forms', async () => {
  for (const rt of ['form_1065', 'form_1120s']) for (const then of ['accept', 'reject']) {
    const what = `${rt}, then ${then}`;
    const T = await mealsCo(rt, `Walnut ${then}`), { f } = T;
    const v1 = await T.answer('Meals', 'accept');
    await T.rename('Staff Meals');
    const v2 = await T.answer('Staff Meals', 'accept');
    await T.rename('Staff costs');
    let r = await compute(pool, T.C, T.ret);
    const g2 = (await listAdjustments(pool, { orgId, returnId: T.ret })).find(g => g.source_version === v2.version);
    assert.deepEqual((r.orphanAnswers ?? []).map(g => g.group_id), [g2.group_id], `${what}: v2 is the operative orphan`);
    await withdrawAdjustment(pool, { ...T.S, groupId: g2.group_id, reason: 'Not meals any more', decidedBy: 'tester' });
    expectFull(await compute(pool, T.C, T.ret), f, `${what}: released`);
    // The exact version-1 source returns: v1 is history, v2 is retired — nothing decides the restored proposal.
    await T.rename('Meals');
    r = await compute(pool, T.C, T.ret);
    const again = r.proposals.find(x => x.accountName === 'Meals');
    assert.equal(again?.version, v1.version, `${what}: the version-1 proposal is computed again`);
    assert.equal(again.answer, null, `${what}: a superseded acceptance is not the answer`);
    for (const k of [`${f.other}|activity`, `${f.nondeductible}|activity`, `${f.ordinary}|activity`]) unknownField(r, k, `${what}: waiting`);
    assert.ok(errorsOf(r, 'proposal_open').length > 0 && errorsOf(r, 'proposal_orphan').length === 0, `${what}: waiting, not orphaned`);
    knownField(r, `${f.sales}|activity`, 50000, `${what}: an unrelated line`);
    // A current decision through the real API: saved despite the superseded row of the same version; applied once, or released.
    await T.answer('Meals', then);
    r = await compute(pool, T.C, T.ret);
    if (then === 'accept') { knownField(r, `${f.other}|activity`, 5000, `${what}: applied once`); knownField(r, `${f.nondeductible}|activity`, 5000, `${what}: applied once`); knownField(r, `${f.ordinary}|activity`, 45000, what); assert.equal(r.deltas.filter(d => d.source === 'proposal').length, 2, `${what}: one pair of delta lines`); }
    else expectFull(r, f, `${what}: released by the rejection`);
    assert.deepEqual(errorsOf(r, 'proposal_open'), [], `${what}: answered`);
    const groups = await listAdjustments(pool, { orgId, returnId: T.ret });
    const h1 = groups.find(g => g.source_version === v1.version && g.group_id !== r.proposals[0]?.answer?.group_id && g.status === 'accepted');
    assert.ok(h1 && h1.lines.length === 2, `${what}: the superseded v1 acceptance is kept with its lines`);
    assert.equal(groups.find(g => g.group_id === g2.group_id)?.status, 'withdrawn', `${what}: the retired v2 is kept`);
  }
  for (const rt of ['form_1065', 'form_1120s']) {
    // accept v1 → reject v2 → restore v1: the rejection is operative but of another version — the restored proposal waits, v1 is not revived.
    const T = await mealsCo(rt, 'Walnut rejected'), { f } = T;
    const v1 = await T.answer('Meals', 'accept');
    await T.rename('Staff Meals');
    await T.answer('Staff Meals', 'reject');
    await T.rename('Meals');
    const r = await compute(pool, T.C, T.ret);
    const again = r.proposals.find(x => x.accountName === 'Meals');
    assert.deepEqual([again?.version === v1.version, again?.answer?.fresh ?? null, again?.answer?.status ?? null], [true, false, 'rejected'], `${rt}: the later rejection is shown as the (stale) answer`);
    for (const k of [`${f.other}|activity`, `${f.nondeductible}|activity`]) unknownField(r, k, `${rt}: waits for a current answer`);
    assert.ok(errorsOf(r, 'proposal_open').length > 0, `${rt}: proposal_open`);
    // Control: a current, unchanged rejection stays fresh.
    const K = await mealsCo(rt, 'Walnut control');
    await K.answer('Meals', 'reject');
    const rk = await compute(pool, K.C, K.ret);
    assert.deepEqual([rk.proposals.find(x => x.accountName === 'Meals')?.answer?.fresh, errorsOf(rk, 'proposal_open')], [true, []], `${rt}: a fresh rejection stays the answer`);
    expectFull(rk, K.f, `${rt}: control`);
  }
});

test('an unmapped cost that could feed any trade’s cost of goods sold leaves aggregate COGS and applicability unknown even where no 1125-A instance exists (Codex t3-r3 R3-3): no workpaper at all; a reviewed trade beside an input-less trade; mapping-only, then a completed reconstruction (35,000); an explicit disposition restores a known sum; book income and the reviewed line 8 known throughout; both forms', async () => {
  for (const rt of ['form_1065', 'form_1120s']) {
    const f = F[rt], what = rt;
    const C = { orgId, entityId: await company(pool, orgId, `Hemlock ${f.suffix}`) };
    const ret = await period(pool, C, 2025, rt, { taxMethod: 'accrual' });
    const one = await activity(pool, C, { name: 'Hemlock retail' });
    const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), re: await acct(pool, C, 'Retained Earnings'), cost: await acct(pool, C, 'Production Costs', 'cost_of_goods_sold') };
    await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 50000]]);
    await je(pool, C, '2025-04-01', [[A.cost, 10000], [A.bank, -10000]]);
    await bindBalance(pool, C, ret, A.bank, f.cash);
    await bindBalance(pool, C, ret, A.re, f.re);
    await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
    await answerTypedItems(pool, C, ret);
    const bookNI = (r, tag) => { knownField(r, `${f.m1}|activity`, 40000, `${tag}: book income is measured`); knownField(r, `${f.sales}|activity`, 50000, `${tag}: an unrelated line`); };
    // No workpaper, no input, a trade that exists: the cost could still become its COGS.
    let r = await compute(pool, C, ret);
    unknownField(r, `${f.cogs}|activity`, `${what}, no workpaper: aggregate COGS`);
    assert.equal(r.applicability.facts.deductsCogs, 'unknown', `${what}, no workpaper: applicability`);
    unknownField(r, `${f.ordinary}|activity`, `${what}, no workpaper`);
    bookNI(r, `${what}, no workpaper`);
    // A reviewed trade beside an input-less trade: the reviewed line 8 is its own; the aggregate still waits on the second trade.
    const two = await activity(pool, C, { name: 'Hemlock parts' });
    await saveWorkpaper(pool, { ...C, returnId: ret, activityId: one, path: 'reviewed', treatment: 'inventory_as_booked', method: 'cost', reviewedLines: { '1': '0', '2': '250.00', '3': '0', '4': '0', '5': [], '7': '0' }, sourceNote: 'The count sheets', reviewedBy: 'tester' });
    r = await compute(pool, C, ret);
    knownField(r, kOf(8, one), 25000, `${what}, reviewed beside input-less: the reviewed line 8`);
    unknownField(r, `${f.cogs}|activity`, `${what}, reviewed beside input-less: aggregate COGS`);
    assert.equal(r.applicability.facts.deductsCogs, 'unknown', `${what}, reviewed beside input-less: applicability`);
    bookNI(r, `${what}, reviewed beside input-less`);
    // Mapping only (the second trade's purchases, no workpaper yet): still unresolved; its reconstruction completed: 35,000.
    await bind(pool, C, ret, A.cost, 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.2', activityId: two }]);
    r = await compute(pool, C, ret);
    unknownField(r, `${f.cogs}|activity`, `${what}, mapped, no workpaper`);
    knownField(r, kOf(8, one), 25000, `${what}, mapped, no workpaper: the reviewed line 8`);
    await saveWorkpaper(pool, { ...C, returnId: ret, activityId: two, path: 'reconstruct', treatment: 'inventory_as_booked', method: 'cost', begin: '0', end: '0', reviewedBy: 'tester' });
    r = await compute(pool, C, ret);
    knownField(r, `${f.cogs}|activity`, 35000, `${what}, reconstructed`);
    knownField(r, kOf(8, two), 10000, `${what}, reconstructed: once`);
    knownField(r, `${f.ordinary}|activity`, 15000, `${what}, reconstructed`);
    assert.equal(r.applicability.facts.deductsCogs, true, `${what}, reconstructed: applicability`);
    bookNI(r, `${what}, reconstructed`);
    // An explicit disposition instead (other deductions): nothing can enter the input-less trade's COGS any more — the aggregate is the reviewed one.
    await bind(pool, C, ret, A.cost, 'activity', [{ treatment: 'statement_row', destination: f.other }]);
    await pool.query('DELETE FROM tax_cogs_workpaper WHERE org_id = $1 AND return_id = $2 AND activity_id = $3', [orgId, ret, two]);
    r = await compute(pool, C, ret);
    knownField(r, `${f.cogs}|activity`, 25000, `${what}, disposed: the reviewed trade alone`);
    knownField(r, `${f.other}|activity`, 10000, `${what}, disposed`);
    knownField(r, `${f.ordinary}|activity`, 15000, `${what}, disposed`);
    assert.equal(r.applicability.facts.deductsCogs, true, `${what}, disposed: applicability`);
    assert.ok(!r.fields.some(x => x.fieldId.startsWith('f1125a.') && x.dims.activity === `act:${two}`), `${what}, disposed: no placeholder left on the input-less trade`);
    bookNI(r, `${what}, disposed`);
  }
});

test('an uncovered inventory activity holds the reconstructed cost of goods sold it could feed (Codex t3-r3 R3-4): net-zero inventory with gross movements, a zero predecessor, book COGS compared, an otherwise completed reconstruction — purchases, line 8, page-1 COGS, ordinary income, Schedule K and the M-1 endpoint unresolved while book income and a reviewed activity stay known; frozen; mapped, 10,000 consumed once; both forms', async () => {
  for (const rt of ['form_1065', 'form_1120s']) {
    const f = F[rt], what = rt;
    const C = { orgId, entityId: await company(pool, orgId, `Larch Inventory ${f.suffix}`) };
    const ret = await period(pool, C, 2025, rt, { taxMethod: 'accrual' });
    const one = await activity(pool, C, { name: 'Larch retail' }), two = await activity(pool, C, { name: 'Larch parts' });
    const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), re: await acct(pool, C, 'Retained Earnings'), inv: await acct(pool, C, 'Inventory Asset'), cogs: await acct(pool, C, 'Cost of Goods Sold') };
    await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 50000]]);
    await expense(pool, C, '2025-04-01', A.bank, [[A.inv, 10000]]);
    await rawTxn(pool, C, 'inventory_adjustment', '2025-05-01', [[A.cogs, 10000], [A.inv, -10000]], { accountId: A.inv });
    await bindBalance(pool, C, ret, A.bank, f.cash);
    await bindBalance(pool, C, ret, A.re, f.re);
    await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
    await bind(pool, C, ret, A.cogs, 'activity', [{ treatment: 'cogs_tieout', destination: 'f1125a.main.8', activityId: one }]);
    await answerTypedItems(pool, C, ret);
    await saveWorkpaper(pool, { ...C, returnId: ret, activityId: one, path: 'reconstruct', treatment: 'inventory_as_booked', method: 'cost', begin: '0', end: '0', reviewedBy: 'tester' });
    await saveWorkpaper(pool, { ...C, returnId: ret, activityId: two, path: 'reviewed', treatment: 'inventory_as_booked', method: 'cost', reviewedLines: { '1': '0', '2': '250.00', '3': '0', '4': '0', '5': [], '7': '0' }, sourceNote: 'The count sheets', reviewedBy: 'tester' });
    const facts = (await scheduleLFacts(rt, [])).map(([fieldId, cents]) => ({ factKind: 'schedule_l_end', fieldId, measurement: 'end', effectiveOn: '2024-12-31', amountCents: String(cents), state: 'known', provenance: { page: 4 }, reviewStatus: 'verified' }));
    const b = await importBaseline(pool, { ...C, payload: { importKey: `filed-2024-larch-${rt}`, payloadVersion: 1, kind: 'imported_filed', returnType: rt, formEdition: 2024, bookBasis: 'accrual', consolidationPolicy: 'inclusion_edges',
      sourcePeriodStart: '2024-01-01', sourcePeriodEnd: '2024-12-31', sourceDocument: { hash: 'sha256:sample', pages: '1-5' }, extractionStatus: 'verified', facts }, actor: 'tester' });
    await setPredecessor(pool, { ...C, returnId: ret, baselineId: b.baselineId });
    let r = await compute(pool, C, ret);
    assert.equal(r.cov.sources[0].accounts.find(a => a.accountId === A.inv)?.status, 'uncovered', `${what}: the inventory activity is uncovered`);
    for (const k of [kOf(2, one), kOf(8, one), `${f.cogs}|activity`, `${f.ordinary}|activity`, `${f.k1}|activity`, `${f.endpoint}|activity`]) unknownField(r, k, `${what}, uncovered`);
    knownField(r, `${f.m1}|activity`, 40000, `${what}, uncovered: book income is measured`);
    knownField(r, kOf(8, two), 25000, `${what}, uncovered: the reviewed activity`);
    knownField(r, `${f.sales}|activity`, 50000, `${what}, uncovered: an unrelated line`);
    const { revisionNo } = await takeWorkingRevision(pool, { ...C, returnId: ret, takenBy: 'tester' });
    const saved = await getRevision(pool, { ...C, returnId: ret, revisionNo });
    assert.deepEqual(saved.results.fields.filter(x => x.key === `${f.ordinary}|activity`).map(x => [x.cents, x.status]), [[null, 'unresolved']], `${what}: the revision keeps the unknown`);
    // The inventory activity routed to the workpaper's purchases: consumed once.
    await bind(pool, C, ret, A.inv, 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.2', activityId: one }]);
    r = await compute(pool, C, ret);
    for (const [k, v] of [[kOf(2, one), 10000], [kOf(8, one), 10000], [`${f.cogs}|activity`, 35000], [`${f.ordinary}|activity`, 15000], [`${f.k1}|activity`, 15000], [`${f.m1}|activity`, 40000]]) knownField(r, k, v, `${what}, mapped`);
    assert.deepEqual(errorsOf(r).map(c => c.code).filter(c => c !== 'cogs'), [], `${what}, mapped: no error (${errorsOf(r).map(c => c.message.slice(0, 60)).join(' ; ')})`);
  }
});

const LINV = { form_1065: 'f1065.L.3', form_1120s: 'f1120s.L.3' };
// A zero (or given) predecessor for a company, verified and complete.
const zeroPredecessor = async (C, ret, rt, given = [], tag = '', bookBasis = 'accrual') => {
  const facts = (await scheduleLFacts(rt, given)).map(([fieldId, cents]) => ({ factKind: 'schedule_l_end', fieldId, measurement: 'end', effectiveOn: '2024-12-31', amountCents: String(cents), state: 'known', provenance: { page: 4 }, reviewStatus: 'verified' }));
  const b = await importBaseline(pool, { ...C, payload: { importKey: `filed-2024-${C.entityId}-${tag}`, payloadVersion: 1, kind: 'imported_filed', returnType: rt, formEdition: 2024, bookBasis, consolidationPolicy: 'inclusion_edges',
    sourcePeriodStart: '2024-01-01', sourcePeriodEnd: '2024-12-31', sourceDocument: { hash: 'sha256:sample', pages: '1-5' }, extractionStatus: 'verified', facts }, actor: 'tester' });
  await setPredecessor(pool, { ...C, returnId: ret, baselineId: b.baselineId });
  return b;
};
const reviewedPaper = (C, ret, act) => saveWorkpaper(pool, { ...C, returnId: ret, activityId: act, path: 'reviewed', treatment: 'inventory_as_booked', method: 'cost', reviewedLines: { '1': '0', '2': '250.00', '3': '0', '4': '0', '5': [], '7': '0' }, sourceNote: 'The count sheets', reviewedBy: 'tester' });
const builtPaper = (C, ret, act, begin = '0', end = '0') => saveWorkpaper(pool, { ...C, returnId: ret, activityId: act, path: 'reconstruct', treatment: 'inventory_as_booked', method: 'cost', begin, end, reviewedBy: 'tester' });
const frozenUnknown = async (C, ret, key, what) => { const { revisionNo } = await takeWorkingRevision(pool, { ...C, returnId: ret, takenBy: 'tester' }); const saved = await getRevision(pool, { ...C, returnId: ret, revisionNo }); assert.deepEqual(saved.results.fields.filter(x => x.key === key).map(x => [x.cents, x.status]), [[null, 'unresolved']], `${what}: the revision keeps the unknown`); };

test('an inventory account with gross movements needs an activity disposition whatever its balances (Codex t3-r4 R4-1): a 10,000 purchase relieved by 9,000 with the balances mapped and the activity not — reconstructed costs, line 8, page-1 COGS and the dependent totals unresolved and frozen, book income, a reviewed activity and an uncovered prepaid independent; mapped, 10,000 once (COGS 9,000); a nonzero beginning inventory; an explicit alternative disposition; both forms', async () => {
  for (const rt of ['form_1065', 'form_1120s']) for (const variant of ['zero', 'opening']) {
    const f = F[rt], what = `${rt}, ${variant} beginning inventory`;
    const C = { orgId, entityId: await company(pool, orgId, `Fir ${variant} ${f.suffix}`) };
    const ret = await period(pool, C, 2025, rt, { taxMethod: 'accrual' });
    const one = await activity(pool, C, { name: 'Fir retail' }), two = await activity(pool, C, { name: 'Fir parts' });
    const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), re: await acct(pool, C, 'Retained Earnings'), inv: await acct(pool, C, 'Inventory Asset'), cogs: await acct(pool, C, 'Cost of Goods Sold'), util: await acct(pool, C, 'Utilities'), prepaid: await acct(pool, C, 'Prepaid Expenses') };
    const opening = variant === 'opening' ? 3000 : 0;
    if (opening) await expense(pool, C, '2024-11-01', A.bank, [[A.inv, opening]]);
    await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 50000]]);
    await expense(pool, C, '2025-04-01', A.bank, [[A.inv, 10000]]);
    await rawTxn(pool, C, 'inventory_adjustment', '2025-05-01', [[A.cogs, 9000], [A.inv, -9000]], { accountId: A.inv });
    // A prepaid paid and used up within the year (its activity needs a disposition too): never the return's income.
    await expense(pool, C, '2025-06-01', A.bank, [[A.prepaid, 2000]]);
    await je(pool, C, '2025-07-01', [[A.util, 2000], [A.prepaid, -2000]]);
    await bindBalance(pool, C, ret, A.bank, f.cash);
    await bindBalance(pool, C, ret, A.re, f.re);
    await bindBalance(pool, C, ret, A.inv, LINV[rt]);
    await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
    await bind(pool, C, ret, A.util, 'activity', [{ treatment: 'statement_row', destination: f.other }]);
    await bind(pool, C, ret, A.cogs, 'activity', [{ treatment: 'cogs_tieout', destination: 'f1125a.main.8', activityId: one }]);
    await answerTypedItems(pool, C, ret);
    await builtPaper(C, ret, one, String(opening / 100), opening ? '40.00' : '10.00');
    await reviewedPaper(C, ret, two);
    await zeroPredecessor(C, ret, rt, opening ? [[LINV[rt], opening], [f.cash, -opening]] : [], variant);
    let r = await compute(pool, C, ret);
    for (const k of [kOf(2, one), kOf(8, one), `${f.cogs}|activity`, `${f.ordinary}|activity`, `${f.k1}|activity`, `${f.endpoint}|activity`]) unknownField(r, k, `${what}, undisposed`);
    knownField(r, `${f.m1}|activity`, 39000, `${what}, undisposed: book income is measured`);
    knownField(r, kOf(8, two), 25000, `${what}, undisposed: the reviewed activity`);
    knownField(r, `${f.other}|activity`, 2000, `${what}, undisposed: an unrelated deduction`);
    assert.ok(errorsOf(r, 'inventory_activity').some(c => /Inventory Asset/.test(c.message)), `${what}: the missing disposition is an error of its own`);
    await frozenUnknown(C, ret, `${f.ordinary}|activity`, what);
    // Mapped to the workpaper's purchases: consumed once; the prepaid's activity still undisposed and still nobody's income.
    await bind(pool, C, ret, A.inv, 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.2', activityId: one }]);
    r = await compute(pool, C, ret);
    for (const [k, v] of [[kOf(2, one), 10000], [kOf(8, one), 9000], [`${f.cogs}|activity`, 34000], [`${f.ordinary}|activity`, 50000 - 34000 - 2000], [`${f.m1}|activity`, 39000]]) knownField(r, k, v, `${what}, mapped`);
    assert.equal(r.cov.sources[0].accounts.find(a => a.accountId === A.prepaid)?.status, 'uncovered', `${what}: the prepaid stays a coverage item`);
    assert.deepEqual(errorsOf(r, 'inventory_activity'), [], `${what}, mapped: disposed`);
    // An explicit alternative disposition instead: not on the return — the workpaper's purchases are a known zero by that decision.
    await bind(pool, C, ret, A.inv, 'activity', [{ treatment: 'not_tax', memo: 'counted in the reviewed figures' }]);
    r = await compute(pool, C, ret);
    knownField(r, kOf(2, one), 0, `${what}, disposed otherwise`);
    knownField(r, kOf(8, one), opening ? 3000 - 4000 : -1000, `${what}, disposed otherwise`);
    assert.deepEqual(errorsOf(r, 'inventory_activity'), [], `${what}, disposed otherwise`);
  }
});

test('missing cost inputs stay unknown beside an independently assigned 1125-A input (Codex t3-r4 R4-3): a trade without a workpaper, only its tax beginning inventory typed (zero, then nonzero), a cost line partly typed — line 8, page-1 COGS and applicability unknown with the typed values kept; a reviewed control and the mapping-and-reconstruction recovery; both forms', async () => {
  for (const rt of ['form_1065', 'form_1120s']) {
    const f = F[rt], what = rt;
    const C = { orgId, entityId: await company(pool, orgId, `Yew Typed ${f.suffix}`) };
    const ret = await period(pool, C, 2025, rt, { taxMethod: 'accrual' });
    const one = await activity(pool, C, { name: 'Yew retail' }), two = await activity(pool, C, { name: 'Yew parts' });
    const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), re: await acct(pool, C, 'Retained Earnings'), cost: await acct(pool, C, 'Production Costs', 'cost_of_goods_sold') };
    await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 50000]]);
    await je(pool, C, '2025-04-01', [[A.cost, 10000], [A.bank, -10000]]);
    await bindBalance(pool, C, ret, A.bank, f.cash);
    await bindBalance(pool, C, ret, A.re, f.re);
    await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
    await reviewedPaper(C, ret, two);
    const assign = async (n, amount) => { await assignProvider(pool, { ...C, returnId: ret, slotKey: kOf(n, one), providerKind: 'manual', schemaVersion: 1, sourceRef: { reason: 'count sheet' }, sourceVersion: `manual:count@${n}` }); await saveManualItem(pool, { ...C, returnId: ret, itemKey: kOf(n, one), status: 'entered', amount, enteredBy: 'tester' }); };
    await assign(1, '0.00');
    await answerTypedItems(pool, C, ret);
    const expectOpen = (r, tag, line1) => {
      knownField(r, kOf(1, one), line1, `${tag}: the typed inventory is kept`);
      for (const k of [kOf(8, one), `${f.cogs}|activity`, `${f.ordinary}|activity`]) unknownField(r, k, tag);
      assert.equal(r.applicability.facts.deductsCogs, 'unknown', `${tag}: applicability`);
      knownField(r, kOf(8, two), 25000, `${tag}: the reviewed control`);
      knownField(r, `${f.m1}|activity`, 40000, `${tag}: book income`);
    };
    expectOpen(await compute(pool, C, ret), `${what}, typed zero beginning`, 0);
    await saveManualItem(pool, { ...C, returnId: ret, itemKey: kOf(1, one), status: 'entered', amount: '500.00', enteredBy: 'tester' });
    expectOpen(await compute(pool, C, ret), `${what}, typed nonzero beginning`, 50000);
    await assign(3, '100.00');
    let r = await compute(pool, C, ret);
    expectOpen(r, `${what}, a cost line typed`, 50000);
    knownField(r, kOf(3, one), 10000, `${what}: the typed labor is kept`);
    // Recovery: the typed items released, the cost mapped to purchases (no workpaper: still unknown), then the reconstruction completed.
    await pool.query('DELETE FROM tax_provider_assignment WHERE org_id = $1 AND return_id = $2', [orgId, ret]);
    await pool.query(`DELETE FROM tax_manual_item WHERE org_id = $1 AND return_id = $2 AND item_key LIKE 'f1125a.%'`, [orgId, ret]);
    await bind(pool, C, ret, A.cost, 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.2', activityId: one }]);
    r = await compute(pool, C, ret);
    unknownField(r, `${f.cogs}|activity`, `${what}, mapped, no workpaper`);
    await builtPaper(C, ret, one);
    r = await compute(pool, C, ret);
    for (const [k, v] of [[kOf(8, one), 10000], [`${f.cogs}|activity`, 35000], [`${f.ordinary}|activity`, 15000]]) knownField(r, k, v, `${what}, reconstructed`);
    assert.equal(r.applicability.facts.deductsCogs, true, `${what}, reconstructed: applicability`);
  }
});

test('activity uncertainty reaches the reconstructible cost inputs, never the entered tax inventory (Codex t3-r4 R4-5): beginning 12,300 and ending 4,500 stay complete while purchases, line 8 and the dependent totals wait — an undisposed inventory movement, then an unmapped cost; frozen; mapping-only recovery; a reviewed activity independent; both forms', async () => {
  for (const rt of ['form_1065', 'form_1120s']) for (const source of ['inventory', 'cost']) {
    const f = F[rt], what = `${rt}, undisposed ${source}`;
    const C = { orgId, entityId: await company(pool, orgId, `Ash ${source} ${f.suffix}`) };
    const ret = await period(pool, C, 2025, rt, { taxMethod: 'accrual' });
    const one = await activity(pool, C, { name: 'Ash retail' }), two = await activity(pool, C, { name: 'Ash parts' });
    const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), re: await acct(pool, C, 'Retained Earnings'), inv: await acct(pool, C, 'Inventory Asset'), cogs: await acct(pool, C, 'Cost of Goods Sold'), cost: await acct(pool, C, 'Production Costs', 'cost_of_goods_sold') };
    await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 50000]]);
    await expense(pool, C, '2025-04-01', A.bank, [[A.inv, 10000]]);
    await rawTxn(pool, C, 'inventory_adjustment', '2025-05-01', [[A.cogs, 10000], [A.inv, -10000]], { accountId: A.inv });
    if (source === 'cost') await je(pool, C, '2025-04-02', [[A.cost, 3000], [A.bank, -3000]]);
    await bindBalance(pool, C, ret, A.bank, f.cash);
    await bindBalance(pool, C, ret, A.re, f.re);
    await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
    await bind(pool, C, ret, A.cogs, 'activity', [{ treatment: 'cogs_tieout', destination: 'f1125a.main.8', activityId: one }]);
    const route = () => bind(pool, C, ret, A.inv, 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.2', activityId: one }]);
    await route();
    if (source === 'cost') await bind(pool, C, ret, A.cost, 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.5', activityId: one }]);
    await answerTypedItems(pool, C, ret);
    await builtPaper(C, ret, one, '123.00', '45.00');
    await reviewedPaper(C, ret, two);
    await zeroPredecessor(C, ret, rt, [], source);
    const other = source === 'cost' ? 3000 : 0;
    let r = await compute(pool, C, ret);
    for (const [k, v] of [[kOf(1, one), 12300], [kOf(7, one), 4500], [kOf(2, one), 10000], [kOf(8, one), 12300 + 10000 + other - 4500]]) knownField(r, k, v, `${what}, routed`);
    // The source undisposed: the inventory route removed, or the cost's binding removed.
    if (source === 'inventory') await pool.query(`DELETE FROM tax_binding WHERE org_id = $1 AND return_id = $2 AND account_id = $3 AND measurement = 'activity'`, [orgId, ret, A.inv]);
    else await pool.query(`DELETE FROM tax_binding WHERE org_id = $1 AND return_id = $2 AND account_id = $3`, [orgId, ret, A.cost]);
    r = await compute(pool, C, ret);
    knownField(r, kOf(1, one), 12300, `${what}: the entered beginning inventory`);
    knownField(r, kOf(7, one), 4500, `${what}: the entered ending inventory`);
    for (const k of [kOf(2, one), kOf(8, one), `${f.cogs}|activity`, `${f.ordinary}|activity`]) unknownField(r, k, `${what}: the reconstructible costs and what depends on them`);
    knownField(r, `${f.m1}|activity`, 50000 - 10000 - other, `${what}: book income`);
    knownField(r, kOf(8, two), 25000, `${what}: the reviewed activity`);
    await frozenUnknown(C, ret, kOf(8, one), what);
    const saved = await getRevision(pool, { ...C, returnId: ret, revisionNo: 1 });
    assert.deepEqual(saved.results.fields.filter(x => x.key === kOf(1, one)).map(x => [x.cents, x.status]), [['12300', 'complete']], `${what}: the revision keeps the entered inventory`);
    // Mapping only restores everything.
    if (source === 'inventory') await route(); else await bind(pool, C, ret, A.cost, 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.5', activityId: one }]);
    r = await compute(pool, C, ret);
    for (const [k, v] of [[kOf(1, one), 12300], [kOf(7, one), 4500], [kOf(2, one), 10000], [kOf(8, one), 12300 + 10000 + other - 4500], [`${f.cogs}|activity`, 12300 + 10000 + other - 4500 + 25000]]) knownField(r, k, v, `${what}, routed again`);
  }
});

test('every opening failure follows the account to its actual destinations, by provider consumption (Codex t3-r4 R4-2, R4-4): an unbridged mismatch, absent and unknown facts and an unreviewed allocation with the receivable’s ending moved to line 8 or split — line 8 ending null and unresolved with the old instance and the totals; a proper review recovers; a manual-provider replacement ending of 30,000 stays known while the original opening stays unresolved', async () => {
  const f = F.form_1120s;
  const mk = async (C, name) => { const owner = await party(pool, orgId, name); await saveInterest(pool, { ...C, fields: { partyId: owner, role: 'shareholder', from: '2020-01-01', to: null, profit: '1/1', loss: '1/1', capital: '1/1' }, actor: 'tester' }); return { owner, id: await interestOf(C, owner) }; };
  const setup = async name => {
    const C = { orgId, entityId: await company(pool, orgId, `Sycamore ${name} Corp`) };
    const ret = await period(pool, C, 2025, 'form_1120s', { taxMethod: 'accrual' });
    const one = await mk(C, `Sample Sycamore ${name} Owner`);
    const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), re: await acct(pool, C, 'Retained Earnings'), loanR: await acct(pool, C, 'Loans to Shareholders', 'other_current_asset'), loanR2: await acct(pool, C, 'Second Loan to Shareholders', 'other_current_asset'), loanP: await acct(pool, C, 'Loans from Shareholders', 'other_current_liability') };
    await je(pool, C, '2024-06-01', [[A.loanR, 10000], [A.loanP, -10000]]);
    await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 5000]]);
    await bindBalance(pool, C, ret, A.bank, f.cash);
    await bindBalance(pool, C, ret, A.re, f.re);
    await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
    const ownerRoute = (destination, o = one) => [{ treatment: 'input', destination, interestPartyId: o.owner }];
    for (const m of ['begin', 'end']) { await bind(pool, C, ret, A.loanR, m, ownerRoute('f1120s.L.7')); await bind(pool, C, ret, A.loanP, m, ownerRoute('f1120s.L.19')); }
    await answerTypedItems(pool, C, ret);
    let n = 0;
    const filed = async (given, { drop = [], unknown = [] } = {}) => {
      await pool.query('DELETE FROM opening_bridge WHERE org_id = $1 AND return_id = $2', [orgId, ret]);
      const facts = (await scheduleLFacts('form_1120s', given)).filter(([fid]) => !drop.includes(fid)).map(([fieldId, cents]) => ({ factKind: 'schedule_l_end', fieldId, measurement: 'end', effectiveOn: '2024-12-31', amountCents: unknown.includes(fieldId) ? null : String(cents), state: unknown.includes(fieldId) ? 'unknown' : 'known', provenance: { page: 4 }, reviewStatus: 'verified' }));
      n += 1;
      const b = await importBaseline(pool, { ...C, payload: { importKey: `filed-2024-${name}-${n}`, payloadVersion: 1, kind: 'imported_filed', returnType: 'form_1120s', formEdition: 2024, bookBasis: 'accrual', consolidationPolicy: 'inclusion_edges',
        sourcePeriodStart: '2024-01-01', sourcePeriodEnd: '2024-12-31', sourceDocument: { hash: 'sha256:sample', pages: '1-5' }, extractionStatus: 'verified', facts }, actor: 'tester' });
      await setPredecessor(pool, { ...C, returnId: ret, baselineId: b.baselineId });
      return b;
    };
    const k7 = (m, o = one) => `f1120s.L.7|interest=i:${o.id}|${m}`, k19 = m => `f1120s.L.19|interest=i:${one.id}|${m}`;
    return { C, ret, one, A, ownerRoute, filed, k7, k19 };
  };
  // Part 1 (R4-2): the ordinary checks, no bridge — the books-fed replacement ending is held with the old instance.
  {
    const { C, ret, A, ownerRoute, filed, k7, k19 } = await setup('unbridged');
    const moveEnd = () => bind(pool, C, ret, A.loanR, 'end', [{ treatment: 'input', destination: 'f1120s.L.8' }]);
    const restoreEnd = () => bind(pool, C, ret, A.loanR, 'end', ownerRoute('f1120s.L.7'));
    const held = (r, what) => {
      unknownField(r, 'f1120s.L.8|end', `${what}: the replacement ending`);
      for (const k of [k7('begin'), k7('end'), `${f.assets}|begin`, `${f.assets}|end`]) unknownField(r, k, what);
      knownField(r, `${f.cash}|end`, 5000, `${what}: an independent balance`);
      assert.ok(!r.fields.some(x => x.fieldId === 'f1120s.L.7' && !Object.keys(x.dims).length), `${what}: no unscoped owner key`);
    };
    await filed([['f1120s.L.7', 20000], ['f1120s.L.19', 20000]]);
    await moveEnd();
    let r = await compute(pool, C, ret);
    held(r, 'mismatch, ending moved');
    assert.ok(errorsOf(r, 'openings_unexplained').some(c => /Loans to shareholders/.test(c.message)), 'mismatch: the error');
    await filed([], { drop: ['f1120s.L.7', 'f1120s.L.19'] });
    held(await compute(pool, C, ret), 'absent fact, ending moved');
    await filed([['f1120s.L.7', 0], ['f1120s.L.19', 0]], { unknown: ['f1120s.L.7', 'f1120s.L.19'] });
    held(await compute(pool, C, ret), 'unknown fact, ending moved');
    // An allocation needed (two accounts open on the owner's line 7, no bridge), the first one's ending split between the owner line and line 8.
    await restoreEnd();
    await je(pool, C, '2024-06-02', [[A.loanR2, 5000], [A.loanP, -5000]]);
    for (const m of ['begin', 'end']) await bind(pool, C, ret, A.loanR2, m, ownerRoute('f1120s.L.7'));
    await filed([['f1120s.L.7', 15000], ['f1120s.L.19', 15000]]);
    await bind(pool, C, ret, A.loanR, 'end', [{ treatment: 'input', destination: 'f1120s.L.7', interestPartyId: (await pool.query('SELECT party_id FROM ownership_interest WHERE entity_id = $1 LIMIT 1', [C.entityId])).rows[0].party_id, share: '1/2' }, { treatment: 'input', destination: 'f1120s.L.8', share: '1/2' }], { split: 'shares' });
    r = await compute(pool, C, ret);
    held(r, 'allocation needed, ending split');
    assert.ok(errorsOf(r, 'openings_unreviewed').length > 0, 'allocation needed: the error');
    // A proper review: the ending restored, the filed amount allocated to both accounts and the books amounts recorded.
    await restoreEnd();
    const b = await filed([['f1120s.L.7', 15000], ['f1120s.L.19', 15000]]);
    const { rows: [fact] } = await pool.query(`SELECT fact_id FROM baseline_fact WHERE baseline_id = $1 AND field_id = 'f1120s.L.7' AND row_key IS NULL`, [b.baselineId]);
    await bridgeOpening(pool, { ...C, returnId: ret, factId: Number(fact.fact_id), rows: [{ accountId: A.loanR, allocatedCents: '10000', explanation: 'Loan statements' }, { accountId: A.loanR2, allocatedCents: '5000', explanation: 'Loan statements' }], approvedBy: 'tester' });
    await confirmOpeningBooks(pool, { ...C, returnId: ret, factId: Number(fact.fact_id), reviewedBy: 'tester' });
    r = await compute(pool, C, ret);
    for (const [k, v] of [[k7('begin'), 15000], [k7('end'), 15000], [k19('begin'), 15000], [`${f.assets}|begin`, 15000], [`${f.assets}|end`, 20000]]) knownField(r, k, v, 'reviewed');
    assert.deepEqual(errorsOf(r).filter(c => c.code.startsWith('openings')), [], 'reviewed: no opening error');
  }
  // Part 2 (R4-4): a manual-provider replacement ending beside the moved route keeps its entered amount; the original opening stays unresolved.
  {
    const { C, ret, A, ownerRoute, filed, k7 } = await setup('typed');
    const b = await filed([['f1120s.L.7', 20000], ['f1120s.L.19', 20000]]);
    const fid = new Map((await pool.query('SELECT fact_id, field_id FROM baseline_fact WHERE baseline_id = $1 AND row_key IS NULL', [b.baselineId])).rows.map(x => [x.field_id, Number(x.fact_id)]));
    for (const [l, a] of [['f1120s.L.7', A.loanR], ['f1120s.L.19', A.loanP]]) {
      await bridgeOpening(pool, { ...C, returnId: ret, factId: fid.get(l), rows: [{ accountId: a, allocatedCents: '20000', explanation: 'Accrued interest recorded by the preparer' }], approvedBy: 'tester' });
      await confirmOpeningBooks(pool, { ...C, returnId: ret, factId: fid.get(l), reviewedBy: 'tester' });
    }
    knownField(await compute(pool, C, ret), k7('end'), 20000, 'typed: the bridged control');
    await assignProvider(pool, { ...C, returnId: ret, slotKey: 'f1120s.L.8|end', providerKind: 'manual', schemaVersion: 1, sourceRef: { reason: 'loan statement' }, sourceVersion: 'manual:loan8@1' });
    await saveManualItem(pool, { ...C, returnId: ret, itemKey: 'f1120s.L.8|end', status: 'entered', amount: '300.00', enteredBy: 'tester' });
    let r = await compute(pool, C, ret);
    knownField(r, 'f1120s.L.8|end', 30000, 'typed: before the route beside it');
    knownField(r, k7('end'), 20000, 'typed: the bridged owner instance');
    await bind(pool, C, ret, A.loanR, 'end', [{ treatment: 'input', destination: 'f1120s.L.8' }]);
    r = await compute(pool, C, ret);
    knownField(r, 'f1120s.L.8|end', 30000, 'typed: the independent replacement ending stays known beside the moved route');
    for (const k of [k7('begin'), k7('end')]) unknownField(r, k, 'typed: the original opening stays unresolved');
    assert.ok(errorsOf(r, 'openings_unmapped').some(c => /Loans to Shareholders/.test(c.message)), 'typed: the opening failure is still reported');
    await bind(pool, C, ret, A.loanR, 'end', [{ treatment: 'not_tax', memo: 'repaid in the period' }]);
    r = await compute(pool, C, ret);
    knownField(r, 'f1120s.L.8|end', 30000, 'typed: with the route not on the return');
    assert.ok(errorsOf(r, 'openings_unmapped').length > 0, 'typed: the opening failure is still reported');
    await bind(pool, C, ret, A.loanR, 'end', ownerRoute('f1120s.L.7'));
    r = await compute(pool, C, ret);
    knownField(r, k7('end'), 20000, 'typed: restored, 20,000 once');
    knownField(r, 'f1120s.L.8|end', 30000, 'typed: the typed ending stands on its own');
  }
});

// Attribute one posting line of an account (the line on that account of the given transaction) to a target.
const attributeOne = async (C, ret, accountId, txnId, target) => {
  const lines = (await measureLines(pool, { orgId, sourceEntityId: C.entityId, accountIds: [accountId], periodStart: '2025-01-01', periodEnd: '2025-12-31', returnId: ret })).get(accountId) ?? [];
  const l = lines.find(x => x.txnId === txnId);
  await attributeLine(pool, { ...C, returnId: ret, sourceEntityId: C.entityId, accountId, txnId, lineNo: l.lineNo, expectTxnVersion: l.txnVersion, target, actor: 'tester' });
};

test('source completeness is read from the partition, not from the existence of a disposition (Codex t3-r5 R5-1): the inventory relief alone attributed not on the return leaves the undisposed purchase holding the reconstructed costs and income; a P&L expense with one of two postings attributed (a nonzero, then a net-zero residual) holds its line and income; a fully attributed disposition releases; mapping-only recovery; frozen; both forms', async () => {
  for (const rt of ['form_1065', 'form_1120s']) {
    const f = F[rt], what = rt;
    // Inventory: the R4-1 books, then only the -9,000 relief line disposed of.
    {
      const C = { orgId, entityId: await company(pool, orgId, `Cedar Partial ${f.suffix}`) };
      const ret = await period(pool, C, 2025, rt, { taxMethod: 'accrual' });
      const one = await activity(pool, C, { name: 'Cedar retail' }), two = await activity(pool, C, { name: 'Cedar parts' });
      const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), re: await acct(pool, C, 'Retained Earnings'), inv: await acct(pool, C, 'Inventory Asset'), cogs: await acct(pool, C, 'Cost of Goods Sold') };
      await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 50000]]);
      await expense(pool, C, '2025-04-01', A.bank, [[A.inv, 10000]]);
      const relief = await rawTxn(pool, C, 'inventory_adjustment', '2025-05-01', [[A.cogs, 9000], [A.inv, -9000]], { accountId: A.inv });
      await bindBalance(pool, C, ret, A.bank, f.cash);
      await bindBalance(pool, C, ret, A.re, f.re);
      await bindBalance(pool, C, ret, A.inv, LINV[rt]);
      await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
      await bind(pool, C, ret, A.cogs, 'activity', [{ treatment: 'cogs_tieout', destination: 'f1125a.main.8', activityId: one }]);
      await answerTypedItems(pool, C, ret);
      await builtPaper(C, ret, one, '0', '10.00');
      await reviewedPaper(C, ret, two);
      await zeroPredecessor(C, ret, rt, [], 'partial');
      await attributeOne(C, ret, A.inv, relief, { treatment: 'not_tax', memo: 'relief, counted through the ending count' });
      let r = await compute(pool, C, ret);
      assert.equal(r.cov.sources[0].accounts.find(a => a.accountId === A.inv)?.results?.activity?.status, 'unresolved', `${what}, inventory: the partition says the rest is undisposed`);
      for (const k of [kOf(2, one), kOf(8, one), `${f.cogs}|activity`, `${f.ordinary}|activity`, `${f.k1}|activity`]) unknownField(r, k, `${what}, inventory partly disposed`);
      knownField(r, `${f.m1}|activity`, 41000, `${what}, inventory partly disposed: book income`);
      knownField(r, kOf(8, two), 25000, `${what}, inventory partly disposed: the reviewed activity`);
      knownField(r, kOf(7, one), 1000, `${what}, inventory partly disposed: the entered ending inventory`);
      assert.ok(errorsOf(r, 'inventory_activity').length > 0, `${what}, inventory partly disposed: the error`);
      await frozenUnknown(C, ret, `${f.ordinary}|activity`, `${what}, inventory partly disposed`);
      // The attribution removed and the whole activity routed to the workpaper's purchases (a reconstruction takes a whole account): 10,000 once.
      await pool.query('DELETE FROM tax_binding_line WHERE org_id = $1 AND return_id = $2 AND account_id = $3', [orgId, ret, A.inv]);
      await bind(pool, C, ret, A.inv, 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.2', activityId: one }]);
      r = await compute(pool, C, ret);
      for (const [k, v] of [[kOf(2, one), 10000], [kOf(8, one), 9000], [`${f.cogs}|activity`, 34000], [`${f.ordinary}|activity`, 16000]]) knownField(r, k, v, `${what}, inventory fully disposed`);
      assert.deepEqual(errorsOf(r, 'inventory_activity'), [], `${what}, inventory fully disposed`);
    }
    // An expense account: 4,000 and 6,000 posted, only the 4,000 line attributed not on the return.
    {
      const C = { orgId, entityId: await company(pool, orgId, `Cedar Expense ${f.suffix}`) };
      const ret = await period(pool, C, 2025, rt, { taxMethod: 'accrual' });
      const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), re: await acct(pool, C, 'Retained Earnings'), util: await acct(pool, C, 'Utilities') };
      await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 50000]]);
      const first = await je(pool, C, '2025-04-01', [[A.util, 4000], [A.bank, -4000]]);
      const second = await je(pool, C, '2025-05-01', [[A.util, 6000], [A.bank, -6000]]);
      await bindBalance(pool, C, ret, A.bank, f.cash);
      await bindBalance(pool, C, ret, A.re, f.re);
      await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
      await answerTypedItems(pool, C, ret);
      await attributeOne(C, ret, A.util, first, { treatment: 'not_tax', memo: 'the owner’s share' });
      let r = await compute(pool, C, ret);
      for (const k of [`${f.other}|activity`, `${f.deductions}|activity`, `${f.ordinary}|activity`, `${f.k1}|activity`]) unknownField(r, k, `${what}, expense partly disposed`);
      knownField(r, `${f.sales}|activity`, 50000, `${what}, expense partly disposed: an unrelated line`);
      knownField(r, `${f.m1}|activity`, 40000, `${what}, expense partly disposed: book income`);
      await frozenUnknown(C, ret, `${f.ordinary}|activity`, `${what}, expense partly disposed`);
      // A net-zero residual is undisposed too: two more lines that cancel.
      const plus = await je(pool, C, '2025-06-01', [[A.util, 3000], [A.bank, -3000]]), minus = await je(pool, C, '2025-06-02', [[A.bank, 3000], [A.util, -3000]]);
      await attributeOne(C, ret, A.util, second, { treatment: 'statement_row', destination: f.other });
      r = await compute(pool, C, ret);
      unknownField(r, `${f.other}|activity`, `${what}, net-zero residual undisposed`);
      unknownField(r, `${f.ordinary}|activity`, `${what}, net-zero residual undisposed`);
      // Every line attributed: a complete, current disposition releases.
      await attributeOne(C, ret, A.util, plus, { treatment: 'not_tax', memo: 'personal' });
      await attributeOne(C, ret, A.util, minus, { treatment: 'not_tax', memo: 'personal' });
      r = await compute(pool, C, ret);
      knownField(r, `${f.other}|activity`, 6000, `${what}, fully attributed`);
      knownField(r, `${f.ordinary}|activity`, 44000, `${what}, fully attributed`);
      // Or the residual bound (mapping only): known.
      await pool.query('DELETE FROM tax_binding_line WHERE org_id = $1 AND return_id = $2 AND txn_id = ANY($3::bigint[])', [orgId, ret, [plus, minus]]);
      await bind(pool, C, ret, A.util, 'activity', [{ treatment: 'not_tax', memo: 'personal' }]);
      r = await compute(pool, C, ret);
      knownField(r, `${f.other}|activity`, 6000, `${what}, residual bound`);
      knownField(r, `${f.ordinary}|activity`, 44000, `${what}, residual bound`);
    }
  }
});

test('detected COGS uncertainty reaches the aggregate even with no trade activity to carry it (Codex t3-r5 R5-2): an undisposed inventory purchase and no activity — page-1 COGS, dependent totals and applicability unknown, frozen; an activity not in effect counts as absent; an empty trade changes nothing; a reviewed activity stays known beside it; an alternative disposition releases a known zero; a routed reconstruction recovers exactly; both forms', async () => {
  for (const rt of ['form_1065', 'form_1120s']) {
    const f = F[rt], what = rt;
    const C = { orgId, entityId: await company(pool, orgId, `Hickory ${f.suffix}`) };
    const ret = await period(pool, C, 2025, rt, { taxMethod: 'accrual' });
    const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), re: await acct(pool, C, 'Retained Earnings'), inv: await acct(pool, C, 'Inventory Asset') };
    await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 50000]]);
    await expense(pool, C, '2025-04-01', A.bank, [[A.inv, 10000]]);
    await bindBalance(pool, C, ret, A.bank, f.cash);
    await bindBalance(pool, C, ret, A.re, f.re);
    await bindBalance(pool, C, ret, A.inv, LINV[rt]);
    await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
    await answerTypedItems(pool, C, ret);
    await zeroPredecessor(C, ret, rt, [], 'none');
    const held = (r, tag) => {
      for (const k of [`${f.cogs}|activity`, `${f.ordinary}|activity`, `${f.k1}|activity`, `${f.endpoint}|activity`]) unknownField(r, k, tag);
      assert.equal(r.applicability.facts.deductsCogs, 'unknown', `${tag}: applicability`);
      knownField(r, `${f.m1}|activity`, 50000, `${tag}: book income`);
      knownField(r, `${f.sales}|activity`, 50000, `${tag}: sales`);
      assert.ok(errorsOf(r, 'inventory_activity').length > 0, `${tag}: the error`);
    };
    held(await compute(pool, C, ret), `${what}, no activity`);
    await frozenUnknown(C, ret, `${f.cogs}|activity`, `${what}, no activity`);
    const ended = await activity(pool, C, { name: 'Hickory old trade', from: '2020-01-01', to: '2024-06-30' });
    held(await compute(pool, C, ret), `${what}, an activity not in effect`);
    const one = await activity(pool, C, { name: 'Hickory retail' });
    held(await compute(pool, C, ret), `${what}, an empty trade`);
    const two = await activity(pool, C, { name: 'Hickory parts' });
    await reviewedPaper(C, ret, two);
    let r = await compute(pool, C, ret);
    held(r, `${what}, a reviewed activity beside it`);
    knownField(r, kOf(8, two), 25000, `${what}: the reviewed activity`);
    // An explicit alternative disposition: the empty trade's cost of goods sold is a known zero; the aggregate is the reviewed one.
    await bind(pool, C, ret, A.inv, 'activity', [{ treatment: 'not_tax', memo: 'held for resale next year, counted in the reviewed figures' }]);
    r = await compute(pool, C, ret);
    knownField(r, `${f.cogs}|activity`, 25000, `${what}, disposed otherwise`);
    knownField(r, `${f.ordinary}|activity`, 25000, `${what}, disposed otherwise`);
    assert.equal(r.applicability.facts.deductsCogs, true, `${what}, disposed otherwise`);
    // A routed reconstruction recovers exactly.
    await bind(pool, C, ret, A.inv, 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.2', activityId: one }]);
    await builtPaper(C, ret, one);
    r = await compute(pool, C, ret);
    for (const [k, v] of [[kOf(2, one), 10000], [kOf(8, one), 10000], [`${f.cogs}|activity`, 35000], [`${f.ordinary}|activity`, 15000]]) knownField(r, k, v, `${what}, reconstructed`);
    assert.ok(Number.isInteger(ended), 'the ended activity exists');
  }
});

test('a verified first year holds contradictory openings like a predecessor mismatch (Codex t3-r5 R5-3): pre-period postings after verification — the affected instances, consuming replacement endings and the balance totals unresolved, frozen; an assigned ending and income known; the source removed, exact zeros; both forms, and the 1120-S owner-instance variant with the ending moved to line 8', async () => {
  const start = async (rt, name) => {
    const C = { orgId, entityId: await company(pool, orgId, name) };
    await saveProfile(pool, { ...C, fields: { returnType: rt, taxMethodDefault: 'accrual', bookBasisDefault: 'accrual', yearEndMonth: 12, dateStarted: '2025-01-01' }, reason: 'test', actor: 'tester' });
    const ret = Number(await openPeriod(pool, { ...C, year: 2025, initial: true, actor: 'tester' }));
    await verifyInitial(pool, { ...C, returnId: ret, verifiedBy: 'tester', evidence: 'Certificate of formation' });
    return { C, ret };
  };
  for (const rt of ['form_1065', 'form_1120s']) {
    const f = F[rt], what = rt;
    const { C, ret } = await start(rt, `Linden First ${f.suffix}`);
    const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), re: await acct(pool, C, 'Retained Earnings'), prepaid: await acct(pool, C, 'Prepaid Expenses'), payroll: await acct(pool, C, 'Payroll Liabilities') };
    const liab = rt === 'form_1065' ? 'f1065.L.17' : 'f1120s.L.18';
    await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 5000]]);
    await bindBalance(pool, C, ret, A.bank, f.cash);
    await bindBalance(pool, C, ret, A.re, f.re);
    await bindBalance(pool, C, ret, A.prepaid, f.prepaid, 'statement_row');
    await bindBalance(pool, C, ret, A.payroll, liab, 'statement_row');
    await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
    await answerTypedItems(pool, C, ret);
    let r = await compute(pool, C, ret);
    assert.deepEqual(errorsOf(r).filter(c => c.code.startsWith('openings')), [], `${what}: the legitimate first year`);
    knownField(r, `${f.prepaid}|begin`, 0, `${what}: a known zero opening`);
    const bad = await je(pool, C, '2024-12-01', [[A.prepaid, 10000], [A.payroll, -10000]]);
    r = await compute(pool, C, ret);
    for (const k of [`${f.prepaid}|begin`, `${f.prepaid}|end`, `${liab}|begin`, `${liab}|end`, `${f.assets}|begin`, `${f.assets}|end`, `${f.total}|begin`, `${f.total}|end`]) unknownField(r, k, `${what}, contradictory`);
    knownField(r, `${f.sales}|activity`, 5000, `${what}, contradictory: income`);
    knownField(r, `${f.cash}|end`, 5000, `${what}, contradictory: an unrelated balance`);
    assert.equal(errorsOf(r, 'openings_initial').length, 2, `${what}: both lines reported`);
    await frozenUnknown(C, ret, `${f.assets}|end`, `${what}, contradictory`);
    await dropTxn(bad);
    r = await compute(pool, C, ret);
    for (const k of [`${f.prepaid}|begin`, `${f.prepaid}|end`, `${liab}|begin`, `${liab}|end`]) knownField(r, k, 0, `${what}, corrected: exact zeros`);
    assert.deepEqual(errorsOf(r).filter(c => c.code.startsWith('openings')), [], `${what}, corrected`);
  }
  // 1120-S owner instances: loans booked before the verified start, the receivable's ending moved to line 8, a typed line 8 ending beside it.
  {
    const f = F.form_1120s;
    const { C, ret } = await start('form_1120s', 'Linden Owners Corp');
    const owner = await party(pool, orgId, 'Sample Linden Owner');
    await saveInterest(pool, { ...C, fields: { partyId: owner, role: 'shareholder', from: '2025-01-01', to: null, profit: '1/1', loss: '1/1', capital: '1/1' }, actor: 'tester' });
    const id = await interestOf(C, owner);
    const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), re: await acct(pool, C, 'Retained Earnings'), loanR: await acct(pool, C, 'Loans to Shareholders', 'other_current_asset'), loanP: await acct(pool, C, 'Loans from Shareholders', 'other_current_liability') };
    await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 5000]]);
    await bindBalance(pool, C, ret, A.bank, f.cash);
    await bindBalance(pool, C, ret, A.re, f.re);
    await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
    for (const m of ['begin', 'end']) { await bind(pool, C, ret, A.loanR, m, [{ treatment: 'input', destination: 'f1120s.L.7', interestPartyId: owner }]); await bind(pool, C, ret, A.loanP, m, [{ treatment: 'input', destination: 'f1120s.L.19', interestPartyId: owner }]); }
    await answerTypedItems(pool, C, ret);
    const bad = await je(pool, C, '2024-12-01', [[A.loanR, 10000], [A.loanP, -10000]]);
    await bind(pool, C, ret, A.loanR, 'end', [{ treatment: 'input', destination: 'f1120s.L.8' }]);
    let r = await compute(pool, C, ret);
    for (const k of [`f1120s.L.7|interest=i:${id}|begin`, `f1120s.L.7|interest=i:${id}|end`, `f1120s.L.19|interest=i:${id}|begin`, `f1120s.L.19|interest=i:${id}|end`, 'f1120s.L.8|end', `${f.assets}|begin`, `${f.assets}|end`, `${f.total}|end`]) unknownField(r, k, 'owners, contradictory');
    knownField(r, `${f.sales}|activity`, 5000, 'owners, contradictory: income');
    assert.ok(!r.fields.some(x => ['f1120s.L.7', 'f1120s.L.19'].includes(x.fieldId) && !Object.keys(x.dims).length), 'owners: no unscoped key');
    await frozenUnknown(C, ret, 'f1120s.L.8|end', 'owners, contradictory');
    // A typed line 8 ending beside the moved route keeps its amount.
    await assignProvider(pool, { ...C, returnId: ret, slotKey: 'f1120s.L.8|end', providerKind: 'manual', schemaVersion: 1, sourceRef: { reason: 'loan statement' }, sourceVersion: 'manual:loan8@1' });
    await saveManualItem(pool, { ...C, returnId: ret, itemKey: 'f1120s.L.8|end', status: 'entered', amount: '300.00', enteredBy: 'tester' });
    r = await compute(pool, C, ret);
    knownField(r, 'f1120s.L.8|end', 30000, 'owners: the typed replacement ending');
    unknownField(r, `f1120s.L.7|interest=i:${id}|begin`, 'owners: the contradiction still held');
    await dropTxn(bad);
    r = await compute(pool, C, ret);
    for (const k of [`f1120s.L.7|interest=i:${id}|begin`, `f1120s.L.19|interest=i:${id}|begin`]) knownField(r, k, 0, 'owners, corrected: exact zeros');
    assert.deepEqual(errorsOf(r).filter(c => c.code.startsWith('openings')), [], 'owners, corrected');
  }
});

test('the book-income roll-forward holds only the retained-earnings endings that consume it (Codex t3-r5 R5-4): an assigned retained-earnings ending of 40,000 stays known through an undecided, stale and deleted closing while book income, the reconciliation and the book-fed balances wait; with the comparison route, without it; frozen; reclassified, the errors clear; accrual and cash-basis books; both forms', async () => {
  for (const rt of ['form_1065', 'form_1120s']) for (const basis of ['accrual', 'cash']) {
    const f = F[rt], what = `${rt}, ${basis} books`;
    const C = { orgId, entityId: await company(pool, orgId, `Magnolia ${basis} ${f.suffix}`) };
    const ret = await period(pool, C, 2025, rt, { taxMethod: basis === 'cash' ? 'cash' : 'accrual', bookBasis: basis });
    const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), util: await acct(pool, C, 'Utilities'), re: await acct(pool, C, 'Retained Earnings') };
    await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 50000]]);
    await je(pool, C, '2025-06-01', [[A.util, 10000], [A.bank, -10000]]);
    const close = await je(pool, C, '2025-12-31', [[A.re, 10000], [A.util, -10000]], { memo: 'closing' });
    await bindBalance(pool, C, ret, A.bank, f.cash);
    await bindBalance(pool, C, ret, A.re, f.re);
    await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
    await bind(pool, C, ret, A.util, 'activity', [{ treatment: 'statement_row', destination: f.other }]);
    await assignProvider(pool, { ...C, returnId: ret, slotKey: `${f.re}|end`, providerKind: 'manual', schemaVersion: 1, sourceRef: { reason: 'equity roll-forward workpaper' }, sourceVersion: 'manual:equity@1' });
    await answerTypedItems(pool, C, ret, { except: [`${f.re}|end`] });
    await saveManualItem(pool, { ...C, returnId: ret, itemKey: `${f.re}|end`, status: 'entered', amount: '400.00', enteredBy: 'tester' });
    await zeroPredecessor(C, ret, rt, [], basis, basis);
    const typedKnown = (r, tag) => { knownField(r, `${f.re}|end`, 40000, `${tag}: the typed ending`); knownField(r, `${f.sales}|activity`, 50000, `${tag}: an unrelated line`); };
    const bookUnknown = (r, tag) => { unknownField(r, `${f.m1}|activity`, `${tag}: book income`); assert.equal(r.bridge.bookNetIncome, null, `${tag}: the bridge`); };
    // Undecided.
    let r = await compute(pool, C, ret);
    typedKnown(r, `${what}, undecided`); bookUnknown(r, `${what}, undecided`);
    await classifyClosing(C, ret, close);
    r = await compute(pool, C, ret);
    typedKnown(r, `${what}, decided`);
    knownField(r, `${f.m1}|activity`, 40000, `${what}, decided: book income`);
    assert.deepEqual(errorsOf(r).filter(c => !['closing_candidate'].includes(c.code)), [], `${what}, decided: no error`);
    // Stale: book income unknown, the typed ending not.
    await pool.query(`UPDATE txn SET memo = 'edited' WHERE txn_id = $1`, [close]);
    r = await compute(pool, C, ret);
    typedKnown(r, `${what}, stale`); bookUnknown(r, `${what}, stale`);
    const { revisionNo } = await takeWorkingRevision(pool, { ...C, returnId: ret, takenBy: 'tester' });
    const saved = await getRevision(pool, { ...C, returnId: ret, revisionNo });
    assert.deepEqual(saved.results.fields.filter(x => x.key === `${f.re}|end`).map(x => [x.cents, x.status]), [['40000', 'complete']], `${what}: the revision keeps the typed ending`);
    assert.equal(saved.results.bridge.bookNetIncome, null, `${what}: and the unknown book income`);
    // The comparison route taken away (not on the return): the typed ending stands alone; put back and reclassified: everything known.
    await bind(pool, C, ret, A.re, 'end', [{ treatment: 'not_tax', memo: 'the roll-forward is typed' }]);
    r = await compute(pool, C, ret);
    typedKnown(r, `${what}, stale, no route beside`); bookUnknown(r, `${what}, stale, no route beside`);
    await bind(pool, C, ret, A.re, 'end', [{ treatment: 'input', destination: f.re }]);
    await classifyClosing(C, ret, close);
    r = await compute(pool, C, ret);
    typedKnown(r, `${what}, reclassified`);
    knownField(r, `${f.m1}|activity`, 40000, `${what}, reclassified`);
    // Deleted: held again until cleared.
    await dropTxn(close);
    r = await compute(pool, C, ret);
    typedKnown(r, `${what}, deleted`); bookUnknown(r, `${what}, deleted`);
    await clearClassification(pool, { ...C, returnId: ret, txnId: close });
    r = await compute(pool, C, ret);
    typedKnown(r, `${what}, cleared`);
    knownField(r, `${f.m1}|activity`, 40000, `${what}, cleared`);
  }
});

test('a trade whose cost of goods sold inputs are all present and independently authoritative keeps a known aggregate beside an unmapped expense (Codex t3-r6 R6-1): all six Form 1125-A inputs typed (12,300 / 25,000 / 4,500 / 0 / 0 / 0) — line 8 and page-1 COGS 32,800 complete, applicability true, ordinary income unresolved, frozen; the zero-total variant; a fully reviewed workpaper; mapping only the expense changes no COGS knownness; both forms', async () => {
  for (const rt of ['form_1065', 'form_1120s']) for (const variant of ['typed', 'zero', 'reviewed']) {
    const f = F[rt], what = `${rt}, ${variant}`;
    const C = { orgId, entityId: await company(pool, orgId, `Elder ${variant} ${f.suffix}`) };
    const ret = await period(pool, C, 2025, rt, { taxMethod: 'accrual' });
    const one = await activity(pool, C, { name: 'Elder retail' });
    const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), re: await acct(pool, C, 'Retained Earnings'), util: await acct(pool, C, 'Utilities') };
    await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 50000]]);
    await je(pool, C, '2025-04-01', [[A.util, 10000], [A.bank, -10000]]);
    await bindBalance(pool, C, ret, A.bank, f.cash);
    await bindBalance(pool, C, ret, A.re, f.re);
    await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
    const amounts = variant === 'typed' ? { 1: '123.00', 2: '250.00', 3: '0.00', 4: '0.00', 5: '0.00', 7: '45.00' } : { 1: '0.00', 2: '0.00', 3: '0.00', 4: '0.00', 5: '0.00', 7: '0.00' };
    if (variant === 'reviewed') await reviewedPaper(C, ret, one);
    else for (const n of ['1', '2', '3', '4', '5', '7']) await assignProvider(pool, { ...C, returnId: ret, slotKey: kOf(n, one), providerKind: 'manual', schemaVersion: 1, sourceRef: { reason: 'cost of goods sold workpaper' }, sourceVersion: `manual:cogs@${n}` });
    await answerTypedItems(pool, C, ret, { except: variant === 'reviewed' ? [] : ['1', '2', '3', '4', '5', '7'].map(n => kOf(n, one)) });
    // Line 5 (other costs) is a statement: none is the person's explicit "not applicable" (a zero).
    if (variant !== 'reviewed') for (const n of ['1', '2', '3', '4', '5', '7']) await saveManualItem(pool, { ...C, returnId: ret, itemKey: kOf(n, one), ...(n === '5' ? { status: 'not_applicable' } : { status: 'entered', amount: amounts[n] }), enteredBy: 'tester' });
    const total = { typed: 32800, zero: 0, reviewed: 25000 }[variant];
    const cogsKnown = (r, tag) => {
      knownField(r, kOf(8, one), total, `${tag}: line 8`);
      knownField(r, `${f.cogs}|activity`, total, `${tag}: page-1 COGS`);
      assert.equal(r.applicability.facts.deductsCogs, total ? true : false, `${tag}: applicability`);
      assert.ok(!r.fields.some(x => x.key.includes('act:pending')), `${tag}: no member invented`);
      knownField(r, `${f.m1}|activity`, 40000, `${tag}: book income`);
    };
    let r = await compute(pool, C, ret);
    cogsKnown(r, `${what}, expense unmapped`);
    unknownField(r, `${f.ordinary}|activity`, `${what}, expense unmapped: ordinary income waits on the expense`);
    const { revisionNo } = await takeWorkingRevision(pool, { ...C, returnId: ret, takenBy: 'tester' });
    const saved = await getRevision(pool, { ...C, returnId: ret, revisionNo });
    const frozen = k => saved.results.fields.filter(x => x.key === k).map(x => [x.cents, x.status]);
    assert.deepEqual([frozen(kOf(8, one)), frozen(`${f.cogs}|activity`), frozen(`${f.ordinary}|activity`)], [[[String(total), 'complete']], [[String(total), 'complete']], [[null, 'unresolved']]], `${what}: the revision freezes the same values`);
    // Mapping only the expense: the COGS figures do not change knownness; ordinary income becomes known.
    await bind(pool, C, ret, A.util, 'activity', [{ treatment: 'statement_row', destination: f.other }]);
    r = await compute(pool, C, ret);
    cogsKnown(r, `${what}, expense mapped`);
    knownField(r, `${f.ordinary}|activity`, 50000 - total - 10000, `${what}, expense mapped`);
  }
});

test('a verified first year is checked account by account and instance by instance before anything nets (Codex t3-r6 R6-2): +10,000 and -10,000 on one line with an ending moved or split, two owners’ offsetting loans, a contradicted instance beside an unknown one — the affected fields and totals unresolved, frozen, a typed replacement ending known; the source removed, exact zeros; both forms', async () => {
  const start = async (rt, name) => {
    const C = { orgId, entityId: await company(pool, orgId, name) };
    await saveProfile(pool, { ...C, fields: { returnType: rt, taxMethodDefault: 'accrual', bookBasisDefault: 'accrual', yearEndMonth: 12, dateStarted: '2025-01-01' }, reason: 'test', actor: 'tester' });
    const ret = Number(await openPeriod(pool, { ...C, year: 2025, initial: true, actor: 'tester' }));
    await verifyInitial(pool, { ...C, returnId: ret, verifiedBy: 'tester', evidence: 'Certificate of formation' });
    return { C, ret };
  };
  const L4 = { form_1065: 'f1065.L.4', form_1120s: 'f1120s.L.4' };
  for (const rt of ['form_1065', 'form_1120s']) for (const ending of ['moved', 'split']) {
    const f = F[rt], what = `${rt}, ending ${ending}`;
    const { C, ret } = await start(rt, `Pine Offset ${ending} ${f.suffix}`);
    const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), re: await acct(pool, C, 'Retained Earnings'), prepaid: await acct(pool, C, 'Prepaid Expenses'), deposits: await acct(pool, C, 'Deposits Paid', 'other_current_asset') };
    await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 5000]]);
    await bindBalance(pool, C, ret, A.bank, f.cash);
    await bindBalance(pool, C, ret, A.re, f.re);
    for (const a of [A.prepaid, A.deposits]) await bindBalance(pool, C, ret, a, f.prepaid, 'statement_row');
    if (ending === 'moved') await bind(pool, C, ret, A.prepaid, 'end', [{ treatment: 'input', destination: L4[rt] }]);
    else await bind(pool, C, ret, A.prepaid, 'end', [{ treatment: 'input', destination: L4[rt], share: '1/2' }, { treatment: 'statement_row', destination: f.prepaid, share: '1/2' }], { split: 'shares' });
    await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
    await answerTypedItems(pool, C, ret);
    const bad = await je(pool, C, '2024-12-01', [[A.prepaid, 10000], [A.deposits, -10000]]);
    let r = await compute(pool, C, ret);
    for (const k of [`${f.prepaid}|begin`, `${f.prepaid}|end`, `${L4[rt]}|end`, `${f.assets}|begin`, `${f.assets}|end`]) unknownField(r, k, `${what}, offsetting contradiction`);
    knownField(r, `${f.cash}|end`, 5000, `${what}: an unrelated balance`);
    knownField(r, `${f.sales}|activity`, 5000, `${what}: income`);
    assert.ok(errorsOf(r, 'openings_initial').some(c => /Prepaid Expenses/.test(c.message) && /Deposits Paid/.test(c.message)), `${what}: both contributing accounts named (${errorsOf(r).map(c => c.code).join(',')})`);
    await frozenUnknown(C, ret, `${L4[rt]}|end`, `${what}, offsetting contradiction`);
    // A typed replacement ending beside the moved route keeps its amount.
    await assignProvider(pool, { ...C, returnId: ret, slotKey: `${L4[rt]}|end`, providerKind: 'manual', schemaVersion: 1, sourceRef: { reason: 'broker statement' }, sourceVersion: 'manual:l4@1' });
    await saveManualItem(pool, { ...C, returnId: ret, itemKey: `${L4[rt]}|end`, status: 'entered', amount: '300.00', enteredBy: 'tester' });
    r = await compute(pool, C, ret);
    knownField(r, `${L4[rt]}|end`, 30000, `${what}: the typed replacement ending`);
    unknownField(r, `${f.prepaid}|begin`, `${what}: the contradiction still held`);
    await pool.query('DELETE FROM tax_provider_assignment WHERE org_id = $1 AND return_id = $2', [orgId, ret]);
    await pool.query(`DELETE FROM tax_manual_item WHERE org_id = $1 AND return_id = $2 AND item_key = $3`, [orgId, ret, `${L4[rt]}|end`]);
    await dropTxn(bad);
    r = await compute(pool, C, ret);
    for (const k of [`${f.prepaid}|begin`, `${f.prepaid}|end`, `${L4[rt]}|end`, `${f.assets}|begin`]) knownField(r, k, 0, `${what}, corrected: exact zeros`);
    assert.deepEqual(errorsOf(r).filter(c => c.code.startsWith('openings')), [], `${what}, corrected`);
  }
  // 1120-S: two owners' loans offsetting before the start; then a contradicted instance beside an unknown (typed, not entered) one.
  const f = F.form_1120s;
  for (const variant of ['offset', 'beside-unknown']) {
    const { C, ret } = await start('form_1120s', `Pine Owners ${variant} Corp`);
    const mk = async name => { const owner = await party(pool, orgId, name); await saveInterest(pool, { ...C, fields: { partyId: owner, role: 'shareholder', from: '2025-01-01', to: null, profit: '1/2', loss: '1/2', capital: '1/2' }, actor: 'tester' }); return { owner, id: await interestOf(C, owner) }; };
    const one = await mk(`Sample Pine ${variant} Owner One`), two = await mk(`Sample Pine ${variant} Owner Two`);
    const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), re: await acct(pool, C, 'Retained Earnings'), l1: await acct(pool, C, 'Loan to Owner One', 'other_current_asset'), l2: await acct(pool, C, 'Loan to Owner Two', 'other_current_asset'), lp: await acct(pool, C, 'Loans from Shareholders', 'other_current_liability') };
    await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 5000]]);
    await bindBalance(pool, C, ret, A.bank, f.cash);
    await bindBalance(pool, C, ret, A.re, f.re);
    await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
    const k7 = (o, m) => `f1120s.L.7|interest=i:${o.id}|${m}`;
    let bad;
    if (variant === 'offset') {
      for (const [a, o] of [[A.l1, one], [A.l2, two]]) for (const m of ['begin', 'end']) await bind(pool, C, ret, a, m, [{ treatment: 'input', destination: 'f1120s.L.7', interestPartyId: o.owner }]);
      await answerTypedItems(pool, C, ret);
      bad = await je(pool, C, '2024-12-01', [[A.l1, 10000], [A.l2, -10000]]);
    } else {
      for (const m of ['begin', 'end']) { await bind(pool, C, ret, A.l1, m, [{ treatment: 'input', destination: 'f1120s.L.7', interestPartyId: one.owner }]); await bind(pool, C, ret, A.lp, m, [{ treatment: 'input', destination: 'f1120s.L.19', interestPartyId: one.owner }]); }
      await answerTypedItems(pool, C, ret);
      // The second owner's line 7 beginning typed, not entered yet: unknown — it must not hide the first owner's contradiction.
      await assignProvider(pool, { ...C, returnId: ret, slotKey: k7(two, 'begin'), providerKind: 'manual', schemaVersion: 1, sourceRef: { reason: 'loan schedule' }, sourceVersion: 'manual:loan2@1' });
      bad = await je(pool, C, '2024-12-01', [[A.l1, 10000], [A.lp, -10000]]);
    }
    let r = await compute(pool, C, ret);
    const held = variant === 'offset' ? [k7(one, 'begin'), k7(one, 'end'), k7(two, 'begin'), k7(two, 'end')] : [k7(one, 'begin'), k7(one, 'end')];
    for (const k of [...held, `${f.assets}|begin`, `${f.assets}|end`]) unknownField(r, k, `owners ${variant}`);
    knownField(r, `${f.sales}|activity`, 5000, `owners ${variant}: income`);
    knownField(r, `${f.cash}|end`, 5000, `owners ${variant}: an unrelated balance`);
    assert.ok(errorsOf(r, 'openings_initial').some(c => /Loans to shareholders/.test(c.message)), `owners ${variant}: line 7 reported`);
    assert.ok(!r.fields.some(x => x.fieldId === 'f1120s.L.7' && !Object.keys(x.dims).length), `owners ${variant}: no unscoped key`);
    await frozenUnknown(C, ret, k7(one, 'begin'), `owners ${variant}`);
    await dropTxn(bad);
    r = await compute(pool, C, ret);
    knownField(r, k7(one, 'begin'), 0, `owners ${variant}, corrected: an exact zero`);
    if (variant === 'offset') knownField(r, k7(two, 'begin'), 0, `owners ${variant}, corrected`);
    assert.ok(!errorsOf(r, 'openings_initial').length, `owners ${variant}, corrected`);
  }
});

test('an explicit retained-earnings ending disposition that consumes no roll-forward never holds the balance totals (Codex t3-r6 R6-3): cash, a typed retained-earnings ending and both ending totals the same with the comparison route and with not on the return, while book income waits — undecided, stale and deleted closings, frozen, route-only and reclassification recovery; a books-fed ending and an unmapped ending stay held; accrual and cash-basis books; both forms', async () => {
  for (const rt of ['form_1065', 'form_1120s']) for (const basis of ['accrual', 'cash']) {
    const f = F[rt], what = `${rt}, ${basis} books`;
    const C = { orgId, entityId: await company(pool, orgId, `Alder Totals ${basis} ${f.suffix}`) };
    const ret = await period(pool, C, 2025, rt, { taxMethod: basis === 'cash' ? 'cash' : 'accrual', bookBasis: basis });
    const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), util: await acct(pool, C, 'Utilities'), re: await acct(pool, C, 'Retained Earnings') };
    await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 50000]]);
    await je(pool, C, '2025-06-01', [[A.util, 10000], [A.bank, -10000]]);
    const close = await je(pool, C, '2025-12-31', [[A.re, 10000], [A.util, -10000]], { memo: 'closing' });
    await bindBalance(pool, C, ret, A.bank, f.cash);
    await bindBalance(pool, C, ret, A.re, f.re);
    await bind(pool, C, ret, A.re, 'activity', [{ treatment: 'not_tax', memo: 'closing entries only' }]);
    await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
    await bind(pool, C, ret, A.util, 'activity', [{ treatment: 'statement_row', destination: f.other }]);
    await assignProvider(pool, { ...C, returnId: ret, slotKey: `${f.re}|end`, providerKind: 'manual', schemaVersion: 1, sourceRef: { reason: 'equity roll-forward workpaper' }, sourceVersion: 'manual:equity@1' });
    await answerTypedItems(pool, C, ret, { except: [`${f.re}|end`] });
    await saveManualItem(pool, { ...C, returnId: ret, itemKey: `${f.re}|end`, status: 'entered', amount: '400.00', enteredBy: 'tester' });
    await zeroPredecessor(C, ret, rt, [], `totals-${basis}`, basis);
    const comparison = () => bind(pool, C, ret, A.re, 'end', [{ treatment: 'input', destination: f.re }]);
    const disposed = () => bind(pool, C, ret, A.re, 'end', [{ treatment: 'not_tax', memo: 'the reviewed ending is typed' }]);
    const endings = r => [`${f.cash}|end`, `${f.re}|end`, `${f.assets}|end`, `${f.total}|end`].map(k => fieldOf(r, k));
    const expected = [['40000', 'complete'], ['40000', 'complete'], ['40000', 'complete'], ['40000', 'complete']];
    const bookWaits = (r, tag) => { unknownField(r, `${f.m1}|activity`, `${tag}: book income`); assert.equal(r.bridge.bookNetIncome, null, `${tag}: the bridge`); };
    const invariant = async tag => {
      await comparison();
      let r = await compute(pool, C, ret);
      assert.deepEqual(endings(r), expected, `${tag}, comparison route: cash, retained earnings and both ending totals`);
      bookWaits(r, `${tag}, comparison route`);
      await disposed();
      r = await compute(pool, C, ret);
      assert.deepEqual(endings(r), expected, `${tag}, not on the return: the same`);
      bookWaits(r, `${tag}, not on the return`);
      return r;
    };
    await invariant(`${what}, undecided`);
    await classifyClosing(C, ret, close);
    await pool.query(`UPDATE txn SET memo = 'edited' WHERE txn_id = $1`, [close]);
    await invariant(`${what}, stale`);
    const { revisionNo } = await takeWorkingRevision(pool, { ...C, returnId: ret, takenBy: 'tester' });
    const saved = await getRevision(pool, { ...C, returnId: ret, revisionNo });
    assert.deepEqual([`${f.assets}|end`, `${f.total}|end`].map(k => saved.results.fields.filter(x => x.key === k).map(x => [x.cents, x.status])), [[['40000', 'complete']], [['40000', 'complete']]], `${what}: the revision keeps the totals`);
    // Route-only recovery (the comparison back, the closing still stale) and reclassification recovery.
    await comparison();
    assert.deepEqual(endings(await compute(pool, C, ret)), expected, `${what}: route only`);
    await disposed();
    await classifyClosing(C, ret, close);
    let r = await compute(pool, C, ret);
    assert.deepEqual(endings(r), expected, `${what}: reclassified`);
    knownField(r, `${f.m1}|activity`, 40000, `${what}: reclassified, book income`);
    await dropTxn(close);
    await invariant(`${what}, deleted`);
    // Controls: the books' own ending (no typed amount) is held with book income; an ending with no disposition at all holds the totals.
    await pool.query('DELETE FROM tax_provider_assignment WHERE org_id = $1 AND return_id = $2', [orgId, ret]);
    await comparison();
    r = await compute(pool, C, ret);
    unknownField(r, `${f.re}|end`, `${what}, books-fed control`);
    unknownField(r, `${f.total}|end`, `${what}, books-fed control`);
    await pool.query(`DELETE FROM tax_binding WHERE org_id = $1 AND return_id = $2 AND account_id = $3 AND measurement = 'end'`, [orgId, ret, A.re]);
    r = await compute(pool, C, ret);
    unknownField(r, `${f.total}|end`, `${what}, unmapped-ending control`);
    unknownField(r, `${f.assets}|end`, `${what}, unmapped-ending control`);
  }
});

test('a COGS computation started by typed inputs needs all six inputs: absent tax inventory is unknown, never zero (Codex t3-r7 R7-1): only costs 2-5 typed, both inventories absent, then each one missing — line 8, page-1 COGS, income and applicability unknown, frozen; disposing of the inventory source releases nothing; assigning without answering changes nothing; 12,300 / 4,500 entered recovers 32,800 / 17,200 once; explicit zero inventories a known total; both forms', async () => {
  for (const rt of ['form_1065', 'form_1120s']) {
    const f = F[rt], what = rt;
    const C = { orgId, entityId: await company(pool, orgId, `Rowan Typed ${f.suffix}`) };
    const ret = await period(pool, C, 2025, rt, { taxMethod: 'accrual' });
    const one = await activity(pool, C, { name: 'Rowan retail' });
    const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), re: await acct(pool, C, 'Retained Earnings'), inv: await acct(pool, C, 'Inventory Asset') };
    await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 50000]]);
    await expense(pool, C, '2025-04-01', A.bank, [[A.inv, 10000]]);
    await bindBalance(pool, C, ret, A.bank, f.cash);
    await bindBalance(pool, C, ret, A.re, f.re);
    await bindBalance(pool, C, ret, A.inv, LINV[rt]);
    await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
    await answerTypedItems(pool, C, ret);
    await zeroPredecessor(C, ret, rt, [], 'typed-costs');
    const assign = n => assignProvider(pool, { ...C, returnId: ret, slotKey: kOf(n, one), providerKind: 'manual', schemaVersion: 1, sourceRef: { reason: 'cost of goods sold workpaper' }, sourceVersion: `manual:cogs@${n}` });
    const enter = (n, amount) => saveManualItem(pool, { ...C, returnId: ret, itemKey: kOf(n, one), ...(amount === null ? { status: 'not_applicable' } : { status: 'entered', amount }), enteredBy: 'tester' });
    const drop = n => Promise.all([pool.query('DELETE FROM tax_provider_assignment WHERE org_id = $1 AND return_id = $2 AND slot_key = $3', [orgId, ret, kOf(n, one)]), pool.query('DELETE FROM tax_manual_item WHERE org_id = $1 AND return_id = $2 AND item_key = $3', [orgId, ret, kOf(n, one)])]);
    for (const [n, amount] of [['2', '250.00'], ['3', '0.00'], ['4', '0.00'], ['5', null]]) { await assign(n); await enter(n, amount); }
    const waits = (r, tag) => {
      for (const k of [kOf(8, one), `${f.cogs}|activity`, `${f.ordinary}|activity`]) unknownField(r, k, tag);
      assert.equal(r.applicability.facts.deductsCogs, 'unknown', `${tag}: applicability`);
      knownField(r, kOf(2, one), 25000, `${tag}: the typed purchases`);
      knownField(r, `${f.m1}|activity`, 50000, `${tag}: book income`);
    };
    let r = await compute(pool, C, ret);
    waits(r, `${what}, both inventories absent, inventory undisposed`);
    await frozenUnknown(C, ret, `${f.cogs}|activity`, `${what}, both inventories absent`);
    // The inventory account's activity disposed of: no tax count is supplied by it — the absent inventories still wait.
    await bind(pool, C, ret, A.inv, 'activity', [{ treatment: 'not_tax', memo: 'counted on the workpaper' }]);
    waits(await compute(pool, C, ret), `${what}, both absent, inventory disposed`);
    // Each inventory missing separately.
    await assign('1'); await enter('1', '123.00');
    r = await compute(pool, C, ret);
    waits(r, `${what}, ending inventory absent`);
    knownField(r, kOf(1, one), 12300, `${what}: the entered beginning inventory`);
    await drop('1'); await assign('7'); await enter('7', '45.00');
    waits(await compute(pool, C, ret), `${what}, beginning inventory absent`);
    // Assigned without an answer: no change in knownness.
    await assign('1');
    waits(await compute(pool, C, ret), `${what}, beginning assigned, not answered`);
    // Entered: 32,800 once.
    await enter('1', '123.00');
    r = await compute(pool, C, ret);
    for (const [k, v] of [[kOf(8, one), 32800], [`${f.cogs}|activity`, 32800], [`${f.ordinary}|activity`, 17200]]) knownField(r, k, v, `${what}, both entered`);
    assert.equal(r.applicability.facts.deductsCogs, true, `${what}, both entered`);
    // Explicit zero inventories: the costs alone, known.
    await enter('1', '0.00'); await enter('7', '0.00');
    r = await compute(pool, C, ret);
    for (const [k, v] of [[kOf(8, one), 25000], [`${f.cogs}|activity`, 25000], [`${f.ordinary}|activity`, 25000]]) knownField(r, k, v, `${what}, zero inventories`);
  }
});

test('a verified first year finds a contradicted source opening whatever its beginning binding says (Codex t3-r7 R7-2): beginnings not on the return, endings still consuming the source (moved, split, two owners) — the endings and totals unresolved and reported, frozen; restoring the beginning routes keeps the hold; the source corrected, exact zeros; a typed replacement ending stays 30,000 beside a held one; typed +30,000 / -30,000 endings and their total stay known with comparison routes or explicit dispositions; both forms, accrual and cash-basis books', async () => {
  const start = async (rt, name, basis) => {
    const C = { orgId, entityId: await company(pool, orgId, name) };
    await saveProfile(pool, { ...C, fields: { returnType: rt, taxMethodDefault: basis === 'cash' ? 'cash' : 'accrual', bookBasisDefault: basis, yearEndMonth: 12, dateStarted: '2025-01-01' }, reason: 'test', actor: 'tester' });
    const ret = Number(await openPeriod(pool, { ...C, year: 2025, initial: true, actor: 'tester' }));
    await verifyInitial(pool, { ...C, returnId: ret, verifiedBy: 'tester', evidence: 'Certificate of formation' });
    return { C, ret };
  };
  const L4 = { form_1065: 'f1065.L.4', form_1120s: 'f1120s.L.4' }, L5 = { form_1065: 'f1065.L.5', form_1120s: 'f1120s.L.5' };
  const notTax = memo => [{ treatment: 'not_tax', memo }];
  for (const rt of ['form_1065', 'form_1120s']) for (const basis of ['accrual', 'cash']) {
    const f = F[rt];
    for (const ending of ['moved', 'split']) {
      const what = `${rt}, ${basis} books, ending ${ending}`;
      const { C, ret } = await start(rt, `Spruce First ${basis} ${ending} ${f.suffix}`, basis);
      const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), re: await acct(pool, C, 'Retained Earnings'), a: await acct(pool, C, 'Prepaid Expenses'), b: await acct(pool, C, 'Deposits Paid', 'other_current_asset') };
      await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 5000]]);
      await bindBalance(pool, C, ret, A.bank, f.cash);
      await bindBalance(pool, C, ret, A.re, f.re);
      for (const a of [A.a, A.b]) await bind(pool, C, ret, a, 'begin', notTax('opening shown on the workpaper'));
      if (ending === 'moved') await bind(pool, C, ret, A.a, 'end', [{ treatment: 'input', destination: L4[rt] }]);
      else await bind(pool, C, ret, A.a, 'end', [{ treatment: 'input', destination: L4[rt], share: '1/2' }, { treatment: 'statement_row', destination: f.prepaid, share: '1/2' }], { split: 'shares' });
      await bind(pool, C, ret, A.b, 'end', [{ treatment: 'statement_row', destination: f.prepaid }]);
      await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
      await answerTypedItems(pool, C, ret);
      const bad = await je(pool, C, '2024-12-01', [[A.a, 10000], [A.b, -10000]]);
      const held = (r, tag) => {
        for (const k of [`${L4[rt]}|end`, `${f.prepaid}|end`, `${f.assets}|end`]) unknownField(r, k, tag);
        knownField(r, `${f.cash}|end`, 5000, `${tag}: an unrelated balance`);
        knownField(r, `${f.sales}|activity`, 5000, `${tag}: income`);
        assert.ok(errorsOf(r, 'openings_initial').some(c => /Prepaid Expenses/.test(c.message)) && errorsOf(r, 'openings_initial').some(c => /Deposits Paid/.test(c.message)), `${tag}: both sources reported`);
      };
      held(await compute(pool, C, ret), `${what}, beginnings not on the return`);
      await frozenUnknown(C, ret, `${L4[rt]}|end`, what);
      // Route-only restoration of the beginnings: still held (now also through the line).
      for (const a of [A.a, A.b]) await bind(pool, C, ret, a, 'begin', [{ treatment: 'statement_row', destination: f.prepaid }]);
      held(await compute(pool, C, ret), `${what}, beginnings routed again`);
      for (const a of [A.a, A.b]) await bind(pool, C, ret, a, 'begin', notTax('opening shown on the workpaper'));
      await dropTxn(bad);
      const r = await compute(pool, C, ret);
      for (const k of [`${L4[rt]}|end`, `${f.prepaid}|end`, `${f.assets}|end`]) knownField(r, k, k === `${f.assets}|end` ? 5000 : 0, `${what}, corrected: exact`);
      assert.deepEqual(errorsOf(r).filter(c => c.code.startsWith('openings')), [], `${what}, corrected`);
    }
    // Mixed control: A's ending typed on line 4 (the route beside it), B's ending still consuming the source on line 6.
    {
      const what = `${rt}, ${basis} books, mixed`;
      const { C, ret } = await start(rt, `Spruce Mixed ${basis} ${f.suffix}`, basis);
      const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), re: await acct(pool, C, 'Retained Earnings'), a: await acct(pool, C, 'Prepaid Expenses'), b: await acct(pool, C, 'Deposits Paid', 'other_current_asset') };
      await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 5000]]);
      await bindBalance(pool, C, ret, A.bank, f.cash);
      await bindBalance(pool, C, ret, A.re, f.re);
      for (const a of [A.a, A.b]) await bind(pool, C, ret, a, 'begin', notTax('opening shown on the workpaper'));
      await bind(pool, C, ret, A.a, 'end', [{ treatment: 'input', destination: L4[rt] }]);
      await bind(pool, C, ret, A.b, 'end', [{ treatment: 'statement_row', destination: f.prepaid }]);
      await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
      await assignProvider(pool, { ...C, returnId: ret, slotKey: `${L4[rt]}|end`, providerKind: 'manual', schemaVersion: 1, sourceRef: { reason: 'broker statement' }, sourceVersion: 'manual:l4@1' });
      await answerTypedItems(pool, C, ret, { except: [`${L4[rt]}|end`] });
      await saveManualItem(pool, { ...C, returnId: ret, itemKey: `${L4[rt]}|end`, status: 'entered', amount: '300.00', enteredBy: 'tester' });
      await je(pool, C, '2024-12-01', [[A.a, 10000], [A.b, -10000]]);
      const r = await compute(pool, C, ret);
      knownField(r, `${L4[rt]}|end`, 30000, `${what}: the typed replacement ending`);
      unknownField(r, `${f.prepaid}|end`, `${what}: the ending still consuming the source`);
      unknownField(r, `${f.assets}|end`, `${what}: the total`);
    }
    // Wholly independent typed endings (+30,000 on line 4, -30,000 on line 5): known, with comparison routes and with explicit dispositions.
    {
      const what = `${rt}, ${basis} books, independent`;
      const { C, ret } = await start(rt, `Spruce Typed ${basis} ${f.suffix}`, basis);
      const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), re: await acct(pool, C, 'Retained Earnings'), a: await acct(pool, C, 'Prepaid Expenses'), b: await acct(pool, C, 'Deposits Paid', 'other_current_asset') };
      await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 5000]]);
      await bindBalance(pool, C, ret, A.bank, f.cash);
      await bindBalance(pool, C, ret, A.re, f.re);
      for (const a of [A.a, A.b]) await bind(pool, C, ret, a, 'begin', notTax('opening shown on the workpaper'));
      await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
      for (const [l, n] of [[L4[rt], '300.00'], [L5[rt], '-300.00']]) await assignProvider(pool, { ...C, returnId: ret, slotKey: `${l}|end`, providerKind: 'manual', schemaVersion: 1, sourceRef: { reason: 'statements' }, sourceVersion: `manual:${l}@1` });
      for (const [a, l] of [[A.a, L4[rt]], [A.b, L5[rt]]]) await bind(pool, C, ret, a, 'end', [{ treatment: 'input', destination: l }]);
      await answerTypedItems(pool, C, ret, { except: [`${L4[rt]}|end`, `${L5[rt]}|end`] });
      for (const [l, n] of [[L4[rt], '300.00'], [L5[rt], '-300.00']]) await saveManualItem(pool, { ...C, returnId: ret, itemKey: `${l}|end`, status: 'entered', amount: n, enteredBy: 'tester' });
      await je(pool, C, '2024-12-01', [[A.a, 10000], [A.b, -10000]]);
      const known = (r, tag) => { knownField(r, `${L4[rt]}|end`, 30000, tag); knownField(r, `${L5[rt]}|end`, -30000, tag); knownField(r, `${f.assets}|end`, 5000, `${tag}: their total`); };
      known(await compute(pool, C, ret), `${what}, comparison routes`);
      for (const a of [A.a, A.b]) await bind(pool, C, ret, a, 'end', notTax('the reviewed ending is typed'));
      known(await compute(pool, C, ret), `${what}, explicit dispositions`);
    }
    // 1120-S: two owners' loans, beginnings not on the return, endings on their actual instances.
    if (rt === 'form_1120s') {
      const what = `owners, ${basis} books`;
      const { C, ret } = await start('form_1120s', `Spruce Owners ${basis} Corp`, basis);
      const mk = async name => { const owner = await party(pool, orgId, name); await saveInterest(pool, { ...C, fields: { partyId: owner, role: 'shareholder', from: '2025-01-01', to: null, profit: '1/2', loss: '1/2', capital: '1/2' }, actor: 'tester' }); return { owner, id: await interestOf(C, owner) }; };
      const one = await mk(`Sample Spruce ${basis} Owner One`), two = await mk(`Sample Spruce ${basis} Owner Two`);
      const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), re: await acct(pool, C, 'Retained Earnings'), l1: await acct(pool, C, 'Loan to Owner One', 'other_current_asset'), l2: await acct(pool, C, 'Loan to Owner Two', 'other_current_asset') };
      await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 5000]]);
      await bindBalance(pool, C, ret, A.bank, f.cash);
      await bindBalance(pool, C, ret, A.re, f.re);
      await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
      for (const [a, o] of [[A.l1, one], [A.l2, two]]) { await bind(pool, C, ret, a, 'begin', notTax('opening shown on the workpaper')); await bind(pool, C, ret, a, 'end', [{ treatment: 'input', destination: 'f1120s.L.7', interestPartyId: o.owner }]); }
      await answerTypedItems(pool, C, ret);
      const bad = await je(pool, C, '2024-12-01', [[A.l1, 10000], [A.l2, -10000]]);
      const k7 = (o, m) => `f1120s.L.7|interest=i:${o.id}|${m}`;
      let r = await compute(pool, C, ret);
      for (const k of [k7(one, 'end'), k7(two, 'end'), `${f.assets}|end`]) unknownField(r, k, what);
      knownField(r, `${f.cash}|end`, 5000, `${what}: an unrelated balance`);
      assert.ok(['Loan to Owner One', 'Loan to Owner Two'].every(n => errorsOf(r, 'openings_initial').some(c => c.message.includes(n))), `${what}: reported, both sources named`);
      assert.ok(!r.fields.some(x => x.fieldId === 'f1120s.L.7' && !Object.keys(x.dims).length), `${what}: no unscoped key`);
      await frozenUnknown(C, ret, k7(one, 'end'), what);
      await dropTxn(bad);
      r = await compute(pool, C, ret);
      for (const k of [k7(one, 'end'), k7(two, 'end')]) knownField(r, k, 0, `${what}, corrected`);
      assert.deepEqual(errorsOf(r).filter(c => c.code.startsWith('openings')), [], `${what}, corrected`);
    }
  }
});

test('typed first-year openings and endings beside contradicted book comparisons stay known (Codex t3-r8 R8-2): typed 0 / 0 beginnings and +30,000 / -30,000 endings on lines 4 and 5, the same with the beginning comparison routes and with the beginnings not on the return, frozen; two 1120-S owner instances; a nonzero typed opening still fails, an unanswered one is unknown; a consuming ending beside them is held; the source corrected; both forms, accrual and cash-basis books', async () => {
  const start = async (rt, name, basis) => {
    const C = { orgId, entityId: await company(pool, orgId, name) };
    await saveProfile(pool, { ...C, fields: { returnType: rt, taxMethodDefault: basis === 'cash' ? 'cash' : 'accrual', bookBasisDefault: basis, yearEndMonth: 12, dateStarted: '2025-01-01' }, reason: 'test', actor: 'tester' });
    const ret = Number(await openPeriod(pool, { ...C, year: 2025, initial: true, actor: 'tester' }));
    await verifyInitial(pool, { ...C, returnId: ret, verifiedBy: 'tester', evidence: 'Certificate of formation' });
    return { C, ret };
  };
  const typed = async (C, ret, key, amount) => {
    await assignProvider(pool, { ...C, returnId: ret, slotKey: key, providerKind: 'manual', schemaVersion: 1, sourceRef: { reason: 'statements' }, sourceVersion: `manual:${key}@1` });
    if (amount !== undefined) await saveManualItem(pool, { ...C, returnId: ret, itemKey: key, status: 'entered', amount, enteredBy: 'tester' });
  };
  const notTax = [{ treatment: 'not_tax', memo: 'opening shown on the workpaper' }];
  for (const rt of ['form_1065', 'form_1120s']) for (const basis of ['accrual', 'cash']) {
    const f = F[rt], what = `${rt}, ${basis} books`;
    const L4 = rt === 'form_1065' ? 'f1065.L.4' : 'f1120s.L.4', L5 = rt === 'form_1065' ? 'f1065.L.5' : 'f1120s.L.5';
    const { C, ret } = await start(rt, `Willow Typed ${basis} ${f.suffix}`, basis);
    const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), re: await acct(pool, C, 'Retained Earnings'), a: await acct(pool, C, 'Prepaid Expenses'), b: await acct(pool, C, 'Deposits Paid', 'other_current_asset') };
    await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 50000]]);
    await bindBalance(pool, C, ret, A.bank, f.cash);
    await bindBalance(pool, C, ret, A.re, f.re);
    await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
    await bindBalance(pool, C, ret, A.a, L4);
    await bindBalance(pool, C, ret, A.b, L5);
    const keys = [[`${L4}|begin`, '0.00'], [`${L5}|begin`, '0.00'], [`${L4}|end`, '300.00'], [`${L5}|end`, '-300.00']];
    for (const [k] of keys) await typed(C, ret, k);
    await answerTypedItems(pool, C, ret, { except: keys.map(([k]) => k) });
    for (const [k, v] of keys) await saveManualItem(pool, { ...C, returnId: ret, itemKey: k, status: 'entered', amount: v, enteredBy: 'tester' });
    const bad = await je(pool, C, '2024-12-01', [[A.a, 10000], [A.b, -10000]]);
    const expected = [[`${L4}|begin`, 0], [`${L5}|begin`, 0], [`${L4}|end`, 30000], [`${L5}|end`, -30000], [`${f.assets}|begin`, 0], [`${f.assets}|end`, 50000]];
    const known = (r, tag) => { for (const [k, v] of expected) knownField(r, k, v, tag); assert.deepEqual(errorsOf(r, 'openings_initial'), [], `${tag}: the provided openings tie`); };
    let r = await compute(pool, C, ret);
    known(r, `${what}, beginning comparisons`);
    assert.ok(r.checks.some(c => c.code === 'openings_source' && /Prepaid Expenses/.test(c.message)), `${what}: the book contradiction stays visible`);
    const { revisionNo } = await takeWorkingRevision(pool, { ...C, returnId: ret, takenBy: 'tester' });
    const saved = await getRevision(pool, { ...C, returnId: ret, revisionNo });
    assert.deepEqual(expected.map(([k]) => saved.results.fields.filter(x => x.key === k).map(x => [x.cents, x.status])[0]), expected.map(([, v]) => [String(v), 'complete']), `${what}: the revision keeps them`);
    for (const a of [A.a, A.b]) await bind(pool, C, ret, a, 'begin', notTax);
    known(await compute(pool, C, ret), `${what}, beginnings not on the return`);
    for (const a of [A.a, A.b]) await bind(pool, C, ret, a, 'begin', [{ treatment: 'input', destination: a === A.a ? L4 : L5 }]);
    // A nonzero typed opening still fails its own check; an unanswered one is unknown; neither touches the other line.
    await saveManualItem(pool, { ...C, returnId: ret, itemKey: `${L4}|begin`, status: 'entered', amount: '100.00', enteredBy: 'tester' });
    r = await compute(pool, C, ret);
    for (const k of [`${L4}|begin`, `${L4}|end`, `${f.assets}|begin`]) unknownField(r, k, `${what}, nonzero typed opening`);
    knownField(r, `${L5}|end`, -30000, `${what}, nonzero typed opening: the other line`);
    assert.ok(errorsOf(r, 'openings_initial').length > 0, `${what}: nonzero typed opening reported`);
    await pool.query('DELETE FROM tax_manual_item WHERE org_id = $1 AND return_id = $2 AND item_key = $3', [orgId, ret, `${L4}|begin`]);
    r = await compute(pool, C, ret);
    unknownField(r, `${L4}|begin`, `${what}, unanswered typed opening`);
    knownField(r, `${L5}|end`, -30000, `${what}, unanswered typed opening: the other line`);
    await saveManualItem(pool, { ...C, returnId: ret, itemKey: `${L4}|begin`, status: 'entered', amount: '0.00', enteredBy: 'tester' });
    // A consuming ending beside them: B's ending back to the books (its typed ending released) is held; A's typed ending stays known.
    await pool.query('DELETE FROM tax_provider_assignment WHERE org_id = $1 AND return_id = $2 AND slot_key = $3', [orgId, ret, `${L5}|end`]);
    await pool.query('DELETE FROM tax_manual_item WHERE org_id = $1 AND return_id = $2 AND item_key = $3', [orgId, ret, `${L5}|end`]);
    r = await compute(pool, C, ret);
    unknownField(r, `${L5}|end`, `${what}, consuming ending`);
    unknownField(r, `${f.assets}|end`, `${what}, consuming ending: the total`);
    knownField(r, `${L4}|end`, 30000, `${what}, consuming ending: the typed one`);
    assert.ok(errorsOf(r, 'openings_initial').length > 0, `${what}, consuming ending: reported`);
    await dropTxn(bad);
    r = await compute(pool, C, ret);
    knownField(r, `${L5}|end`, 0, `${what}, corrected`);
    assert.deepEqual(errorsOf(r, 'openings_initial'), [], `${what}, corrected`);
  }
  for (const basis of ['accrual', 'cash']) {
    const f = F.form_1120s, what = `owners, ${basis} books`;
    const { C, ret } = await start('form_1120s', `Willow Owners ${basis} Corp`, basis);
    const mk = async name => { const owner = await party(pool, orgId, name); await saveInterest(pool, { ...C, fields: { partyId: owner, role: 'shareholder', from: '2025-01-01', to: null, profit: '1/2', loss: '1/2', capital: '1/2' }, actor: 'tester' }); return { owner, id: await interestOf(C, owner) }; };
    const one = await mk(`Sample Willow ${basis} Owner One`), two = await mk(`Sample Willow ${basis} Owner Two`);
    const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), re: await acct(pool, C, 'Retained Earnings'), l1: await acct(pool, C, 'Loan to Owner One', 'other_current_asset'), l2: await acct(pool, C, 'Loan to Owner Two', 'other_current_asset') };
    await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 50000]]);
    await bindBalance(pool, C, ret, A.bank, f.cash);
    await bindBalance(pool, C, ret, A.re, f.re);
    await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
    for (const [a, o] of [[A.l1, one], [A.l2, two]]) for (const m of ['begin', 'end']) await bind(pool, C, ret, a, m, [{ treatment: 'input', destination: 'f1120s.L.7', interestPartyId: o.owner }]);
    const k7 = (o, m) => `f1120s.L.7|interest=i:${o.id}|${m}`;
    const keys = [[k7(one, 'begin'), '0.00'], [k7(two, 'begin'), '0.00'], [k7(one, 'end'), '300.00'], [k7(two, 'end'), '-300.00']];
    for (const [k] of keys) await typed(C, ret, k);
    await answerTypedItems(pool, C, ret, { except: keys.map(([k]) => k) });
    for (const [k, v] of keys) await saveManualItem(pool, { ...C, returnId: ret, itemKey: k, status: 'entered', amount: v, enteredBy: 'tester' });
    await je(pool, C, '2024-12-01', [[A.l1, 10000], [A.l2, -10000]]);
    const expected = [[k7(one, 'begin'), 0], [k7(two, 'begin'), 0], [k7(one, 'end'), 30000], [k7(two, 'end'), -30000], [`${f.assets}|begin`, 0], [`${f.assets}|end`, 50000]];
    const known = (r, tag) => { for (const [k, v] of expected) knownField(r, k, v, tag); };
    known(await compute(pool, C, ret), `${what}, beginning comparisons`);
    for (const a of [A.l1, A.l2]) await bind(pool, C, ret, a, 'begin', notTax);
    known(await compute(pool, C, ret), `${what}, beginnings not on the return`);
  }
});

test('a saved COGS-provider assignment starts the computation even when no route or workpaper materialized it (Codex t3-r8 R8-1): each of the six inputs assigned alone; the full sequence — undisposed, then disposed inventory, a reviewed neighbour at 25,000, an unanswered reconstruction, the 10,000 / 0 / 1,000 reconstruction recovering 9,000 and 34,000 once — frozen; an untouched activity stays a known zero; both forms', async () => {
  const assignWorkpaper = (C, ret, key, kind = 'cogs_workpaper') => assignProvider(pool, { ...C, returnId: ret, slotKey: key, providerKind: kind, schemaVersion: 1, sourceRef: { reason: 'cost of goods sold workpaper' }, sourceVersion: `${kind}:${key}@1` });
  for (const rt of ['form_1065', 'form_1120s']) {
    const f = F[rt];
    // Each of the six possible initiating inputs, alone, on an activity with no workpaper, route or inventory source.
    for (const n of ['none', '1', '2', '3', '4', '5', '7']) {
      const what = `${rt}, ${n === 'none' ? 'no assignment' : `line ${n} assigned`}`;
      const C = { orgId, entityId: await company(pool, orgId, `Laurel ${n} ${f.suffix}`) };
      const ret = await period(pool, C, 2025, rt, { taxMethod: 'accrual' });
      const one = await activity(pool, C, { name: 'Laurel retail' });
      const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), re: await acct(pool, C, 'Retained Earnings') };
      await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 50000]]);
      await bindBalance(pool, C, ret, A.bank, f.cash);
      await bindBalance(pool, C, ret, A.re, f.re);
      await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
      await answerTypedItems(pool, C, ret);
      if (n !== 'none') await assignWorkpaper(C, ret, kOf(n, one));
      const r = await compute(pool, C, ret);
      if (n === 'none') { knownField(r, `${f.cogs}|activity`, 0, `${what}: the untouched activity is a known zero`); knownField(r, `${f.ordinary}|activity`, 50000, what); continue; }
      for (const k of [kOf(8, one), `${f.cogs}|activity`, `${f.ordinary}|activity`]) unknownField(r, k, what);
      assert.equal(r.applicability.facts.deductsCogs, 'unknown', `${what}: applicability`);
      knownField(r, `${f.m1}|activity`, 50000, `${what}: book income`);
    }
    // The full sequence on line 2.
    const what = `${rt}, sequence`;
    const C = { orgId, entityId: await company(pool, orgId, `Laurel Sequence ${f.suffix}`) };
    const ret = await period(pool, C, 2025, rt, { taxMethod: 'accrual' });
    const one = await activity(pool, C, { name: 'Laurel retail' });
    const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), re: await acct(pool, C, 'Retained Earnings'), inv: await acct(pool, C, 'Inventory Asset') };
    await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 50000]]);
    await expense(pool, C, '2025-04-01', A.bank, [[A.inv, 10000]]);
    await bindBalance(pool, C, ret, A.bank, f.cash);
    await bindBalance(pool, C, ret, A.re, f.re);
    await bindBalance(pool, C, ret, A.inv, LINV[rt]);
    await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
    await answerTypedItems(pool, C, ret);
    await zeroPredecessor(C, ret, rt, [], 'assigned');
    await assignWorkpaper(C, ret, kOf(2, one));
    const waits = (r, tag) => { for (const k of [kOf(8, one), `${f.cogs}|activity`, `${f.ordinary}|activity`]) unknownField(r, k, tag); assert.equal(r.applicability.facts.deductsCogs, 'unknown', `${tag}: applicability`); };
    waits(await compute(pool, C, ret), `${what}, inventory undisposed`);
    await bind(pool, C, ret, A.inv, 'activity', [{ treatment: 'not_tax', memo: 'counted on the workpaper' }]);
    waits(await compute(pool, C, ret), `${what}, inventory disposed`);
    await frozenUnknown(C, ret, `${f.cogs}|activity`, `${what}, inventory disposed`);
    const two = await activity(pool, C, { name: 'Laurel parts' });
    await reviewedPaper(C, ret, two);
    let r = await compute(pool, C, ret);
    waits(r, `${what}, reviewed neighbour`);
    knownField(r, kOf(8, two), 25000, `${what}: the reviewed neighbour`);
    await builtPaper(C, ret, one, null, null);
    waits(await compute(pool, C, ret), `${what}, unanswered reconstruction`);
    await bind(pool, C, ret, A.inv, 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.2', activityId: one }]);
    await builtPaper(C, ret, one, '0', '10.00');
    r = await compute(pool, C, ret);
    for (const [k, v] of [[kOf(2, one), 10000], [kOf(8, one), 9000], [`${f.cogs}|activity`, 34000], [`${f.ordinary}|activity`, 16000]]) knownField(r, k, v, `${what}, reconstructed`);
    assert.equal(r.applicability.facts.deductsCogs, true, `${what}, reconstructed`);
  }
});

test('saved COGS assignments retain required membership after activity eligibility changes (Codex t3-r9 R9-1)', async t => {
  const inputs = ['1', '2', '3', '4', '5', '7'];
  const assign = (C, ret, key, kind) => assignProvider(pool, { ...C, returnId: ret, slotKey: key, providerKind: kind, schemaVersion: 1, sourceRef: { reason: 'sample COGS workpaper' }, sourceVersion: `${kind}:${key}@1` });
  const setup = async (rt, tag) => {
    const f = F[rt], C = { orgId, entityId: await company(pool, orgId, `Sample COGS ${tag} ${f.suffix}`) };
    const ret = await period(pool, C, 2025, rt, { taxMethod: 'accrual' });
    const one = await activity(pool, C, { name: 'Sample retail' });
    const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), re: await acct(pool, C, 'Retained Earnings'), inv: await acct(pool, C, 'Inventory Asset') };
    await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 50000]]);
    await expense(pool, C, '2025-04-01', A.bank, [[A.inv, 10000]]);
    await bindBalance(pool, C, ret, A.bank, f.cash);
    await bindBalance(pool, C, ret, A.re, f.re);
    await bindBalance(pool, C, ret, A.inv, LINV[rt]);
    await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
    await bind(pool, C, ret, A.inv, 'activity', [{ treatment: 'not_tax', memo: 'counted on the workpaper' }]);
    await answerTypedItems(pool, C, ret);
    await zeroPredecessor(C, ret, rt, [], tag);
    const change = fields => saveActivity(pool, { ...C, activityId: one, fields: { kind: 'trade', name: 'Sample retail', schedule: 'p1', from: '2020-01-01', to: '', disposedOn: '', ...fields } });
    const totals = [`${f.cogs}|activity`, `${f.sales.replace('1a', '3')}|activity`, `${rt === 'form_1065' ? 'f1065.p1.8' : 'f1120s.p1.6'}|activity`, `${f.ordinary}|activity`, `${f.k1}|activity`, `${f.endpoint}|activity`];
    const independent = (r, tag) => {
      for (const [k, v] of [[`${f.sales}|activity`, 50000], [`${f.m1}|activity`, 50000], [`${f.deductions}|activity`, 0], [`${f.cash}|end`, 40000], [`${LINV[rt]}|end`, 10000]]) knownField(r, k, v, tag);
    };
    return { C, ret, one, A, f, change, totals, independent };
  };
  for (const rt of ['form_1065', 'form_1120s']) for (const kind of ['cogs_workpaper', 'books', 'cash_layer']) for (const n of inputs) {
    await t.test(`${rt}, ${kind}, initiating line ${n}`, async () => {
      const { C, ret, one, A, f, change, totals, independent } = await setup(rt, `${kind} ${n}`);
      const key = kOf(n, one), affected = [...inputs.map(i => kOf(i, one)), kOf(6, one), kOf(8, one), ...totals];
      await assign(C, ret, key, kind);
      let two = null;
      const waits = (r, tag, scope = null) => {
        for (const k of affected) unknownField(r, k, tag);
        independent(r, tag);
        if (two) for (const [i, v] of [[1, 0], [2, 25000], [3, 0], [4, 0], [5, 0], [6, 25000], [7, 0], [8, 25000]]) knownField(r, kOf(i, two), v, tag);
        assert.equal(r.applicability.facts.deductsCogs, 'unknown', `${tag}: applicability`);
        if (scope) {
          assert.ok(r.fields.find(x => x.key === key)?.reasons.some(why => scope.test(why)), `${tag}: the assigned member explains its scope failure`);
          assert.ok(errorsOf(r).some(c => scope.test(c.message)), `${tag}: the scope failure is reported`);
        }
      };
      waits(await compute(pool, C, ret), 'eligible, assignment only');
      // No neighbour first: a saved member cannot disappear into a complete zero either.
      await change({ to: '2024-12-31' });
      waits(await compute(pool, C, ret), 'ended, no neighbour', /not in effect in this period/);
      await change({});
      two = await activity(pool, C, { name: 'Sample reviewed trade' });
      await reviewedPaper(C, ret, two);
      waits(await compute(pool, C, ret), 'eligible beside reviewed trade');
      const revisions = [];
      for (const [tag, fields, scope] of [['ended', { to: '2024-12-31' }, /not in effect in this period/], ['moved', { schedule: 'none' }, /not reported on this form/]]) {
        await change(fields);
        const r = await compute(pool, C, ret);
        waits(r, tag, scope);
        assert.deepEqual(errorsOf(r, 'inventory_activity'), [], `${tag}: inventory is explicitly disposed of`);
        assert.ok(!r.cogs.has(one), `${tag}: no workpaper was invented`);
        const { revisionNo } = await takeWorkingRevision(pool, { ...C, returnId: ret, takenBy: 'tester' });
        revisions.push({ revisionNo, tag, scope });
        await change({});
        waits(await compute(pool, C, ret), `${tag}, eligibility restored`);
      }
      // Revisions preserve the assignment, the scope reason, the unknowns and the independent amounts after restoration.
      for (const { revisionNo, tag, scope } of revisions) {
        const saved = await getRevision(pool, { ...C, returnId: ret, revisionNo });
        waits(saved.results, `${tag}, frozen`, scope);
        assert.ok(saved.inputs.assignments.some(a => a.slot === key && a.kind === kind), `${tag}: the assignment is frozen`);
        assert.ok(!saved.inputs.cogs.some(w => w.activityId === one), `${tag}: no saved workpaper was invented`);
      }
      // One completed reconstruction per form proves the unresolved member is counted exactly once when repaired.
      if (kind === 'cogs_workpaper' && n === '2') {
        await bind(pool, C, ret, A.inv, 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.2', activityId: one }]);
        await builtPaper(C, ret, one, '0', '10.00');
        const r = await compute(pool, C, ret);
        for (const [i, v] of [[1, 0], [2, 10000], [3, 0], [4, 0], [5, 0], [6, 10000], [7, 1000], [8, 9000]]) knownField(r, kOf(i, one), v, 'reconstructed');
        for (const k of totals) knownField(r, k, k === `${f.cogs}|activity` ? 34000 : 16000, 'reconstructed');
        knownField(r, kOf(8, two), 25000, 'reconstructed neighbour');
        independent(r, 'reconstructed');
        assert.equal(r.applicability.facts.deductsCogs, true);
      }
    });
  }
  for (const rt of ['form_1065', 'form_1120s']) for (const path of ['manual', 'workpaper']) await t.test(`${rt}, existing ${path} scope control`, async () => {
    const { C, ret, one, change, totals, independent } = await setup(rt, path);
    if (path === 'manual') await assign(C, ret, kOf(2, one), 'manual');
    else await builtPaper(C, ret, one, null, null);
    for (const [fields, scope] of [[{ to: '2024-12-31' }, /not in effect in this period/], [{ schedule: 'none' }, /not reported on this form/]]) {
      await change(fields);
      const r = await compute(pool, C, ret);
      for (const k of [kOf(2, one), kOf(6, one), kOf(8, one), ...totals]) unknownField(r, k, path);
      independent(r, path);
      assert.ok(errorsOf(r).some(c => scope.test(c.message)), `${path}: scope is reported`);
      await change({});
    }
  });
  for (const rt of ['form_1065', 'form_1120s']) await t.test(`${rt}, all 64 manual subsets and answer clearing controls`, async () => {
    const { C, ret, one, f, totals, independent } = await setup(rt, 'subsets');
    const amounts = ['123.00', '250.00', '0.00', '0.00', null, '45.00'], cents = [12300, 25000, 0, 0, 0, 4500];
    const enter = i => saveManualItem(pool, { ...C, returnId: ret, itemKey: kOf(inputs[i], one), ...(amounts[i] === null ? { status: 'not_applicable' } : { status: 'entered', amount: amounts[i] }), enteredBy: 'tester' });
    for (let mask = 0; mask < 64; mask += 1) {
      await pool.query('DELETE FROM tax_provider_assignment WHERE org_id = $1 AND return_id = $2', [orgId, ret]);
      await pool.query("DELETE FROM tax_manual_item WHERE org_id = $1 AND return_id = $2 AND item_key LIKE 'f1125a.%'", [orgId, ret]);
      for (let i = 0; i < 6; i += 1) if (mask & (1 << i)) { await assign(C, ret, kOf(inputs[i], one), 'manual'); await enter(i); }
      const r = await compute(pool, C, ret), tag = `subset ${mask}`;
      independent(r, tag);
      if (mask) for (let i = 0; i < 6; i += 1) {
        if (mask & (1 << i)) knownField(r, kOf(inputs[i], one), cents[i], tag);
        else unknownField(r, kOf(inputs[i], one), tag);
      }
      if (mask && mask !== 63) {
        for (const k of [kOf(8, one), ...totals]) unknownField(r, k, tag);
        if ((mask & 31) !== 31) unknownField(r, kOf(6, one), tag);
        else knownField(r, kOf(6, one), 37300, tag);
        assert.equal(r.applicability.facts.deductsCogs, 'unknown', tag);
      } else {
        const cogs = mask ? 32800 : 0;
        for (const k of totals) knownField(r, k, k === `${f.cogs}|activity` ? cogs : 50000 - cogs, tag);
        if (mask) knownField(r, kOf(8, one), cogs, tag);
        else assert.ok(!r.fields.some(x => x.dims.activity === `act:${one}`), 'an untouched activity has no invented member');
        assert.equal(r.applicability.facts.deductsCogs, Boolean(mask), tag);
      }
    }
    for (let i = 0; i < 6; i += 1) {
      await pool.query('DELETE FROM tax_manual_item WHERE org_id = $1 AND return_id = $2 AND item_key = $3', [orgId, ret, kOf(inputs[i], one)]);
      let r = await compute(pool, C, ret);
      for (const k of [kOf(inputs[i], one), kOf(8, one), ...totals]) unknownField(r, k, `cleared ${inputs[i]}`);
      for (let j = 0; j < 6; j += 1) if (i !== j) knownField(r, kOf(inputs[j], one), cents[j], 'other answers retained');
      await enter(i);
      r = await compute(pool, C, ret);
      knownField(r, kOf(8, one), 32800, 'answer restored');
      for (const k of totals) knownField(r, k, k === `${f.cogs}|activity` ? 32800 : 17200, 'answer restored');
    }
  });
});

test('a first-year opening failure holds only the failing owner instance (Codex t3-r9 R9-2)', async t => {
  for (const basis of ['accrual', 'cash']) await t.test(`${basis} books`, async () => {
    const f = F.form_1120s, C = { orgId, entityId: await company(pool, orgId, `Sample Independent Owners ${basis} Corp`) };
    await saveProfile(pool, { ...C, fields: { returnType: 'form_1120s', taxMethodDefault: basis, bookBasisDefault: basis, yearEndMonth: 12, dateStarted: '2025-01-01' }, reason: 'test', actor: 'tester' });
    const ret = Number(await openPeriod(pool, { ...C, year: 2025, initial: true, actor: 'tester' }));
    await verifyInitial(pool, { ...C, returnId: ret, verifiedBy: 'tester', evidence: 'Certificate of formation' });
    const mk = async name => { const owner = await party(pool, orgId, name); await saveInterest(pool, { ...C, fields: { partyId: owner, role: 'shareholder', from: '2025-01-01', to: null, profit: '1/2', loss: '1/2', capital: '1/2' }, actor: 'tester' }); return { owner, id: await interestOf(C, owner) }; };
    const one = await mk('Sample Owner One'), two = await mk('Sample Owner Two');
    const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), re: await acct(pool, C, 'Retained Earnings'), l1: await acct(pool, C, 'Loan to Owner One', 'other_current_asset'), l2: await acct(pool, C, 'Loan to Owner Two', 'other_current_asset') };
    const k7 = (o, m) => `f1120s.L.7|interest=i:${o.id}|${m}`;
    const typed = async (key, amount) => {
      await assignProvider(pool, { ...C, returnId: ret, slotKey: key, providerKind: 'manual', schemaVersion: 1, sourceRef: { reason: 'sample loan and equity statements' }, sourceVersion: `manual:${key}@1` });
      await saveManualItem(pool, { ...C, returnId: ret, itemKey: key, status: 'entered', amount, enteredBy: 'tester' });
    };
    await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 50000]]);
    await bindBalance(pool, C, ret, A.bank, f.cash);
    await bindBalance(pool, C, ret, A.re, f.re);
    await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
    const route = o => [{ treatment: 'input', destination: 'f1120s.L.7', interestPartyId: o.owner }];
    for (const [a, o] of [[A.l1, one], [A.l2, two]]) for (const m of ['begin', 'end']) await bind(pool, C, ret, a, m, route(o));
    await answerTypedItems(pool, C, ret);
    await typed(k7(two, 'begin'), '0.00');
    await typed(k7(two, 'end'), '300.00');
    await typed(`${f.re}|end`, '800.00');
    const bad = await je(pool, C, '2024-12-01', [[A.l1, 10000], [A.l2, -10000]]);
    const independent = (r, tag) => {
      for (const [k, v] of [[k7(two, 'begin'), 0], [k7(two, 'end'), 30000], [`${f.cash}|begin`, 0], [`${f.cash}|end`, 50000], [`${f.re}|begin`, 0], [`${f.re}|end`, 80000], [`${f.total}|begin`, 0], [`${f.total}|end`, 80000]]) knownField(r, k, v, tag);
      for (const k of [f.sales, f.ordinary, f.k1, f.endpoint, f.m1]) knownField(r, `${k}|activity`, 50000, tag);
    };
    const waits = (r, tag, beginningHeld) => {
      for (const k of [k7(one, 'end'), `${f.assets}|end`]) unknownField(r, k, tag);
      if (beginningHeld) for (const k of [k7(one, 'begin'), `${f.assets}|begin`]) unknownField(r, k, tag);
      else knownField(r, `${f.assets}|begin`, 0, tag);
      independent(r, tag);
      assert.ok(errorsOf(r, 'openings_initial').length > 0, `${tag}: the contradiction stays reported`);
      assert.ok(!r.fields.some(x => x.fieldId === 'f1120s.L.7' && !Object.keys(x.dims).length), `${tag}: only actual owner instances`);
    };
    const revisions = [];
    const check = async (tag, beginningHeld) => {
      waits(await compute(pool, C, ret), tag, beginningHeld);
      const { revisionNo } = await takeWorkingRevision(pool, { ...C, returnId: ret, takenBy: 'tester' });
      revisions.push({ revisionNo, tag, beginningHeld });
    };
    await check('book-fed opening beside independent sibling', true);
    await bind(pool, C, ret, A.l1, 'begin', [{ treatment: 'not_tax', memo: 'opening shown on the workpaper' }]);
    await check('only failing beginning disposed', false);
    await bind(pool, C, ret, A.l1, 'begin', route(one));
    await check('only failing beginning route restored', true);
    await typed(k7(one, 'begin'), '0.00');
    await check('both provided beginnings zero, consuming ending still held', false);
    knownField(await compute(pool, C, ret), k7(one, 'begin'), 0, 'typed zero opening');
    await saveManualItem(pool, { ...C, returnId: ret, itemKey: k7(one, 'begin'), status: 'entered', amount: '100.00', enteredBy: 'tester' });
    await check('nonzero manual opening beside independent sibling', true);
    await bind(pool, C, ret, A.l1, 'begin', [{ treatment: 'not_tax', memo: 'opening shown on the workpaper' }]);
    await check('nonzero manual opening, book beginning disposed', true);
    await bind(pool, C, ret, A.l1, 'begin', route(one));
    await check('nonzero manual opening, comparison restored', true);
    await dropTxn(bad);
    await check('source corrected, nonzero manual opening still fails', true);
    await saveManualItem(pool, { ...C, returnId: ret, itemKey: k7(one, 'begin'), status: 'entered', amount: '0.00', enteredBy: 'tester' });
    const r = await compute(pool, C, ret);
    independent(r, 'source and typed opening corrected');
    for (const [k, v] of [[k7(one, 'begin'), 0], [k7(one, 'end'), 0], [`${f.assets}|begin`, 0], [`${f.assets}|end`, 80000]]) knownField(r, k, v, 'corrected');
    assert.deepEqual(errorsOf(r), [], 'balanced corrected control has no errors');
    for (const { revisionNo, tag, beginningHeld } of revisions) {
      const saved = await getRevision(pool, { ...C, returnId: ret, revisionNo });
      waits(saved.results, `${tag}, frozen after correction`, beginningHeld);
      for (const m of ['begin', 'end']) assert.ok(saved.inputs.assignments.some(a => a.slot === k7(two, m) && a.kind === 'manual'), 'the independent authority is frozen');
    }
  });
});

const RP = (C, ret) => ({ return_id: ret, entity_id: C.entityId, period_start: '2025-01-01', period_end: '2025-12-31' });
const classifyClosing = async (C, ret, txnId) => { const c = (await closingCandidates(pool, { orgId, ret: RP(C, ret) })).find(x => x.txnId === txnId); await classifyEntry(pool, { ...C, returnId: ret, txnId, cls: 'closing', lines: c.proposed, expectTxnVersion: c.txnVersion, reviewedBy: 'tester' }); };
const redate = async (id, date) => { await pool.query('UPDATE txn SET txn_date = $2 WHERE txn_id = $1', [id, date]); await pool.query('UPDATE posting SET txn_date = $2 WHERE txn_id = $1', [id, date]); };

test('an unresolved closing makes net income per books unknown (Codex t3-r1 B3): undecided, memo-stale, deleted and moved closing sources on accrual and cash-basis books — M-1 line 1 and the bridge’s book amount null and unresolved, a revision preserving the unknown, a typed tax amount known throughout; reconfirmed or cleared, the amount returns; both forms', async () => {
  for (const rt of ['form_1065', 'form_1120s']) for (const basis of ['accrual', 'cash']) {
    const f = F[rt], what = `${rt}, ${basis} books`;
    const C = { orgId, entityId: await company(pool, orgId, `Rowan ${basis} ${f.suffix}`) };
    const ret = await period(pool, C, 2025, rt, { taxMethod: basis === 'cash' ? 'cash' : 'accrual', bookBasis: basis });
    const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), util: await acct(pool, C, 'Utilities'), re: await acct(pool, C, 'Retained Earnings') };
    await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 50000]]);
    await je(pool, C, '2025-06-01', [[A.util, 10000], [A.bank, -10000]]);
    const close = await je(pool, C, '2025-12-31', [[A.re, 10000], [A.util, -10000]], { memo: 'closing' });
    await bindBalance(pool, C, ret, A.bank, f.cash);
    await bindBalance(pool, C, ret, A.re, f.re);
    await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
    await bind(pool, C, ret, A.util, 'activity', [{ treatment: 'statement_row', destination: f.other }]);
    await answerTypedItems(pool, C, ret, { except: [`${f.dep}|activity`] });
    await saveManualItem(pool, { ...C, returnId: ret, itemKey: `${f.dep}|activity`, status: 'entered', amount: '250.00', enteredBy: 'tester' });
    const expectUnknown = (r, tag) => {
      unknownField(r, `${f.m1}|activity`, `${what}, ${tag}: M-1 line 1`);
      assert.equal(r.bridge.bookNetIncome, null, `${what}, ${tag}: the bridge’s book amount`);
      assert.ok(r.bridge.unknown.length > 0, `${what}, ${tag}: the bridge waits`);
      unknownField(r, `${f.re}|end`, `${what}, ${tag}: retained earnings takes the period’s income`);
      knownField(r, `${f.dep}|activity`, 25000, `${what}, ${tag}: the typed tax amount`);
      knownField(r, `${f.sales}|activity`, 50000, `${what}, ${tag}: an unrelated line`);
    };
    const expectKnown = (r, tag) => {
      knownField(r, `${f.m1}|activity`, 40000, `${what}, ${tag}: M-1 line 1`);
      assert.equal(r.bridge.bookNetIncome, '40000', `${what}, ${tag}: the bridge’s book amount`);
      knownField(r, `${f.dep}|activity`, 25000, `${what}, ${tag}: the typed tax amount`);
    };
    // Undecided.
    expectUnknown(await compute(pool, C, ret), 'undecided');
    await classifyClosing(C, ret, close);
    expectKnown(await compute(pool, C, ret), 'decided');
    // Memo-stale: the raw measurement nets to zero, the saved decision is stale — unknown, frozen as such, until decided again.
    await pool.query(`UPDATE txn SET memo = 'edited' WHERE txn_id = $1`, [close]);
    expectUnknown(await compute(pool, C, ret), 'stale');
    const { revisionNo } = await takeWorkingRevision(pool, { ...C, returnId: ret, takenBy: 'tester' });
    const saved = await getRevision(pool, { ...C, returnId: ret, revisionNo });
    assert.equal(saved.results.bridge.bookNetIncome, null, `${what}: the revision keeps the unknown book amount`);
    assert.deepEqual(saved.results.fields.filter(x => x.key === `${f.m1}|activity`).map(x => [x.cents, x.status]), [[null, 'unresolved']], `${what}: the revision keeps M-1 line 1 unknown`);
    await classifyClosing(C, ret, close);
    expectKnown(await compute(pool, C, ret), 'reconfirmed');
    // Moved into the year before: stale (no longer this period’s), unknown until cleared.
    await redate(close, '2024-12-31');
    expectUnknown(await compute(pool, C, ret), 'moved');
    await clearClassification(pool, { ...C, returnId: ret, txnId: close });
    expectKnown(await compute(pool, C, ret), 'moved and cleared');
    await redate(close, '2025-12-31');
    await classifyClosing(C, ret, close);
    expectKnown(await compute(pool, C, ret), 'moved back and decided');
    // Deleted: the decision outlives its entry; cleared, the books as they are now.
    await dropTxn(close);
    expectUnknown(await compute(pool, C, ret), 'deleted');
    await clearClassification(pool, { ...C, returnId: ret, txnId: close });
    expectKnown(await compute(pool, C, ret), 'deleted and cleared');
  }
});

const kOf = (n, act) => `f1125a.main.${n}|activity=act:${act}|activity`;

test('a reviewed COGS workpaper keeps its purchases beside a closing candidate on its old income-statement input (Codex t3-r1 B4): undecided, memo-stale and deleted closings — purchases, line 8, page 1 COGS and ordinary income keep the entered amounts, the packet claims no book slice, the book side waits, an unrelated activity is known; back to a reconstruction the hold returns; both forms', async () => {
  for (const rt of ['form_1065', 'form_1120s']) for (const state of ['undecided', 'stale', 'deleted']) {
    const f = F[rt], what = `${rt}, ${state}`;
    const C = { orgId, entityId: await company(pool, orgId, `Alder ${state} ${f.suffix}`) };
    const ret = await period(pool, C, 2025, rt, { taxMethod: 'accrual' });
    const one = await activity(pool, C, { name: `Alder ${state} retail` }), two = await activity(pool, C, { name: `Alder ${state} parts` });
    const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), re: await acct(pool, C, 'Retained Earnings'), cost: await acct(pool, C, 'Purchases', 'cost_of_goods_sold'), labor: await acct(pool, C, 'Direct Labor', 'cost_of_goods_sold') };
    await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 50000]]);
    await je(pool, C, '2025-04-01', [[A.cost, 10000], [A.bank, -10000]]);
    await je(pool, C, '2025-04-02', [[A.labor, 7000], [A.bank, -7000]]);
    const close = await je(pool, C, '2025-12-31', [[A.re, 10000], [A.cost, -10000]], { memo: 'closing' });
    await bindBalance(pool, C, ret, A.bank, f.cash);
    await bindBalance(pool, C, ret, A.re, f.re);
    await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
    await bind(pool, C, ret, A.cost, 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.2', activityId: one }]);
    await bind(pool, C, ret, A.labor, 'activity', [{ treatment: 'cogs_input', destination: 'f1125a.main.3', activityId: two }]);
    await answerTypedItems(pool, C, ret);
    const reviewed = () => saveWorkpaper(pool, { ...C, returnId: ret, activityId: one, path: 'reviewed', treatment: 'inventory_as_booked', method: 'cost', reviewedLines: { '1': '0', '2': '250.00', '3': '0', '4': '0', '5': [], '7': '0' }, sourceNote: 'The count sheets', reviewedBy: 'tester' });
    const reconstruct = () => saveWorkpaper(pool, { ...C, returnId: ret, activityId: one, path: 'reconstruct', treatment: 'inventory_as_booked', method: 'cost', begin: '0', end: '0', reviewedBy: 'tester' });
    await saveWorkpaper(pool, { ...C, returnId: ret, activityId: two, path: 'reconstruct', treatment: 'inventory_as_booked', method: 'cost', begin: '0', end: '0', reviewedBy: 'tester' });
    if (state !== 'undecided') await classifyClosing(C, ret, close);
    if (state === 'stale') await pool.query(`UPDATE txn SET memo = 'edited' WHERE txn_id = $1`, [close]);
    if (state === 'deleted') await dropTxn(close);
    await reviewed();
    let r = await compute(pool, C, ret);
    knownField(r, kOf(2, one), 25000, `${what}: reviewed purchases`);
    knownField(r, kOf(8, one), 25000, `${what}: line 8`);
    knownField(r, `${f.cogs}|activity`, 32000, `${what}: page 1 cost of goods sold`);
    knownField(r, `${f.ordinary}|activity`, 18000, `${what}: independently determinable income`);
    knownField(r, kOf(3, two), 7000, `${what}: the unrelated activity`);
    assert.deepEqual(r.packets.find(p => p.values[0].slotKey === kOf(2, one))?.consumedSlices, [], `${what}: the reviewed packet claims no book slice`);
    assert.ok(r.bridge.unknown.length > 0 && r.fields.some(x => x.fieldId.startsWith(F[rt].m1.slice(0, -1)) && x.status === 'unresolved'), `${what}: the book side waits`);
    assert.ok(r.candidates.some(c => c.txnId === close && c.state !== 'decided'), `${what}: the candidate is shown`);
    // Back to a reconstruction: the input is consumed again, and the closing holds it.
    await reconstruct();
    r = await compute(pool, C, ret);
    unknownField(r, kOf(2, one), `${what}, reconstructed`);
    unknownField(r, `${f.cogs}|activity`, `${what}, reconstructed`);
    knownField(r, kOf(3, two), 7000, `${what}, reconstructed: the unrelated activity`);
  }
});

test('an accepted proposal whose rule no longer matches stays in force and holds what it decided until withdrawn (Codex t3-r1 B5): the account renamed to a neutral name, remapped to another deduction, its source deleted, its sign changed — the deduction, Schedule K’s nondeductible line and ordinary income null and unresolved, the decision listed and frozen; a renamed-but-still-matching control waits as a changed proposal; withdrawing (or answering the new proposal) releases the hold; both forms', async () => {
  for (const rt of ['form_1065', 'form_1120s']) for (const scenario of ['renamed', 'remapped', 'deleted', 'sign', 'control']) {
    const f = F[rt], what = `${rt}, ${scenario}`;
    const C = { orgId, entityId: await company(pool, orgId, `Juniper ${scenario} ${f.suffix}`) };
    const ret = await period(pool, C, 2025, rt, { taxMethod: 'accrual' });
    const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), meals: await acct(pool, C, 'Meals'), re: await acct(pool, C, 'Retained Earnings') };
    await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 50000]]);
    const mealsTxn = await je(pool, C, '2025-04-01', [[A.meals, 10000], [A.bank, -10000]]);
    await bindBalance(pool, C, ret, A.bank, f.cash);
    await bindBalance(pool, C, ret, A.re, f.re);
    await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
    await bind(pool, C, ret, A.meals, 'activity', [{ treatment: 'statement_row', destination: f.other }]);
    await answerTypedItems(pool, C, ret);
    const S = { ...C, returnId: ret };
    let r = await compute(pool, C, ret);
    const p = r.proposals.find(x => x.accountName === 'Meals');
    assert.ok(p, `${what}: the meals proposal`);
    await answerProposal(pool, { ...S, key: p.key, version: p.version, decision: 'accept', decidedBy: 'tester', compute: computeIn });
    r = await compute(pool, C, ret);
    knownField(r, `${f.other}|activity`, 5000, `${what}, accepted`);
    knownField(r, `${f.nondeductible}|activity`, 5000, `${what}, accepted`);
    knownField(r, `${f.ordinary}|activity`, 45000, `${what}, accepted`);
    const group = (await listAdjustments(pool, { orgId, returnId: ret })).find(g => g.source === 'proposal');
    // The source changes so that the rule no longer produces this proposal (or, the control, still does).
    if (scenario === 'renamed') await pool.query(`UPDATE account SET name = 'Staff costs' WHERE account_id = $1`, [A.meals]);
    if (scenario === 'remapped') await bind(pool, C, ret, A.meals, 'activity', [{ treatment: 'input', destination: f.rent }]);
    if (scenario === 'deleted') await dropTxn(mealsTxn);
    if (scenario === 'sign') await je(pool, C, '2025-07-01', [[A.bank, 15000], [A.meals, -15000]]);
    if (scenario === 'control') await pool.query(`UPDATE account SET name = 'Staff Meals' WHERE account_id = $1`, [A.meals]);
    r = await compute(pool, C, ret);
    knownField(r, `${f.sales}|activity`, 50000, `${what}: an unrelated line`);
    if (scenario === 'control') {
      // Still a meals account: the proposal is computed again with a new version; the old answer is stale, the line waits — not an orphan.
      assert.deepEqual(r.orphanAnswers ?? [], [], `${what}: no orphan`);
      unknownField(r, `${f.other}|activity`, `${what}: the changed proposal waits`);
      const again = r.proposals.find(x => x.accountName === 'Staff Meals');
      assert.ok(again && !again.answer?.fresh && errorsOf(r, 'proposal_open').length, `${what}: shown as changed since answered`);
      await answerProposal(pool, { ...S, key: again.key, version: again.version, decision: 'accept', decidedBy: 'tester', compute: computeIn });
      r = await compute(pool, C, ret);
      knownField(r, `${f.other}|activity`, 5000, `${what}, answered again`);
      knownField(r, `${f.nondeductible}|activity`, 5000, `${what}, answered again`);
      continue;
    }
    for (const k of [`${f.other}|activity`, `${f.nondeductible}|activity`, `${f.ordinary}|activity`, `${f.k1}|activity`]) unknownField(r, k, `${what}: held by the orphaned answer`);
    if (scenario === 'remapped') unknownField(r, `${f.rent}|activity`, `${what}: the replacement destination is held too`);
    assert.ok(!r.proposals.some(x => x.key === p.key), `${what}: the rule no longer proposes it`);
    assert.ok((r.orphanAnswers ?? []).some(g => g.group_id === group.group_id && g.status === 'accepted'), `${what}: the accepted answer is listed as no longer matching`);
    assert.ok(errorsOf(r, 'proposal_orphan').length > 0 && !r.checks.some(c => c.code === 'stale_answer'), `${what}: an error, not a warning`);
    // Frozen: the revision keeps the decision and the unknown it causes.
    const { revisionNo } = await takeWorkingRevision(pool, { ...S, takenBy: 'tester' });
    const saved = await getRevision(pool, { ...S, revisionNo });
    const frozen = saved.inputs.adjustments.groups.find(g => g.id === group.group_id);
    assert.deepEqual([frozen?.status, frozen?.lines.map(l => l.cents)], ['accepted', ['-5000', '5000']], `${what}: the old answer is frozen whole`);
    assert.ok(saved.inputs.adjustments.orphans.includes(group.group_id), `${what}: listed as an orphan in the revision`);
    assert.deepEqual(saved.results.fields.filter(x => x.key === `${f.other}|activity`).map(x => [x.cents, x.status]), [[null, 'unresolved']], `${what}: the revision keeps the unknown`);
    // The explicit current decision: withdrawn against today's evidence.
    await withdrawAdjustment(pool, { ...S, groupId: group.group_id, reason: 'The account is not meals any more', decidedBy: 'tester' });
    r = await compute(pool, C, ret);
    assert.deepEqual(r.orphanAnswers ?? [], [], `${what}, withdrawn: nothing listed`);
    const want = { renamed: [10000, 0, 40000], deleted: [0, 0, 50000], sign: [-5000, 0, 55000], remapped: [0, null, null] }[scenario];
    for (const [k, v] of [[`${f.other}|activity`, want[0]], [`${f.nondeductible}|activity`, want[1]], [`${f.ordinary}|activity`, want[2]]]) { if (v === null) unknownField(r, k, `${what}, withdrawn`); else knownField(r, k, v, `${what}, withdrawn: the full default, by a decision`); }
    if (scenario === 'remapped') {
      // The new proposal on the new destination still waits; answered, it applies there once.
      const next = r.proposals.find(x => x.accountName === 'Meals');
      assert.ok(next && !next.answer, `${what}: the new proposal waits`);
      await answerProposal(pool, { ...S, key: next.key, version: next.version, decision: 'accept', decidedBy: 'tester', compute: computeIn });
      r = await compute(pool, C, ret);
      knownField(r, `${f.rent}|activity`, 5000, `${what}, new proposal accepted`);
      knownField(r, `${f.nondeductible}|activity`, 5000, `${what}, new proposal accepted: once`);
      knownField(r, `${f.ordinary}|activity`, 45000, `${what}, new proposal accepted`);
    }
  }
});
