// test/tax-engine-contracts.test.js — the engine's contracts beyond the end-to-end returns (Codex t3-plan-r1): tax-exempt interest has one
// M-1 treatment whoever provides it (B6: both forms; books, cash and typed authority; equal and unequal periods; an adjustment that adds it);
// classified components wait for a person and never exceed their parent (B10); book portions of every packet are T2's proved partition
// portions, and a tampered or mixed mapping is refused even when totals conserve (B11), a destination fed only by books that cannot be read
// is unknown; a saved reference that changes after the save leaves its input unresolved (B9); applicability is three-state and the lines
// that wait for stage T4 are listed, unresolved (B14).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { catalogFor } from '../lib/tax/catalog/index.js';
import { t2Db, company, acct, je, period, activity, bind, bindBalance, compute, valueOf, errorsOf, answerTypedItems, deposit, importedJe } from './tax-t3-fixtures.js';
import { include, party } from './tax-t2-fixtures.js';
import { saveManualItem, manualNeeds, markRemainingNotApplicable, listManualItems, clearManualItem } from '../lib/tax/manual.js';
import { saveAdjustment, withdrawAdjustment } from '../lib/tax/adjustments.js';
import { saveWorkpaper } from '../lib/tax/cogs.js';
import { cashRecognition, saveTimingReview } from '../lib/tax/cash.js';
import { assignProvider } from '../lib/tax/providers.js';
import { saveInterest } from '../lib/tax/ownership.js';
import { saveBindings } from '../lib/tax/bindings.js';
import { buildPartition } from '../lib/tax/partition.js';
import { bookParts, packetSetProblems } from '../lib/tax/engine/compute.js';

let t, pool, orgId;
before(async () => { t = await t2Db(); pool = t.pool; orgId = t.orgId; });
after(async () => { await t.db.drop(); });
const expectAll = (r, want) => { for (const [k, v] of Object.entries(want)) assert.equal(valueOf(r, k), v, k); };
const rows = r => r.bridge.rows.map(x => [x.line, x.cents, x.cls]).sort();
const catalogLabel = (rt, id) => catalogFor(rt, 2025).byId.get(id).label;

// A small company: services income, tax-exempt interest into its own account, an interest receivable for accruals.
async function exemptCo(name, returnType, taxMethod) {
  const C = { orgId, entityId: await company(pool, orgId, name) };
  const ret = await period(pool, C, 2025, returnType, { taxMethod });
  const f = returnType === 'form_1065' ? { cash: 'f1065.L.1', other: 'f1065.L.6', capital: 'f1065.L.21', sales: 'f1065.p1.1a', exempt: 'f1065.k.18a' } : { cash: 'f1120s.L.1', other: 'f1120s.L.6', capital: 'f1120s.L.24', sales: 'f1120s.p1.1a', exempt: 'f1120s.k.16a' };
  const A = { bank: await acct(pool, C, 'Checking'), svc: await acct(pool, C, 'Services'), muni: await acct(pool, C, 'Municipal Bond Interest', 'other_income'), recv: await acct(pool, C, 'Interest Receivable', 'other_current_asset') };
  await deposit(pool, C, '2025-02-01', A.bank, [[A.svc, 50000]]);
  await deposit(pool, C, '2025-05-01', A.bank, [[A.muni, 10000]]);
  await bindBalance(pool, C, ret, A.bank, f.cash);
  await bind(pool, C, ret, A.recv, 'end', [{ treatment: 'statement_row', destination: f.other }]);
  await bind(pool, C, ret, await acct(pool, C, 'Retained Earnings'), 'end', [{ treatment: 'input', destination: f.capital }]);
  await bind(pool, C, ret, A.svc, 'activity', [{ treatment: 'input', destination: f.sales }]);
  await bind(pool, C, ret, A.muni, 'activity', [{ treatment: 'input', destination: f.exempt }]);
  await answerTypedItems(pool, C, ret);
  return { C, ret, A, f };
}

test('tax-exempt interest, one M-1 treatment (Form 1065, cash method): equal periods; recognized by the books a period earlier; typed instead of the books; added by an adjustment — never subtracted twice', async () => {
  const { C, ret, A } = await exemptCo('Ash Cash Partners', 'form_1065', 'cash');
  let r = await compute(pool, C, ret);
  expectAll(r, { 'f1065.k.18a|activity': 10000n, 'f1065.anal.1|activity': 50000n, 'f1065.m1.1|activity': 60000n, 'f1065.m1.6a|activity': 10000n, 'f1065.m1.9|activity': 50000n });
  assert.deepEqual(rows(r), [['6a', '10000', 'tax_exempt']], 'the books’ tax-exempt interest once, on line 6a');
  assert.equal(r.bridge.residual, '0');
  // Accrued by the books in December, received next year: the return excludes it this year; the books still recorded it.
  const accrual = await importedJe(pool, C, '2025-12-31', [[A.recv, 3000], [A.muni, -3000]]);
  const R = { return_id: ret, entity_id: C.entityId, period_start: '2025-01-01', period_end: '2025-12-31', tax_method: 'cash' };
  const c = (await cashRecognition(pool, { orgId, ret: R })).candidates.find(x => x.txnId === accrual);
  await saveTimingReview(pool, { ...C, returnId: ret, txnId: accrual, kind: 'imported_accrual_je', decision: 'exclude', expectTxnVersion: c.txnVersion, expectEventVersion: c.eventVersion, reviewedBy: 'tester' });
  r = await compute(pool, C, ret);
  expectAll(r, { 'f1065.k.18a|activity': 10000n, 'f1065.m1.1|activity': 63000n, 'f1065.m1.6a|activity': 13000n, 'f1065.m1.9|activity': 50000n });
  assert.deepEqual(rows(r), [['6a', '13000', 'tax_exempt']], 'the book amount on 6a, and no second, "timing" subtraction');
  assert.equal(r.bridge.residual, '0');
  // Typed instead (a reviewed tax-exempt amount): the books' 13,000 stays the M-1 amount; the typed 5,000 is Schedule K's.
  await assignProvider(pool, { ...C, returnId: ret, slotKey: 'f1065.k.18a|activity', providerKind: 'manual', schemaVersion: 1, sourceRef: { reason: 'broker statement' }, sourceVersion: 'manual:broker@1' });
  await saveManualItem(pool, { ...C, returnId: ret, itemKey: 'f1065.k.18a|activity', status: 'entered', amount: '50.00', enteredBy: 'tester' });
  r = await compute(pool, C, ret);
  expectAll(r, { 'f1065.k.18a|activity': 5000n, 'f1065.m1.6a|activity': 13000n, 'f1065.m1.9|activity': 50000n });
  assert.deepEqual(rows(r), [['6a', '13000', 'tax_exempt']]);
  // Added by an adjustment (interest the books never recorded): Schedule K only; no M-1 difference.
  await saveAdjustment(pool, { ...C, returnId: ret, purpose: 'tax_exempt_interest', memo: 'Interest the books missed', evidence: 'Broker statement, December', decidedBy: 'tester', lines: [{ slotKey: 'f1065.k.18a|activity', amount: '25.00', m1Class: 'tax_exempt' }] });
  r = await compute(pool, C, ret);
  expectAll(r, { 'f1065.k.18a|activity': 7500n, 'f1065.m1.6a|activity': 13000n, 'f1065.m1.9|activity': 50000n });
  assert.deepEqual(rows(r), [['6a', '13000', 'tax_exempt']]);
  assert.equal(r.bridge.residual, '0');
});

test('tax-exempt interest, one M-1 treatment (Form 1120-S, books authority): line 5a is the books’ amount; an adjustment adding to line 16a is no M-1 difference; book income moved there by an adjustment is line 5a too', async () => {
  const { C, ret, A } = await exemptCo('Ash Corp', 'form_1120s', 'accrual');
  let r = await compute(pool, C, ret);
  expectAll(r, { 'f1120s.k.16a|activity': 10000n, 'f1120s.k.18|activity': 50000n, 'f1120s.m1.1|activity': 60000n, 'f1120s.m1.5a|activity': 10000n, 'f1120s.m1.8|activity': 50000n });
  assert.deepEqual(rows(r), [['6a', '10000', 'tax_exempt']]);
  await saveAdjustment(pool, { ...C, returnId: ret, purpose: 'tax_exempt_interest', memo: 'Interest the books missed', evidence: 'Broker statement', decidedBy: 'tester', lines: [{ slotKey: 'f1120s.k.16a|activity', amount: '25.00', m1Class: 'tax_exempt' }] });
  // Income booked to Services that is tax-exempt interest: out of the reconciliation, onto line 16a; the M-1 shows it on 5a.
  // (Not a reclass: it changes the return's income.)
  await assert.rejects(saveAdjustment(pool, { ...C, returnId: ret, purpose: 'reclass', memo: 'Bond interest booked as services', evidence: 'Deposit detail', decidedBy: 'tester',
    lines: [{ slotKey: 'f1120s.p1.1a|activity', amount: '-40.00', m1Class: 'reclass' }, { slotKey: 'f1120s.k.16a|activity', amount: '40.00', m1Class: 'reclass' }] }), /without changing the return’s income/);
  await saveAdjustment(pool, { ...C, returnId: ret, purpose: 'tax_exempt_interest', memo: 'Bond interest booked as services', evidence: 'Deposit detail', decidedBy: 'tester',
    lines: [{ slotKey: 'f1120s.p1.1a|activity', amount: '-40.00', m1Class: 'tax_exempt' }, { slotKey: 'f1120s.k.16a|activity', amount: '40.00', m1Class: 'tax_exempt' }] });
  r = await compute(pool, C, ret);
  expectAll(r, { 'f1120s.k.16a|activity': 16500n, 'f1120s.k.18|activity': 46000n, 'f1120s.m1.1|activity': 60000n, 'f1120s.m1.5a|activity': 14000n, 'f1120s.m1.8|activity': 46000n });
  assert.equal(r.bridge.residual, '0');
  void A;
});

test('classified components (Codex t3-plan-r1 B10), both forms: unresolved while the parent has an amount and nothing is entered; an explicit zero; a valid part; one larger than its parent refused; never added to income twice', async () => {
  for (const [rt, parent, sub, inv, invParent, endpoint] of [['form_1065', 'f1065.k.6a', 'f1065.k.6b', 'f1065.k.11_inv', 'f1065.k.11', 'f1065.anal.1'], ['form_1120s', 'f1120s.k.5a', 'f1120s.k.5b', 'f1120s.k.10_inv', 'f1120s.k.10', 'f1120s.k.18']]) {
    const C = { orgId, entityId: await company(pool, orgId, `Bay ${rt === 'form_1065' ? 'Partners' : 'Corp'}`) };
    const ret = await period(pool, C, 2025, rt, { taxMethod: 'accrual' });
    const bank = await acct(pool, C, 'Checking'), div = await acct(pool, C, 'Dividends Earned', 'other_income');
    await je(pool, C, '2025-03-01', [[bank, 8000], [div, -8000]]);
    await bindBalance(pool, C, ret, bank, rt === 'form_1065' ? 'f1065.L.1' : 'f1120s.L.1');
    await bind(pool, C, ret, await acct(pool, C, 'Retained Earnings'), 'end', [{ treatment: 'input', destination: rt === 'form_1065' ? 'f1065.L.21' : 'f1120s.L.24' }]);
    await bind(pool, C, ret, div, 'activity', [{ treatment: 'input', destination: parent }]);
    await answerTypedItems(pool, C, ret, { except: [`${sub}|activity`, `${inv}|activity`] });
    const S = { ...C, returnId: ret };
    let r = await compute(pool, C, ret);
    assert.equal(valueOf(r, `${sub}|activity`), null, `${rt}: the parent has 80.00 and nothing is entered`);
    assert.ok(errorsOf(r, 'manual_open').some(e => e.itemKey === `${sub}|activity`));
    assert.equal(valueOf(r, `${inv}|activity`), 0n, `${rt}: its parent (${invParent}) is a known zero, so is it`);
    assert.ok(!errorsOf(r, 'manual_open').some(e => e.itemKey === `${inv}|activity`));
    assert.equal(valueOf(r, `${endpoint}|activity`), 8000n, 'the reconciliation never waits on, or adds, a component');
    await saveManualItem(pool, { ...S, itemKey: `${sub}|activity`, status: 'entered', amount: '0', enteredBy: 'tester' });
    assert.equal(valueOf(await compute(pool, C, ret), `${sub}|activity`), 0n, 'an entered zero');
    await saveManualItem(pool, { ...S, itemKey: `${sub}|activity`, status: 'entered', amount: '30.00', enteredBy: 'tester' });
    r = await compute(pool, C, ret);
    assert.equal(valueOf(r, `${sub}|activity`), 3000n);
    assert.equal(valueOf(r, `${endpoint}|activity`), 8000n, 'not counted twice');
    await saveManualItem(pool, { ...S, itemKey: `${sub}|activity`, status: 'entered', amount: '90.00', enteredBy: 'tester' });
    r = await compute(pool, C, ret);
    assert.equal(valueOf(r, `${sub}|activity`), null);
    assert.ok(errorsOf(r, 'subset').some(e => /is not part of/.test(e.message)));
  }
});

