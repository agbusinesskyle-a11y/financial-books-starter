import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerCheck, listAccounts, systemAccounts } from '../lib/data/ledger.js';
import { getAccountingSettings } from '../lib/data/accounting.js';
import { canAccess } from '../lib/domain/roles.js';
import { ledgerLines } from '../lib/reports/ledger-data.js';
import { runReport } from '../lib/reports/engine.js';
import { startApp } from './app-harness.js';

// Reports R1b: cash flows, journal, transaction lists, account list, adjusted trial balance, snapshot, notes, email —
// and every customer's and vendor's balance on the reports.
const TODAY = '2026-10-12';
let app, scope, ctx;
before(async () => {
  app = await startApp();
  scope = { orgId: app.ids.orgId, entityId: app.ids.entityId };
  const [accounting, accounts, sys] = await Promise.all([getAccountingSettings(app.db.pool, scope), listAccounts(app.db.pool, scope), systemAccounts(app.db.pool, scope.orgId, scope.entityId)]);
  ctx = { accounting, accounts, retainedAccountId: sys.retained, sys };
});
after(async () => {
  const check = await ledgerCheck(app.db.pool, scope);
  assert.ok(check.balanced && check.arMatches && check.apMatches && check.inventoryMatches, JSON.stringify(check));
  await app.close();
});

const run = (key, query = {}) => runReport(app.db.pool, { ...scope, key, query, today: TODAY, ...ctx });

test('cash flows: beginning cash + net change = ending cash = the bank balances, month by month', async () => {
  const banks = ctx.accounts.filter(a => a.type === 'bank').map(a => a.account_id);
  for (const basis of ['accrual', 'cash']) {
    const cf = await run('statement_of_cash_flows', { period: 'this_year_to_date', columns: 'months', basis, run: '1' });
    for (let i = 0; i < cf.columns.length; i++) {
      const bs = await run('balance_sheet', { period: 'custom', to: cf.columns[i].base.to, basis, run: '1' });
      const bank = bs.rows.filter(r => banks.includes(r.accountId)).reduce((s, r) => s + r.values[0], 0);
      assert.equal(cf.totals.ending[i], bank, `${basis} column ${i}`);
      assert.equal(cf.totals.beginning[i] + cf.totals.net[i], cf.totals.ending[i]);
    }
    const pl = await run('profit_and_loss', { period: 'this_year_to_date', basis, run: '1' });
    assert.equal(cf.totals.netIncome.at(-1), pl.totals.netIncome[0]);
  }
});

test('journal debits equal credits; splits net to zero; transaction list and account list agree with the books', async () => {
  const j = await run('journal', { period: 'this_year_to_date', run: '1' });
  assert.equal(j.totals.debit, j.totals.credit);
  assert.ok(j.totals.debit > 0);
  for (const t of j.rows.filter(r => r.kind === 'total')) assert.equal(t.cells.debit, t.cells.credit);
  const splits = await run('transaction_list_with_splits', { period: 'this_month', run: '1' });
  assert.ok(splits.rows.length);
  assert.equal(splits.rows.reduce((s, r) => s + (r.cells.amount ?? 0), 0), 0);

  const list = await run('transaction_list_by_date', { period: 'this_year_to_date', run: '1' });
  const n = Number((await app.db.pool.query(`SELECT count(*) AS n FROM txn WHERE org_id = $1 AND entity_id = $2 AND txn_date BETWEEN '2026-01-01' AND $3`,
    [scope.orgId, scope.entityId, TODAY])).rows[0].n);
  assert.equal(list.rows.length, n);
  assert.ok(list.rows.filter(r => r.txnType === 'invoice' && r.cells.posting === 'Yes').every(r => /Accounts Receivable/.test(r.cells.account)));
  assert.ok(list.rows.filter(r => r.txnType === 'bill' && r.cells.posting === 'Yes').every(r => /Accounts Payable/.test(r.cells.account)));

  const al = await run('account_list', { period: 'today', run: '1' });
  const bs = await run('balance_sheet', { period: 'today', run: '1' });
  const checked = bs.rows.filter(x => x.kind === 'account' && x.accountId && x.accountId !== ctx.retainedAccountId && !x.parent);
  assert.ok(checked.length > 5);
  for (const r of checked) assert.equal(al.rows.find(x => x.accountId === r.accountId).cells.balance, r.values[0], r.label);
});

