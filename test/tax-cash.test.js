// test/tax-cash.test.js — the tax cash layer (spec §4.11, §5.3, §13.1 T3), across periods so "recognized once" is checked, not assumed:
// partial payments shared exactly, credit memos, a card purchase and a card refund vs the card repayment vs a merchant settlement, a voided
// payment (a reversal: nothing recognized), a December invoice paid in January and opening A/R collected, an imported accrual entry, money
// applied to opening balances (one decision for every application of the payment, the whole amount or nothing), reviewed receipt dates (the
// first-week suggestion and any other deposit selected; the periods a date can move to), advances decided BEFORE their later applications
// (Codex t3-plan-r1 B1: a later, resized or re-pointed application makes the decision stale and unresolved — never added on top), a partly
// applied advance consumed over three periods (the eligible cents recognized exactly once), and stale decisions left unresolved, never the
// default; exact BigInt arithmetic beyond 2^53.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { t2Db, company, acct, je, period, invoice, payment, apply, creditMemo, expense, deposit, cardPayment, importedJe, rawTxn } from './tax-t3-fixtures.js';
import { openPeriod } from '../lib/tax/periods.js';
import { cashRecognition, saveTimingReview, clearTimingReview, prorateBig } from '../lib/tax/cash.js';
import { prorate } from '../lib/reports/ledger-data.js';
import { voidTxn } from '../lib/data/writes.js';

let t, pool, orgId, F, r25, r26, A;
const RET = (C, id, y) => ({ return_id: id, entity_id: C.entityId, period_start: `${y}-01-01`, period_end: `${y}-12-31`, tax_method: 'cash', return_type: 'form_1065', form_edition: y });
const rec = (C, id, y) => cashRecognition(pool, { orgId, ret: RET(C, id, y) });
// The income a period recognizes on one account plus its reviewed destinations, as positive cents (credits are income).
const income = async (C, id, y, account) => { const r = await rec(C, id, y); return { cents: -(r.byAccount.get(account) ?? 0n) - r.slotItems.reduce((s, x) => s + x.cents, 0n), r }; };
const find = (r, txnId, kind) => [...r.candidates, ...r.selectable.receipts.map(x => ({ ...x, kinds: ['receipt_date'] }))].find(x => x.txnId === txnId && x.kinds.includes(kind));
const decide = async (C, id, y, txnId, kind, decision, extra = {}) => {
  const c = find(await rec(C, id, y), txnId, kind);
  assert.ok(c, `a ${kind} event for ${txnId}`);
  return saveTimingReview(pool, { ...C, returnId: id, txnId, kind, decision, expectTxnVersion: c.txnVersion, expectEventVersion: c.eventVersion, reviewedBy: 'tester', ...extra });
};
before(async () => {
  t = await t2Db(); pool = t.pool; orgId = t.orgId;
  F = { orgId, entityId: await company(pool, orgId, 'Fir Partners') };
  r25 = await period(pool, F, 2025, 'form_1065', { taxMethod: 'cash' });
  r26 = Number(await openPeriod(pool, { ...F, year: 2026, actor: 'tester' }));
  A = {};
  for (const n of ['Checking', 'Services', 'Other Income', 'Supplies & Materials', 'Credit Card', 'Payroll Liabilities', 'Accounts Receivable (A/R)', 'Opening Balance Equity']) A[n] = await acct(pool, F, n);
});
after(async () => { await t.db.drop(); });

test('largest-remainder sharing is exact and agrees with the books’ own cash basis within the safe range; beyond it, BigInt keeps every cent', () => {
  for (const [amount, weights] of [[-3333, [-6000, -4000]], [7, [1, 1, 1]], [-1001, [-333, -333, -335]], [10000, [5000, -2500, 7500]]]) {
    assert.deepEqual(prorateBig(BigInt(amount), weights.map(BigInt)).map(Number), prorate(amount, weights), JSON.stringify([amount, weights]));
  }
  const big = 9007199254740993n;
  const parts = prorateBig(big, [1n, 1n]);
  assert.equal(parts[0] + parts[1], big);
});