test('packets carry T2’s proved partition (Codex t3-plan-r1 B11): the manifest version and normalization; other shares, targets or normalizations and mixed manifests are refused even when totals conserve; a destination fed only by unread books is unknown', async () => {
  const P = { orgId, entityId: await company(pool, orgId, 'Pine Partners') };
  const ret = await period(pool, P, 2025, 'form_1065', { taxMethod: 'accrual' });
  const bank = await acct(pool, P, 'Checking'), svc = await acct(pool, P, 'Services'), wages = await acct(pool, P, 'Wages');
  await je(pool, P, '2025-02-01', [[bank, 90000], [svc, -90000]]);
  await je(pool, P, '2025-03-01', [[wages, 30000], [bank, -30000]]);
  await bindBalance(pool, P, ret, bank, 'f1065.L.1');
  await bind(pool, P, ret, await acct(pool, P, 'Retained Earnings'), 'end', [{ treatment: 'input', destination: 'f1065.L.21' }]);
  await bind(pool, P, ret, svc, 'activity', [{ treatment: 'input', destination: 'f1065.p1.1a' }]);
  await bind(pool, P, ret, wages, 'activity', [{ treatment: 'input', destination: 'f1065.p1.9', share: '1/2' }, { treatment: 'statement_row', destination: 'f1065.p1.21', share: '1/2' }], { split: 'shares' });
  await answerTypedItems(pool, P, ret);
  const r = await compute(pool, P, ret);
  const own = r.cov.sources[0].accounts.find(a => a.accountId === svc);
  const pk = r.packets.find(x => x.values[0].slotKey === 'f1065.p1.1a|activity');
  assert.deepEqual(pk.sourceRefs.filter(x => x.kind === 'books_partition'), [{ kind: 'books_partition', id: `${P.entityId}/${svc}/activity`, version: own.results.activity.version, normalization: 'as_posted' }]);
  assert.equal(r.packets.find(x => x.values[0].slotKey === 'f1065.p1.9|activity').consumedSlices.length, 1, 'each share is its own portion');
  // The proof, against the saved rows: another share, another target or another normalization is refused though the cents conserve.
  const measured = { cents: 30000n, version: 'm1', lineGroups: 1, normalization: 'as_posted' };
  const rowsSaved = [{ id: 1, targetKey: 'a', shareNum: '1', shareDen: '2' }, { id: 2, targetKey: 'b', shareNum: '1', shareDen: '2' }];
  const owners = new Map([['9/7/activity/binding:1', 'books'], ['9/7/activity/binding:2', 'books']]);
  const part = rs => buildPartition({ entityId: 9, accountId: 7, measurement: 'activity', measured, rows: rs });
  const take = (p, m = measured) => bookParts({ partition: p, provider: 'books', memberIds: new Set(['binding:1']), owners, measured: m, lines: null, approved: { rows: rowsSaved, attributions: [] } });
  assert.equal(take(part(rowsSaved)).cents, 15000n);
  assert.throws(() => take(part([{ ...rowsSaved[0], shareNum: '1', shareDen: '3' }, { ...rowsSaved[1], shareNum: '2', shareDen: '3' }])), /not the approved mapping/);
  assert.throws(() => take(part([{ ...rowsSaved[0], targetKey: 'c' }, rowsSaved[1]])), /not the approved mapping/);
  assert.throws(() => take(part(rowsSaved), { ...measured, normalization: 'closings:abc' }), /not the approved mapping|another version/);
  const ok = take(part(rowsSaved));
  assert.deepEqual(packetSetProblems([{ sourceRefs: ok.sourceRefs }, { sourceRefs: [{ ...ok.sourceRefs[0], version: 'other' }] }]).map(x => x.id), ['9/7/activity'], 'two manifests of one source never combine');
  // A destination fed only by books that no longer reach this return (stored, its inclusion gone): unknown, never absent.
  const K = { orgId, entityId: await company(pool, orgId, 'Pine Child LLC') };
  await period(pool, K, 2025, 'disregarded');
  const edge = await include(pool, P, ret, await activity(pool, P, { name: 'Pine trade' }), K.entityId);
  const kInt = await acct(pool, K, 'Interest Earned');
  await je(pool, K, '2025-04-01', [[await acct(pool, K, 'Checking'), 700], [kInt, -700]]);
  await saveBindings(pool, { ...P, returnId: ret, sourceEntityId: K.entityId, accountId: kInt, measurement: 'activity', rows: [{ treatment: 'statement_row', destination: 'f1065.p1.7' }], actor: 'tester' });
  await pool.query('ALTER TABLE activity_inclusion DISABLE TRIGGER activity_inclusion_bound');
  try { await pool.query('DELETE FROM activity_inclusion WHERE org_id = $1 AND inclusion_id = $2', [orgId, edge]); } finally { await pool.query('ALTER TABLE activity_inclusion ENABLE TRIGGER activity_inclusion_bound'); }
  const s = await compute(pool, P, ret);
  assert.equal(valueOf(s, 'f1065.p1.7|activity'), null, 'unread books: their slot is unknown');
  assert.equal(valueOf(s, 'f1065.p1.8|activity'), null, 'and every total it reaches');
  assert.ok(errorsOf(s, 'coverage').length && errorsOf(s, 'slot').some(e => e.slotKey === 'f1065.p1.7|activity'));
});

test('a saved reference that changes after the save leaves its input unresolved (Codex t3-plan-r1 B9); applicability is three-state and the lines waiting for stage T4 are listed (B14)', async () => {
  const Q = { orgId, entityId: await company(pool, orgId, 'Quince Trade Partners') };
  const ret = await period(pool, Q, 2025, 'form_1065', { taxMethod: 'accrual' });
  const act = await activity(pool, Q, { name: 'Quince trade' });
  const bank = await acct(pool, Q, 'Checking'), svc = await acct(pool, Q, 'Services'), wages = await acct(pool, Q, 'Wages');
  const cogsAcct = await acct(pool, Q, 'Cost of Goods Sold');
  await je(pool, Q, '2025-02-01', [[bank, 90000], [svc, -90000]]);
  await je(pool, Q, '2025-03-01', [[cogsAcct, 20000], [bank, -20000]]);
  await je(pool, Q, '2025-04-01', [[wages, 10000], [bank, -10000]]);
  await bindBalance(pool, Q, ret, bank, 'f1065.L.1');
  await bind(pool, Q, ret, await acct(pool, Q, 'Retained Earnings'), 'end', [{ treatment: 'input', destination: 'f1065.L.21' }]);
  await bind(pool, Q, ret, svc, 'activity', [{ treatment: 'input', destination: 'f1065.p1.1a' }]);
  await bind(pool, Q, ret, cogsAcct, 'activity', [{ treatment: 'cogs_tieout', destination: 'f1125a.main.8', activityId: act }]);
  await bind(pool, Q, ret, wages, 'activity', [{ treatment: 'input', destination: 'f1065.p1.9' }]);
  await answerTypedItems(pool, Q, ret);
  // An unfinished workpaper: COGS deducted is unknown, never "no".
  let r = await compute(pool, Q, ret);
  assert.equal(r.applicability.facts.deductsCogs, 'unknown');
  await saveWorkpaper(pool, { ...Q, returnId: ret, activityId: act, path: 'reviewed', treatment: 'inventory_as_booked', method: 'cost', reviewedBy: 'tester', sourceNote: 'Count sheets',
    reviewedLines: { '1': '0', '2': '0', '3': '0', '4': '0', '7': '0' } });
  r = await compute(pool, Q, ret);
  assert.equal(r.applicability.facts.deductsCogs, false, 'a completed workpaper at a known zero');
  await saveWorkpaper(pool, { ...Q, returnId: ret, activityId: act, path: 'reviewed', treatment: 'inventory_as_booked', method: 'cost', reviewedBy: 'tester', sourceNote: 'Count sheets',
    reviewedLines: { '1': '0', '2': '200.00', '3': '0', '4': '0', '7': '0' } });
  r = await compute(pool, Q, ret);
  assert.equal(r.applicability.facts.deductsCogs, true);
  assert.ok(r.applicability.schedules.required.includes('f1125a'));
  assert.equal(r.applicability.facts.hasRental, false);
  await activity(pool, Q, { name: 'Quince warehouse', kind: 'rental', schedule: 'f8825' });
  assert.equal((await compute(pool, Q, ret)).applicability.facts.hasRental, true, 'a rental activity in effect: Form 8825, whatever its amounts');
  // An adjustment on the activity's own Form 1125-A line, then the activity is ended before the period: the adjustment is unresolved.
  await saveAdjustment(pool, { ...Q, returnId: ret, purpose: 'other', memo: 'Freight left out of the count', evidence: 'Freight invoices', decidedBy: 'tester', lines: [{ slotKey: `f1125a.main.3|activity=act:${act}|activity`, amount: '10.00', m1Class: 'inventory' }] });
  assert.equal(valueOf(await compute(pool, Q, ret), `f1125a.main.3|activity=act:${act}|activity`), 1000n);
  await pool.query(`UPDATE tax_activity SET effective_to = '2024-12-31' WHERE activity_id = $1`, [act]);
  r = await compute(pool, Q, ret);
  assert.equal(valueOf(r, `f1125a.main.3|activity=act:${act}|activity`), null);
  assert.ok(errorsOf(r, 'adjustment_scope').some(e => /not in effect in this period/.test(e.message)));
  await pool.query(`UPDATE tax_activity SET effective_to = NULL WHERE activity_id = $1`, [act]);
  // Guaranteed payments wait for stage T4: listed per owner, unresolved — not dropped from the results.
  const partner = await party(pool, orgId, 'Sample Quince Partner');
  await saveInterest(pool, { ...Q, fields: { partyId: partner, role: 'general_partner', from: '2020-01-01', to: null, profit: '1/1', loss: '1/1', capital: '1/1' }, actor: 'tester' });
  await bind(pool, Q, ret, wages, 'activity', [{ treatment: 'guaranteed_payment', destination: 'services', interestPartyId: partner }]);
  const out = await compute(pool, Q, ret); // its fields are what resultsJson (Task 9) serializes
  const gp = out.fields.find(f => f.key === 'f1065.p1.10|interest=i:t4|activity');
  assert.deepEqual([gp?.status, gp?.cents, gp?.dims], ['unresolved', null, { interest: 'i:t4' }]);
  assert.match(gp.reasons.join(' '), /stage T4/);
  // A line nothing routes to is a known zero only while the books are completely mapped.
  assert.deepEqual(out.fields.find(f => f.key === 'f1065.p1.6|activity')?.cents, '0');
});

