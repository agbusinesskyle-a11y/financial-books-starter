// test/tax-measure.test.js — exact book measurements: BigInt from SQL, gross activity, balances, versions, cash-touched accounts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { t2Db, company, acct, je } from './tax-t2-fixtures.js';
import { measureAccounts, measureLines, dollars } from '../lib/tax/measure.js';

let t, pool, orgId;
before(async () => { t = await t2Db(); pool = t.pool; orgId = t.orgId; });
after(async () => { await t.db.drop(); });
const Y25 = { periodStart: '2025-01-01', periodEnd: '2025-12-31' };

test('amounts come out of SQL exactly, beyond the range a Number can hold', async () => {
  const S = { orgId, entityId: await company(pool, orgId, 'Exact Sample Co') };
  const bank = await acct(pool, S, 'Checking'), inc = await acct(pool, S, 'Services');
  const big = 9007199254740993n; // 2^53 + 1
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows: [x] } = await c.query(`INSERT INTO txn (org_id, entity_id, type, doc_number, txn_date, total_cents, open_cents) VALUES ($1,$2,'journal_entry','EXACT-1','2025-03-01',$3,0) RETURNING txn_id::text AS id`, [orgId, S.entityId, big.toString()]);
    await c.query(`INSERT INTO posting (org_id, entity_id, txn_id, line_no, account_id, amount_cents, txn_date) VALUES ($1,$2,$3,1,$4,$5,'2025-03-01'), ($1,$2,$3,2,$6,$7,'2025-03-01')`,
      [orgId, S.entityId, x.id, bank, big.toString(), inc, (-big).toString()]);
    await c.query('COMMIT');
  } finally { c.release(); }
  const m = await measureAccounts(pool, { orgId, sourceEntityId: S.entityId, ...Y25 });
  assert.equal(m.get(bank).end, big);
  assert.equal(m.get(bank).grossDebit, big);
  assert.equal(m.get(inc).activity, -big);
  assert.equal(dollars(-big), '-$90,071,992,547,409.93');
});

test('gross activity, balances and the retained-earnings beginning', async () => {
  const S = { orgId, entityId: await company(pool, orgId, 'Gross Sample Co') };
  const bank = await acct(pool, S, 'Checking'), inc = await acct(pool, S, 'Services'), other = await acct(pool, S, 'Other Expenses'), re = await acct(pool, S, 'Retained Earnings');
  await je(pool, S, '2024-06-01', [[bank, 100000], [inc, -100000]]);
  await je(pool, S, '2025-02-01', [[other, 4000], [bank, -4000]]);
  await je(pool, S, '2025-02-09', [[bank, 4000], [other, -4000]]);
  const m = await measureAccounts(pool, { orgId, sourceEntityId: S.entityId, ...Y25 });
  const o = m.get(other);
  assert.deepEqual([o.activity, o.grossDebit, o.grossCredit, o.postings], [0n, 4000n, 4000n, 2], 'an account netting to zero still shows its gross activity');
  assert.deepEqual([o.begin, o.pl], [0n, true], 'an expense account starts the year at zero');
  assert.deepEqual([m.get(bank).begin, m.get(bank).end], [100000n, 100000n]);
  assert.equal(m.get(inc).begin, 0n, 'last year’s income is not this year’s beginning');
  assert.equal(m.get(re).begin, -100000n, 'earlier years’ profit sits in retained earnings (a credit, negative)');
  const lines = (await measureLines(pool, { orgId, sourceEntityId: S.entityId, accountIds: [other], ...Y25 })).get(other);
  assert.deepEqual(lines.map(l => l.cents), [4000n, -4000n]);
  assert.ok(lines.every(l => Number.isInteger(l.lineNo) && l.lineNo > 0 && /^[0-9a-f]{32}$/.test(l.txnVersion)));
  assert.equal(o.lineGroups, 2, 'the period’s posting lines are counted, so an enumeration that omits offsetting lines is caught');
});