test('customers and vendors: every customer’s A/R and every vendor’s A/P on the reports equal what they owe or are owed', async () => {
  const all = await ledgerLines(app.db.pool, { ...scope, to: TODAY });
  const { rows: customers } = await app.db.pool.query(
    `SELECT c.customer_id, c.display_name, coalesce(sum(CASE WHEN t.type IN ('invoice', 'late_fee') THEN t.open_cents
              WHEN t.type IN ('payment', 'credit_memo') THEN -t.open_cents ELSE 0 END), 0)::bigint AS owed
       FROM customer c LEFT JOIN txn t ON t.customer_id = c.customer_id AND t.voided_at IS NULL WHERE c.org_id = $1 GROUP BY c.customer_id`, [scope.orgId]);
  assert.ok(customers.length > 3);
  for (const c of customers) {
    const ar = all.filter(l => l.accountId === ctx.sys.ar && l.customerId === Number(c.customer_id)).reduce((s, l) => s + l.amount, 0);
    assert.equal(ar, Number(c.owed), c.display_name);
  }
  const { rows: vendors } = await app.db.pool.query(
    `SELECT v.vendor_id, v.display_name, coalesce(sum(CASE WHEN t.type IN ('bill', 'item_receipt') THEN t.open_cents
              WHEN t.type IN ('vendor_credit', 'bill_payment') THEN -t.open_cents ELSE 0 END), 0)::bigint AS owed
       FROM vendor v LEFT JOIN txn t ON t.vendor_id = v.vendor_id AND t.voided_at IS NULL WHERE v.org_id = $1 GROUP BY v.vendor_id`, [scope.orgId]);
  assert.ok(vendors.length > 3);
  for (const v of vendors) {
    const ap = 0 - all.filter(l => l.accountId === ctx.sys.ap && l.vendorId === Number(v.vendor_id)).reduce((s, l) => s + l.amount, 0) || 0;
    assert.equal(ap, Number(v.owed), v.display_name);
  }
  // Filtering by a customer or vendor shows only their transactions, under their name, and their balance.
  const cust = customers.find(c => Number(c.owed) > 0);
  const td = await run('transaction_detail_by_account', { period: 'all', customer: String(cust.customer_id), run: '1' });
  const lines = td.rows.filter(r => r.kind === 'line');
  assert.ok(lines.length && lines.every(r => r.cells.name === cust.display_name));
  const bsCust = await run('balance_sheet', { period: 'today', customer: String(cust.customer_id), run: '1' });
  assert.equal(bsCust.rows.find(r => r.accountId === ctx.sys.ar).values[0], Number(cust.owed));
  const vend = vendors.find(v => Number(v.owed) > 0);
  const bsVend = await run('balance_sheet', { period: 'today', vendor: String(vend.vendor_id), run: '1' });
  assert.equal(bsVend.rows.find(r => r.accountId === ctx.sys.ap).values[0], Number(vend.owed));
  const vl = await run('transaction_list_by_date', { period: 'all', vendor: String(vend.vendor_id), run: '1' });
  assert.ok(vl.rows.length && vl.rows.every(r => r.cells.name === vend.display_name));
});

test('adjusted trial balance: adjusting entries get their own columns and everything still balances', async () => {
  const a = app.ids.accounts;
  const p = new URLSearchParams({ txn_date: TODAY, memo: 'Year-end accrual', adjusting: '1' });
  for (const [acct, debit, credit] of [[a.rent, '250', ''], [a.checking, '', '250']]) {
    p.append('je_account', String(acct)); p.append('je_debit', debit); p.append('je_credit', credit);
    p.append('je_desc', ''); p.append('je_party', ''); p.append('je_class', '');
  }
  const res = await app.post('/journal', p);
  assert.equal(res.status, 303, await res.clone().text());
  assert.match(await (await app.get(`${res.headers.get('location').replace('/ledger/', '/journal/')}/edit`)).text(), /name="adjusting" value="1" checked/);
  const atb = await run('adjusted_trial_balance', { period: 'this_fiscal_year_to_date', run: '1' });
  const t = atb.totals;
  assert.equal(t[0], t[1]); assert.equal(t[2], t[3]); assert.equal(t[4], t[5]);
  assert.equal(t[2], 25000);
  assert.equal(atb.rows.find(r => r.accountId === a.rent).values[2], 25000);
  const tb = await run('trial_balance', { period: 'today', run: '1' });
  assert.equal(t[4], tb.totals.debit);
});

test('business snapshot: monthly income and expenses add up to the year’s P&L', async () => {
  const snap = await run('business_snapshot');
  const pl = await run('profit_and_loss', { period: 'this_fiscal_year_to_date', run: '1' });
  const total = snap.rows.at(-1).values;
  assert.equal(total[0], pl.totals.income[0] + pl.totals.other_income[0]);
  assert.equal(total[2], pl.totals.cogs[0] + pl.totals.expenses[0] + pl.totals.other_expenses[0]);
  assert.ok(snap.charts.income.length && snap.charts.expenses.length);
  assert.match(await (await app.get('/reports/r/business_snapshot')).text(), /<svg viewBox/);
});

test('notes and email on a report; reports-only people can’t change them', async () => {
  const q = 'period=this_month&run=1';
  assert.equal((await app.post('/reports/r/balance_sheet/note', { note: 'Unaudited — for the bank.', q })).status, 303);
  assert.match(await (await app.get('/reports/r/balance_sheet')).text(), /Unaudited — for the bank\./);
  assert.match(await (await app.get('/reports/r/balance_sheet.csv')).text(), /Unaudited/);
  const bad = await app.post('/reports/r/balance_sheet/email', { to: 'not an address', q });
  assert.equal(bad.status, 422);
  const ok = await app.post('/reports/r/balance_sheet/email', { to: 'owner@example.com', format: 'xlsx', subject: 'BS', message: 'Here it is', q });
  assert.equal(ok.status, 303);
  assert.match(ok.headers.get('location'), /^\/reports\/r\/balance_sheet\?period=this_month/);
  assert.match(await (await app.get(ok.headers.get('location'))).text(), /recorded as sent|emailed/);
  assert.ok(!canAccess('reports', 'POST', '/reports/r/balance_sheet/note'));
  assert.ok(!canAccess('reports', 'POST', '/reports/r/balance_sheet/email'));
  for (const key of ['statement_of_cash_flows', 'journal', 'transaction_list_by_date', 'transaction_list_with_splits', 'account_list', 'adjusted_trial_balance', 'business_snapshot']) {
    for (const ext of ['', '.csv', '.xlsx', '.pdf']) assert.equal((await app.get(`/reports/r/${key}${ext}`)).status, 200, key + ext);
  }
});