test('other tax-exempt income is not tax-exempt interest (Codex t3-plan-r2 R2-10): with both on the books, interest is M-1 6a / 5a and other exempt income the other-income statement — books, cash and typed authority, adjustments; both forms', async () => {
  for (const [rt, method, names] of [['form_1065', 'cash', { other: 'f1065.k.18b', m1other: 'f1065.m1.6b', m1int: 'f1065.m1.6a' }], ['form_1120s', 'accrual', { other: 'f1120s.k.16b', m1other: 'f1120s.m1.5b', m1int: 'f1120s.m1.5a' }]]) {
    const { C, ret, A } = await exemptCo(`Elder ${rt === 'form_1065' ? 'Partners' : 'Corp'}`, rt, method);
    const grant = await acct(pool, C, 'Exempt Grant Income', 'other_income');
    await deposit(pool, C, '2025-06-01', A.bank, [[grant, 2500]]);
    await bind(pool, C, ret, grant, 'activity', [{ treatment: 'input', destination: names.other }]);
    let r = await compute(pool, C, ret);
    assert.deepEqual([valueOf(r, `${names.m1int}|activity`), valueOf(r, `${names.m1other}|activity`)], [10000n, 2500n], `${rt}: interest 6a/5a, other exempt income on the statement`);
    assert.deepEqual(r.fields.find(f => f.key === `${names.m1other}|activity`).rows, [{ label: catalogLabel(rt, names.other), cents: '2500' }]);
    assert.equal(r.bridge.residual, '0');
    // An adjustment moving book income to OTHER exempt income is the statement line; one moving it to exempt INTEREST is 6a / 5a.
    const sales = rt === 'form_1065' ? 'f1065.p1.1a' : 'f1120s.p1.1a', interest = rt === 'form_1065' ? 'f1065.k.18a' : 'f1120s.k.16a';
    await saveAdjustment(pool, { ...C, returnId: ret, purpose: 'other', memo: 'Exempt fee income booked as sales', evidence: 'Grant letter', decidedBy: 'tester',
      lines: [{ slotKey: `${sales}|activity`, amount: '-10.00', m1Class: 'tax_exempt' }, { slotKey: `${names.other}|activity`, amount: '10.00', m1Class: 'tax_exempt' }] });
    await saveAdjustment(pool, { ...C, returnId: ret, purpose: 'tax_exempt_interest', memo: 'Bond interest booked as sales', evidence: 'Broker statement', decidedBy: 'tester',
      lines: [{ slotKey: `${sales}|activity`, amount: '-20.00', m1Class: 'tax_exempt' }, { slotKey: `${interest}|activity`, amount: '20.00', m1Class: 'tax_exempt' }] });
    r = await compute(pool, C, ret);
    assert.deepEqual([valueOf(r, `${names.m1int}|activity`), valueOf(r, `${names.m1other}|activity`)], [12000n, 3500n], `${rt}: each adjustment on its own M-1 line`);
    assert.equal(r.bridge.residual, '0');
    if (rt === 'form_1065') {
      // Typed instead: the other exempt income's book amount stays the statement row.
      await assignProvider(pool, { ...C, returnId: ret, slotKey: `${names.other}|activity`, providerKind: 'manual', schemaVersion: 1, sourceRef: { reason: 'grant schedule' }, sourceVersion: 'manual:grant@1' });
      await saveManualItem(pool, { ...C, returnId: ret, itemKey: `${names.other}|activity`, status: 'entered', amount: '15.00', enteredBy: 'tester' });
      r = await compute(pool, C, ret);
      assert.deepEqual([valueOf(r, `${names.m1int}|activity`), valueOf(r, `${names.m1other}|activity`)], [12000n, 3500n]);
      assert.equal(r.bridge.residual, '0');
    }
  }
});

test('a typed item’s slot is this return’s, on save and when read (Codex t3-plan-r2 R2-7): an assigned slot naming a nonexistent owner, another company’s, another organization’s or a mid-year interest is refused; the bulk answer skips it; an interest that ends after the save leaves the saved amount unresolved', async () => {
  const S2 = { orgId, entityId: await company(pool, orgId, 'Fennel Corp') };
  const ret = await period(pool, S2, 2025, 'form_1120s', { taxMethod: 'accrual' });
  const owner = await party(pool, orgId, 'Sample Fennel Owner');
  await saveInterest(pool, { ...S2, fields: { partyId: owner, role: 'shareholder', from: '2020-01-01', to: null, profit: '1/1', loss: '1/1', capital: '1/1' }, actor: 'tester' });
  const { rows: [mine] } = await pool.query('SELECT interest_id FROM ownership_interest WHERE org_id = $1 AND entity_id = $2', [orgId, S2.entityId]);
  const O = { orgId, entityId: await company(pool, orgId, 'Fennel Other Corp') };
  await period(pool, O, 2025, 'form_1120s', { taxMethod: 'accrual' });
  await saveInterest(pool, { ...O, fields: { partyId: await party(pool, orgId, 'Sample Other Owner'), role: 'shareholder', from: '2020-01-01', to: null, profit: '1/1', loss: '1/1', capital: '1/1' }, actor: 'tester' });
  const { rows: [theirs] } = await pool.query('SELECT interest_id FROM ownership_interest WHERE org_id = $1 AND entity_id = $2', [orgId, O.entityId]);
  const { rows: [org2] } = await pool.query(`INSERT INTO org (slug, name) VALUES ('t3_manual_other', 'Manual Sample Org') RETURNING org_id`);
  const X = { orgId: Number(org2.org_id), entityId: await company(pool, Number(org2.org_id), 'Foreign Corp') };
  await period(pool, X, 2025, 'form_1120s', { taxMethod: 'accrual' });
  await saveInterest(pool, { ...X, fields: { partyId: await party(pool, X.orgId, 'Sample Foreign Owner'), role: 'shareholder', from: '2020-01-01', to: null, profit: '1/1', loss: '1/1', capital: '1/1' }, actor: 'tester' });
  const { rows: [foreign] } = await pool.query('SELECT interest_id FROM ownership_interest WHERE org_id = $1 AND entity_id = $2', [X.orgId, X.entityId]);
  const key = id => `f1120s.p1.7|interest=i:${id}|activity`;
  const assign = id => assignProvider(pool, { ...S2, returnId: ret, slotKey: key(id), providerKind: 'manual', schemaVersion: 1, sourceRef: { reason: 'officer pay' }, sourceVersion: 'manual:officer@1' });
  for (const [id, why] of [[999999999, /not an owner’s interest in this company/], [theirs.interest_id, /not an owner’s interest in this company/], [foreign.interest_id, /not an owner’s interest in this company/]]) {
    await assign(id);
    await assert.rejects(saveManualItem(pool, { ...S2, returnId: ret, itemKey: key(id), status: 'entered', amount: '100.00', enteredBy: 'tester' }), why);
  }
  const keys = (await manualNeeds(pool, { orgId, ret: { return_id: ret, entity_id: S2.entityId, return_type: 'form_1120s', form_edition: 2025, period_start: '2025-01-01', period_end: '2025-12-31' } })).map(n => n.key);
  await markRemainingNotApplicable(pool, { ...S2, returnId: ret, keys, enteredBy: 'tester' });
  const items = await listManualItems(pool, { orgId, returnId: ret });
  assert.ok(!items.some(i => [999999999, theirs.interest_id, foreign.interest_id].some(id => i.item_key === key(id))), 'the bulk answer never writes them');
  await pool.query('DELETE FROM tax_provider_assignment WHERE org_id = $1 AND return_id = $2', [orgId, ret]);
  await pool.query('DELETE FROM tax_manual_item WHERE org_id = $1 AND return_id = $2', [orgId, ret]);
  // A valid interest: saved; then it ends mid-year — the saved amount is unresolved, never read.
  await assign(mine.interest_id);
  await saveManualItem(pool, { ...S2, returnId: ret, itemKey: key(mine.interest_id), status: 'entered', amount: '100.00', enteredBy: 'tester' });
  await answerTypedItems(pool, S2, ret);
  assert.equal(valueOf(await compute(pool, S2, ret), `${key(mine.interest_id)}`), 10000n);
  await pool.query(`UPDATE ownership_interest SET effective_to = '2025-06-30' WHERE interest_id = $1`, [mine.interest_id]);
  const r = await compute(pool, S2, ret);
  assert.equal(valueOf(r, key(mine.interest_id)), null);
  assert.ok(errorsOf(r, 'manual_scope').some(e => /changes during the period/.test(e.message)));
  await assert.rejects(saveManualItem(pool, { ...S2, returnId: ret, itemKey: key(mine.interest_id), status: 'entered', amount: '100.00', enteredBy: 'tester' }), /changes during the period/);
});

test('adjustments to a classified component apply after it and are checked with it (Codex t3-plan-r2 R2-11): a valid adjusted amount, one beyond the parent refused — all four components', async () => {
  for (const [rt, parent, sub] of [['form_1065', 'f1065.k.6a', 'f1065.k.6b'], ['form_1065', 'f1065.k.11', 'f1065.k.11_inv'], ['form_1120s', 'f1120s.k.5a', 'f1120s.k.5b'], ['form_1120s', 'f1120s.k.10', 'f1120s.k.10_inv']]) {
    const C = { orgId, entityId: await company(pool, orgId, `Hyssop ${sub.replace(/[^a-z0-9]/g, '')}`) };
    const ret = await period(pool, C, 2025, rt, { taxMethod: 'accrual' });
    const bank = await acct(pool, C, 'Checking'), inc = await acct(pool, C, 'Investment Receipts', 'other_income');
    await je(pool, C, '2025-03-01', [[bank, 8000], [inc, -8000]]);
    await bindBalance(pool, C, ret, bank, rt === 'form_1065' ? 'f1065.L.1' : 'f1120s.L.1');
    await bind(pool, C, ret, await acct(pool, C, 'Retained Earnings'), 'end', [{ treatment: 'input', destination: rt === 'form_1065' ? 'f1065.L.21' : 'f1120s.L.24' }]);
    await bind(pool, C, ret, inc, 'activity', [{ treatment: parent.endsWith('.11') || parent.endsWith('.10') ? 'statement_row' : 'input', destination: parent }]);
    await answerTypedItems(pool, C, ret, { except: [`${sub}|activity`] });
    await saveManualItem(pool, { ...C, returnId: ret, itemKey: `${sub}|activity`, status: 'entered', amount: '30.00', enteredBy: 'tester' });
    const g = await saveAdjustment(pool, { ...C, returnId: ret, purpose: 'other', memo: 'Year-end statement', evidence: 'Broker 1099', decidedBy: 'tester', lines: [{ slotKey: `${sub}|activity`, amount: '20.00', m1Class: 'other' }] });
    let r = await compute(pool, C, ret);
    assert.equal(valueOf(r, `${sub}|activity`), 5000n, `${sub}: 30.00 classified plus the 20.00 adjustment, once`);
    await withdrawAdjustment(pool, { ...C, returnId: ret, groupId: g, reason: 'Replaced', decidedBy: 'tester' });
    await saveAdjustment(pool, { ...C, returnId: ret, purpose: 'other', memo: 'Year-end statement', evidence: 'Broker 1099', decidedBy: 'tester', lines: [{ slotKey: `${sub}|activity`, amount: '60.00', m1Class: 'other' }] });
    r = await compute(pool, C, ret);
    assert.equal(valueOf(r, `${sub}|activity`), null, `${sub}: 90.00 is more than its parent’s 80.00`);
    assert.ok(errorsOf(r, 'subset').some(e => /adjustments included/.test(e.message)));
  }
});

