// test/tax-cashbasis.test.js — the books' own cash basis, exact (spec §5.2, §13.1 T3): lib/tax/engine/cashbasis.js agrees with
// lib/reports/ledger-data.js ledgerLines(basis: 'cash') within the safe range — income collected and expenses paid in the period, a
// receivable only for what was paid ahead and not applied, retained earnings beginning with the earlier years' cash-basis income.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { t2Db, company, acct, period, invoice, payment, bill, billPayment } from './tax-t3-fixtures.js';
import { cashBasisMeasure } from '../lib/tax/engine/cashbasis.js';
import { ledgerLines } from '../lib/reports/ledger-data.js';

let t, pool, orgId, N, ret, A;
const R = () => ({ return_id: ret, entity_id: N.entityId, period_start: '2025-01-01', period_end: '2025-12-31', tax_method: 'cash' });
before(async () => {
  t = await t2Db(); pool = t.pool; orgId = t.orgId;
  N = { orgId, entityId: await company(pool, orgId, 'Nutmeg Partners') };
  ret = await period(pool, N, 2025, 'form_1065', { taxMethod: 'cash', bookBasis: 'cash' });
  A = {};
  for (const n of ['Checking', 'Services', 'Utilities', 'Retained Earnings', 'Accounts Receivable (A/R)', 'Accounts Payable (A/P)']) A[n] = await acct(pool, N, n);
  const old = await invoice(pool, N, '2024-10-01', [[A.Services, 30000]]);
  await payment(pool, N, '2024-11-01', 10000, A.Checking, [[old, 10000, '2024-11-01']]);
  await payment(pool, N, '2025-02-01', 20000, A.Checking, [[old, 20000, '2025-02-01']]);
  const inv = await invoice(pool, N, '2025-03-01', [[A.Services, 70000]]);
  await payment(pool, N, '2025-04-01', 70000, A.Checking, [[inv, 70000, '2025-04-01']]);
  await invoice(pool, N, '2025-12-01', [[A.Services, 9000]]);
  await payment(pool, N, '2025-12-29', 4000, A.Checking);
  const b = await bill(pool, N, '2025-05-01', [[A.Utilities, 6000]]);
  await billPayment(pool, N, '2025-05-20', 6000, A.Checking, [[b, 6000, '2025-05-20']]);
  await bill(pool, N, '2025-12-15', [[A.Utilities, 1500]]);
});
after(async () => { await t.db.drop(); });

test('the exact cash-basis measurement is the books’ own cash basis, account by account', async () => {
  const cb = await cashBasisMeasure(pool, { orgId, ret: R() });
  const lines = await ledgerLines(pool, { orgId, entityId: N.entityId, to: '2025-12-31', basis: 'cash' });
  for (const [id, m] of cb) {
    if (m.pl) assert.equal(m.activity, BigInt(lines.filter(l => l.accountId === id && l.date >= '2025-01-01').reduce((s, l) => s + l.amount, 0)), `account ${id}`);
    else if (id !== A['Retained Earnings']) assert.equal(m.end, BigInt(lines.filter(l => l.accountId === id).reduce((s, l) => s + l.amount, 0)), `account ${id}`);
  }
  assert.deepEqual([cb.get(A.Services).activity, cb.get(A.Utilities).activity], [-90000n, 6000n], 'collected and paid in the year; the December invoice and bill wait');
  assert.equal(cb.get(A['Accounts Receivable (A/R)']).end, -4000n, 'only the unapplied advance stays in A/R');
  assert.equal(cb.get(A['Accounts Payable (A/P)']).end, 0n);
  assert.equal(cb.get(A['Retained Earnings']).begin, -10000n, 'last year’s cash-basis income');
});
