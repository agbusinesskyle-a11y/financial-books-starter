import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerCheck, listAccounts, systemAccounts } from '../lib/data/ledger.js';
import { getAccountingSettings } from '../lib/data/accounting.js';
import { runReport } from '../lib/reports/engine.js';
import { dashboardData, DASHBOARDS } from '../lib/reports/dashboards.js';
import { cashProjection, occurrences } from '../lib/reports/cashplan.js';
import { openItems } from '../lib/reports/receivables.js';
import { addDays } from '../lib/domain/dates.js';
import { startApp } from './app-harness.js';

// Reports R5b — dashboards, the cash flow planner, forecasts.
const TODAY = '2026-10-12';
let app, scope, ctx, pool;
before(async () => {
  app = await startApp();
  pool = app.db.pool;
  scope = { orgId: app.ids.orgId, entityId: app.ids.entityId };
  const [accounting, accounts, sys] = await Promise.all([getAccountingSettings(pool, scope), listAccounts(pool, scope), systemAccounts(pool, scope.orgId, scope.entityId)]);
  ctx = { accounting, accounts, retainedAccountId: sys.retained, sys };
});
after(async () => {
  const check = await ledgerCheck(pool, scope);
  assert.ok(check.balanced && check.arMatches && check.apMatches && check.inventoryMatches, JSON.stringify(check));
  await app.close();
});
const run = (key, query = {}) => runReport(pool, { ...scope, key, query, today: TODAY, ...ctx });

test('dashboards: every chart series equals the reports, month by month', async () => {
  const from = '2025-10-01', to = '2026-09-30';
  const d = await dashboardData(pool, { ...scope, accounts: ctx.accounts, from, to, key: 'standard' });
  const pl = await run('pl_by_month', { period: 'custom', from, to, columns: 'months', run: '1' });
  assert.equal(d.months.length, 12);
  assert.deepEqual(d.series.revenue, pl.totals.income.slice(0, 12));
  assert.deepEqual(d.series.netIncome, pl.totals.netIncome.slice(0, 12));
  const banks = ctx.accounts.filter(a => a.type === 'bank').map(a => a.account_id);
  const bs = await run('balance_sheet', { period: 'custom', to, run: '1' });
  assert.equal(d.series.cash.at(-1), bs.rows.filter(r => banks.includes(r.accountId)).reduce((s, r) => s + r.values[0], 0));
  const aging = await run('ar_aging_summary', { period: 'custom', to, run: '1' });
  assert.deepEqual(d.bars.arAging.map(b => b.value), aging.rows.at(-1).values.slice(0, -1));
  assert.ok(d.bars.topExpenses.length > 0 && d.bars.topExpenses.length <= 7);
  const rev = await dashboardData(pool, { ...scope, accounts: ctx.accounts, from, to, key: 'revenue' });
  const lastYear = await run('pl_by_month', { period: 'custom', from: '2024-10-01', to: '2025-09-30', columns: 'months', run: '1' });
  assert.deepEqual(rev.series.revenuePy, lastYear.totals.income.slice(0, 12));
  for (const [key] of DASHBOARDS) {
    const page = await (await app.get(`/reports/dashboards?d=${key}`)).text();
    assert.match(page, /<svg viewBox/, key);
    assert.match(page, /class="tile"/, key);
  }
});