test('stale timing decisions publish no amount (Codex t3-plan-r3 R3-2): a changed refundable deposit leaves the return’s income unknown; a deleted next-period settlement leaves its income line unknown', async () => {
  const C = { orgId, entityId: await company(pool, orgId, 'Tansy Partners') };
  const y25 = await period(pool, C, 2025, 'form_1065', { taxMethod: 'cash' });
  const { openPeriod } = await import('../lib/tax/periods.js');
  const y26 = Number(await openPeriod(pool, { ...C, year: 2026, actor: 'tester' }));
  const bank = await acct(pool, C, 'Checking'), svc = await acct(pool, C, 'Services');
  await deposit(pool, C, '2025-03-01', bank, [[svc, 40000]]);
  await bindBalance(pool, C, y25, bank, 'f1065.L.1');
  await bind(pool, C, y25, await acct(pool, C, 'Retained Earnings'), 'end', [{ treatment: 'input', destination: 'f1065.L.21' }]);
  await bind(pool, C, y25, svc, 'activity', [{ treatment: 'input', destination: 'f1065.p1.1a' }]);
  await bindBalance(pool, C, y25, await acct(pool, C, 'Accounts Receivable (A/R)'), 'f1065.L.2a');
  await answerTypedItems(pool, C, y25);
  const R = y => ({ return_id: y === 2025 ? y25 : y26, entity_id: C.entityId, period_start: `${y}-01-01`, period_end: `${y}-12-31`, tax_method: 'cash' });
  const decide = async (y, txnId, kind, decision, extra = {}) => { const r = await cashRecognition(pool, { orgId, ret: R(y) }); const c = [...r.candidates, ...r.selectable.receipts.map(x => ({ ...x, kinds: ['receipt_date'] }))].find(x => x.txnId === txnId && x.kinds.includes(kind));
    await saveTimingReview(pool, { ...C, returnId: R(y).return_id, txnId, kind, decision, expectTxnVersion: c.txnVersion, expectEventVersion: c.eventVersion, reviewedBy: 'tester', ...extra }); };
  const { payment } = await import('./tax-t3-fixtures.js');
  const dep = await payment(pool, C, '2025-12-10', 3000, bank);
  await decide(2025, dep, 'refundable_deposit', 'exclude');
  let r = await compute(pool, C, y25);
  assert.equal(valueOf(r, 'f1065.p1.8|activity'), 40000n);
  await pool.query(`UPDATE txn SET memo = 'deposit, changed' WHERE txn_id = $1`, [dep]);
  r = await compute(pool, C, y25);
  for (const k of ['f1065.p1.8|activity', 'f1065.anal.1|activity']) assert.deepEqual([valueOf(r, k), r.fields.find(f => f.key === k).status], [null, 'unresolved'], k);
  await decide(2025, dep, 'refundable_deposit', 'exclude');
  assert.equal(valueOf(await compute(pool, C, y25), 'f1065.p1.8|activity'), 40000n, 'decided again');
  const jan = await deposit(pool, C, '2026-01-04', bank, [[svc, 500]]);
  await decide(2026, jan, 'receipt_date', 'include', { recognizeOn: '2025-12-30' });
  assert.equal(valueOf(await compute(pool, C, y25), 'f1065.p1.1a|activity'), 40500n);
  await pool.query('DELETE FROM posting WHERE txn_id = $1', [jan]);
  await pool.query('DELETE FROM txn WHERE txn_id = $1', [jan]);
  r = await compute(pool, C, y25);
  assert.deepEqual([valueOf(r, 'f1065.p1.1a|activity'), r.fields.find(f => f.key === 'f1065.p1.1a|activity').status], [null, 'unresolved'], 'never a known 40,000 without it');
});

test('a saved typed item for an activity that no longer applies stays, unresolved, until cleared (Codex t3-plan-r3 R3-3): rental depreciation on both forms, the activity ended and then moved to another schedule', async () => {
  for (const [rt, k2] of [['form_1065', 'f1065.k.2'], ['form_1120s', 'f1120s.k.2']]) {
    const C = { orgId, entityId: await company(pool, orgId, `Juniper Rental ${rt === 'form_1065' ? 'Partners' : 'Corp'}`) };
    const ret = await period(pool, C, 2025, rt, { taxMethod: 'accrual' });
    const bank = await acct(pool, C, 'Checking');
    await bindBalance(pool, C, ret, bank, rt === 'form_1065' ? 'f1065.L.1' : 'f1120s.L.1');
    await bind(pool, C, ret, await acct(pool, C, 'Retained Earnings'), 'end', [{ treatment: 'input', destination: rt === 'form_1065' ? 'f1065.L.21' : 'f1120s.L.24' }]);
    const act = await activity(pool, C, { name: 'Sample duplex', kind: 'rental', schedule: 'f8825' });
    const dep = `f8825.main.14|activity=act:${act}|activity`;
    await answerTypedItems(pool, C, ret, { except: [dep] });
    await saveManualItem(pool, { ...C, returnId: ret, itemKey: dep, status: 'entered', amount: '100.00', enteredBy: 'tester' });
    let r = await compute(pool, C, ret);
    assert.deepEqual([valueOf(r, dep), valueOf(r, `${k2}|activity`)], [10000n, -10000n], `${rt}: the rental's depreciation and its rental result`);
    for (const change of [`effective_to = '2024-12-31'`, `schedule = 'p1'`]) {
      await pool.query(`UPDATE tax_activity SET ${change} WHERE activity_id = $1`, [act]);
      r = await compute(pool, C, ret);
      assert.ok(r.orphanItems.some(i => i.item_key === dep), `${rt} ${change}: the saved item is still shown`);
      assert.deepEqual([valueOf(r, dep), r.fields.find(f => f.key === dep)?.status], [null, 'unresolved'], `${rt} ${change}: its line is unresolved`);
      assert.equal(valueOf(r, `${k2}|activity`), null, `${rt} ${change}: and so is the rental result`);
      assert.ok(errorsOf(r, 'manual_scope').some(e => e.itemKey === dep));
      await assert.rejects(saveManualItem(pool, { ...C, returnId: ret, itemKey: dep, status: 'entered', amount: '100.00', enteredBy: 'tester' }), /not a typed item of this return/);
      await pool.query(`UPDATE tax_activity SET effective_to = NULL, schedule = 'f8825' WHERE activity_id = $1`, [act]);
    }
    await pool.query(`UPDATE tax_activity SET effective_to = '2024-12-31' WHERE activity_id = $1`, [act]);
    for (const it of (await compute(pool, C, ret)).orphanItems) await clearManualItem(pool, { ...C, returnId: ret, itemKey: it.item_key });
    r = await compute(pool, C, ret);
    assert.deepEqual([r.orphanItems.length, valueOf(r, `${k2}|activity`)], [0, 0n], `${rt}: cleared, the rental result is a known zero`);
  }
});

test('one tax_exempt adjustment never mixes exempt interest and other exempt income (Codex t3-plan-r3 R3-5): refused when saved; an existing one is refused again when computed, every line it touches unresolved — both forms', async () => {
  for (const [rt, sales, interest, other] of [['form_1065', 'f1065.p1.1a', 'f1065.k.18a', 'f1065.k.18b'], ['form_1120s', 'f1120s.p1.1a', 'f1120s.k.16a', 'f1120s.k.16b']]) {
    const { C, ret } = await exemptCo(`Laurel ${rt === 'form_1065' ? 'Partners' : 'Corp'}`, rt, 'accrual');
    const lines = [{ slotKey: `${sales}|activity`, amount: '-300.00', m1Class: 'tax_exempt' }, { slotKey: `${interest}|activity`, amount: '100.00', m1Class: 'tax_exempt' }, { slotKey: `${other}|activity`, amount: '200.00', m1Class: 'tax_exempt' }];
    await assert.rejects(saveAdjustment(pool, { ...C, returnId: ret, purpose: 'other', memo: 'Exempt income booked as sales', evidence: 'Statements', decidedBy: 'tester', lines }), /separate adjustments/);
    // As saved before the rule: written directly.
    const { rows: [g] } = await pool.query(`INSERT INTO tax_adjustment_group (org_id, return_id, purpose, source, memo, evidence, status, decided_by) VALUES ($1,$2,'other','person','Exempt income booked as sales','Statements','accepted','tester') RETURNING group_id`, [orgId, ret]);
    for (const [slot, cents] of [[`${sales}|activity`, -30000], [`${interest}|activity`, 10000], [`${other}|activity`, 20000]]) {
      await pool.query(`INSERT INTO tax_adjustment (org_id, group_id, return_id, slot_key, amount_cents, m1_class) VALUES ($1,$2,$3,$4,$5,'tax_exempt')`, [orgId, g.group_id, ret, slot, cents]);
    }
    const r = await compute(pool, C, ret);
    for (const k of [sales, interest, other]) assert.deepEqual([valueOf(r, `${k}|activity`), r.fields.find(f => f.key === `${k}|activity`).status], [null, 'unresolved'], `${rt} ${k}`);
    assert.ok(errorsOf(r, 'adjustment_mixed').length);
    assert.ok(!r.deltas.some(d => d.groupId === Number(g.group_id)), 'none of its lines is applied');
  }
});

test('a next period’s receipt date stays in force when its deposit is redated into this period (Codex t3-plan-r4 R4-1): unchanged cents, then changed cents and account — the income unresolved, the decision a dependency, recognized exactly once when it is cleared', async () => {
  const { openPeriod } = await import('../lib/tax/periods.js');
  const { clearTimingReview } = await import('../lib/tax/cash.js');
  for (const changed of [false, true]) {
    const C = { orgId, entityId: await company(pool, orgId, changed ? 'Yarrow Traders' : 'Yarrow Partners') };
    const y25 = await period(pool, C, 2025, 'form_1065', { taxMethod: 'cash' });
    const y26 = Number(await openPeriod(pool, { ...C, year: 2026, actor: 'tester' }));
    const bank = await acct(pool, C, 'Checking'), svc = await acct(pool, C, 'Services'), fees = await acct(pool, C, 'Consulting Fees', 'income');
    await deposit(pool, C, '2025-03-01', bank, [[svc, 40000]]);
    await bindBalance(pool, C, y25, bank, 'f1065.L.1');
    await bind(pool, C, y25, await acct(pool, C, 'Retained Earnings'), 'end', [{ treatment: 'input', destination: 'f1065.L.21' }]);
    await bind(pool, C, y25, svc, 'activity', [{ treatment: 'input', destination: 'f1065.p1.1a' }]);
    await bind(pool, C, y25, fees, 'activity', [{ treatment: 'input', destination: 'f1065.p1.1a' }]);
    await answerTypedItems(pool, C, y25);
    const jan = await deposit(pool, C, '2026-01-04', bank, [[svc, 500]]);
    const r26 = await cashRecognition(pool, { orgId, ret: { return_id: y26, entity_id: C.entityId, period_start: '2026-01-01', period_end: '2026-12-31', tax_method: 'cash' } });
    const c = [...r26.candidates, ...r26.selectable.receipts].find(x => x.txnId === jan);
    await saveTimingReview(pool, { ...C, returnId: y26, txnId: jan, kind: 'receipt_date', decision: 'include', recognizeOn: '2025-12-30', expectTxnVersion: c.txnVersion, expectEventVersion: c.eventVersion, reviewedBy: 'tester' });
    let r = await compute(pool, C, y25);
    assert.equal(valueOf(r, 'f1065.p1.1a|activity'), 40500n, 'received in December by the review');
    const review = [...r.cash.deps.reviews.values()].find(d => d.txnId === jan && d.kind === 'receipt_date');
    // The bank's date corrected into December — with the same cents, or with other cents on another income account too.
    await pool.query(`UPDATE txn SET txn_date = '2025-12-30' WHERE txn_id = $1`, [jan]);
    await pool.query(`UPDATE posting SET txn_date = '2025-12-30' WHERE txn_id = $1`, [jan]);
    if (changed) {
      await pool.query('UPDATE posting SET account_id = CASE WHEN account_id = $3 THEN $2 ELSE account_id END, amount_cents = CASE WHEN account_id = $3 THEN -700 ELSE 700 END WHERE txn_id = $1', [jan, fees, svc]);
      await pool.query('UPDATE txn SET total_cents = 700 WHERE txn_id = $1', [jan]);
    }
    r = await compute(pool, C, y25);
    for (const k of ['f1065.p1.1a|activity', 'f1065.p1.8|activity', 'f1065.p1.23|activity', 'f1065.k.1|activity', 'f1065.anal.1|activity']) {
      assert.deepEqual([valueOf(r, k), r.fields.find(f => f.key === k)?.status, r.fields.find(f => f.key === k)?.cents], [null, 'unresolved', null], `${changed ? 'changed' : 'unchanged'}: ${k}`);
    }
    assert.ok([...r.cash.deps.reviews.values()].some(d => d.id === review.id), 'the next period’s decision stays a dependency of this period');
    assert.ok(r.cash.unresolved.some(u => u.accountIds.includes(svc)), 'the account it brought income to is held');
    assert.ok(errorsOf(r, 'timing_stale').some(e => /clear its receipt date on the next period/.test(e.message)), 'with what to do');
    assert.ok(r.holds.some(h => h.accountId === svc && h.source === 'timing' && h.domains.includes('income')));
    await clearTimingReview(pool, { ...C, returnId: y26, reviewId: review.id });
    r = await compute(pool, C, y25);
    assert.deepEqual([valueOf(r, 'f1065.p1.1a|activity'), r.cash.unresolved.length, r.holds.length], [changed ? 40700n : 40500n, 0, 0], 'cleared: recognized once, on its own December date');
    assert.equal(valueOf(r, 'f1065.p1.23|activity'), changed ? 40700n : 40500n);
  }
});