test('a version changes exactly when the rows behind its measurement change', async () => {
  const S = { orgId, entityId: await company(pool, orgId, 'Version Sample Co') };
  const bank = await acct(pool, S, 'Checking'), wages = await acct(pool, S, 'Wages');
  await je(pool, S, '2024-12-15', [[wages, 1000], [bank, -1000]]);
  const id = await je(pool, S, '2025-04-01', [[wages, 5000], [bank, -5000]]);
  const before = (await measureAccounts(pool, { orgId, sourceEntityId: S.entityId, ...Y25 })).get(bank).versions;
  await je(pool, S, '2025-04-01', [[wages, 5100], [bank, -5100]], { txnId: id });
  const after = (await measureAccounts(pool, { orgId, sourceEntityId: S.entityId, ...Y25 })).get(bank).versions;
  assert.equal(after.begin, before.begin, 'last year is unchanged');
  assert.notEqual(after.activity, before.activity);
  assert.notEqual(after.end, before.end);
});

// A settled document and its payment, by SQL: invoice (A/R debit, income credit) on invoiceDate, payment (bank debit, A/R credit) on
// paidOn, and the application on appliedOn.
async function settled(S, { inc, bank, invoiceDate, paidOn, appliedOn, cents = 75000 }) {
  const { rows: [{ ar }] } = await pool.query(`SELECT account_id AS ar FROM account WHERE org_id = $1 AND entity_id = $2 AND system_key = 'ar'`, [orgId, S.entityId]);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows: [cust] } = await c.query(`INSERT INTO customer (org_id, entity_id, display_name) VALUES ($1,$2,'Sample Customer') RETURNING customer_id`, [orgId, S.entityId]);
    const { rows: [inv] } = await c.query(`INSERT INTO txn (org_id, entity_id, customer_id, type, txn_date, due_date, total_cents, open_cents) VALUES ($1,$2,$3,'invoice',$4,$4,$5,0) RETURNING txn_id`, [orgId, S.entityId, cust.customer_id, invoiceDate, cents]);
    const { rows: [pay] } = await c.query(`INSERT INTO txn (org_id, entity_id, customer_id, type, txn_date, total_cents, open_cents) VALUES ($1,$2,$3,'payment',$4,$5,0) RETURNING txn_id`, [orgId, S.entityId, cust.customer_id, paidOn, cents]);
    await c.query(`INSERT INTO posting (org_id, entity_id, txn_id, line_no, account_id, amount_cents, txn_date) VALUES ($1,$2,$3,1,$4,$8,$9), ($1,$2,$3,2,$5,-$8::bigint,$9),
      ($1,$2,$6,1,$7,$8,$10), ($1,$2,$6,2,$4,-$8::bigint,$10)`, [orgId, S.entityId, inv.txn_id, ar, inc, pay.txn_id, bank, cents, invoiceDate, paidOn]);
    await c.query(`INSERT INTO application (org_id, credit_txn_id, charge_txn_id, amount_cents, applied_on) VALUES ($1,$2,$3,$4,$5)`, [orgId, pay.txn_id, inv.txn_id, cents, appliedOn]);
    await c.query('COMMIT');
  } finally { c.release(); }
}

test('cash candidates (B3): a December receipt applied in January to a January invoice, and a prior-year invoice collected this year, touch this year', async () => {
  for (const [name, invoiceDate, paidOn] of [['Advance Sample Co', '2026-01-10', '2025-12-20'], ['Collected Sample Co', '2024-12-20', '2025-01-05']]) {
    const S = { orgId, entityId: await company(pool, orgId, name) };
    const inc = await acct(pool, S, 'Services'), bank = await acct(pool, S, 'Checking');
    await settled(S, { inc, bank, invoiceDate, paidOn, appliedOn: invoiceDate > paidOn ? invoiceDate : paidOn });
    const m = (await measureAccounts(pool, { orgId, sourceEntityId: S.entityId, ...Y25 })).get(inc);
    assert.deepEqual([m.postings, m.activity, m.cashTouched], [0, 0n, true], name);
  }
  // A document and payment both outside the year touch nothing in it.
  const S = { orgId, entityId: await company(pool, orgId, 'Outside Sample Co') };
  const inc = await acct(pool, S, 'Services'), bank = await acct(pool, S, 'Checking');
  await settled(S, { inc, bank, invoiceDate: '2024-03-01', paidOn: '2024-04-01', appliedOn: '2024-04-01' });
  assert.equal((await measureAccounts(pool, { orgId, sourceEntityId: S.entityId, ...Y25 })).get(inc).cashTouched, false);
});
