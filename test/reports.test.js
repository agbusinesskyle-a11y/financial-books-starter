import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { ledgerCheck, listAccounts, systemAccounts } from '../lib/data/ledger.js';
import { getAccountingSettings } from '../lib/data/accounting.js';
import { canAccess } from '../lib/domain/roles.js';
import { resolvePeriod, previousPeriod, timeBuckets, fiscalYearOf, PERIODS } from '../lib/reports/periods.js';
import { prorate, ledgerLines } from '../lib/reports/ledger-data.js';
import { runReport } from '../lib/reports/engine.js';
import { REPORTS } from '../lib/reports/registry.js';
import { addDays } from '../lib/domain/dates.js';
import { startApp } from './app-harness.js';

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
const rowOf = (report, pred) => report.rows.find(pred);
const valueOf = (report, label, col = 0) => rowOf(report, r => r.label === label || r.key === label)?.values?.[col];

test('report periods follow QuickBooks’ presets and the fiscal year', () => {
  assert.equal(PERIODS.length, 52);
  for (const [key] of PERIODS) if (key !== 'custom') assert.ok(resolvePeriod(key, TODAY, 1), key);
  assert.deepEqual(resolvePeriod('this_month', TODAY), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(resolvePeriod('last_quarter', TODAY), { from: '2026-07-01', to: '2026-09-30' });
  assert.deepEqual(resolvePeriod('this_fiscal_year', TODAY, 7), { from: '2026-07-01', to: '2027-06-30' });
  assert.deepEqual(resolvePeriod('last_fiscal_year_to_date', TODAY, 7), { from: '2025-07-01', to: '2025-10-12' });
  assert.deepEqual(resolvePeriod('this_week', TODAY), { from: '2026-10-11', to: '2026-10-17' }, 'weeks start Sunday');
  assert.deepEqual(resolvePeriod('last_12_months', TODAY), { from: '2025-10-01', to: '2026-09-30' });
  assert.deepEqual(fiscalYearOf('2026-03-15', 4), { start: '2025-04-01', end: '2026-03-31' });
  assert.deepEqual(previousPeriod({ from: '2026-04-01', to: '2026-06-30' }), { from: '2026-01-01', to: '2026-03-31' });
  assert.deepEqual(previousPeriod({ from: '2026-10-05', to: '2026-10-11' }), { from: '2026-09-28', to: '2026-10-04' });
  assert.equal(timeBuckets('months', '2026-01-15', '2026-10-12').length, 10);
  assert.equal(timeBuckets('quarters', '2026-01-01', '2026-12-31').map(b => b.label).join(','), 'Q1 2026,Q2 2026,Q3 2026,Q4 2026');
});

test('prorating adds up exactly and keeps signs', () => {
  assert.deepEqual(prorate(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(prorate(-90, [-100, 10]), [-100, 10]);
  assert.deepEqual(prorate(-45, [-100, 10]), [-50, 5]);
  for (const [a, w] of [[1001, [3, 7, 11]], [-77, [-5, 2, -9]], [5, [0, 0, 1]]]) assert.equal(prorate(a, w).reduce((s, x) => s + x, 0), a);
});

test('both bases balance: every set of report lines nets to zero', async () => {
  for (const basis of ['accrual', 'cash']) {
    const lines = await ledgerLines(app.db.pool, { ...scope, to: TODAY, basis });
    assert.ok(lines.length > 50, basis);
    assert.equal(lines.reduce((s, l) => s + l.amount, 0), 0, `${basis} lines balance`);
  }
});

test('the balance sheet balances, month by month, on both bases', async () => {
  for (const basis of ['accrual', 'cash']) {
    const bs = await run('balance_sheet', { period: 'last_12_months', columns: 'months', basis, run: '1' });
    assert.equal(bs.columns.length, 12);
    bs.totals.assets.forEach((a, i) => assert.equal(a, bs.totals.liabilitiesEquity[i], `${basis} column ${i}`));
    assert.ok(bs.totals.assets.some(Boolean));
  }
});

test('P&L net income equals the balance sheet’s net income and the change in equity', async () => {
  const fy = fiscalYearOf(TODAY, ctx.accounting.fiscalStartMonth);
  for (const basis of ['accrual', 'cash']) {
    const pl = await run('profit_and_loss', { period: 'this_fiscal_year_to_date', basis, run: '1' });
    const bs = await run('balance_sheet', { period: 'today', basis, run: '1' });
    assert.equal(pl.totals.netIncome[0], bs.rows.find(r => r.key === 'net_income').values[0], basis);
    // All-time profit = retained earnings + this year's net income, less anything posted straight to Retained Earnings.
    const all = await run('profit_and_loss', { period: 'all', basis, run: '1' });
    assert.equal(all.totals.netIncome[0], bs.retained[0] + bs.netIncome[0], basis);
    // Last fiscal year's profit is this year's opening retained earnings.
    const lastYear = await run('profit_and_loss', { period: 'custom', from: '', to: addDays(fy.start, -1), basis, run: '1' });
    assert.equal(lastYear.totals.netIncome[0], bs.retained[0], basis);
  }
});

test('trial balance debits equal credits, and income accounts start fresh each fiscal year', async () => {
  const tb = await run('trial_balance', { period: 'today', run: '1' });
  assert.equal(tb.totals.debit, tb.totals.credit);
  assert.ok(tb.totals.debit > 0);
  const pl = await run('profit_and_loss', { period: 'this_fiscal_year_to_date', run: '1' });
  const plSales = pl.rows.find(r => r.kind === 'account' && r.values[0] && ctx.accounts.find(a => a.account_id === r.accountId)?.type === 'income');
  const tbSales = tb.rows.find(r => r.accountId === plSales.accountId);
  assert.equal(tbSales.values[1] - tbSales.values[0], plSales.values[0]);
});

test('by-month columns add up to the total column; the comparison column is last year’s report', async () => {
  const pl = await run('pl_by_month', { period: 'this_year_to_date', run: '1', columns: 'months' });
  const n = pl.columns.length;
  assert.equal(pl.columns.at(-1).label, 'Total');
  for (const r of pl.rows.filter(x => x.values)) assert.equal(r.values.slice(0, n - 1).reduce((s, x) => s + x, 0), r.values[n - 1], r.label);

  const cmp = await run('pl_comparison');
  assert.deepEqual(cmp.columns.map(c => c.kind), ['value', 'value', 'change', 'pct_change']);
  const last = await run('profit_and_loss', { period: 'custom', from: '2025-01-01', to: '2025-10-12', run: '1' });
  assert.equal(cmp.totals.netIncome[1], last.totals.netIncome[0]);
  const ni = cmp.rows.find(r => r.key === 'net_income');
  assert.equal(ni.cells[2].v, ni.values[0] - ni.values[1]);
});

test('by-customer columns cover every line: the columns add up to the total', async () => {
  const pl = await run('pl_by_customer', { period: 'this_year_to_date', columns: 'customer', run: '1' });
  assert.ok(pl.columns.length > 3);
  assert.equal(pl.columns.at(-2).label, 'Not specified');
  const n = pl.columns.length;
  const ni = pl.totals.netIncome;
  assert.equal(ni.slice(0, n - 1).reduce((s, x) => s + x, 0), ni[n - 1]);
  const plain = await run('profit_and_loss', { period: 'this_year_to_date', run: '1' });
  assert.equal(ni[n - 1], plain.totals.netIncome[0]);
});

test('% of income: total income is 100%', async () => {
  const pl = await run('pl_percent_income');
  const inc = pl.rows.find(r => r.kind === 'total' && r.section === 'income');
  assert.equal(inc.cells[1].pct, 1);
});

test('filters narrow the lines; a customer filter matches that customer’s column', async () => {
  const byCust = await run('pl_by_customer', { period: 'this_year_to_date', columns: 'customer', run: '1' });
  const col = byCust.columns.findIndex(c => c.base?.dim?.[1] != null);
  const custId = byCust.columns[col].base.dim[1];
  const one = await run('profit_and_loss', { period: 'this_year_to_date', customer: String(custId), run: '1' });
  assert.equal(one.totals.netIncome[0], byCust.totals.netIncome[col]);
});

test('drill-down: an account’s detail total equals its amount on the P&L', async () => {
  const pl = await run('profit_and_loss', { period: 'this_year_to_date', run: '1' });
  const row = pl.rows.find(r => r.kind === 'account' && r.accountIds && r.values[0]);
  const q = pl.drill(row, pl.columns[0]);
  const detail = await run('transaction_detail_by_account', { period: 'custom', from: q.from, to: q.to, account: q.account.join(','), run: '1' });
  const totals = detail.rows.filter(r => r.kind === 'total').reduce((s, r) => s + r.cells.amount, 0);
  assert.equal(totals, row.values[0]);
  // The general ledger's ending balance for the bank account equals the balance sheet.
  const bank = ctx.accounts.find(a => a.type === 'bank');
  const gl = await run('general_ledger', { period: 'this_month', account: String(bank.account_id), run: '1' });
  const bs = await run('balance_sheet', { period: 'this_month', run: '1' });
  assert.equal(gl.rows.find(r => r.kind === 'total').cells.balance, bs.rows.find(r => r.accountId === bank.account_id).values[0]);
});

test('report pages, exports, favorites and who may see them', async () => {
  const list = await (await app.get('/reports')).text();
  for (const r of REPORTS) assert.match(list, new RegExp(`/reports/r/${r.key}"`), r.key);
  assert.match(await (await app.get('/reports?q=ledger')).text(), /General Ledger/);
  for (const r of REPORTS) {
    const res = await app.get(`/reports/r/${r.key}`);
    assert.equal(res.status, 200, r.key);
  }
  const page = await (await app.get('/reports/r/profit_and_loss')).text();
  assert.match(page, /Net Income/);
  const drill = /href="(\/reports\/r\/transaction_detail_by_account\?[^"]+)"/.exec(page)[1].replace(/&amp;/g, '&');
  const detail = await (await app.get(drill)).text();
  assert.match(detail, /Total for/);
  assert.equal((await app.get('/reports/r/nope')).status, 404);

  const csv = await (await app.get('/reports/r/balance_sheet.csv')).text();
  assert.match(csv, /Total for Assets/);
  const pdf = Buffer.from(await (await app.get('/reports/r/pl_by_month.pdf')).arrayBuffer());
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  const xlsx = Buffer.from(await (await app.get('/reports/r/profit_and_loss.xlsx')).arrayBuffer());
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsx);
  const ws = wb.worksheets[0];
  let total;
  ws.eachRow(row => { if (row.getCell(1).value === 'Total for Income') total = row.getCell(2).value; });
  assert.ok(total?.formula, 'totals are formulas');
  const pl = await run('profit_and_loss');
  assert.equal(Math.round(total.result * 100), pl.totals.income[0]);

  const fav = await app.post('/reports/favorite', { key: 'trial_balance', next: '/reports' });
  assert.equal(fav.status, 303);
  assert.match(await (await app.get('/reports')).text(), /<h2>Favorites<\/h2>[\s\S]*trial_balance/);
  await app.post('/reports/favorite', { key: 'trial_balance', next: '/reports' });
  assert.doesNotMatch(await (await app.get('/reports')).text(), /<h2>Favorites<\/h2>/);

  assert.ok(canAccess('reports', 'GET', '/reports/r/balance_sheet'));
  assert.ok(canAccess('reports', 'POST', '/reports/favorite'));
  assert.ok(!canAccess('reports', 'POST', '/journal'));
  assert.ok(!canAccess('customers', 'GET', '/reports'));
  assert.ok(!canAccess('vendors', 'GET', '/reports/r/profit_and_loss'));
});

