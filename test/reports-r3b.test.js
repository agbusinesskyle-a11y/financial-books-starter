import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerCheck, listAccounts, systemAccounts } from '../lib/data/ledger.js';
import { getAccountingSettings } from '../lib/data/accounting.js';
import { canAccess } from '../lib/domain/roles.js';
import { runReport } from '../lib/reports/engine.js';
import { startApp } from './app-harness.js';

// Reports R3b — exchange gains and losses, budgets, the audit log.
const TODAY = '2026-10-12';
let app, scope, ctx, pool, eur, budgetId;
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
const run = (key, query = {}) => runReport(pool, { ...scope, key, query, today: TODAY, ...ctx });
const grandOf = (report, key) => report.rows.find(r => r.kind === 'total' && r.grand)?.cells[key] ?? 0;

before(async () => {
  app = await startApp();
  pool = app.db.pool;
  scope = { orgId: app.ids.orgId, entityId: app.ids.entityId };
  // A EUR customer: invoice EUR 100 at 1.10 ($110.00), EUR 40 paid when the rate is 1.05 (a $2.00 realized loss).
  assert.equal((await app.post('/settings/currencies/on')).status, 303);
  assert.equal((await app.post('/settings/currencies', { code: 'EUR', rate: '1.10', date: '2026-10-01' })).status, 303);
  assert.equal((await app.post('/settings/currencies/EUR/rate', { rate: '1.05', date: '2026-10-11' })).status, 303);
  const res = await app.post('/customers', { displayName: 'Lyon Haras', currency: 'EUR', active: '1' });
  eur = Number(/\/customers\/(\d+)/.exec(res.headers.get('location'))[1]);
  const p = new URLSearchParams({ type: 'invoice', customer_id: String(eur), txn_date: TODAY, after_save: 'none', exchange_rate: '1.10' });
  p.append('line_item', ''); p.append('line_desc', 'Export order'); p.append('line_qty', '1'); p.append('line_rate', '100');
  assert.equal((await app.post('/txns', p)).status, 303);
  const inv = (await q(`SELECT txn_id FROM txn WHERE customer_id = $1 AND type = 'invoice'`, [eur]))[0].txn_id;
  assert.equal((await app.post('/txns', { type: 'payment', customer_id: String(eur), txn_date: TODAY, amount: '40', payment_method: 'Wire', [`apply_${inv}`]: '40' })).status, 303);
  // A 2026 budget for rent.
  const b = await app.post('/budgets', { name: 'Plan 2026', fiscalYear: '2026', subdivide: 'none', startFrom: 'blank' });
  budgetId = Number(/\/budgets\/(\d+)/.exec(b.headers.get('location'))[1]);
  const rent = app.ids.accounts.rent;
  assert.equal((await app.post(`/budgets/${budgetId}`, Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`c_${rent}_${i + 1}`, '2000'])))).status, 303);
  const [accounting, accounts, sys] = await Promise.all([getAccountingSettings(pool, scope), listAccounts(pool, scope), systemAccounts(pool, scope.orgId, scope.entityId)]);
  ctx = { accounting, accounts, retainedAccountId: sys.retained, sys };
});
after(async () => {
  const check = await ledgerCheck(pool, scope);
  assert.ok(check.balanced && check.arMatches && check.apMatches && check.inventoryMatches, JSON.stringify(check));
  await app.close();
});

test('exchange gains and losses: realized equals the Exchange Gain or Loss account; unrealized values open EUR at today’s rate', async () => {
  const realized = await run('realized_gains_losses', { period: 'this_year_to_date', run: '1' });
  assert.equal(grandOf(realized, 'amount'), -200, 'a $2.00 loss');
  const fx = ctx.accounts.find(a => a.system_key === 'fx_gain_loss');
  const pl = await run('profit_and_loss', { period: 'this_year_to_date', run: '1' });
  assert.equal(-pl.rows.find(r => r.accountId === fx.account_id).values[0], grandOf(realized, 'amount'));
  // EUR 60 still open, booked at $66.00, worth $63.00 at 1.05: a $3.00 unrealized loss.
  const unrealized = await run('unrealized_gains_losses', { period: 'today', run: '1' });
  const line = unrealized.rows.find(r => r.kind === 'line');
  assert.deepEqual([line.cells.foreign, line.cells.booked, line.cells.revalued, line.cells.amount], [6000, 6600, 6300, -300]);
  // On 10/05 the rate was 1.10 and nothing had been paid: no gain or loss yet.
  const earlier = await run('unrealized_gains_losses', { period: 'custom', to: '2026-10-05', run: '1' });
  assert.equal(earlier.rows.length, 0, 'the invoice is dated 10/12, so on 10/05 nothing is open');
});