test('partial payments of a two-line invoice are shared exactly on the cumulative amount paid; a credit memo applied nets; nothing for an unpaid invoice', async () => {
  const inv = await invoice(pool, F, '2025-03-01', [[A.Services, 6000], [A['Other Income'], 4000]]);
  await payment(pool, F, '2025-03-10', 3333, A.Checking, [[inv, 3333, '2025-03-10']]);
  const r1 = await rec(F, r25, 2025);
  assert.deepEqual([r1.byAccount.get(A.Services), r1.byAccount.get(A['Other Income'])], [-2000n, -1333n]);
  await payment(pool, F, '2025-04-10', 6667, A.Checking, [[inv, 6667, '2025-04-10']]);
  const r2 = await rec(F, r25, 2025);
  assert.deepEqual([r2.byAccount.get(A.Services), r2.byAccount.get(A['Other Income'])], [-6000n, -4000n], 'the last payment clears every line exactly');
  const inv2 = await invoice(pool, F, '2025-05-01', [[A.Services, 5000]]);
  const cm = await creditMemo(pool, F, '2025-05-02', [[A.Services, 1000]]);
  await apply(pool, F, cm, inv2, 1000, '2025-05-02');
  await payment(pool, F, '2025-05-20', 4000, A.Checking, [[inv2, 4000, '2025-05-20']]);
  await invoice(pool, F, '2025-11-01', [[A.Services, 9900]]); // unpaid at year end: never income on the cash method
  assert.equal((await rec(F, r25, 2025)).byAccount.get(A.Services), -6000n - 4000n, 'the credit and the cash together recognize 4,000 of the 5,000 invoice');
});

test('a card purchase is deducted when charged and a card refund when credited; the card repayment deducts nothing more; a settlement counts on its bank date; a voided payment recognizes nothing', async () => {
  await expense(pool, F, '2025-06-01', A['Credit Card'], [[A['Supplies & Materials'], 2500]]);
  await rawTxn(pool, F, 'cc_credit', '2025-06-20', [[A['Credit Card'], 400], [A['Supplies & Materials'], -400]], { accountId: A['Credit Card'] });
  await cardPayment(pool, F, '2025-07-01', A.Checking, A['Credit Card'], 2100);
  await deposit(pool, F, '2025-08-03', A.Checking, [[A.Services, 1200]]);
  let r = await rec(F, r25, 2025);
  assert.equal(r.byAccount.get(A['Supplies & Materials']), 2100n, 'charged 2,500, refunded 400 onto the card');
  assert.deepEqual(r.events.filter(e => e.accountId === A['Supplies & Materials']).map(e => [e.kind, e.cents]), [['card', 2500n], ['card', -400n]]);
  assert.equal(r.byAccount.get(A.Services), -10000n - 1200n);
  // A reversal: a payment applied to an invoice and then voided (its application removed) — the invoice is unpaid again, nothing recognized.
  const inv = await invoice(pool, F, '2025-09-01', [[A.Services, 700]]);
  const pay = await payment(pool, F, '2025-09-05', 700, A.Checking, [[inv, 700, '2025-09-05']]);
  assert.equal((await rec(F, r25, 2025)).byAccount.get(A.Services), -11200n - 700n);
  await voidTxn(pool, { ...F, txnId: pay, actor: 'tester' });
  r = await rec(F, r25, 2025);
  assert.equal(r.byAccount.get(A.Services), -11200n, 'the voided payment is no event');
  assert.ok(!r.applications.some(a => a.credit === pay));
});

test('a December invoice paid in January is January’s; an invoice of the year before collected this year is this year’s', async () => {
  const dec = await invoice(pool, F, '2025-12-15', [[A['Other Income'], 800]]);
  await payment(pool, F, '2026-01-08', 800, A.Checking, [[dec, 800, '2026-01-08']]);
  const old = await invoice(pool, F, '2024-11-01', [[A['Other Income'], 450]]);
  await payment(pool, F, '2025-02-01', 450, A.Checking, [[old, 450, '2025-02-01']]);
  assert.equal((await rec(F, r25, 2025)).byAccount.get(A['Other Income']), -4000n - 450n);
  assert.equal((await rec(F, r26, 2026)).byAccount.get(A['Other Income']), -800n);
});

