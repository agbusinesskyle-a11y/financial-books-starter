// test/tax-engine.test.js — the T3 engine on sample books: a Form 1065 on accrual books (page 1, Schedule K, Schedule L, M-1 and the
// Analysis of Net Income), the sign facts through the engine (returns and allowances, accumulated depreciation), typed items and the K-1
// answer, unknown never zero, a Form 1120-S, and what the engine refuses to compute.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { t2Db, company, acct, je, period, bind, bindBalance, compute, valueOf, errorsOf, answerTypedItems } from './tax-t3-fixtures.js';
import { saveManualItem } from '../lib/tax/manual.js';
import { saveProfile, openPeriod } from '../lib/tax/periods.js';
import { activity, include } from './tax-t2-fixtures.js';

let t, pool, orgId, B, bRet, A;
before(async () => {
  t = await t2Db(); pool = t.pool; orgId = t.orgId;
  B = { orgId, entityId: await company(pool, orgId, 'Birch Partners') };
  bRet = await period(pool, B, 2025, 'form_1065', { taxMethod: 'accrual' });
  A = {};
  for (const n of ['Checking', 'Services', 'Wages', 'Depreciation', 'Loan Payable', 'Retained Earnings', 'Interest Earned']) A[n] = await acct(pool, B, n);
  A.Returns = await acct(pool, B, 'Returns and Allowances', 'income');
  A.Equipment = await acct(pool, B, 'Furniture and Equipment');
  A.AccumDep = await acct(pool, B, 'Accumulated Depreciation');
  A.Muni = await acct(pool, B, 'Municipal Bond Interest', 'other_income');
  await je(pool, B, '2024-02-01', [[A.Checking, 500000], [A['Loan Payable'], -200000], [A.Services, -300000]]);
  await je(pool, B, '2024-03-01', [[A.Equipment, 100000], [A.Checking, -100000]]);
  await je(pool, B, '2024-12-31', [[A.Depreciation, 20000], [A.AccumDep, -20000]]);
  await je(pool, B, '2025-02-01', [[A.Checking, 800000], [A.Services, -800000]]);
  await je(pool, B, '2025-03-01', [[A.Returns, 30000], [A.Checking, -30000]]);
  await je(pool, B, '2025-04-01', [[A.Wages, 200000], [A.Checking, -200000]]);
  await je(pool, B, '2025-05-01', [[A.Checking, 5000], [A['Interest Earned'], -5000]]);
  await je(pool, B, '2025-05-02', [[A.Checking, 2000], [A.Muni, -2000]]);
  await je(pool, B, '2025-12-31', [[A.Depreciation, 20000], [A.AccumDep, -20000]]);
  await je(pool, B, '2025-06-01', [[A['Loan Payable'], 50000], [A.Checking, -50000]]);
  await bindBalance(pool, B, bRet, A.Checking, 'f1065.L.1');
  await bindBalance(pool, B, bRet, A.Equipment, 'f1065.L.9a');
  await bindBalance(pool, B, bRet, A.AccumDep, 'f1065.L.9b');
  await bindBalance(pool, B, bRet, A['Loan Payable'], 'f1065.L.19b');
  await bindBalance(pool, B, bRet, A['Retained Earnings'], 'f1065.L.21');
  for (const [a, d] of [[A.Services, 'f1065.p1.1a'], [A.Returns, 'f1065.p1.1b'], [A.Wages, 'f1065.p1.9'], [A['Interest Earned'], 'f1065.k.5'], [A.Muni, 'f1065.k.18a']]) {
    await bind(pool, B, bRet, a, 'activity', [{ treatment: 'input', destination: d }]);
  }
  await bind(pool, B, bRet, A.Depreciation, 'activity', [{ treatment: 'manual_feed', destination: 'f1065.p1.16a' }]);
});
after(async () => { await t.db.drop(); });

test('a typed line not entered is unknown, and so is everything computed from it; the K-1 answer is asked for', async () => {
  const r = await compute(pool, B, bRet);
  assert.equal(r.refused, null);
  assert.equal(valueOf(r, 'f1065.p1.16a|activity'), null);
  assert.equal(valueOf(r, 'f1065.p1.23|activity'), null, 'never zero');
  assert.equal(valueOf(r, 'f1065.p1.1c|activity'), 770000n, 'an independent line keeps its amount');
  assert.ok(errorsOf(r, 'manual_open').some(c => c.itemKey === 'f1065.p1.16a|activity'));
  assert.equal(errorsOf(r, 'k1_inflows').length, 1);
  assert.equal(valueOf(r, 'f1065.k.5|activity'), null, 'a Schedule K line that also takes K-1 members waits on the K-1 answer');
});