test('a held decision whose account left coverage leaves the domain’s totals unknown, never a complete zero (Codex t3-plan-r4 R4-2): an accrual exclusion, a next period’s receipt date and a closing classification, their source deleted and its account’s last binding removed — both forms', async () => {
  const { openPeriod } = await import('../lib/tax/periods.js');
  const { clearTimingReview, accrualTiming } = await import('../lib/tax/cash.js');
  const { classifyEntry, closingCandidates, clearClassification } = await import('../lib/tax/classify.js');
  const F = {
    form_1065: { sales: 'f1065.p1.1a', other: 'f1065.p1.21', income: 'f1065.p1.8', deductions: 'f1065.p1.22', ordinary: 'f1065.p1.23', k1: 'f1065.k.1', cash: 'f1065.L.1', liab: 'f1065.L.17', re: 'f1065.L.21', total: 'f1065.L.22' },
    form_1120s: { sales: 'f1120s.p1.1a', other: 'f1120s.p1.20', income: 'f1120s.p1.6', deductions: 'f1120s.p1.21', ordinary: 'f1120s.p1.22', k1: 'f1120s.k.1', cash: 'f1120s.L.1', liab: 'f1120s.L.18', re: 'f1120s.L.24', total: 'f1120s.L.27' },
  };
  const unbind = (id, ret) => pool.query('DELETE FROM tax_binding WHERE org_id = $1 AND return_id = $2 AND account_id = $3', [orgId, ret, id]);
  const drop = async id => { await pool.query('DELETE FROM posting WHERE txn_id = $1', [id]); await pool.query('DELETE FROM txn WHERE txn_id = $1', [id]); };
  const status = (r, k) => [valueOf(r, k), r.fields.find(f => f.key === k)?.status];
  for (const rt of ['form_1065', 'form_1120s']) {
    const f = F[rt], suffix = rt === 'form_1065' ? 'Partners' : 'Corp';
    const base = async (name, method) => {
      const C = { orgId, entityId: await company(pool, orgId, `${name} ${suffix}`) };
      const ret = await period(pool, C, 2025, rt, { taxMethod: method });
      const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), re: await acct(pool, C, 'Retained Earnings') };
      await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 50000]]);
      await bindBalance(pool, C, ret, A.bank, f.cash);
      await bindBalance(pool, C, ret, A.re, f.re);
      await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
      return { C, ret, A };
    };
    const domainUnknown = (r, what) => {
      for (const k of [f.income, f.deductions, f.ordinary, f.k1]) assert.deepEqual(status(r, `${k}|activity`), [null, 'unresolved'], `${rt} ${what}: ${k}`);
      assert.equal(valueOf(r, `${f.sales}|activity`), 50000n, `${rt} ${what}: an independently known input keeps its amount`);
    };
    // 1. An excluded accrual (accrual method): the entry deleted, its expense account unbound — out of coverage.
    {
      const { C, ret, A } = await base('Hawthorn Accrual', 'accrual');
      const repairs = await acct(pool, C, 'Utilities'), liab = await acct(pool, C, 'Payroll Liabilities');
      const accrual = await je(pool, C, '2025-12-31', [[repairs, 3000], [liab, -3000]]);
      await bind(pool, C, ret, liab, 'end', [{ treatment: 'statement_row', destination: f.liab }]);
      await bind(pool, C, ret, repairs, 'activity', [{ treatment: 'statement_row', destination: f.other }]);
      await answerTypedItems(pool, C, ret);
      const R = { return_id: ret, entity_id: C.entityId, period_start: '2025-01-01', period_end: '2025-12-31', tax_method: 'accrual' };
      const c = (await accrualTiming(pool, { orgId, ret: R })).candidates.find(x => x.txnId === accrual);
      await saveTimingReview(pool, { ...C, returnId: ret, txnId: accrual, kind: 'imported_accrual_je', decision: 'exclude', expectTxnVersion: c.txnVersion, expectEventVersion: c.eventVersion, reviewedBy: 'tester' });
      assert.equal(valueOf(await compute(pool, C, ret), `${f.ordinary}|activity`), 50000n, `${rt}: excluded, nothing deducted`);
      await drop(accrual);
      await unbind(repairs, ret);
      let r = await compute(pool, C, ret);
      assert.ok(!r.cov.sources[0].accounts.some(a => a.accountId === repairs), 'the expense account left coverage');
      domainUnknown(r, 'accrual');
      assert.ok(r.holds.some(h => h.accountId === repairs));
      await clearTimingReview(pool, { ...C, returnId: ret, reviewId: r.timing.candidates.find(x => x.txnId === accrual).review.review_id });
      r = await compute(pool, C, ret);
      assert.deepEqual([valueOf(r, `${f.ordinary}|activity`), valueOf(r, `${f.deductions}|activity`), r.holds.length], [50000n, 0n, 0], `${rt}: cleared, the empty source is a known zero`);
    }
    // 2. A next period's receipt date (cash method): the January deposit deleted, its income account unbound here.
    {
      const { C, ret, A } = await base('Hawthorn Receipts', 'cash');
      const y26 = Number(await openPeriod(pool, { ...C, year: 2026, actor: 'tester' }));
      const fees = await acct(pool, C, 'Consulting Fees', 'income');
      await bind(pool, C, ret, fees, 'activity', [{ treatment: 'input', destination: f.sales }]);
      await answerTypedItems(pool, C, ret);
      const jan = await deposit(pool, C, '2026-01-04', A.bank, [[fees, 500]]);
      const r26 = await cashRecognition(pool, { orgId, ret: { return_id: y26, entity_id: C.entityId, period_start: '2026-01-01', period_end: '2026-12-31', tax_method: 'cash' } });
      const c = [...r26.candidates, ...r26.selectable.receipts].find(x => x.txnId === jan);
      await saveTimingReview(pool, { ...C, returnId: y26, txnId: jan, kind: 'receipt_date', decision: 'include', recognizeOn: '2025-12-30', expectTxnVersion: c.txnVersion, expectEventVersion: c.eventVersion, reviewedBy: 'tester' });
      let r = await compute(pool, C, ret);
      assert.equal(valueOf(r, `${f.sales}|activity`), 50500n);
      const review = [...r.cash.deps.reviews.values()].find(d => d.txnId === jan);
      await drop(jan);
      await unbind(fees, ret);
      r = await compute(pool, C, ret);
      assert.ok(!r.cov.sources[0].accounts.some(a => a.accountId === fees), 'the income account left coverage');
      domainUnknown(r, 'receipt');
      assert.ok([...r.cash.deps.reviews.values()].some(d => d.id === review.id), 'still a dependency');
      await clearTimingReview(pool, { ...C, returnId: y26, reviewId: review.id });
      r = await compute(pool, C, ret);
      assert.deepEqual([valueOf(r, `${f.ordinary}|activity`), r.holds.length], [50000n, 0], `${rt}: cleared, a known amount`);
    }
    // 3. A closing classification: the entry deleted, its income account unbound — out of coverage; retained earnings is a balance effect.
    {
      const { C, ret, A } = await base('Hawthorn Closing', 'accrual');
      const ev = await acct(pool, C, 'Event Income', 'income');
      await answerTypedItems(pool, C, ret);
      await bind(pool, C, ret, ev, 'activity', [{ treatment: 'input', destination: f.sales }]);
      const close = await je(pool, C, '2025-12-31', [[ev, 2000], [A.re, -2000]]);
      const R = { return_id: ret, entity_id: C.entityId, period_start: '2025-01-01', period_end: '2025-12-31' };
      const c = (await closingCandidates(pool, { orgId, ret: R })).find(x => x.txnId === close);
      await classifyEntry(pool, { ...C, returnId: ret, txnId: close, cls: 'closing', lines: c.proposed, expectTxnVersion: c.txnVersion, reviewedBy: 'tester' });
      let r = await compute(pool, C, ret);
      assert.equal(valueOf(r, `${f.ordinary}|activity`), 50000n, `${rt}: the closing removed from income`);
      await drop(close);
      await unbind(ev, ret);
      r = await compute(pool, C, ret);
      assert.ok(!r.cov.sources[0].accounts.some(a => a.accountId === ev), 'the income account left coverage');
      assert.equal(r.candidates.find(x => x.txnId === close)?.state, 'stale', 'the decision stays listed');
      domainUnknown(r, 'closing');
      for (const k of [`${f.re}|end`, `${f.total}|end`]) assert.deepEqual(status(r, k), [null, 'unresolved'], `${rt} closing: ${k}`);
      assert.equal(valueOf(r, `${f.cash}|end`), 50000n, 'an independent balance keeps its amount');
      await clearClassification(pool, { ...C, returnId: ret, txnId: close });
      r = await compute(pool, C, ret);
      assert.deepEqual([valueOf(r, `${f.ordinary}|activity`), valueOf(r, `${f.total}|end`) !== null, r.holds.length], [50000n, true, 0], `${rt}: cleared, known again`);
    }
  }
});