test('an imported accrual entry is a review (as posted until decided); money applied to two opening balances is ONE decision of the whole payment, recognized once — a split is refused', async () => {
  const accrual = await je(pool, F, '2025-12-31', [[A['Supplies & Materials'], 800], [A['Payroll Liabilities'], -800]]);
  assert.equal((await rec(F, r25, 2025)).byAccount.get(A['Supplies & Materials']), 2100n + 800n);
  await decide(F, r25, 2025, accrual, 'imported_accrual_je', 'exclude');
  assert.equal((await rec(F, r25, 2025)).byAccount.get(A['Supplies & Materials']), 2100n);
  const o1 = await importedJe(pool, F, '2024-12-31', [[A['Accounts Receivable (A/R)'], 5000], [A['Opening Balance Equity'], -5000]]);
  const o2 = await importedJe(pool, F, '2024-12-31', [[A['Accounts Receivable (A/R)'], 3000], [A['Opening Balance Equity'], -3000]]);
  const pay = await payment(pool, F, '2025-01-20', 8000, A.Checking, [[o1, 5000, '2025-01-20'], [o2, 3000, '2025-01-20']]);
  const r = await rec(F, r25, 2025);
  const cs = r.candidates.filter(x => x.txnId === pay);
  assert.deepEqual(cs.map(c => [c.kinds[0], c.cents, c.applications.length]), [['opening_ar_ap_payment', 8000n, 2]], 'one event for both applications');
  await assert.rejects(decide(F, r25, 2025, pay, 'opening_ar_ap_payment', 'include', { slotKey: 'f1065.L.1|end', amount: '80.00' }), /does not take a reviewed income or deduction amount/);
  await assert.rejects(decide(F, r25, 2025, pay, 'opening_ar_ap_payment', 'include', { slotKey: 'f1065.p1.1a|activity', amount: '50.00' }), /whole 8000 cents.*split is not taken/);
  await decide(F, r25, 2025, pay, 'opening_ar_ap_payment', 'include', { slotKey: 'f1065.p1.1a|activity', amount: '80.00' });
  const items = (await rec(F, r25, 2025)).slotItems.filter(x => x.txnId === pay);
  assert.deepEqual(items.map(x => x.cents), [-8000n], 'recognized once, not once per application');
  // One application resized: the event the decision was made against is gone — stale, and its destination unresolved (never the old 80.00).
  await pool.query('UPDATE application SET amount_cents = 2000 WHERE credit_txn_id = $1 AND charge_txn_id = $2', [pay, o2]);
  const r2 = await rec(F, r25, 2025);
  assert.equal(r2.candidates.find(x => x.txnId === pay).state, 'stale');
  assert.equal(r2.slotItems.filter(x => x.txnId === pay).length, 0);
  assert.ok(r2.unresolved.some(u => u.slotKeys.includes('f1065.p1.1a|activity')));
});

test('a stale decision is unresolved, never the default: an accrual entry edited after its review leaves its accounts unresolved', async () => {
  const r0 = await rec(F, r25, 2025);
  const accrual = r0.candidates.find(x => x.kinds.includes('imported_accrual_je'));
  assert.equal(accrual.state, 'decided');
  await pool.query(`UPDATE txn SET memo = 'edited after review' WHERE txn_id = $1`, [accrual.txnId]);
  const r1 = await rec(F, r25, 2025);
  assert.equal(r1.candidates.find(x => x.txnId === accrual.txnId).state, 'stale');
  assert.ok(r1.unresolved.some(u => u.accountIds.includes(A['Supplies & Materials'])), 'the accounts it decided are unresolved until it is decided again');
});

