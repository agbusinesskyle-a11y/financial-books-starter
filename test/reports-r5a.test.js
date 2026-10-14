import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerCheck, listAccounts, systemAccounts } from '../lib/data/ledger.js';
import { getAccountingSettings } from '../lib/data/accounting.js';
import { runReport } from '../lib/reports/engine.js';
import { measures } from '../lib/reports/kpis.js';
import { runDailyJobs } from '../services/jobs/index.js';
import { startApp } from './app-harness.js';

// Reports R5a — KPI scorecard, custom KPIs, management reports.
const TODAY = '2026-10-12';
const outbox = [];
const mailer = { kind: 'smtp', from: 'books@samplefeed.example', async send(m) { outbox.push(m); return { status: 'sent' }; } };
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
const q = async (sql, params = [scope.orgId, scope.entityId]) => (await pool.query(sql, params)).rows;

test('KPIs equal the figures on the reports they come from', async () => {
  const range = { from: '2026-09-01', to: '2026-09-30' };
  const [m] = await measures(pool, { ...scope, accounts: ctx.accounts, basis: 'accrual', ranges: [range] });
  const base = { period: 'custom', from: range.from, to: range.to, run: '1' };
  const pl = await run('profit_and_loss', base);
  assert.equal(m.revenue, pl.totals.income[0]);
  assert.equal(m.net_income, pl.totals.netIncome[0]);
  assert.equal(m.gross_profit, pl.totals.income[0] - pl.totals.cogs[0]);
  assert.equal(m.gross_margin, m.gross_profit / m.revenue);
  assert.equal(m.operating_expenses, pl.totals.expenses[0]);
  const cf = await run('statement_of_cash_flows', base);
  assert.equal(m.operating_cash_flow, cf.totals.operating[0]);
  assert.equal(m.cash_on_hand, cf.totals.ending[0]);
  const aging = await run('ar_aging_summary', { period: 'custom', to: range.to, run: '1' });
  assert.equal(m.ar_balance, aging.rows.at(-1).values.at(-1));
  const apAging = await run('ap_aging_summary', { period: 'custom', to: range.to, run: '1' });
  assert.equal(m.ap_balance, apAging.rows.at(-1).values.at(-1));
  const [{ n, v }] = await q(`SELECT count(*)::int AS n, coalesce(sum(total_cents), 0)::bigint AS v FROM txn WHERE org_id = $1 AND entity_id = $2 AND type = 'invoice'
    AND voided_at IS NULL AND txn_date BETWEEN '2026-09-01' AND '2026-09-30'`);
  assert.deepEqual([m.invoice_count, m.invoice_value], [n, Number(v)]);
  const income = await run('income_by_customer_summary', base);
  assert.ok(m.active_customers > 0 && m.active_customers <= income.rows.filter(r => r.groupId).length);
  assert.equal(m.revenue_per_customer, Math.round(m.revenue / m.active_customers));
  const bs = await run('balance_sheet', { period: 'custom', to: range.to, run: '1' });
  const cur = bs.rows.find(r => r.label === 'Total for Current Assets').values[0];
  const curLiab = bs.rows.find(r => r.label === 'Total for Current Liabilities').values[0];
  assert.equal(m.current_ratio, cur / curLiab);

  const card = await run('kpi_scorecard', { period: 'last_month', kpi_compare: 'py', run: '1' });
  const rev = card.rows.find(r => r.kpi === 'revenue');
  const lastYear = await run('profit_and_loss', { period: 'custom', from: '2025-09-01', to: '2025-09-30', run: '1' });
  assert.equal(rev.values[1], lastYear.totals.income[0], 'compared with the same month last year');
  assert.equal(rev.cells[2].v, rev.values[0] - rev.values[1]);
  assert.ok(['good', 'bad', null].includes(rev.tone));
  assert.match(card.columns[1].label, /Previous year \(Sep 1, 2025/);
});

test('custom KPIs: checked formulas, worked out from the built-in measures, shown and removed', async () => {
  const bad = await app.post('/reports/kpis', { name: 'Broken', unit: 'percent', formula: 'net_income / sales * 100' });
  assert.equal(bad.status, 422);
  assert.match(await bad.text(), /Unknown name: sales/);
  assert.equal((await app.post('/reports/kpis', { name: 'Profit per invoice', category: 'Mine', unit: 'money', direction: 'up', formula: 'net_income / invoice_count' })).status, 303);
  assert.equal((await app.post('/reports/kpis', { name: 'Profit per invoice', unit: 'money', formula: 'net_income' })).status, 422, 'names are unique');
  const card = await run('kpi_scorecard', { period: 'last_month', run: '1' });
  const row = card.rows.find(r => r.label === 'Profit per invoice');
  const m = card.measures.current;
  assert.equal(row.values[0], Math.round((m.net_income / 100 / m.invoice_count) * 100));
  assert.ok(card.rows.some(r => r.kind === 'section' && r.label === 'Mine'));
  const page = await (await app.get('/reports/r/kpi_scorecard')).text();
  assert.match(page, /Your KPIs[\s\S]*Profit per invoice/);
  assert.match(page, /href="\/reports\/kpis\/new">Create KPI/);
  for (const ext of ['.csv', '.xlsx', '.pdf']) assert.equal((await app.get(`/reports/r/kpi_scorecard${ext}`)).status, 200, ext);
  const [{ kpi_id: id }] = await q('SELECT kpi_id FROM kpi WHERE org_id = $1 AND entity_id = $2', [scope.orgId, scope.entityId]);
  assert.equal((await app.post(`/reports/kpis/${id}/delete`)).status, 303);
  assert.equal((await q('SELECT 1 FROM kpi WHERE org_id = $1 AND entity_id = $2')).length, 0);
});

test('management reports: from a template, edit the sections, one PDF, publish and email on a schedule', async () => {
  const res = await app.post('/reports/management', { template: 'company_overview' });
  assert.equal(res.status, 303);
  const id = Number(/\/reports\/management\/(\d+)/.exec(res.headers.get('location'))[1]);
  let [mg] = await q('SELECT * FROM mgmt_report WHERE mgmt_id = $1', [id]);
  assert.deepEqual(mg.sections.map(s => s.key), ['kpi_scorecard', 'profit_and_loss', 'balance_sheet', 'statement_of_cash_flows']);
  const page = await (await app.get(`/reports/management/${id}`)).text();
  assert.match(page, /name="sec_key" value="kpi_scorecard"/);

  const form = sections => {
    const p = new URLSearchParams({ name: 'Board pack', status: 'draft', period: 'last_quarter', basis: 'accrual', cover_title: 'Q3 board pack', cover_subtitle: 'Sample Feed Co.',
      prepared_by: 'operator', intro: 'A good quarter.', closing: 'Questions to the owner.', freq: 'none', day: '1', to: '' });
    for (const s of sections) { p.append('sec_key', s.key); p.append('sec_title', s.title ?? ''); p.append('sec_query', s.query ?? ''); p.append('sec_note', s.note ?? ''); }
    return p;
  };
  // Add an A/R aging section, move it up, remove the cash flow statement.
  let p = form(mg.sections); p.set('action', 'add'); p.set('add_key', 'ar_aging_summary');
  assert.equal((await app.post(`/reports/management/${id}`, p)).status, 303);
  [mg] = await q('SELECT * FROM mgmt_report WHERE mgmt_id = $1', [id]);
  assert.equal(mg.sections.at(-1).key, 'ar_aging_summary');
  p = form(mg.sections); p.set('action', `up:${mg.sections.length - 1}`);
  await app.post(`/reports/management/${id}`, p);
  [mg] = await q('SELECT * FROM mgmt_report WHERE mgmt_id = $1', [id]);
  p = form(mg.sections); p.set('action', `remove:${mg.sections.findIndex(s => s.key === 'statement_of_cash_flows')}`);
  await app.post(`/reports/management/${id}`, p);
  [mg] = await q('SELECT * FROM mgmt_report WHERE mgmt_id = $1', [id]);
  assert.deepEqual(mg.sections.map(s => s.key), ['kpi_scorecard', 'profit_and_loss', 'balance_sheet', 'ar_aging_summary']);
  assert.equal(mg.period, 'last_quarter');
  assert.equal(mg.cover_title, 'Q3 board pack');

  const pdf = await app.get(`/reports/management/${id}.pdf`);
  assert.equal(pdf.status, 200);
  const body = Buffer.from(await pdf.arrayBuffer());
  assert.equal(body.subarray(0, 4).toString(), '%PDF');
  const pages = (body.toString('latin1').match(/\/Type \/Page[^s]/g) ?? []).length;
  assert.ok(pages >= 7, `cover, contents, introduction, four reports, notes: ${pages} pages`);

  // A schedule needs the report published.
  p = form(mg.sections); p.set('action', 'save'); p.set('freq', 'monthly'); p.set('day', '1'); p.set('to', 'board@example.com');
  assert.equal((await app.post(`/reports/management/${id}`, p)).status, 422);
  p.set('status', 'published');
  assert.equal((await app.post(`/reports/management/${id}`, p)).status, 303);
  [mg] = await q('SELECT * FROM mgmt_report WHERE mgmt_id = $1', [id]);
  assert.equal(mg.sched_next, '2026-11-01');
  await pool.query(`UPDATE mgmt_report SET sched_next = '2026-10-12' WHERE mgmt_id = $1`, [id]);
  outbox.length = 0;
  const summary = await runDailyJobs({ pool, mailer, now: () => new Date('2026-10-12T17:00:00Z') });
  assert.ok(summary.reportsSent >= 1);
  const mail = outbox.find(o => o.subject === 'Board pack');
  assert.equal(mail.to, 'board@example.com');
  assert.match(mail.attachments[0].filename, /^Board-pack-2026-10-12\.pdf$/);
  assert.match(await (await app.get('/reports/management')).text(), /Board pack[\s\S]*Published/);
  assert.equal((await app.post(`/reports/management/${id}/delete`)).status, 303);
});