// Round 5 (Codex t3-plan-r5): the lines each form uses below.
const R5 = {
  form_1065: { sales: 'f1065.p1.1a', otherIncome: 'f1065.p1.7', other: 'f1065.p1.21', income: 'f1065.p1.8', deductions: 'f1065.p1.22', ordinary: 'f1065.p1.23', k1: 'f1065.k.1', cash: 'f1065.L.1', ar: 'f1065.L.2a',
    prepaid: 'f1065.L.6', assets: 'f1065.L.14', ap: 'f1065.L.15', liab: 'f1065.L.17', re: 'f1065.L.21', total: 'f1065.L.22', dep: 'f1065.p1.16a', rent: 'f1065.p1.13', m1: 'f1065.m1.', suffix: 'Partners' },
  form_1120s: { sales: 'f1120s.p1.1a', otherIncome: 'f1120s.p1.5', other: 'f1120s.p1.20', income: 'f1120s.p1.6', deductions: 'f1120s.p1.21', ordinary: 'f1120s.p1.22', k1: 'f1120s.k.1', cash: 'f1120s.L.1', ar: 'f1120s.L.2a',
    prepaid: 'f1120s.L.6', assets: 'f1120s.L.15', ap: 'f1120s.L.16', liab: 'f1120s.L.18', re: 'f1120s.L.24', total: 'f1120s.L.27', dep: 'f1120s.p1.14', rent: 'f1120s.p1.11', m1: 'f1120s.m1.', suffix: 'Corp' },
};
const fieldOf = (r, k) => { const f = r.fields.find(x => x.key === k); return [f?.cents ?? null, f?.status ?? null]; };
const unknownField = (r, k, what) => assert.deepEqual(fieldOf(r, k), [null, 'unresolved'], `${what}: ${k}`);
const knownField = (r, k, cents, what) => assert.deepEqual(fieldOf(r, k), [String(cents), 'complete'], `${what}: ${k}`);
const dropTxn = async id => { await pool.query('DELETE FROM application WHERE credit_txn_id = $1 OR charge_txn_id = $1', [id]); await pool.query('DELETE FROM posting WHERE txn_id = $1', [id]); await pool.query('DELETE FROM txn WHERE txn_id = $1', [id]); };
const redate = async (id, date) => { await pool.query('UPDATE txn SET txn_date = $2 WHERE txn_id = $1', [id, date]); await pool.query('UPDATE posting SET txn_date = $2 WHERE txn_id = $1', [id, date]); };

test('a saved advance or prepayment of an earlier period is reconciled by the transaction and the return it was SAVED on (Codex t3-plan-r5 R5-1): the payment redated into this period, into another earlier period, before the periods kept — document and opening applications; both forms', async () => {
  const { openPeriod } = await import('../lib/tax/periods.js');
  const { invoice, payment, apply, bill, billPayment } = await import('./tax-t3-fixtures.js');
  const { clearTimingReview } = await import('../lib/tax/cash.js');
  for (const rt of ['form_1065', 'form_1120s']) for (const kind of ['advance', 'prepayment']) for (const move of ['into', 'earlier', 'before']) {
    const f = R5[rt], what = `${rt} ${kind} ${move}`;
    const C = { orgId, entityId: await company(pool, orgId, `Linden ${kind} ${move} ${f.suffix}`) };
    const y25 = await period(pool, C, 2025, rt, { taxMethod: 'cash' });
    const y24 = Number(await openPeriod(pool, { ...C, year: 2024, actor: 'tester' }));
    await openPeriod(pool, { ...C, year: 2023, actor: 'tester' });
    const A = {};
    for (const n of ['Checking', 'Services', 'Supplies & Materials', 'Accounts Receivable (A/R)', 'Accounts Payable (A/P)', 'Opening Balance Equity', 'Retained Earnings']) A[n] = await acct(pool, C, n);
    await deposit(pool, C, '2025-03-01', A.Checking, [[A.Services, 50000]]);
    await bindBalance(pool, C, y25, A.Checking, f.cash);
    await bindBalance(pool, C, y25, A['Accounts Receivable (A/R)'], f.ar);
    await bindBalance(pool, C, y25, A['Accounts Payable (A/P)'], f.ap);
    await bindBalance(pool, C, y25, A['Opening Balance Equity'], f.re);
    await bindBalance(pool, C, y25, A['Retained Earnings'], f.re);
    await bind(pool, C, y25, A.Services, 'activity', [{ treatment: 'input', destination: f.sales }]);
    await bind(pool, C, y25, A['Supplies & Materials'], 'activity', [{ treatment: 'statement_row', destination: f.other }]);
    await answerTypedItems(pool, C, y25);
    // Received (or paid) in December 2024 and decided there: income (a deduction) when received. The 2024 forms are not in the app (no
    // catalog), so the decision is written as the app writes one on a period that has them: its event version from the 2024 period's
    // candidate, the whole amount in ledger sign, its accounts and domain.
    const customer = kind === 'advance';
    const pay = customer ? await payment(pool, C, '2024-12-01', 10000, A.Checking) : await billPayment(pool, C, '2024-12-01', 10000, A.Checking);
    const r24 = await cashRecognition(pool, { orgId, ret: { return_id: y24, entity_id: C.entityId, period_start: '2024-01-01', period_end: '2024-12-31', tax_method: 'cash' } });
    const c = r24.candidates.find(x => x.txnId === pay);
    const { rows: [saved] } = await pool.query(`INSERT INTO cash_timing_review (org_id, return_id, source_entity_id, txn_id, kind, decision, slot_key, cents, txn_version, event_version, affected_accounts, affected_domains, reviewed_by, reason)
      VALUES ($1,$2,$3,$4,$5,'include',$6,$7,$8,$9,'{}','{income}','tester','Received for work not yet invoiced') RETURNING review_id`,
    [orgId, y24, C.entityId, pay, customer ? 'unrestricted_advance' : 'prepaid_expense', `${customer ? f.sales : f.other}|activity`, customer ? -10000 : 10000, c.txnVersion, c.eventVersion]);
    // Applied in 2025: to a 2025 document, and (the advance) to an opening balance with no document behind it.
    if (customer) {
      const opening = await importedJe(pool, C, '2022-12-31', [[A['Accounts Receivable (A/R)'], 4000], [A['Opening Balance Equity'], -4000]]);
      await apply(pool, C, pay, await invoice(pool, C, '2025-02-01', [[A.Services, 6000]]), 6000, '2025-02-10');
      await apply(pool, C, pay, opening, 4000, '2025-02-11');
    } else await apply(pool, C, pay, await bill(pool, C, '2025-02-01', [[A['Supplies & Materials'], 6000]]), 6000, '2025-02-10');
    const line = `${customer ? f.sales : f.other}|activity`;
    let r = await compute(pool, C, y25);
    knownField(r, line, customer ? 50000 : 0, `${what}, as decided (consumed, once)`);
    knownField(r, `${f.ordinary}|activity`, 50000, `${what}, as decided`);
    // The payment redated out of the period that decided it.
    await redate(pay, { into: '2025-01-02', earlier: '2023-06-01', before: '2021-06-01' }[move]);
    r = await compute(pool, C, y25);
    for (const k of [line, `${f.income}|activity`, `${f.ordinary}|activity`, `${f.k1}|activity`]) if (customer || k !== `${f.income}|activity`) unknownField(r, k, what);
    knownField(r, `${f.cash}|end`, customer ? 60000 : 40000, `${what}: an independent balance`);
    const dep = [...r.cash.deps.reviews.values()].find(d => d.id === Number(saved.review_id));
    assert.deepEqual([dep?.returnId, dep?.kind, dep?.domains, dep?.reason], [y24, customer ? 'unrestricted_advance' : 'prepaid_expense', ['income'], 'Received for work not yet invoiced'], `${what}: the saved decision, whole`);
    assert.ok(errorsOf(r, 'timing_stale').some(e => /was decided on the 2024 period and the payment is now dated/.test(e.message)), `${what}: with what to do`);
    assert.ok(!r.cash.candidates.some(x => x.txnId === pay && x.kinds.includes('earlier_settlement')), `${what}: never offered again as undecided`);
    await clearTimingReview(pool, { ...C, returnId: y24, reviewId: saved.review_id });
    r = await compute(pool, C, y25);
    knownField(r, line, customer ? 56000 : 6000, `${what}: cleared, the application recognized exactly once`);
    knownField(r, `${f.ordinary}|activity`, customer ? 56000 : 44000, `${what}: cleared`);
  }
});

test('a held decision is held in the domain SAVED with it, measurement by measurement (Codex t3-plan-r5 R5-2): a deleted closing whose equity account keeps only its beginning, only its ending, both or no mapping; a deleted accrual whose expense account is then retyped — both forms', async () => {
  const { classifyEntry, closingCandidates, clearClassification } = await import('../lib/tax/classify.js');
  const { accrualTiming, clearTimingReview } = await import('../lib/tax/cash.js');
  const { saveAccount } = await import('../lib/data/ledger.js');
  for (const rt of ['form_1065', 'form_1120s']) {
    const f = R5[rt];
    for (const keep of ['both', 'begin', 'end', 'none']) {
      const what = `${rt} closing, ${keep}`;
      const C = { orgId, entityId: await company(pool, orgId, `Hornbeam ${keep} ${f.suffix}`) };
      const ret = await period(pool, C, 2025, rt, { taxMethod: 'accrual' });
      const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), re: await acct(pool, C, 'Retained Earnings'), ev: await acct(pool, C, 'Event Income', 'income'), clear: await acct(pool, C, 'Owner Clearing', 'equity') };
      await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 50000]]);
      await bindBalance(pool, C, ret, A.bank, f.cash);
      await bindBalance(pool, C, ret, A.re, f.re);
      await bindBalance(pool, C, ret, A.clear, f.re);
      await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
      await bind(pool, C, ret, A.ev, 'activity', [{ treatment: 'statement_row', destination: f.otherIncome }]);
      await answerTypedItems(pool, C, ret);
      const close = await je(pool, C, '2025-12-31', [[A.ev, 2000], [A.clear, -2000]]);
      const c = (await closingCandidates(pool, { orgId, ret: { return_id: ret, entity_id: C.entityId, period_start: '2025-01-01', period_end: '2025-12-31' } })).find(x => x.txnId === close);
      await classifyEntry(pool, { ...C, returnId: ret, txnId: close, cls: 'closing', lines: c.proposed, expectTxnVersion: c.txnVersion, reviewedBy: 'tester', reason: 'Year-end close' });
      const { rows: [saved] } = await pool.query('SELECT accounts, account_domains FROM book_entry_classification WHERE txn_id = $1', [close]);
      assert.deepEqual(saved.accounts.map(Number).map(id => [id, saved.account_domains[saved.accounts.map(Number).indexOf(id)]]).sort(), [[A.ev, 'income'], [A.clear, 'balance']].sort(), 'each account saved with its domain');
      await dropTxn(close);
      if (keep !== 'both') await pool.query('DELETE FROM tax_binding WHERE org_id = $1 AND return_id = $2 AND account_id = $3 AND measurement <> ALL($4::text[])', [orgId, ret, A.clear, keep === 'none' ? [] : [keep]]);
      const r = await compute(pool, C, ret);
      if (keep === 'both' || keep === 'begin') unknownField(r, `${f.re}|begin`, what);
      if (keep === 'both' || keep === 'end') unknownField(r, `${f.re}|end`, what);
      for (const ms of ['begin', 'end']) {
        unknownField(r, `${f.total}|${ms}`, what);
        // Total assets: known while every balance measurement the decision reached has a destination (narrow), unknown otherwise (the domain).
        if (keep === 'both') knownField(r, `${f.assets}|${ms}`, ms === 'begin' ? 0 : 50000, what);
        else if (keep !== ms) unknownField(r, `${f.assets}|${ms}`, what);
      }
      unknownField(r, `${f.otherIncome}|activity`, what);
      knownField(r, `${f.sales}|activity`, 50000, `${what}: an independent input`);
      knownField(r, `${f.cash}|end`, 50000, `${what}: an independent balance`);
      await clearClassification(pool, { ...C, returnId: ret, txnId: close });
      const after = await compute(pool, C, ret);
      for (const ms of ['begin', 'end']) knownField(after, `${f.assets}|${ms}`, ms === 'begin' ? 0 : 50000, `${what}: cleared`);
      assert.equal(after.holds.length, 0);
    }
    // A deleted accrual whose expense account is retyped (the account editor allows it once the account has no postings): still income.
    const what = `${rt} retyped`;
    const C = { orgId, entityId: await company(pool, orgId, `Hornbeam Retyped ${f.suffix}`) };
    const ret = await period(pool, C, 2025, rt, { taxMethod: 'accrual' });
    const bank = await acct(pool, C, 'Checking'), sales = await acct(pool, C, 'Services'), liab = await acct(pool, C, 'Payroll Liabilities'), rental = await acct(pool, C, 'Equipment Rental', 'expense');
    await deposit(pool, C, '2025-03-01', bank, [[sales, 50000]]);
    const accrual = await je(pool, C, '2025-12-31', [[rental, 3000], [liab, -3000]]);
    await bindBalance(pool, C, ret, bank, f.cash);
    await bindBalance(pool, C, ret, await acct(pool, C, 'Retained Earnings'), f.re);
    await bind(pool, C, ret, liab, 'end', [{ treatment: 'statement_row', destination: f.liab }]);
    await bind(pool, C, ret, sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
    await bind(pool, C, ret, rental, 'activity', [{ treatment: 'statement_row', destination: f.other }]);
    await answerTypedItems(pool, C, ret);
    const R = { return_id: ret, entity_id: C.entityId, period_start: '2025-01-01', period_end: '2025-12-31', tax_method: 'accrual' };
    const c = (await accrualTiming(pool, { orgId, ret: R })).candidates.find(x => x.txnId === accrual);
    await saveTimingReview(pool, { ...C, returnId: ret, txnId: accrual, kind: 'imported_accrual_je', decision: 'exclude', expectTxnVersion: c.txnVersion, expectEventVersion: c.eventVersion, reviewedBy: 'tester' });
    knownField(await compute(pool, C, ret), `${f.ordinary}|activity`, 50000, `${what}, as decided`);
    await dropTxn(accrual);
    await pool.query('DELETE FROM tax_binding WHERE org_id = $1 AND return_id = $2 AND account_id = $3', [orgId, ret, rental]);
    await saveAccount(pool, { ...C, accountId: rental, fields: { name: 'Equipment Rental', number: '', type: 'other_current_asset', parentId: '', description: '', active: true } });
    let r = await compute(pool, C, ret);
    for (const k of [f.income, f.deductions, f.ordinary, f.k1]) unknownField(r, `${k}|activity`, what);
    knownField(r, `${f.sales}|activity`, 50000, `${what}: an independent input`);
    await clearTimingReview(pool, { ...C, returnId: ret, reviewId: r.timing.candidates.find(x => x.txnId === accrual).review.review_id });
    r = await compute(pool, C, ret);
    knownField(r, `${f.ordinary}|activity`, 50000, `${what}: cleared`);
  }
});