test('receipt dates: the first week is suggested, any other deposit to income can be selected (a January 10 settlement received in December); the date must move it into the open previous period; stale evidence leaves it unresolved in both periods', async () => {
  const R = { orgId, entityId: await company(pool, orgId, 'Rowan Partners') };
  const p25 = await period(pool, R, 2025, 'form_1065', { taxMethod: 'cash' });
  const p26 = Number(await openPeriod(pool, { ...R, year: 2026, actor: 'tester' }));
  const bank = await acct(pool, R, 'Checking'), svc = await acct(pool, R, 'Services');
  const early = await deposit(pool, R, '2026-01-03', bank, [[svc, 700]]);
  const late = await deposit(pool, R, '2026-01-10', bank, [[svc, 500]]);
  let r = await rec(R, p26, 2026);
  assert.ok(r.candidates.some(c => c.txnId === early && c.kinds.includes('receipt_date')), 'suggested: the first week');
  assert.ok(!r.candidates.some(c => c.txnId === late) && r.selectable.receipts.some(x => x.txnId === late), 'not suggested, but selectable');
  await decide(R, p26, 2026, early, 'receipt_date', 'include', { recognizeOn: '2025-12-30' });
  await assert.rejects(decide(R, p26, 2026, late, 'receipt_date', 'include', { recognizeOn: '2026-01-05' }), /same period/);
  await assert.rejects(decide(R, p26, 2026, late, 'receipt_date', 'include', { recognizeOn: '2024-12-31' }), /more than one period/);
  await assert.rejects(decide(R, p26, 2026, late, 'receipt_date', 'include', { recognizeOn: '2026-01-10' }), /a day before the bank date/);
  await decide(R, p26, 2026, late, 'receipt_date', 'include', { recognizeOn: '2025-12-28', reason: 'Card batch of December 28' });
  assert.equal((await income(R, p25, 2025, svc)).cents, 1200n, 'both settlements are the year they were received in');
  assert.equal((await income(R, p26, 2026, svc)).cents, 0n, 'and not again in the year they were deposited');
  r = await rec(R, p26, 2026);
  assert.ok(r.candidates.some(c => c.txnId === late && c.state === 'decided'), 'a decided selection stays listed');
  // The settlement edited after its receipt date was reviewed: unresolved in both periods, never silently back on the bank date.
  await pool.query(`UPDATE txn SET memo = 'corrected batch' WHERE txn_id = $1`, [late]);
  const [x25, x26] = [await rec(R, p25, 2025), await rec(R, p26, 2026)];
  assert.equal(-(x25.byAccount.get(svc) ?? 0n), 700n, 'the edited settlement is not pulled in');
  assert.ok(x25.unresolved.some(u => u.accountIds.includes(svc)) && x26.unresolved.some(u => u.accountIds.includes(svc)));
  assert.equal(x26.candidates.find(c => c.txnId === late).state, 'stale');
  // A company whose previous period is not kept: the receipt cannot move.
  const N = { orgId, entityId: await company(pool, orgId, 'Rowan New Partners') };
  const n26 = await period(pool, N, 2026, 'form_1065', { taxMethod: 'cash' });
  const nd = await deposit(pool, N, '2026-01-02', await acct(pool, N, 'Checking'), [[await acct(pool, N, 'Services'), 300]]);
  await assert.rejects(decide(N, n26, 2026, nd, 'receipt_date', 'include', { recognizeOn: '2025-12-31' }), /previous period is not kept/);
});

