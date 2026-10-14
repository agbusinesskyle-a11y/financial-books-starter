import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { ledgerCheck, listAccounts, systemAccounts } from '../lib/data/ledger.js';
import { getAccountingSettings } from '../lib/data/accounting.js';
import { canAccess } from '../lib/domain/roles.js';
import { runReport } from '../lib/reports/engine.js';
import { evalFormula, formulaError, formatter } from '../lib/reports/customize.js';
import { listSaved, nextRun } from '../lib/reports/saved.js';
import { runDailyJobs } from '../services/jobs/index.js';
import { startApp } from './app-harness.js';

// Reports R4a — customize, save as, custom reports, defaults, scheduled emails.
const TODAY = '2026-10-12';
const outbox = [];
let failNext = false;
const mailer = { kind: 'smtp', from: 'books@samplefeed.example', async send(m) { if (failNext) { failNext = false; throw new Error('mail server said no'); } outbox.push(m); return { status: 'sent' }; } };
let app, scope, ctx, pool;
before(async () => {
  app = await startApp({ mailer });
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
const savedIdFrom = res => Number(/saved=(\d+)/.exec(res.headers.get('location'))[1]);

test('formulas: arithmetic with names, nothing else', () => {
  assert.equal(evalFormula('C1 - C2', { C1: 10, C2: 4 }), 6);
  assert.equal(evalFormula('(C1 + C2) * 2 / 4', { C1: 1, C2: 3 }), 2);
  assert.equal(evalFormula('-C1 + 1.5', { C1: 1 }), 0.5);
  assert.equal(evalFormula('C1 / C2', { C1: 1, C2: 0 }), null, 'dividing by zero gives nothing, not Infinity');
  assert.match(formulaError('C1 +', ['C1']), /ends too soon/);
  assert.match(formulaError('process.exit()', ['C1']), /Can’t read|Unknown/);
  assert.match(formulaError('net_income / revenue', ['net_income']), /Unknown name: revenue/);
  assert.equal(formulaError('C1 * 100', ['C1']), null);
  const f = formatter({ fmt_neg: 'paren', fmt_div: '1', empty: 'dash' });
  assert.equal(f.money(-123456789), '($1,234.57K)');
  assert.equal(f.money(0), '–');
  assert.equal(formatter({ fmt_dec: '0', fmt_nosym: '1' }).money(123456), '1,235');
});

test('customize: title, renamed sections, calculated column and number format, on the page and in exports', async () => {
  const custom = { period: 'this_year_to_date', run: '1', cmp_py: '1', c_title: 'Owner P&L', c_t_income: 'Sales', c_t_net_income: 'Bottom line',
    c_calc_name: 'Growth', c_calc_formula: 'C1 - C2', c_fmt_neg: 'paren', c_banded: '1', c_hide_company: '1' };
  const rep = await run('profit_and_loss', custom);
  assert.equal(rep.title, 'Owner P&L');
  assert.ok(rep.rows.some(r => r.label === 'Sales') && rep.rows.some(r => r.label === 'Total for Sales') && rep.rows.some(r => r.label === 'Bottom line'));
  assert.equal(rep.columns.at(-1).label, 'Growth');
  const ni = rep.rows.find(r => r.key === 'net_income');
  assert.equal(ni.cells.at(-1).v, ni.values[0] - ni.values[1], 'C1 - C2 in cents');
  const qs = new URLSearchParams(custom).toString();
  const page = await (await app.get(`/reports/r/profit_and_loss?${qs}`)).text();
  assert.match(page, /<h1>Owner P&amp;L<\/h1>/);
  assert.match(page, /class="report banded"/);
  assert.doesNotMatch(page, /<p class="company">/);
  assert.match(page, /Growth/);
  assert.match(page, /name="c_title" value="Owner P&amp;L"/, 'the Customize panel keeps the settings');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await (await app.get(`/reports/r/profit_and_loss.xlsx?${qs}`)).arrayBuffer()));
  assert.match(wb.worksheets[0].getColumn(2).numFmt, /\(\$#,##0\.00\)/);
  assert.equal((await app.get(`/reports/r/profit_and_loss.pdf?${qs}`)).status, 200);
  // A broken formula is dropped rather than shown.
  assert.equal((await run('profit_and_loss', { run: '1', c_calc_formula: 'C1 +' })).columns.length, 1);
});

test('save as, custom reports list, private vs shared, update, edit schedule and delete', async () => {
  const qs = 'period=last_month&run=1&basis=cash';
  const res = await app.post('/reports/r/balance_sheet/save', { q: qs, name: 'Cash BS for the bank', group: 'Bank pack', mode: 'new' });
  assert.equal(res.status, 303);
  const id = savedIdFrom(res);
  const opened = await app.get(`/reports/saved/${id}`);
  assert.match(opened.headers.get('location'), /\/reports\/r\/balance_sheet\?period=last_month&run=1&basis=cash&saved=\d+/);
  const page = await (await app.get(opened.headers.get('location'))).text();
  assert.match(page, /Custom report: Cash BS for the bank/);
  assert.match(page, /Cash basis/);
  assert.match(await (await app.get('/reports/custom')).text(), /Bank pack[\s\S]*Cash BS for the bank/);
  assert.match(await (await app.get('/reports')).text(), /Custom reports \(1\)/);

  // Private to the owner; others see it once it's shared.
  const someoneElse = { userId: 999, name: 'Pat', role: 'standard' };
  assert.equal((await listSaved(pool, { ...scope, who: someoneElse })).length, 0);
  assert.equal((await app.post(`/reports/saved/${id}/edit`, { name: 'Cash BS for the bank', group: 'Bank pack', shared: '1', freq: 'none' })).status, 303);
  assert.equal((await listSaved(pool, { ...scope, who: someoneElse })).length, 1);
  assert.equal((await listSaved(pool, { ...scope, who: someoneElse }))[0].editable, false, 'shared means look, not change');

  // Update it with new settings.
  assert.equal((await app.post('/reports/r/balance_sheet/save', { q: 'period=today&run=1', saved_id: String(id), mode: 'update' })).status, 303);
  assert.equal((await q('SELECT query FROM saved_report WHERE saved_id = $1', [id]))[0].query, 'period=today&run=1');

  // A schedule needs recipients; weekly on Monday sends next on Monday 10/19.
  const bad = await app.post(`/reports/saved/${id}/edit`, { name: 'Cash BS for the bank', freq: 'weekly', day: '1', to: '' });
  assert.equal(bad.status, 422);
  assert.equal((await app.post(`/reports/saved/${id}/edit`, { name: 'Cash BS for the bank', shared: '1', freq: 'weekly', day: '1', to: 'bank@example.com, me@example.com', format: 'xlsx' })).status, 303);
  const s = (await q('SELECT * FROM saved_report WHERE saved_id = $1', [id]))[0];
  assert.equal(s.sched_next, '2026-10-19');
  assert.equal(nextRun('monthly', 1, '2026-10-12'), '2026-11-01');
  assert.equal(nextRun('daily', 1, '2026-10-12'), '2026-10-13');

  const other = savedIdFrom(await app.post('/reports/r/trial_balance/save', { q: 'run=1', name: 'TB', mode: 'new' }));
  assert.equal((await app.post(`/reports/saved/${other}/delete`)).status, 303);
  assert.equal((await q('SELECT 1 FROM saved_report WHERE saved_id = $1', [other])).length, 0);
  assert.ok((await q(`SELECT 1 FROM audit_log WHERE table_name = 'saved_report' AND action = 'delete'`)).length, 'in the audit log');
});

test('scheduled emails go out on their day with the report attached; failures are kept and retried', async () => {
  const [s] = await q(`SELECT saved_id FROM saved_report WHERE name = 'Cash BS for the bank'`);
  await pool.query(`UPDATE saved_report SET sched_next = '2026-10-12' WHERE saved_id = $1`, [s.saved_id]);
  outbox.length = 0;
  failNext = true;
  const now = () => new Date('2026-10-12T17:00:00Z');
  const first = await runDailyJobs({ pool, mailer, now });
  assert.equal(first.reportsFailed, 1);
  let row = (await q('SELECT * FROM saved_report WHERE saved_id = $1', [s.saved_id]))[0];
  assert.match(row.last_error, /mail server said no/);
  assert.equal(row.sched_next, '2026-10-12', 'tried again next run');
  assert.match(await (await app.get('/reports/custom')).text(), /Last send failed: mail server said no/);
  const second = await runDailyJobs({ pool, mailer, now });
  assert.equal(second.reportsSent, 1);
  const mail = outbox.find(m => /Cash BS for the bank/.test(m.subject));
  assert.equal(mail.to, 'bank@example.com, me@example.com');
  assert.match(mail.attachments[0].filename, /\.xlsx$/);
  assert.equal(mail.attachments[0].content.subarray(0, 2).toString(), 'PK');
  row = (await q('SELECT * FROM saved_report WHERE saved_id = $1', [s.saved_id]))[0];
  assert.equal(row.sched_next, '2026-10-19');
  assert.equal(row.last_error, null);
  assert.equal((await runDailyJobs({ pool, mailer, now })).reportsSent, 0, 'not twice on one day');
});

test('make default: a report opens with its saved settings; the look can apply to every report; clear goes back', async () => {
  assert.equal((await app.post('/reports/r/trial_balance/default', { q: 'period=last_month&run=1&c_fmt_dec=0', scope: 'this' })).status, 303);
  let page = await (await app.get('/reports/r/trial_balance')).text();
  assert.match(page, /<option value="last_month" selected>/);
  assert.equal((await app.post('/reports/r/profit_and_loss/default', { q: 'period=last_month&run=1&c_fmt_neg=paren&c_title=Mine', scope: 'all' })).status, 303);
  page = await (await app.get('/reports/r/balance_sheet')).text();
  assert.match(page, /<option value="paren" selected>/, 'the look carries over');
  assert.doesNotMatch(page, /<h1>Mine<\/h1>/, 'but not the title or the period');
  assert.match(await (await app.get('/reports/r/balance_sheet?run=1')).text(), /<option value="minus" selected>/, 'running from the form uses what it says');
  await app.post('/reports/r/trial_balance/default', { q: '', scope: 'this', clear: '1' });
  await app.post('/reports/r/trial_balance/default', { q: '', scope: 'all', clear: '1' });
  page = await (await app.get('/reports/r/trial_balance')).text();
  assert.doesNotMatch(page, /<option value="last_month" selected>/);
  assert.ok(canAccess('reports', 'POST', '/reports/r/trial_balance/save'));
  assert.ok(canAccess('reports', 'POST', '/reports/saved/4/edit'));
  assert.ok(!canAccess('reports', 'POST', '/reports/r/trial_balance/email'));
});
