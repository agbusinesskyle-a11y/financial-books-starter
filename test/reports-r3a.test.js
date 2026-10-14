import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerCheck, listAccounts, systemAccounts } from '../lib/data/ledger.js';
import { getAccountingSettings } from '../lib/data/accounting.js';
import { getProject } from '../lib/data/projects.js';
import { projectCosts } from '../lib/data/payables-read.js';
import { runReport } from '../lib/reports/engine.js';
import { REPORTS } from '../lib/reports/registry.js';
import { startApp } from './app-harness.js';

// Reports R3a — projects, inventory, purchase orders, time, recurring, reconciliations, approvals — against the books.
const TODAY = '2026-10-12';
let app, scope, ctx, pool;
before(async () => {
  app = await startApp();
  pool = app.db.pool;
  scope = { orgId: app.ids.orgId, entityId: app.ids.entityId };
  const [accounting, accounts, sys] = await Promise.all([getAccountingSettings(pool, scope), listAccounts(pool, scope), systemAccounts(pool, scope.orgId, scope.entityId)]);
  ctx = { accounting, accounts, retainedAccountId: sys.retained, sys };
  // A project with an invoice (half paid), a credit memo and a project expense, and some time this year, all through
  // the app's own pages.
  const cust = (await pool.query('SELECT customer_id FROM customer WHERE org_id = $1 ORDER BY customer_id LIMIT 1', [scope.orgId])).rows[0].customer_id;
  const res = await app.post(`/customers/${cust}/projects`, { name: 'Report check barn', status: 'in_progress', startDate: '2026-09-01', endDate: '', description: '' });
  const projectId = Number(/\/projects\/(\d+)/.exec(res.headers.get('location'))[1]);
  const doc = (type, desc, qty, rate) => {
    const p = new URLSearchParams({ type, customer_id: String(cust), txn_date: TODAY, project_id: String(projectId) });
    p.append('line_item', ''); p.append('line_desc', desc); p.append('line_qty', qty); p.append('line_rate', rate);
    return p;
  };
  assert.equal((await app.post('/txns', doc('invoice', 'Framing', '4', '250'))).status, 303);
  assert.equal((await app.post('/txns', doc('credit_memo', 'Allowance', '1', '50'))).status, 303);
  const inv = (await pool.query(`SELECT txn_id FROM txn WHERE project_id = $1 AND type = 'invoice'`, [projectId])).rows[0].txn_id;
  assert.equal((await app.post('/txns', { type: 'payment', customer_id: String(cust), txn_date: TODAY, amount: '400.00', [`apply_${inv}`]: '400.00' })).status, 303);
  const bill = new URLSearchParams({ type: 'expense', vendor_id: String(app.ids.vendors.office), txn_date: TODAY, account_id: String(app.ids.accounts.checking), payment_method: 'Cash' });
  bill.append('cat_account', String(app.ids.accounts.repairs)); bill.append('cat_desc', 'Lumber'); bill.append('cat_amount', '300.00'); bill.append('cat_job', `p:${projectId}`);
  const exp = await app.post('/vtxns', bill);
  assert.equal(exp.status, 303, await exp.clone().text());
  for (const [date, hours] of [['2026-10-05', '2'], ['2026-10-06', '1:30'], [TODAY, '3']]) {
    assert.equal((await app.post('/time', { date, job: `c:${cust}`, hours, billable: '1', notes: 'Fencing' })).status, 303);
  }
});
after(async () => {
  const check = await ledgerCheck(pool, scope);
  assert.ok(check.balanced && check.arMatches && check.apMatches && check.inventoryMatches, JSON.stringify(check));
  await app.close();
});

const run = (key, query = {}) => runReport(pool, { ...scope, key, query, today: TODAY, ...ctx });
const q = async (sql, params = [scope.orgId, scope.entityId]) => (await pool.query(sql, params)).rows;
const grandOf = (report, key) => report.rows.find(r => r.kind === 'total' && r.grand)?.cells[key] ?? 0;

test('inventory valuation: each item and the total equal the stock records and the inventory account, today and before', async () => {
  const items = await q(`SELECT item_id, name, qty_on_hand::float AS qty, value_cents::bigint AS value FROM item WHERE org_id = $1 AND entity_id = $2 AND kind = 'inventory'`);
  assert.ok(items.length > 0);
  const val = await run('inventory_valuation_summary', { period: 'today', run: '1' });
  for (const i of items.filter(x => x.qty || Number(x.value))) {
    const r = val.rows.find(x => x.itemId === Number(i.item_id));
    assert.equal(r.cells.qtyValue, i.qty, `${i.name} quantity`);
    assert.equal(r.cells.value, Number(i.value), `${i.name} value`);
  }
  const check = await ledgerCheck(pool, scope);
  assert.equal(grandOf(val, 'value'), check.inventoryLedger);
  const inventoryAccounts = ctx.accounts.filter(a => a.type === 'inventory').map(a => a.account_id);
  for (const date of ['2026-09-30', '2026-06-30', '2026-03-31']) {
    const past = await run('inventory_valuation_summary', { period: 'custom', to: date, run: '1' });
    const bs = await run('balance_sheet', { period: 'custom', to: date, run: '1' });
    const inBooks = bs.rows.filter(r => inventoryAccounts.includes(r.accountId)).reduce((s, r) => s + r.values[0], 0);
    assert.equal(grandOf(past, 'value'), inBooks, `inventory as of ${date}`);
  }
  // The detail's ending quantity and value per item equal the summary.
  const detail = await run('inventory_valuation_detail', { period: 'this_year_to_date', run: '1' });
  for (const r of val.rows.filter(x => x.kind === 'line')) {
    const at = detail.rows.findIndex(x => x.kind === 'section' && x.label === r.cells.name);
    if (at < 0) continue;
    const end = detail.rows.findIndex((x, i) => i > at && x.kind === 'total');
    const lastLine = detail.rows[end - 1];
    assert.equal(lastLine.cells.onhand, r.cells.qty, r.cells.name);
    assert.equal(detail.rows[end].cells.value, r.cells.value, r.cells.name);
  }
  const status = await run('inventory_status', { period: 'today', run: '1' });
  assert.equal(status.rows.length, items.length);
});

