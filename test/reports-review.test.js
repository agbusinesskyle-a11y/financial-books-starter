import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerCheck, listAccounts, systemAccounts } from '../lib/data/ledger.js';
import { getAccountingSettings } from '../lib/data/accounting.js';
import { applyCredit } from '../lib/data/writes.js';
import { runReport } from '../lib/reports/engine.js';
import { resolvePeriod, previousYear, timeBuckets, fitBuckets } from '../lib/reports/periods.js';
import { occurrences } from '../lib/reports/cashplan.js';
import { updateSaved } from '../lib/reports/saved.js';
import { runReportSchedules } from '../lib/reports/schedule.js';
import { ValidationError } from '../lib/data/writes.js';
import { startApp } from './app-harness.js';

// Fixes from the independent review of the Reports section (security, money, robustness), each pinned by a test.
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
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

// ---- security ----

test('the audit log can’t be put in a management report package', async () => {
  const res = await app.post('/reports/management', { template: 'custom' });
  const id = Number(/\/reports\/management\/(\d+)/.exec(res.headers.get('location'))[1]);
  const p = new URLSearchParams({ name: 'Sneaky', status: 'draft', period: 'last_month', basis: 'accrual', freq: 'none', action: 'add', add_key: 'audit_log' });
  p.append('sec_key', 'audit_log'); p.append('sec_title', ''); p.append('sec_query', ''); p.append('sec_note', '');
  await app.post(`/reports/management/${id}`, p);
  assert.deepEqual((await q('SELECT sections FROM mgmt_report WHERE mgmt_id = $1', [id]))[0].sections, []);
});

test('reports-only people can’t schedule emails; schedules stop when their owner no longer can send them', async () => {
  const [{ saved_id: id }] = await q(`INSERT INTO saved_report (org_id, entity_id, report_key, name, owner_key, owner_name)
    VALUES ($1, $2, 'profit_and_loss', 'Mine', '424242', 'Pat') RETURNING saved_id`, [scope.orgId, scope.entityId]);
  await assert.rejects(updateSaved(pool, { ...scope, savedId: id, today: TODAY, who: { userId: 424242, name: 'Pat', role: 'reports' },
    fields: { name: 'Mine', freq: 'daily', to: 'out@example.com' } }), ValidationError);
  // A schedule whose owner isn't an active user any more is switched off, not sent.
  await pool.query(`UPDATE saved_report SET sched_freq = 'daily', sched_to = 'out@example.com', sched_next = $2 WHERE saved_id = $1`, [id, TODAY]);
  const sent = [];
  const out = await runReportSchedules(pool, { ...scope, today: TODAY, timeZone: 'UTC', mailer: async () => ({ send: async m => sent.push(m) }) });
  assert.equal(sent.length, 0);
  assert.equal(out.failed, 1);
  const [row] = await q('SELECT sched_freq, last_error FROM saved_report WHERE saved_id = $1', [id]);
  assert.equal(row.sched_freq, 'none');
  assert.match(row.last_error, /can no longer email/);
});

test('sign-in log: failed attempts are logged under a fixed name; stale forms aren’t logged at all', async () => {
  const before = Number((await q(`SELECT count(*) AS n FROM audit_log WHERE table_name = 'session'`))[0].n);
  await app.raw('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'challenge=stale&email=Pat&password=x' });
  assert.equal(Number((await q(`SELECT count(*) AS n FROM audit_log WHERE table_name = 'session'`))[0].n), before, 'no row for a stale form');
  const page = await fetch(`${app.base}/login`);
  const cookie = (page.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ');
  const challenge = /name="challenge" value="([0-9a-f]+)"/.exec(await page.text())[1];
  await fetch(`${app.base}/login`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ challenge, email: 'boss@example.com', password: 'nope', code: '000000' }).toString() });
  const [row] = await q(`SELECT actor, action, after FROM audit_log WHERE table_name = 'session' ORDER BY audit_id DESC LIMIT 1`);
  assert.equal(row.actor, '(sign-in attempt)');
  assert.equal(row.action, 'sign_in_failed');
  assert.equal(row.after.email, 'boss@example.com');
});