test('an advance decided before its applications: an application made, resized or re-pointed afterwards makes the decision stale (never added on top); decided again, the payment is recognized exactly once across periods', async () => {
  const V = { orgId, entityId: await company(pool, orgId, 'Vine Partners') };
  const v25 = await period(pool, V, 2025, 'form_1065', { taxMethod: 'cash' });
  const v26 = Number(await openPeriod(pool, { ...V, year: 2026, actor: 'tester' }));
  const bank = await acct(pool, V, 'Checking'), svc = await acct(pool, V, 'Services');
  const adv = await payment(pool, V, '2025-12-01', 10000, bank);
  await decide(V, v25, 2025, adv, 'unrestricted_advance', 'include', { slotKey: 'f1065.p1.1a|activity', amount: '100.00' });
  assert.equal((await income(V, v25, 2025, svc)).cents, 10000n);
  // Applied to a December invoice AFTER the decision: the decision was made against 100.00 unapplied, not 60.00.
  const dec = await invoice(pool, V, '2025-12-10', [[svc, 4000]]);
  await apply(pool, V, adv, dec, 4000, '2025-12-10');
  let { cents, r } = await income(V, v25, 2025, svc);
  assert.equal(cents, 4000n, 'only the application: never 4,000 + 10,000');
  assert.equal(r.candidates.find(c => c.txnId === adv).state, 'stale');
  assert.ok(r.unresolved.some(u => u.slotKeys.includes('f1065.p1.1a|activity')), 'the advance’s destination is unresolved until decided again');
  await assert.rejects(decide(V, v25, 2025, adv, 'unrestricted_advance', 'include', { slotKey: 'f1065.p1.1a|activity', amount: '100.00' }), /whole 6000 cents/);
  await decide(V, v25, 2025, adv, 'unrestricted_advance', 'include', { slotKey: 'f1065.p1.1a|activity', amount: '60.00' });
  // January's invoice consumes what December recognized: nothing more.
  const jan = await invoice(pool, V, '2026-01-15', [[svc, 6000]]);
  await apply(pool, V, adv, jan, 6000, '2026-01-15');
  const [a25, a26] = [await income(V, v25, 2025, svc), await income(V, v26, 2026, svc)];
  assert.deepEqual([a25.cents, a26.cents], [10000n, 0n], 'the 10,000 payment is recognized exactly once');
  assert.deepEqual(a26.r.events.filter(e => e.kind === 'carried').map(e => e.cents), [6000n]);
  // Resized or re-pointed in December: stale again (the event changed).
  await pool.query('UPDATE application SET amount_cents = 3000 WHERE credit_txn_id = $1 AND charge_txn_id = $2', [adv, dec]);
  assert.equal((await rec(V, v25, 2025)).candidates.find(c => c.txnId === adv).state, 'stale');
  const dec2 = await invoice(pool, V, '2025-12-11', [[svc, 3000]]);
  await pool.query('UPDATE application SET amount_cents = 4000 WHERE credit_txn_id = $1 AND charge_txn_id = $2', [adv, dec]);
  assert.equal((await rec(V, v25, 2025)).candidates.find(c => c.txnId === adv).state, 'decided', 'back as decided');
  await pool.query('UPDATE application SET charge_txn_id = $3 WHERE credit_txn_id = $1 AND charge_txn_id = $2', [adv, dec, dec2]);
  const re = await rec(V, v25, 2025);
  assert.equal(re.candidates.find(c => c.txnId === adv).state, 'stale', 're-pointed to another invoice');
  // Stale in December, January's application is unresolved there too (its consumption depends on the decision).
  assert.ok((await rec(V, v26, 2026)).unresolved.some(u => u.accountIds.includes(svc)));
});