test('projects: profitability matches each project’s page and the P&L filtered to the project', async () => {
  const prof = await run('project_profitability_summary', { period: 'all', run: '1' });
  const wip = await run('work_in_progress_by_project', { period: 'today', run: '1' });
  const projects = await q('SELECT p.project_id, p.name FROM project p JOIN customer c ON c.customer_id = p.customer_id WHERE p.org_id = $1 AND c.entity_id = $2');
  assert.ok(projects.length > 0);
  let withIncome = 0;
  for (const p of projects) {
    const id = Number(p.project_id);
    const page = await getProject(pool, { ...scope, projectId: id });
    const w = wip.rows.find(r => r.href === `/projects/${id}`);
    assert.equal(w.cells.invoiced, page.invoiced_cents - page.credit_cents, `${p.name} invoiced`);
    assert.equal(w.cells.costs, (await projectCosts(pool, { orgId: scope.orgId, projectId: id })).totalCents, `${p.name} costs`);
    const row = prof.rows.find(r => r.projectId === id);
    if (!row) continue;
    const pl = await run('profit_and_loss', { period: 'all', project: String(id), run: '1' });
    assert.equal(row.values[3], pl.totals.netIncome[0], `${p.name} net income`);
    if (row.values[0]) withIncome++;
  }
  assert.ok(withIncome > 0);
});

test('purchase orders, time, recurring templates, reconciliations, approvals; invalid transactions is empty', async () => {
  const list = await run('open_purchase_order_list', { period: 'today', run: '1' });
  const detail = await run('open_purchase_order_detail', { period: 'today', run: '1' });
  const byProject = await run('open_po_by_project', { period: 'today', run: '1' });
  const [{ n: openPo }] = await q(`SELECT coalesce(sum(l.amount_cents - coalesce(l.received_cents, 0)), 0)::bigint AS n FROM txn t JOIN txn_line l ON l.txn_id = t.txn_id
     WHERE t.org_id = $1 AND t.entity_id = $2 AND t.type = 'purchase_order' AND t.voided_at IS NULL AND t.closed_at IS NULL AND l.amount_cents > coalesce(l.received_cents, 0)`);
  assert.equal(grandOf(list, 'open'), Number(openPo));
  assert.equal(grandOf(detail, 'open'), Number(openPo));
  assert.equal(grandOf(byProject, 'open'), Number(openPo));

  const [{ m }] = await q(`SELECT coalesce(sum(minutes), 0)::int AS m FROM time_entry WHERE org_id = $1 AND entity_id = $2 AND entry_date BETWEEN '2026-01-01' AND '${TODAY}'`);
  for (const key of ['time_activities_by_customer', 'time_activities_by_employee', 'timesheet_detail_by_employee']) {
    const t = await run(key, { period: 'this_year_to_date', run: '1' });
    assert.equal(grandOf(t, 'hours'), (m / 60).toFixed(2), key);
  }

  const templates = await q('SELECT count(*) AS n FROM recurring_template WHERE org_id = $1 AND entity_id = $2 AND active');
  assert.equal((await run('recurring_template_list')).rows.length, Number(templates[0].n));
  const recs = await q('SELECT count(*) AS n FROM reconciliation WHERE org_id = $1 AND entity_id = $2');
  assert.equal((await run('reconciliation_reports')).rows.length, Number(recs[0].n));
  const bills = await q(`SELECT count(*) AS n FROM txn WHERE org_id = $1 AND entity_id = $2 AND type = 'bill' AND voided_at IS NULL AND txn_date BETWEEN '2026-01-01' AND '${TODAY}'`);
  assert.equal((await run('bill_approval_status', { period: 'this_year_to_date', run: '1' })).rows.filter(r => r.kind === 'line').length, Number(bills[0].n));
  assert.equal((await run('invalid_journal_transactions')).rows.length, 0, 'the sample books have no invalid transactions');
});

test('every R3a report opens and exports', async () => {
  const keys = REPORTS.filter(r => ['projects', 'inventory', 'time'].includes(r.group)
    || ['bill_approval_status', 'reconciliation_reports', 'recurring_template_list', 'invalid_journal_transactions'].includes(r.key)).map(r => r.key);
  assert.equal(keys.length, 17);
  for (const key of keys) for (const ext of ['', '.csv', '.xlsx', '.pdf']) assert.equal((await app.get(`/reports/r/${key}${ext}`)).status, 200, key + ext);
});