test('CSV: negative amounts stay numbers; text that looks like a formula is defused', async () => {
  const csv = await (await app.get('/reports/r/statement_of_cash_flows.csv?run=1&period=this_year_to_date')).text();
  assert.match(csv, /,-\d+\.\d{2}(\r|,)/, 'a negative amount, not quoted');
  assert.doesNotMatch(csv, /'-\d/);
});

// ---- money ----

test('applying more of a payment later is dated later: cash basis and aging put each part on its own date', async () => {
  const cust = (await q(`SELECT customer_id FROM customer WHERE org_id = $1 ORDER BY customer_id DESC LIMIT 1`, [scope.orgId]))[0].customer_id;
  const inv = new URLSearchParams({ type: 'invoice', customer_id: String(cust), txn_date: '2026-08-01', after_save: 'none' });
  inv.append('line_item', ''); inv.append('line_desc', 'Review check'); inv.append('line_qty', '1'); inv.append('line_rate', '100');
  assert.equal((await app.post('/txns', inv)).status, 303);
  const invId = (await q(`SELECT txn_id FROM txn WHERE customer_id = $1 AND type = 'invoice' AND txn_date = '2026-08-01' ORDER BY txn_id DESC LIMIT 1`, [cust]))[0].txn_id;
  assert.equal((await app.post('/txns', { type: 'payment', customer_id: String(cust), txn_date: '2026-08-05', amount: '100', [`apply_${invId}`]: '50' })).status, 303);
  const pay = (await q(`SELECT txn_id FROM txn WHERE customer_id = $1 AND type = 'payment' ORDER BY txn_id DESC LIMIT 1`, [cust]))[0].txn_id;
  // 30 more on 9/10; and 5 more "on 7/1" — before the invoice existed, so it counts from 8/5.
  await applyCredit(pool, { ...scope, creditTxnId: pay, applications: [{ chargeTxnId: invId, amountCents: 3000 }], appliedOn: '2026-09-10', actor: 'test' });
  await applyCredit(pool, { ...scope, creditTxnId: pay, applications: [{ chargeTxnId: invId, amountCents: 500 }], appliedOn: '2026-07-01', actor: 'test' });
  const apps = await q('SELECT amount_cents, applied_on::text AS on FROM application WHERE charge_txn_id = $1 ORDER BY application_id', [invId]);
  assert.deepEqual(apps.map(a => [Number(a.amount_cents), a.on]), [[5000, '2026-08-05'], [3000, '2026-09-10'], [500, '2026-08-05']]);
  const cash = await run('pl_by_month', { run: '1', period: 'custom', from: '2026-08-01', to: '2026-09-30', columns: 'months', basis: 'cash', customer: String(cust) });
  assert.deepEqual(cash.totals.income.slice(0, 2), [5500, 3000], 'August 50 + 5, September 30');
  const aging = await run('ar_aging_summary', { run: '1', period: 'custom', to: '2026-08-20', customer: String(cust) });
  const ledgerAr = (await run('balance_sheet', { run: '1', period: 'custom', to: '2026-08-20', customer: String(cust) })).rows.find(r => r.accountId === ctx.sys.ar).values[0];
  assert.equal(aging.rows.at(-1).values.at(-1), ledgerAr, 'aging on 8/20 = the A/R account on 8/20');
});

test('cash basis by customer: A/R is the customer’s own unapplied payments, and nothing sits in A/R without a customer', async () => {
  // (A balance sheet for one customer can't balance: deposits put the money in the bank without a customer.)
  const cust = (await q(`SELECT customer_id FROM txn WHERE org_id = $1 AND type = 'payment' GROUP BY customer_id ORDER BY count(*) DESC LIMIT 1`, [scope.orgId]))[0].customer_id;
  const bs = await run('balance_sheet', { run: '1', period: 'today', basis: 'cash', customer: String(cust) });
  const unapplied = Number((await q(`SELECT coalesce(sum(open_cents), 0) AS n FROM txn WHERE customer_id = $1 AND type = 'payment' AND voided_at IS NULL`, [cust]))[0].n);
  assert.equal(bs.rows.find(r => r.accountId === ctx.sys.ar)?.values[0] ?? 0, 0 - unapplied);
  const byCust = await run('balance_sheet', { run: '1', period: 'today', basis: 'cash', columns: 'customer' });
  const all = await run('balance_sheet', { run: '1', period: 'today', basis: 'cash' });
  const arRow = byCust.rows.find(r => r.accountId === ctx.sys.ar);
  const none = byCust.columns.findIndex(c => c.label === 'Not specified');
  assert.equal(arRow.values[none] ?? 0, 0, 'nothing in A/R without a customer');
  assert.equal(arRow.values.at(-1) ?? all.rows.find(r => r.accountId === ctx.sys.ar).values[0], all.rows.find(r => r.accountId === ctx.sys.ar).values[0]);
});

test('balance sheet “previous period” by month: each column compares with the month before it', async () => {
  const bs = await run('balance_sheet', { run: '1', period: 'custom', from: '2026-01-01', to: '2026-04-30', columns: 'months', cmp_pp: '1' });
  const march = bs.columns.findIndex(c => c.label === '03/31/26' || c.label === '3/31/26');
  const marchPp = bs.columns[march + 1];
  assert.match(marchPp.label, /PP/);
  const feb = await run('balance_sheet', { run: '1', period: 'custom', to: '2026-02-28' });
  assert.equal(bs.totals.assets[march + 1], feb.totals.assets[0]);
});

test('inventory is valued the same on cash and accrual basis', async () => {
  const a = await run('inventory_valuation_summary', { run: '1', period: 'today' });
  const c = await run('inventory_valuation_summary', { run: '1', period: 'today', basis: 'cash' });
  assert.equal(c.rows.at(-1).cells.value, a.rows.at(-1).cells.value);
});

test('periods: previous year keeps month-ends; empty “to last month” in January; fiscal quarters', () => {
  assert.deepEqual(previousYear({ from: '2025-02-01', to: '2025-02-28' }), { from: '2024-02-01', to: '2024-02-29' });
  assert.deepEqual(previousYear({ from: '2024-02-01', to: '2024-02-29' }), { from: '2023-02-01', to: '2023-02-28' });
  const jan = resolvePeriod('this_year_to_last_month', '2026-01-15');
  assert.ok(jan.from > jan.to, 'nothing yet');
  assert.deepEqual(timeBuckets('quarters', '2026-07-01', '2027-06-30', 7).map(b => b.label), ['Q1 FY2027', 'Q2 FY2027', 'Q3 FY2027', 'Q4 FY2027']);
  assert.equal(timeBuckets('years', '2026-07-01', '2027-06-30', 7).length, 1);
  const fit = fitBuckets('days', '2024-01-01', '2026-10-12');
  assert.equal(fit.unit, 'months', '1,016 days and 145 weeks are too many columns; 34 months fit');
  assert.equal(fitBuckets('days', '2026-01-01', '2026-03-31').unit, 'days');
  assert.equal(fitBuckets('days', '2025-01-01', '2026-12-31').unit, 'weeks');
  assert.ok(fit.buckets.length <= 120);
  assert.equal(fitBuckets('days', '2010-01-01', '2026-10-12').unit, 'quarters', '202 months is too many');
  assert.equal(occurrences({ start_date: '2018-01-01', repeat: 'weekly', end_date: null }, '2026-10-12', '2026-10-31').length, 3, 'long-running weekly items still show');
  assert.deepEqual(occurrences({ start_date: '2019-01-31', repeat: 'monthly', end_date: null }, '2026-10-01', '2026-12-31'), ['2026-10-31', '2026-11-30', '2026-12-31']);
});

test('budget vs. actuals says when a filter can’t narrow the budget', async () => {
  const b = await app.post('/budgets', { name: 'Review plan', fiscalYear: '2026', subdivide: 'none', startFrom: 'blank' });
  assert.equal(b.status, 303);
  const cust = (await q('SELECT customer_id FROM customer WHERE org_id = $1 LIMIT 1', [scope.orgId]))[0].customer_id;
  const r = await run('budget_vs_actuals', { run: '1', customer: String(cust) });
  assert.ok(r.opts.notices.some(n => /isn’t split by customer/.test(n)));
});

// ---- robustness ----

test('wide PDFs finish quickly (or say they are too wide); long day ranges coarsen with a note', async () => {
  let t = Date.now();
  const pdf = await app.get('/reports/r/pl_by_month.pdf?period=this_year&cmp_py=1&run=1&columns=months');
  assert.equal(pdf.status, 200);
  assert.ok(Date.now() - t < 10_000, 'didn’t hang');
  t = Date.now();
  assert.equal((await app.get('/reports/r/pl_by_customer.pdf?period=this_year&columns=days&run=1')).status, 200);
  assert.ok(Date.now() - t < 10_000);
  assert.equal((await app.get('/reports/r/report_builder.pdf?run=1&period=this_month' + ['date', 'type', 'num', 'name', 'memo', 'account', 'split', 'due', 'terms', 'status', 'method',
    'class', 'location', 'project', 'tags', 'currency', 'approval', 'created', 'amount', 'open'].map(k => `&b_${k}=1`).join(''))).status, 200);
  const days = await run('profit_and_loss', { run: '1', period: 'custom', from: '2024-01-01', to: '2026-10-12', columns: 'days' });
  assert.ok(days.opts.notices.some(n => /shows months instead/.test(n)));
  const n = days.columns.length - 1;
  for (const r of days.rows.filter(x => x.values)) assert.equal(r.values.slice(0, n).reduce((s, v) => s + v, 0), r.values[n], r.label);
});

test('bad input: invalid and extreme dates, broken formulas and odd titles give notes, not errors', async () => {
  const bad = await run('profit_and_loss', { run: '1', period: 'custom', from: '2026-02-30', to: '2026-10-12', c_calc_formula: 'revenue / 2' });
  assert.ok(bad.opts.notices.some(n => /isn’t a date/.test(n)));
  assert.ok(bad.opts.notices.some(n => /formula/.test(n)));
  assert.equal((await app.get('/reports/r/profit_and_loss?period=custom&from=9999-12-01&to=9999-12-31&columns=months&run=1')).status, 200);
  const page = await (await app.get('/reports/r/profit_and_loss?period=custom&from=2026-02-30&run=1')).text();
  assert.match(page, /isn’t a date/);
  for (const title of ['History', "'Quoted'", '***']) assert.equal((await app.get(`/reports/r/profit_and_loss.xlsx?run=1&c_title=${encodeURIComponent(title)}`)).status, 200, title);
});

test('without JavaScript, typed dates count as custom dates; changing only the preset uses the preset', async () => {
  const typed = await run('profit_and_loss', { run: '1', period: 'this_year_to_date', from: '2026-03-01', to: '2026-03-31', shown_from: '2026-01-01', shown_to: TODAY });
  assert.equal(typed.opts.period, 'custom');
  assert.equal(typed.opts.from, '2026-03-01');
  const preset = await run('profit_and_loss', { run: '1', period: 'last_month', from: '2026-01-01', to: TODAY, shown_from: '2026-01-01', shown_to: TODAY });
  assert.equal(preset.opts.from, '2026-09-01');
});

test('drill-downs keep the number format but not the custom title; builder and lists honour project and type before the row limit', async () => {
  const pl = await run('profit_and_loss', { run: '1', c_title: 'Board P&L', c_fmt_neg: 'paren' });
  const row = pl.rows.find(r => r.accountIds?.length && r.values[0]);
  const { drillHref } = await import('../lib/reports/engine.js');
  const href = drillHref(pl, pl.drill(row, pl.columns[0]));
  assert.doesNotMatch(href, /c_title/);
  assert.match(href, /c_fmt_neg=paren/);
  const res = await app.post(`/customers/${(await q('SELECT customer_id FROM customer WHERE org_id = $1 LIMIT 1', [scope.orgId]))[0].customer_id}/projects`, { name: 'Filter check', status: 'in_progress', startDate: '2026-01-01' });
  const projectId = Number(/\/projects\/(\d+)/.exec(res.headers.get('location'))[1]);
  const list = await run('transaction_list_by_date', { run: '1', period: 'all', project: String(projectId) });
  assert.equal(list.rows.length, 0, 'a project with no transactions lists none');
  const bills = await run('report_builder', { run: '1', period: 'all', b_source: 'bills' });
  assert.ok(bills.rows.filter(r => r.kind === 'line').every(r => r.txnType === 'bill'));
});

test('forms: Enter keeps the package and the saved report; favorites remember the page; whole-number schedule days', async () => {
  const res = await app.post('/reports/management', { template: 'company_overview' });
  const id = Number(/\/reports\/management\/(\d+)/.exec(res.headers.get('location'))[1]);
  const page = await (await app.get(`/reports/management/${id}`)).text();
  assert.ok(page.indexOf('name="action" value="save"') < page.indexOf('value="remove:0"'), 'the first button in the form saves');
  const report = await (await app.get('/reports/r/profit_and_loss')).text();
  const save = report.slice(report.indexOf('/save"'));
  assert.ok(save.indexOf('value="new"') < save.indexOf('value="update"') || save.indexOf('value="update"') < 0);
  const fav = await app.post('/reports/favorite', { key: 'profit_and_loss', next: '/reports/r/profit_and_loss?run=1&c_title=Board+pack' });
  assert.equal(fav.headers.get('location'), '/reports/r/profit_and_loss?run=1&c_title=Board+pack');
  const p = new URLSearchParams({ name: 'Board', status: 'published', period: 'last_month', basis: 'accrual', freq: 'monthly', day: '2.5', to: 'a@example.com', action: 'save' });
  assert.equal((await app.post(`/reports/management/${id}`, p)).status, 422);
  const r = await run('profit_and_loss', {});
  assert.match(r.preparedOn ?? '', /|/);
});