test('a comparison route is never a tax destination (Codex t3-plan-r5 R5-3): a typed depreciation and an assigned typed rent keep their amounts while the accrual beside each is decided, stale with its leg, its leg moved and deleted — only the book reconciliation waits; both forms', async () => {
  const { accrualTiming } = await import('../lib/tax/cash.js');
  for (const rt of ['form_1065', 'form_1120s']) {
    const f = R5[rt];
    const C = { orgId, entityId: await company(pool, orgId, `Sweetgum ${f.suffix}`) };
    const ret = await period(pool, C, 2025, rt, { taxMethod: 'accrual' });
    const A = {};
    for (const n of ['Checking', 'Services', 'Depreciation', 'Rent & Lease', 'Payroll Liabilities', 'Prepaid Expenses', 'Retained Earnings']) A[n] = await acct(pool, C, n);
    await deposit(pool, C, '2025-03-01', A.Checking, [[A.Services, 50000]]);
    const jes = [await je(pool, C, '2025-12-31', [[A.Depreciation, 1000], [A['Payroll Liabilities'], -1000]]), await je(pool, C, '2025-12-31', [[A['Rent & Lease'], 2000], [A['Payroll Liabilities'], -2000]])];
    await bindBalance(pool, C, ret, A.Checking, f.cash);
    await bindBalance(pool, C, ret, A['Retained Earnings'], f.re);
    await bind(pool, C, ret, A['Payroll Liabilities'], 'end', [{ treatment: 'statement_row', destination: f.liab }]);
    await bind(pool, C, ret, A['Prepaid Expenses'], 'end', [{ treatment: 'statement_row', destination: f.prepaid }]);
    await bind(pool, C, ret, A.Services, 'activity', [{ treatment: 'input', destination: f.sales }]);
    await bind(pool, C, ret, A.Depreciation, 'activity', [{ treatment: 'manual_feed', destination: f.dep }]);
    await bind(pool, C, ret, A['Rent & Lease'], 'activity', [{ treatment: 'input', destination: f.rent }]);
    // Rent: books-fed by default, assigned to a typed amount (the lease schedule) — the books then stand beside it as a comparison.
    await assignProvider(pool, { ...C, returnId: ret, slotKey: `${f.rent}|activity`, providerKind: 'manual', schemaVersion: 1, sourceRef: { reason: 'lease schedule' }, sourceVersion: 'manual:lease@1' });
    await answerTypedItems(pool, C, ret, { except: [`${f.dep}|activity`, `${f.rent}|activity`] });
    await saveManualItem(pool, { ...C, returnId: ret, itemKey: `${f.dep}|activity`, status: 'entered', amount: '250.00', enteredBy: 'tester' });
    await saveManualItem(pool, { ...C, returnId: ret, itemKey: `${f.rent}|activity`, status: 'entered', amount: '300.00', enteredBy: 'tester' });
    const R = { return_id: ret, entity_id: C.entityId, period_start: '2025-01-01', period_end: '2025-12-31', tax_method: 'accrual' };
    for (const id of jes) {
      const c = (await accrualTiming(pool, { orgId, ret: R })).candidates.find(x => x.txnId === id);
      await saveTimingReview(pool, { ...C, returnId: ret, txnId: id, kind: 'imported_accrual_je', decision: 'exclude', expectTxnVersion: c.txnVersion, expectEventVersion: c.eventVersion, reviewedBy: 'tester' });
    }
    const states = [['decided', async () => {}], ['stale', async () => { for (const id of jes) await pool.query(`UPDATE txn SET memo = 'edited' WHERE txn_id = $1`, [id]); }],
      ['moved', async () => { await pool.query('UPDATE posting SET account_id = $2 WHERE txn_id = ANY($1::bigint[]) AND account_id = ANY($3::bigint[])', [jes, A['Prepaid Expenses'], [A.Depreciation, A['Rent & Lease']]]); }],
      ['deleted', async () => { for (const id of jes) await dropTxn(id); }]];
    for (const [state, change] of states) {
      await change();
      const r = await compute(pool, C, ret), what = `${rt} ${state}`;
      knownField(r, `${f.dep}|activity`, 25000, `${what}: the typed depreciation`);
      knownField(r, `${f.rent}|activity`, 30000, `${what}: the assigned typed rent`);
      knownField(r, `${f.ordinary}|activity`, -5000, `${what}: independently determinable income`);
      if (state !== 'decided') {
        assert.ok(errorsOf(r).some(e => ['timing_open', 'timing_stale'].includes(e.code)), `${what}: the stale decision is shown`);
        assert.ok(r.bridge.unknown.length > 0, `${what}: the book reconciliation waits`);
        assert.ok(r.fields.some(x => x.fieldId.startsWith(f.m1) && x.status === 'unresolved'), `${what}: the M-1 waits`);
      }
    }
  }
});

test('a prepayment deducted when paid is tied to the entry that uses it up by the SAVED decision (Codex t3-plan-r6 R6-1): unchanged, its memo or amount changed, paid into another account, redated, deleted — the entry held and the decision a dependency; cleared: deducted once; both forms', async () => {
  const { openPeriod } = await import('../lib/tax/periods.js');
  const { expense } = await import('./tax-t3-fixtures.js');
  const { clearTimingReview } = await import('../lib/tax/cash.js');
  for (const rt of ['form_1065', 'form_1120s']) for (const change of ['unchanged', 'memo', 'amount', 'moved', 'redated', 'deleted']) {
    const f = R5[rt], what = `${rt} ${change}`;
    const C = { orgId, entityId: await company(pool, orgId, `Alder ${change} ${f.suffix}`) };
    const y25 = await period(pool, C, 2025, rt, { taxMethod: 'cash' });
    const y24 = Number(await openPeriod(pool, { ...C, year: 2024, actor: 'tester' }));
    const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), util: await acct(pool, C, 'Utilities'), prepaid: await acct(pool, C, 'Prepaid Expenses'),
      other: await acct(pool, C, 'Prepaid Insurance', 'other_current_asset'), re: await acct(pool, C, 'Retained Earnings') };
    await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 50000]]);
    const paid = await expense(pool, C, '2024-11-01', A.bank, [[A.prepaid, 10000]]);
    const r24 = await cashRecognition(pool, { orgId, ret: { return_id: y24, entity_id: C.entityId, period_start: '2024-01-01', period_end: '2024-12-31', tax_method: 'cash' } });
    const c = r24.candidates.find(x => x.txnId === paid && x.kinds.includes('prepaid_expense'));
    assert.deepEqual(c.sourceAccountIds, [A.prepaid], `${what}: the candidate names the prepaid account it pays into`);
    // Decided on the 2024 period as the app saves one (its forms are not in the app, so written as the save writes it): deducted when paid.
    const { rows: [saved] } = await pool.query(`INSERT INTO cash_timing_review (org_id, return_id, source_entity_id, txn_id, kind, decision, slot_key, cents, txn_version, event_version, affected_accounts, affected_domains, source_accounts, reviewed_by, reason)
      VALUES ($1,$2,$3,$4,'prepaid_expense','include',$5,10000,$6,$7,'{}','{income}',$8,'tester','Insurance paid a year ahead') RETURNING review_id`, [orgId, y24, C.entityId, paid, `${f.other}|activity`, c.txnVersion, c.eventVersion, [A.prepaid]]);
    await je(pool, C, '2025-02-01', [[A.util, 10000], [A.prepaid, -10000]]);
    await bindBalance(pool, C, y25, A.bank, f.cash);
    await bindBalance(pool, C, y25, A.re, f.re);
    await bind(pool, C, y25, A.prepaid, 'end', [{ treatment: 'statement_row', destination: f.prepaid }]);
    await bind(pool, C, y25, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
    await bind(pool, C, y25, A.util, 'activity', [{ treatment: 'statement_row', destination: f.other }]);
    await answerTypedItems(pool, C, y25);
    if (change === 'memo') await pool.query(`UPDATE txn SET memo = 'edited' WHERE txn_id = $1`, [paid]);
    if (change === 'amount') { await pool.query('UPDATE posting SET amount_cents = amount_cents * 2 WHERE txn_id = $1', [paid]); await pool.query('UPDATE txn SET total_cents = 20000 WHERE txn_id = $1', [paid]); }
    if (change === 'moved') await pool.query('UPDATE posting SET account_id = $2 WHERE txn_id = $1 AND account_id = $3', [paid, A.other, A.prepaid]);
    if (change === 'redated') await redate(paid, '2025-01-05');
    if (change === 'deleted') await dropTxn(paid);
    let r = await compute(pool, C, y25);
    unknownField(r, `${f.other}|activity`, `${what}: the entry using the prepayment is held`);
    unknownField(r, `${f.ordinary}|activity`, what);
    knownField(r, `${f.sales}|activity`, 50000, `${what}: an independent input`);
    const dep = [...r.cash.deps.reviews.values()].find(d => d.id === Number(saved.review_id));
    assert.deepEqual([dep?.returnId, dep?.kind, dep?.sources, dep?.domains, dep?.reason], [y24, 'prepaid_expense', [A.prepaid], ['income'], 'Insurance paid a year ahead'], `${what}: the saved decision, whole, is a dependency of this period`);
    assert.ok(errorsOf(r, 'timing_stale').some(e => (change === 'unchanged' ? /uses up a prepayment already deducted: decide it/ : /uses up a prepayment whose decision no longer matches its payment/).test(e.message)), `${what}: with what to do`);
    await clearTimingReview(pool, { ...C, returnId: y24, reviewId: saved.review_id });
    r = await compute(pool, C, y25);
    knownField(r, `${f.other}|activity`, 10000, `${what}: cleared, the expense deducted once`);
    knownField(r, `${f.ordinary}|activity`, 40000, `${what}: cleared`);
  }
});