test('a partly applied advance consumed over three periods: each eligible cent recognized exactly once; deciding it again as a refundable deposit moves the recognition, still once', async () => {
  const W = { orgId, entityId: await company(pool, orgId, 'Wisteria Partners') };
  const w25 = await period(pool, W, 2025, 'form_1065', { taxMethod: 'cash' });
  const w26 = Number(await openPeriod(pool, { ...W, year: 2026, actor: 'tester' }));
  const w27 = Number(await openPeriod(pool, { ...W, year: 2027, actor: 'tester' }));
  const bank = await acct(pool, W, 'Checking'), svc = await acct(pool, W, 'Services');
  const i25 = await invoice(pool, W, '2025-11-01', [[svc, 2000]]);
  const adv = await payment(pool, W, '2025-12-20', 9000, bank, [[i25, 2000, '2025-12-20']]);
  await decide(W, w25, 2025, adv, 'unrestricted_advance', 'include', { slotKey: 'f1065.p1.1a|activity', amount: '70.00' });
  const i26 = await invoice(pool, W, '2026-03-01', [[svc, 3000]]);
  await apply(pool, W, adv, i26, 3000, '2026-03-01');
  const i27 = await invoice(pool, W, '2027-02-01', [[svc, 4000]]);
  await apply(pool, W, adv, i27, 4000, '2027-02-01');
  const all = async () => [await income(W, w25, 2025, svc), await income(W, w26, 2026, svc), await income(W, w27, 2027, svc)];
  let [y25, y26, y27] = await all();
  assert.deepEqual([y25.cents, y26.cents, y27.cents], [9000n, 0n, 0n], '2,000 applied plus 7,000 recognized in 2025; nothing again in 2026 or 2027');
  assert.deepEqual(y27.r.events.filter(e => e.kind === 'carried').map(e => [e.cents, e.left]), [[4000n, 0n]], 'consumed in date order across the periods: 7,000 − 3,000 − 4,000');
  // Decided again (a refundable deposit, income when applied): 2,000 in 2025, 3,000 in 2026, 4,000 in 2027 — still 9,000 once.
  await decide(W, w25, 2025, adv, 'refundable_deposit', 'exclude');
  [y25, y26, y27] = await all();
  assert.deepEqual([y25.cents, y26.cents, y27.cents], [2000n, 3000n, 4000n]);
  // The payment edited after the decision: stale in 2025 and the later applications unresolved, never recognized by default as decided.
  await pool.query(`UPDATE txn SET memo = 'edited' WHERE txn_id = $1`, [adv]);
  [y25, y26, y27] = await all();
  assert.equal(y25.r.candidates.find(c => c.txnId === adv).state, 'stale');
  assert.ok(y26.r.unresolved.some(u => u.accountIds.includes(svc)) && y27.r.unresolved.some(u => u.accountIds.includes(svc)));
  const review = y25.r.candidates.find(c => c.txnId === adv).review;
  await clearTimingReview(pool, { ...W, returnId: w25, reviewId: review.review_id });
  assert.equal((await rec(W, w26, 2026)).unresolved.length, 0, 'cleared: undecided again, the books’ timing stands');
});

test('a decision no event matches any more (an advance fully applied after it was decided) stays listed, stale, its destination unresolved, until cleared', async () => {
  const V = { orgId, entityId: await company(pool, orgId, 'Vetch Partners') };
  const v25 = await period(pool, V, 2025, 'form_1065', { taxMethod: 'cash' });
  const bank = await acct(pool, V, 'Checking'), svc = await acct(pool, V, 'Services');
  const adv = await payment(pool, V, '2025-12-01', 5000, bank);
  await decide(V, v25, 2025, adv, 'unrestricted_advance', 'include', { slotKey: 'f1065.p1.1a|activity', amount: '50.00' });
  await apply(pool, V, adv, await invoice(pool, V, '2025-12-05', [[svc, 5000]]), 5000, '2025-12-05');
  const { cents, r } = await income(V, v25, 2025, svc);
  assert.equal(cents, 5000n, 'recognized once, through the application');
  const c = r.candidates.find(x => x.txnId === adv);
  assert.deepEqual([c.state, c.eventVersion], ['stale', null]);
  assert.ok(r.unresolved.some(u => u.slotKeys.includes('f1065.p1.1a|activity')));
  await clearTimingReview(pool, { ...V, returnId: v25, reviewId: c.review.review_id });
  const after = await rec(V, v25, 2025);
  assert.deepEqual([after.candidates.filter(x => x.txnId === adv).length, after.unresolved.length], [0, 0]);
});