test('cash flow planner: today’s cash, invoices and bills by due date, planned items, the threshold', async () => {
  const base = await cashProjection(pool, { ...scope, today: TODAY, accounts: ctx.accounts, weeks: 13 });
  const banks = ctx.accounts.filter(a => a.type === 'bank').map(a => a.account_id);
  const bs = await run('balance_sheet', { period: 'today', run: '1' });
  assert.equal(base.start, bs.rows.filter(r => banks.includes(r.accountId)).reduce((s, r) => s + r.values[0], 0));
  const ar = (await openItems(pool, { ...scope, side: 'ar', asOf: TODAY })).filter(i => !i.credit);
  const end = addDays(TODAY, 13 * 7 - 1);
  assert.equal(base.buckets[0].moneyIn, ar.filter(i => i.due <= addDays(TODAY, 6)).reduce((s, i) => s + i.open, 0), 'overdue counts in week one');
  assert.equal(base.buckets.reduce((s, b) => s + b.moneyIn, 0), ar.filter(i => i.due <= end).reduce((s, i) => s + i.open, 0));
  const noOverdue = await cashProjection(pool, { ...scope, today: TODAY, accounts: ctx.accounts, weeks: 13, overdue: false });
  assert.equal(noOverdue.buckets[0].moneyIn, ar.filter(i => i.due >= TODAY && i.due <= addDays(TODAY, 6)).reduce((s, i) => s + i.open, 0));

  // Planned: $100 out every week for three weeks, $500 in every month.
  assert.equal((await app.post('/reports/cash-flow/items', { direction: 'out', name: 'Fuel', amount: '100', date: TODAY, repeat: 'weekly', until: addDays(TODAY, 20) })).status, 303);
  assert.equal((await app.post('/reports/cash-flow/items', { direction: 'in', name: 'Hay contract', amount: '500.00', date: TODAY, repeat: 'monthly' })).status, 303);
  assert.equal((await app.post('/reports/cash-flow/items', { direction: 'in', name: '', amount: '5', date: TODAY })).status, 422);
  const plan = await cashProjection(pool, { ...scope, today: TODAY, accounts: ctx.accounts, weeks: 13 });
  assert.deepEqual(plan.buckets.slice(0, 4).map(b => b.planned), [-10000 + 50000, -10000, -10000, 0]);
  assert.equal(plan.buckets.reduce((s, b) => s + b.planned, 0), -30000 + 3 * 50000, 'Oct 12, Nov 12, Dec 12 and not Jan 12 (past 13 weeks)');
  for (const b of plan.buckets) assert.equal(b.end, b.start + b.moneyIn - b.moneyOut + b.planned + b.usual);
  assert.deepEqual(occurrences({ start_date: '2026-01-31', repeat: 'monthly', end_date: null }, '2026-01-01', '2026-04-30'), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  assert.equal((await app.post('/reports/cash-flow/threshold', { threshold: '99999999' })).status, 303);
  const page = await (await app.get('/reports/cash-flow?weeks=26&trend=1')).text();
  assert.match(page, /class="tile warn"/);
  assert.match(page, /Hay contract/);
  assert.match(page, /The usual: /);
});

test('forecast: average, same month last year and percentage adjustments, laid out like the P&L', async () => {
  const sales = (await pool.query(`SELECT account_id FROM account WHERE org_id = $1 AND entity_id = $2 AND type = 'income' ORDER BY account_id`, [scope.orgId, scope.entityId])).rows.map(r => r.account_id);
  const hist = await run('pl_by_month', { period: 'custom', from: '2025-10-01', to: '2026-09-30', columns: 'months', run: '1' });
  const acct = hist.rows.find(r => sales.includes(r.accountId) && r.values[12]);
  const rawAvg = acct.values.slice(0, 12).reduce((s, v) => s + v, 0) / 12;
  const avg = Math.round(rawAvg);
  const fc = await run('forecast', { run: '1', fc_months: '12', fc_method: 'average' });
  assert.equal(fc.columns.length, 13);
  assert.equal(fc.columns[0].label, 'Nov 2026');
  assert.equal(fc.rows.find(r => r.accountId === acct.accountId).values[0], avg);
  const up = await run('forecast', { run: '1', fc_months: '3', fc_method: 'average', fc_income: '10' });
  assert.equal(up.rows.find(r => r.accountId === acct.accountId).values[0], Math.round(rawAvg * 1.1), 'rounded once, after the adjustment');
  const ly = await run('forecast', { run: '1', fc_months: '12', fc_method: 'last_year' });
  assert.equal(ly.rows.find(r => r.accountId === acct.accountId).values[0], acct.values[1], 'Nov 2026 = Nov 2025');
  const trend = await run('forecast', { run: '1', fc_months: '6', fc_method: 'trend' });
  assert.ok(Number.isFinite(trend.totals.netIncome[6]));
  assert.equal(fc.totals.netIncome[12], fc.totals.netIncome.slice(0, 12).reduce((s, v) => s + v, 0), 'the total is the sum of the months');
  for (const ext of ['', '.csv', '.xlsx', '.pdf']) assert.equal((await app.get(`/reports/r/forecast${ext}?run=1&fc_method=trend`)).status, 200, ext);
});