test('closing propagation follows authority (Codex t3-plan-r6 R6-3): a stale or deleted closing beside a typed depreciation, an assigned typed rent and an account not on the return leaves their tax amounts and ordinary income known while the book side waits; a closing of a books-owned account still holds its line; both forms', async () => {
  const { classifyEntry, closingCandidates } = await import('../lib/tax/classify.js');
  for (const rt of ['form_1065', 'form_1120s']) for (const state of ['stale', 'deleted']) {
    const f = R5[rt], what = `${rt} ${state}`;
    const C = { orgId, entityId: await company(pool, orgId, `Beech ${state} ${f.suffix}`) };
    const ret = await period(pool, C, 2025, rt, { taxMethod: 'accrual' });
    const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), dep: await acct(pool, C, 'Depreciation'), rent: await acct(pool, C, 'Rent & Lease'),
      gift: await acct(pool, C, 'Donations', 'expense'), util: await acct(pool, C, 'Utilities'), re: await acct(pool, C, 'Retained Earnings') };
    await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 50000]]);
    for (const [a, cents] of [[A.dep, 1000], [A.rent, 2000], [A.gift, 400], [A.util, 3000]]) await je(pool, C, '2025-06-01', [[a, cents], [A.bank, -cents]]);
    const closes = {};
    for (const [n, a, cents] of [['dep', A.dep, 1000], ['rent', A.rent, 2000], ['gift', A.gift, 400], ['util', A.util, 3000]]) closes[n] = await je(pool, C, '2025-12-31', [[A.re, cents], [a, -cents]]);
    await bindBalance(pool, C, ret, A.bank, f.cash);
    await bindBalance(pool, C, ret, A.re, f.re);
    await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
    await bind(pool, C, ret, A.dep, 'activity', [{ treatment: 'manual_feed', destination: f.dep }]);
    await bind(pool, C, ret, A.rent, 'activity', [{ treatment: 'input', destination: f.rent }]);
    await assignProvider(pool, { ...C, returnId: ret, slotKey: `${f.rent}|activity`, providerKind: 'manual', schemaVersion: 1, sourceRef: { reason: 'lease schedule' }, sourceVersion: 'manual:lease@1' });
    await bind(pool, C, ret, A.gift, 'activity', [{ treatment: 'not_tax', memo: 'the owner’s gift' }]);
    await bind(pool, C, ret, A.util, 'activity', [{ treatment: 'statement_row', destination: f.other }]);
    await answerTypedItems(pool, C, ret, { except: [`${f.dep}|activity`, `${f.rent}|activity`] });
    await saveManualItem(pool, { ...C, returnId: ret, itemKey: `${f.dep}|activity`, status: 'entered', amount: '250.00', enteredBy: 'tester' });
    await saveManualItem(pool, { ...C, returnId: ret, itemKey: `${f.rent}|activity`, status: 'entered', amount: '300.00', enteredBy: 'tester' });
    const RP = { return_id: ret, entity_id: C.entityId, period_start: '2025-01-01', period_end: '2025-12-31' };
    for (const id of Object.values(closes)) {
      const c = (await closingCandidates(pool, { orgId, ret: RP })).find(x => x.txnId === id);
      await classifyEntry(pool, { ...C, returnId: ret, txnId: id, cls: 'closing', lines: c.proposed, expectTxnVersion: c.txnVersion, reviewedBy: 'tester' });
    }
    const expectKnown = (r, tag) => { knownField(r, `${f.dep}|activity`, 25000, `${tag}: the typed depreciation`); knownField(r, `${f.rent}|activity`, 30000, `${tag}: the assigned typed rent`); };
    let r = await compute(pool, C, ret);
    expectKnown(r, `${what}, decided`);
    knownField(r, `${f.other}|activity`, 3000, `${what}, decided`);
    knownField(r, `${f.ordinary}|activity`, -8000, `${what}, decided`);
    // The three closings beside comparison and "not on the return" accounts go stale or are deleted: the tax amounts stand.
    for (const n of ['dep', 'rent', 'gift']) { if (state === 'stale') await pool.query(`UPDATE txn SET memo = 'edited' WHERE txn_id = $1`, [closes[n]]); else await dropTxn(closes[n]); }
    r = await compute(pool, C, ret);
    expectKnown(r, what);
    knownField(r, `${f.other}|activity`, 3000, `${what}: an unrelated books-owned line`);
    knownField(r, `${f.ordinary}|activity`, -8000, `${what}: independently determinable income`);
    assert.ok(['dep', 'rent', 'gift'].every(n => r.candidates.find(x => x.txnId === closes[n])?.state === 'stale'), `${what}: the decisions are shown as stale`);
    assert.ok(r.bridge.unknown.length > 0 && r.fields.some(x => x.fieldId.startsWith(f.m1) && x.status === 'unresolved'), `${what}: the book side waits`);
    // The books-owned control: a closing of the utilities account holds its line and the totals.
    if (state === 'stale') await pool.query(`UPDATE txn SET memo = 'edited' WHERE txn_id = $1`, [closes.util]); else await dropTxn(closes.util);
    r = await compute(pool, C, ret);
    unknownField(r, `${f.other}|activity`, `${what}: the books-owned line`);
    unknownField(r, `${f.ordinary}|activity`, `${what}: and the totals`);
    expectKnown(r, `${what}, control`);
  }
});

test('an incomplete book routing beside a typed line never invalidates the typed amount (Codex t3-plan-r7 R7-2): a native typed depreciation and an assigned typed rent beside stale dollar splits — one made stale by a closing that went stale — stay known with ordinary income; a books-owned stale split is still unresolved; the typed packets claim no book slice; both forms', async () => {
  const { classifyEntry, closingCandidates } = await import('../lib/tax/classify.js');
  for (const rt of ['form_1065', 'form_1120s']) {
    const f = R5[rt], what = rt;
    const C = { orgId, entityId: await company(pool, orgId, `Cedar ${f.suffix}`) };
    const ret = await period(pool, C, 2025, rt, { taxMethod: 'accrual' });
    const A = { bank: await acct(pool, C, 'Checking'), sales: await acct(pool, C, 'Services'), dep: await acct(pool, C, 'Depreciation'), rent: await acct(pool, C, 'Rent & Lease'), util: await acct(pool, C, 'Utilities'), re: await acct(pool, C, 'Retained Earnings') };
    await deposit(pool, C, '2025-03-01', A.bank, [[A.sales, 50000]]);
    for (const [a, cents] of [[A.dep, 1000], [A.rent, 2000], [A.util, 3000]]) await je(pool, C, '2025-06-01', [[a, cents], [A.bank, -cents]]);
    const closeDep = await je(pool, C, '2025-12-31', [[A.re, 1000], [A.dep, -1000]]);
    const RP = { return_id: ret, entity_id: C.entityId, period_start: '2025-01-01', period_end: '2025-12-31' };
    const c = (await closingCandidates(pool, { orgId, ret: RP })).find(x => x.txnId === closeDep);
    await classifyEntry(pool, { ...C, returnId: ret, txnId: closeDep, cls: 'closing', lines: c.proposed, expectTxnVersion: c.txnVersion, reviewedBy: 'tester' });
    await bindBalance(pool, C, ret, A.bank, f.cash);
    await bindBalance(pool, C, ret, A.re, f.re);
    await bind(pool, C, ret, A.sales, 'activity', [{ treatment: 'input', destination: f.sales }]);
    // Dollar splits, each complete against the activity as measured now (depreciation: 1,000 with its closing removed).
    await bind(pool, C, ret, A.dep, 'activity', [{ treatment: 'manual_feed', destination: f.dep, amount: '6.00' }, { treatment: 'not_tax', memo: 'personal use', amount: '4.00' }], { split: 'amounts' });
    await bind(pool, C, ret, A.rent, 'activity', [{ treatment: 'input', destination: f.rent, amount: '12.00' }, { treatment: 'not_tax', memo: 'the owner’s storage', amount: '8.00' }], { split: 'amounts' });
    await bind(pool, C, ret, A.util, 'activity', [{ treatment: 'statement_row', destination: f.other, amount: '20.00' }, { treatment: 'not_tax', memo: 'the owner’s share', amount: '10.00' }], { split: 'amounts' });
    await assignProvider(pool, { ...C, returnId: ret, slotKey: `${f.rent}|activity`, providerKind: 'manual', schemaVersion: 1, sourceRef: { reason: 'lease schedule' }, sourceVersion: 'manual:lease@1' });
    await answerTypedItems(pool, C, ret, { except: [`${f.dep}|activity`, `${f.rent}|activity`] });
    await saveManualItem(pool, { ...C, returnId: ret, itemKey: `${f.dep}|activity`, status: 'entered', amount: '250.00', enteredBy: 'tester' });
    await saveManualItem(pool, { ...C, returnId: ret, itemKey: `${f.rent}|activity`, status: 'entered', amount: '300.00', enteredBy: 'tester' });
    let r = await compute(pool, C, ret);
    const expectTyped = (r, tag) => {
      knownField(r, `${f.dep}|activity`, 25000, `${tag}: the typed depreciation`);
      knownField(r, `${f.rent}|activity`, 30000, `${tag}: the assigned typed rent`);
      for (const k of [f.dep, f.rent]) assert.deepEqual(r.packets.find(p => p.values[0].slotKey === `${k}|activity`)?.consumedSlices, [], `${tag}: the typed packet claims no book slice`);
    };
    expectTyped(r, `${what}, complete`);
    knownField(r, `${f.other}|activity`, 2000, `${what}, complete: the books-owned split`);
    knownField(r, `${f.ordinary}|activity`, -7000, `${what}, complete`);
    assert.equal(r.bridge.unknown.length, 0, `${what}, complete: the book side reconciles`);
    // Every split goes stale: the closing's memo edited (its removal no longer applies: depreciation measures 0), more rent and utilities posted.
    await pool.query(`UPDATE txn SET memo = 'edited' WHERE txn_id = $1`, [closeDep]);
    await je(pool, C, '2025-07-01', [[A.rent, 500], [A.bank, -500]]);
    await je(pool, C, '2025-07-01', [[A.util, 500], [A.bank, -500]]);
    r = await compute(pool, C, ret);
    assert.ok(r.cov.sources[0].accounts.filter(a => [A.dep, A.rent, A.util].includes(a.accountId)).every(a => a.results.activity.status !== 'complete'), `${what}: each split is stale`);
    expectTyped(r, `${what}, stale`);
    unknownField(r, `${f.other}|activity`, `${what}, stale: the books-owned split is unresolved`);
    unknownField(r, `${f.ordinary}|activity`, `${what}, stale: through the books-owned line only`);
    assert.ok(errorsOf(r, 'coverage').length && r.bridge.unknown.length > 0, `${what}, stale: the mapping problems and the book side are visible`);
    // The books-owned split repaired: ordinary income is known again while the typed lines' book neighbours stay stale.
    await bind(pool, C, ret, A.util, 'activity', [{ treatment: 'statement_row', destination: f.other }]);
    r = await compute(pool, C, ret);
    expectTyped(r, `${what}, repaired`);
    knownField(r, `${f.other}|activity`, 3500, `${what}, repaired`);
    knownField(r, `${f.ordinary}|activity`, -8500, `${what}, repaired: independently determinable income`);
    assert.ok(r.bridge.unknown.length > 0, `${what}, repaired: the stale comparisons still wait on the book side`);
  }
});