test('an advance recognized when received is consumed by its later applications to opening balances too — one budget, in date order, whatever each application settles (Codex t3-plan-r2 R2-1)', async () => {
  const setup = async name => {
    const C = { orgId, entityId: await company(pool, orgId, name) };
    const y25 = await period(pool, C, 2025, 'form_1065', { taxMethod: 'cash' });
    const y26 = Number(await openPeriod(pool, { ...C, year: 2026, actor: 'tester' }));
    const y27 = Number(await openPeriod(pool, { ...C, year: 2027, actor: 'tester' }));
    const B = { bank: await acct(pool, C, 'Checking'), svc: await acct(pool, C, 'Services'), ar: await acct(pool, C, 'Accounts Receivable (A/R)'), obe: await acct(pool, C, 'Opening Balance Equity') };
    const adv = await payment(pool, C, '2025-12-15', 9000, B.bank);
    await decide(C, y25, 2025, adv, 'unrestricted_advance', 'include', { slotKey: 'f1065.p1.1a|activity', amount: '90.00' });
    const opening = await importedJe(pool, C, '2024-12-31', [[B.ar, 3000], [B.obe, -3000]]);
    const all = async () => [await income(C, y25, 2025, B.svc), await income(C, y26, 2026, B.svc), await income(C, y27, 2027, B.svc)];
    return { C, y25, y26, y27, B, adv, opening, all };
  };
  // Only to an opening balance: nothing offered, nothing recognized again.
  {
    const { C, y26, adv, opening, all } = await setup('Spruce Partners');
    await apply(pool, C, adv, opening, 3000, '2026-02-01');
    const [a, b] = await all();
    assert.deepEqual([a.cents, b.cents], [9000n, 0n]);
    assert.ok(!b.r.candidates.some(c => c.txnId === adv), 'no fresh inclusion of money already recognized');
    assert.deepEqual(b.r.events.filter(e => e.kind === 'carried').map(e => [e.target, e.cents, e.left]), [['opening_balance', 3000n, 6000n]]);
    assert.ok([...b.r.deps.reviews.values()].some(d => d.txnId === adv && d.kind === 'unrestricted_advance'), 'the 2025 decision is a dependency of 2026');
    void y26;
  }
  // Journal first, then documents over two periods: one budget of 9,000 consumed exactly.
  {
    const { C, B, adv, opening, all } = await setup('Spruce Two Partners');
    await apply(pool, C, adv, opening, 3000, '2026-02-01');
    await apply(pool, C, adv, await invoice(pool, C, '2026-03-01', [[B.svc, 4000]]), 4000, '2026-03-01');
    await apply(pool, C, adv, await invoice(pool, C, '2027-01-10', [[B.svc, 2000]]), 2000, '2027-01-10');
    const [a, b, c] = await all();
    assert.deepEqual([a.cents, b.cents, c.cents], [9000n, 0n, 0n], 'recognized once, in 2025');
    assert.deepEqual(b.r.events.filter(e => e.kind === 'carried').map(e => [e.target, e.cents, e.left]), [['opening_balance', 3000n, 6000n], ['document', 4000n, 2000n]]);
    assert.deepEqual(c.r.events.filter(e => e.kind === 'carried').map(e => [e.target, e.cents, e.left]), [['document', 2000n, 0n]]);
  }
  // Documents first, then the journal: the same budget, the same total.
  {
    const { C, B, adv, opening, all } = await setup('Spruce Three Partners');
    await apply(pool, C, adv, await invoice(pool, C, '2026-01-20', [[B.svc, 6000]]), 6000, '2026-01-20');
    await apply(pool, C, adv, opening, 3000, '2026-04-01');
    const [a, b] = await all();
    assert.deepEqual([a.cents, b.cents], [9000n, 0n]);
    assert.deepEqual(b.r.events.filter(e => e.kind === 'carried').map(e => [e.target, e.cents, e.left]), [['document', 6000n, 3000n], ['opening_balance', 3000n, 0n]]);
    assert.equal(b.r.unresolved.length, 0);
  }
});

test('an excluded accrual entry that becomes a direct cash expense: its decision is stale and what it decided — the expense account — is unresolved, not deducted by default (Codex t3-plan-r2 R2-2)', async () => {
  const C = { orgId, entityId: await company(pool, orgId, 'Teak Partners') };
  const y25 = await period(pool, C, 2025, 'form_1065', { taxMethod: 'cash' });
  const bank = await acct(pool, C, 'Checking'), sup = await acct(pool, C, 'Supplies & Materials'), accrued = await acct(pool, C, 'Payroll Liabilities');
  const accrual = await je(pool, C, '2025-12-31', [[sup, 10000], [accrued, -10000]]);
  await decide(C, y25, 2025, accrual, 'imported_accrual_je', 'exclude');
  assert.equal((await rec(C, y25, 2025)).byAccount.get(sup) ?? 0n, 0n);
  await pool.query('UPDATE posting SET account_id = $2 WHERE txn_id = $1 AND account_id = $3', [accrual, bank, accrued]);
  const r = await rec(C, y25, 2025);
  const c = r.candidates.find(x => x.txnId === accrual);
  assert.deepEqual([c.state, c.eventVersion], ['stale', null], 'listed, stale, only to be cleared');
  assert.ok(r.unresolved.some(u => u.accountIds.includes(sup)), 'the account it decided is unresolved');
  await assert.rejects(saveTimingReview(pool, { ...C, returnId: y25, txnId: accrual, kind: 'imported_accrual_je', decision: 'exclude', expectTxnVersion: c.txnVersion, expectEventVersion: 'x', reviewedBy: 'tester' }), /not waiting|clear it/);
});