test('budgets: the overview shows the budget, and budget vs. actuals compares it with the P&L', async () => {
  const rent = app.ids.accounts.rent;
  const overview = await run('budget_overview', { budget: String(budgetId), run: '1' });
  const row = overview.rows.find(r => r.accountId === rent);
  assert.equal(row.values.at(-1), 24000_00);
  assert.equal(row.values[0], 2000_00);
  const bva = await run('budget_vs_actuals', { budget: String(budgetId), period: 'this_fiscal_year_to_date', run: '1' });
  const pl = await run('profit_and_loss', { period: 'this_fiscal_year_to_date', run: '1' });
  const r = bva.rows.find(x => x.accountId === rent);
  assert.equal(r.values[0], pl.rows.find(x => x.accountId === rent).values[0], 'actual = the P&L');
  assert.equal(r.values[1], 2000_00 * 10, 'budget for January–October');
  assert.equal(r.cells[2].v, r.values[0] - r.values[1]);
  assert.equal(r.cells[3].pct, r.values[0] / r.values[1]);
  assert.equal(bva.rows.find(x => x.key === 'net_income').values[0], pl.totals.netIncome[0]);
  const monthly = await run('budget_vs_actuals', { budget: String(budgetId), period: 'this_fiscal_year_to_date', columns: 'months', run: '1' });
  assert.equal(monthly.columns.length, 11 * 4);
  assert.equal(monthly.rows.find(x => x.accountId === rent).values[2 * 10 + 1], 2000_00 * 10, 'the total column holds the whole period');
  assert.match(await (await app.get('/reports/r/budget_vs_actuals')).text(), /Plan 2026 \(FY2026\)/);
});

test('audit log: every change is recorded under the person who made it, with before and after; secrets never are', async () => {
  const cust = (await q('SELECT customer_id, display_name FROM customer WHERE org_id = $1 AND customer_id <> $2 ORDER BY customer_id LIMIT 1', [scope.orgId, eur]))[0];
  assert.equal((await app.post(`/customers/${cust.customer_id}`, { displayName: cust.display_name, email: 'new-address@example.com', active: '1' })).status, 303);
  assert.equal((await app.post('/reports/r/balance_sheet/note', { note: 'Checked', q: 'run=1' })).status, 303);
  const rows = await q(`SELECT actor, action, table_name, row_id, before, after FROM audit_log WHERE org_id = $1 ORDER BY audit_id`, [scope.orgId]);
  const mine = rows.filter(r => r.actor === 'operator');
  assert.ok(mine.some(r => r.table_name === 'txn' && r.action === 'insert' && r.after.type === 'invoice'), 'the invoice');
  assert.ok(mine.some(r => r.table_name === 'application' && r.action === 'insert'), 'the payment applied');
  const change = mine.find(r => r.table_name === 'customer' && r.action === 'update' && r.row_id === Number(cust.customer_id));
  assert.equal(change.after.email, 'new-address@example.com');
  assert.ok('email' in change.before);
  assert.ok(mine.some(r => r.table_name === 'report_note'), 'single-query writes are recorded too');
  assert.ok(rows.some(r => r.table_name === 'session' && r.action === 'sign_in'), 'the sign-in');
  assert.ok(rows.some(r => r.actor === 'system'), 'the sample data was seeded by the system');
  const all = JSON.stringify(rows);
  assert.doesNotMatch(all, /password_hash|totp_enc|tax_id_enc|bank_account_enc|smtp_password/, 'no secrets');

  // The audit log is stamped by the database clock (real time), not the test's fixed date, so look well past it.
  const span = { period: 'custom', from: '2026-01-01', to: '2099-12-31', run: '1' };
  const report = await run('audit_log', { ...span, audit_user: 'operator' });
  assert.ok(report.rows.length > 3);
  assert.ok(report.rows.every(r => r.cells.user === 'operator'));
  const line = report.rows.find(r => r.cells.event === 'Changed Customer' && r.cells.record === cust.display_name && /email/.test(r.cells.changes));
  assert.match(line.cells.changes, /email: .* → new-address@example\.com/);
  assert.equal(line.href, `/customers/${cust.customer_id}`);
  const invoices = await run('audit_log', { ...span, audit_area: 'transactions' });
  assert.ok(invoices.rows.length && invoices.rows.every(r => /Transaction|Payment applied|Tag/.test(r.cells.event)));
  const signIns = await run('audit_log', { ...span, audit_area: 'sign_ins' });
  assert.ok(signIns.rows.some(r => r.cells.event === 'Signed in'));
  // Admins only.
  assert.ok(!canAccess('standard', 'GET', '/reports/r/audit_log'));
  assert.ok(!canAccess('reports', 'GET', '/reports/r/audit_log.csv'));
  assert.ok(canAccess('admin', 'GET', '/reports/r/audit_log'));
  for (const ext of ['', '.csv', '.xlsx', '.pdf']) assert.equal((await app.get(`/reports/r/audit_log${ext}`)).status, 200, ext);
  for (const key of ['budget_overview', 'budget_vs_actuals', 'realized_gains_losses', 'unrealized_gains_losses']) {
    for (const ext of ['', '.csv', '.xlsx', '.pdf']) assert.equal((await app.get(`/reports/r/${key}${ext}`)).status, 200, key + ext);
  }
});