test('cash basis: A/R and A/P hold only unapplied payments; unpaid invoices aren’t income yet', async () => {
  const one = async sql => Number((await app.db.pool.query(sql, [scope.orgId, scope.entityId])).rows[0].n);
  const bs = await run('balance_sheet', { period: 'today', basis: 'cash', run: '1' });
  const ar = bs.rows.find(r => r.accountId === ctx.sys.ar)?.values[0] ?? 0;
  const ap = bs.rows.find(r => r.accountId === ctx.sys.ap)?.values[0] ?? 0;
  assert.equal(ar, -await one(`SELECT coalesce(sum(open_cents), 0) AS n FROM txn WHERE org_id = $1 AND entity_id = $2 AND type = 'payment' AND voided_at IS NULL`));
  assert.equal(ap, -await one(`SELECT coalesce(sum(open_cents), 0) AS n FROM txn WHERE org_id = $1 AND entity_id = $2 AND type = 'bill_payment' AND voided_at IS NULL`));
  const accrual = await run('profit_and_loss', { period: 'all', basis: 'accrual', run: '1' });
  const cash = await run('profit_and_loss', { period: 'all', basis: 'cash', run: '1' });
  const openInvoices = await one(`SELECT coalesce(sum(open_cents), 0) AS n FROM txn WHERE org_id = $1 AND entity_id = $2 AND type IN ('invoice', 'late_fee') AND voided_at IS NULL`);
  assert.ok(openInvoices > 0);
  assert.ok(cash.totals.income[0] < accrual.totals.income[0]);
});