test('an EXCLUDED decision that goes stale is unresolved too, never the default (Codex t3-plan-r3 R3-2): a refundable deposit, a prepayment and an opening application left out, then changed; a next-period settlement moved into this period and then deleted', async () => {
  const C = { orgId, entityId: await company(pool, orgId, 'Tamarind Partners') };
  const y25 = await period(pool, C, 2025, 'form_1065', { taxMethod: 'cash' });
  const y26 = Number(await openPeriod(pool, { ...C, year: 2026, actor: 'tester' }));
  const B = { bank: await acct(pool, C, 'Checking'), svc: await acct(pool, C, 'Services'), prepaid: await acct(pool, C, 'Prepaid Expenses'), ar: await acct(pool, C, 'Accounts Receivable (A/R)'), obe: await acct(pool, C, 'Opening Balance Equity') };
  const dep = await payment(pool, C, '2025-12-10', 3000, B.bank);
  await decide(C, y25, 2025, dep, 'refundable_deposit', 'exclude');
  const pre = await expense(pool, C, '2025-11-01', B.bank, [[B.prepaid, 1200]]);
  await decide(C, y25, 2025, pre, 'prepaid_expense', 'exclude');
  const o1 = await importedJe(pool, C, '2024-12-31', [[B.ar, 800], [B.obe, -800]]);
  const pay = await payment(pool, C, '2025-02-01', 800, B.bank, [[o1, 800, '2025-02-01']]);
  await decide(C, y25, 2025, pay, 'opening_ar_ap_payment', 'exclude');
  let r = await rec(C, y25, 2025);
  assert.deepEqual(r.unresolved, [], 'decided: nothing unresolved');
  await pool.query(`UPDATE txn SET memo = 'deposit, changed' WHERE txn_id = $1`, [dep]);
  await pool.query(`UPDATE txn SET memo = 'prepaid, changed' WHERE txn_id = $1`, [pre]);
  await pool.query('UPDATE application SET amount_cents = 700 WHERE credit_txn_id = $1', [pay]);
  r = await rec(C, y25, 2025);
  for (const id of [dep, pre, pay]) assert.equal(r.candidates.find(x => x.txnId === id && x.review).state, 'stale', String(id));
  assert.equal(r.unresolved.filter(u => u.wide).length, 3, 'each stale exclusion leaves the return’s income unresolved (it names no line of its own)');
  // A January deposit reviewed as received in December, then deleted: December's income from it is unresolved, the decision a dependency.
  const jan = await deposit(pool, C, '2026-01-04', B.bank, [[B.svc, 500]]);
  await decide(C, y26, 2026, jan, 'receipt_date', 'include', { recognizeOn: '2025-12-30' });
  assert.equal((await rec(C, y25, 2025)).byAccount.get(B.svc), -500n);
  await pool.query('DELETE FROM posting WHERE txn_id = $1', [jan]);
  await pool.query('DELETE FROM txn WHERE txn_id = $1', [jan]);
  r = await rec(C, y25, 2025);
  assert.equal(r.byAccount.get(B.svc) ?? 0n, 0n);
  assert.ok(r.unresolved.some(u => u.accountIds.includes(B.svc) && /no longer in the books/.test(u.reason)), 'the account it brought income to is unresolved');
  assert.ok([...r.deps.reviews.values()].some(d => d.txnId === jan && d.kind === 'receipt_date'), 'the consumed decision stays a dependency');
});