test('a Form 1065 on accrual books: page 1, Schedule K, Schedule L at both dates, M-1 reconciled to the Analysis of Net Income, exact cents', async () => {
  await saveManualItem(pool, { ...B, returnId: bRet, itemKey: 'f1065.p1.16a|activity', status: 'entered', amount: '250.00', enteredBy: 'tester' });
  await answerTypedItems(pool, B, bRet);
  const r = await compute(pool, B, bRet);
  const want = { 'f1065.p1.1a|activity': 800000n, 'f1065.p1.1b|activity': 30000n, 'f1065.p1.1c|activity': 770000n, 'f1065.p1.9|activity': 200000n, 'f1065.p1.16c|activity': 25000n,
    'f1065.p1.22|activity': 225000n, 'f1065.p1.23|activity': 545000n, 'f1065.k.1|activity': 545000n, 'f1065.k.5|activity': 5000n, 'f1065.k.18a|activity': 2000n, 'f1065.anal.1|activity': 550000n,
    'f1065.L.1|begin': 400000n, 'f1065.L.9b|begin': 20000n, 'f1065.L.14|begin': 480000n, 'f1065.L.21|begin': 280000n, 'f1065.L.22|begin': 480000n,
    'f1065.L.1|end': 927000n, 'f1065.L.9b|end': 40000n, 'f1065.L.14|end': 987000n, 'f1065.L.19b|end': 150000n, 'f1065.L.21|end': 837000n, 'f1065.L.22|end': 987000n,
    'f1065.m1.1|activity': 557000n, 'f1065.m1.6a|activity': 2000n, 'f1065.m1.7a|activity': 5000n, 'f1065.m1.9|activity': 550000n };
  for (const [k, v] of Object.entries(want)) assert.equal(valueOf(r, k), v, k);
  assert.equal(r.bridge.residual, '0');
  assert.deepEqual(r.bridge.rows.map(x => [x.line, x.cents, x.cls]), [['7a', '5000', 'book_tax_depreciation'], ['6a', '2000', 'tax_exempt']], 'tax depreciation over book, from the typed line beside the book depreciation; the books’ tax-exempt interest on line 6a');
  assert.deepEqual(errorsOf(r).map(c => c.code), ['openings_unknown'], 'only the openings: this first period has no predecessor');
  // Results carry catalog ids, exact cents as strings and statement rows (what the T5 printing slice reads).
  const f = r.fields.find(x => x.key === 'f1065.L.9b|end');
  assert.deepEqual([f.fieldId, f.cents, f.status], ['f1065.L.9b', '40000', 'complete']);
});

test('unknown is never zero: an unmapped account leaves every total it could reach unknown, and mapped lines keep their amounts', async () => {
  const stray = await acct(pool, B, 'Stray Expense', 'expense');
  const txn = await je(pool, B, '2025-07-01', [[stray, 1000], [A.Checking, -1000]]);
  const r = await compute(pool, B, bRet);
  assert.equal(valueOf(r, 'f1065.p1.9|activity'), 200000n);
  for (const k of ['f1065.p1.22|activity', 'f1065.p1.23|activity', 'f1065.anal.1|activity', 'f1065.m1.9|activity']) assert.equal(valueOf(r, k), null, k);
  assert.ok(errorsOf(r, 'incomplete').some(c => /Stray Expense is not mapped/.test(c.message)));
  await pool.query('DELETE FROM posting WHERE txn_id = $1', [txn]);
  await pool.query('DELETE FROM txn WHERE txn_id = $1', [txn]);
});

test('Schedule L out of balance is an error (an unbound balance cannot hide in capital)', async () => {
  const other = await acct(pool, B, 'Deposits Held', 'other_current_asset');
  const txn = await je(pool, B, '2025-08-01', [[other, 7000], [A.Checking, -7000]]);
  await bind(pool, B, bRet, other, 'end', [{ treatment: 'not_tax', memo: 'held for a customer' }]);
  const r = await compute(pool, B, bRet);
  assert.match(errorsOf(r, 'schedule_l_unbalanced').map(c => c.message).join(' '), /end of the year by -7000 cents/);
  await pool.query('DELETE FROM tax_binding WHERE account_id = $1', [other]);
  await pool.query('DELETE FROM posting WHERE txn_id = $1', [txn]);
  await pool.query('DELETE FROM txn WHERE txn_id = $1', [txn]);
});

test('a Form 1120-S: Schedule K line 18 is the M-1 endpoint; a nondeductible expense kept out of the reconciliation is an M-1 line 3c row', async () => {
  const S = { orgId, entityId: await company(pool, orgId, 'Aspen Corp') };
  const ret = await period(pool, S, 2025, 'form_1120s', { taxMethod: 'accrual' });
  const bank = await acct(pool, S, 'Checking'), sales = await acct(pool, S, 'Services'), rent = await acct(pool, S, 'Rent & Lease'), re = await acct(pool, S, 'Retained Earnings');
  const fines = await acct(pool, S, 'Fines and Penalties', 'expense');
  await je(pool, S, '2025-02-01', [[bank, 300000], [sales, -300000]]);
  await je(pool, S, '2025-03-01', [[rent, 120000], [bank, -120000]]);
  await je(pool, S, '2025-03-02', [[fines, 4000], [bank, -4000]]);
  await bindBalance(pool, S, ret, bank, 'f1120s.L.1');
  await bind(pool, S, ret, re, 'end', [{ treatment: 'input', destination: 'f1120s.L.24' }]);
  await bind(pool, S, ret, sales, 'activity', [{ treatment: 'input', destination: 'f1120s.p1.1a' }]);
  await bind(pool, S, ret, rent, 'activity', [{ treatment: 'input', destination: 'f1120s.p1.11' }]);
  await bind(pool, S, ret, fines, 'activity', [{ treatment: 'input', destination: 'f1120s.k.16c' }]);
  await answerTypedItems(pool, S, ret);
  const r = await compute(pool, S, ret);
  for (const [k, v] of Object.entries({ 'f1120s.p1.22|activity': 180000n, 'f1120s.k.1|activity': 180000n, 'f1120s.k.16c|activity': 4000n, 'f1120s.k.18|activity': 180000n, 'f1120s.m1.1|activity': 176000n,
    'f1120s.m1.3c|activity': 4000n, 'f1120s.m1.8|activity': 180000n, 'f1120s.L.15|end': 176000n, 'f1120s.L.24|end': 176000n, 'f1120s.L.27|end': 176000n })) assert.equal(valueOf(r, k), v, k);
  assert.equal(r.bridge.residual, '0');
  assert.deepEqual(r.fields.find(x => x.key === 'f1120s.m1.3c|activity').rows, [{ label: 'Nondeductible expenses', cents: '4000' }]);
});

test('refused, computing nothing: an edition with no catalog, a disregarded period, an accrual return on cash-basis books, a return that includes other books', async () => {
  const later = Number(await openPeriod(pool, { ...B, year: 2026, actor: 'tester' }));
  assert.match((await compute(pool, B, later)).refused, /2026 forms are not in the app yet/);
  const D = { orgId, entityId: await company(pool, orgId, 'Birch Child LLC') };
  const dRet = await period(pool, D, 2025, 'disregarded');
  assert.match((await compute(pool, D, dRet)).refused, /computed on the return that includes them/);
  const K = { orgId, entityId: await company(pool, orgId, 'Cedar Cash Books') };
  const kRet = await period(pool, K, 2025, 'form_1065', { taxMethod: 'accrual', bookBasis: 'cash' });
  assert.match((await compute(pool, K, kRet)).refused, /accrual-method return on cash-basis books/);
  const P = { orgId, entityId: await company(pool, orgId, 'Birch Holding') };
  const pRet = await period(pool, P, 2025, 'form_1065', { taxMethod: 'accrual' });
  await include(pool, P, pRet, await activity(pool, P, { name: 'Holding trade' }), D.entityId);
  assert.match((await compute(pool, P, pRet)).refused, /stage T4/);
  await saveProfile(pool, { ...B, fields: { returnType: 'form_1065', taxMethodDefault: 'accrual', bookBasisDefault: 'accrual', yearEndMonth: 12 }, reason: 'test', actor: 'tester' });
});

test('a provider conflict: the books assigned a line the cash layer must own has no amount, and says why', async () => {
  const { assignProvider } = await import('../lib/tax/providers.js');
  const Q = { orgId, entityId: await company(pool, orgId, 'Quince Cash Partners') };
  const qRet = await period(pool, Q, 2025, 'form_1065', { taxMethod: 'cash' });
  const bank = await acct(pool, Q, 'Checking'), sales = await acct(pool, Q, 'Services');
  await je(pool, Q, '2025-02-01', [[bank, 1000], [sales, -1000]]);
  await bindBalance(pool, Q, qRet, bank, 'f1065.L.1');
  await bind(pool, Q, qRet, await acct(pool, Q, 'Retained Earnings'), 'end', [{ treatment: 'input', destination: 'f1065.L.21' }]);
  await bind(pool, Q, qRet, sales, 'activity', [{ treatment: 'input', destination: 'f1065.p1.1a' }]);
  await answerTypedItems(pool, Q, qRet);
  assert.equal(valueOf(await compute(pool, Q, qRet), 'f1065.p1.1a|activity'), 1000n);
  await assignProvider(pool, { ...Q, returnId: qRet, slotKey: 'f1065.p1.1a|activity', providerKind: 'books', schemaVersion: 1, sourceRef: { reason: 'test' }, sourceVersion: 'books:test@1' });
  const r = await compute(pool, Q, qRet);
  assert.equal(valueOf(r, 'f1065.p1.1a|activity'), null);
  assert.match(errorsOf(r, 'slot').map(c => c.message).join(' '), /assign it to the cash layer/);
});
