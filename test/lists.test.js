import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerCheck } from '../lib/data/ledger.js';
import { LISTS, listFilters, listCompanyTxns } from '../lib/data/lists.js';
import { salesOverview, expensesOverview, listAllProjects, projectsOverview, inventoryOverview } from '../lib/data/overviews.js';
import { homeData } from '../lib/data/home.js';
import { getProject } from '../lib/data/projects.js';
import { projectCosts } from '../lib/data/payables-read.js';
import { repost } from '../lib/data/ledger.js';
import { withTransaction } from '../lib/db.js';
import { inventorySummary } from '../lib/data/inventory.js';
import { txnStatus } from '../lib/domain/status.js';
import { dateRange, parseTxnFilters } from '../lib/domain/filters.js';
import { canAccess } from '../lib/domain/roles.js';
import { GROUPS } from '../lib/views/nav.js';
import { startApp } from './app-harness.js';

// Stage N3: company-wide lists (Sales transactions, Invoices, Estimates, Expense transactions, Bills, Bill payments,
// Item receipts), all projects, and the Overview pages.
const TODAY = '2026-10-12';
let app, scope, pool;
before(async () => { app = await startApp(); pool = app.db.pool; scope = { orgId: app.ids.orgId, entityId: app.ids.entityId }; });
after(async () => {
  const check = await ledgerCheck(pool, scope);
  assert.ok(check.balanced && check.arMatches && check.apMatches && check.inventoryMatches, JSON.stringify(check));
  await app.close();
});
const list = (slug, query = {}, pageSize) => listCompanyTxns(pool, { ...scope, slug, filters: listFilters(slug, query, TODAY), today: TODAY, ...(pageSize ? { pageSize } : {}) });
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

test('every list counts and totals exactly its own transactions', async () => {
  for (const [slug, def] of Object.entries(LISTS)) {
    const r = await list(slug);
    // Signed like the balance: payments and credits subtract; estimates, purchase orders and deposits don't count.
    const sign = `CASE WHEN type IN ('invoice', 'late_fee', 'sales_receipt', 'bill', 'expense', 'check', 'item_receipt') THEN 1
      WHEN type IN ('payment', 'credit_memo', 'vendor_credit', 'bill_payment') THEN -1 ELSE 0 END`;
    const s = await one(`SELECT count(*)::int AS n, coalesce(sum((${sign}) * total_cents) FILTER (WHERE voided_at IS NULL), 0)::bigint AS total,
        coalesce(sum((${sign}) * open_cents) FILTER (WHERE voided_at IS NULL), 0)::bigint AS open
      FROM txn WHERE org_id = $1 AND entity_id = $2 AND type = ANY($3)`, [scope.orgId, scope.entityId, def.types]);
    assert.equal(r.count, s.n, slug);
    assert.equal(r.total, Number(s.total), slug);
    assert.equal(r.open, Number(s.open), slug);
    assert.ok(r.rows.every(t => def.types.includes(t.type)), slug);
    assert.ok(r.rows.length <= 100, `${slug}: 100 to a page`);
  }
  assert.ok((await list('sales-transactions')).count > 100, 'sample data spans pages');
});

test('paging walks every row once, in order', async () => {
  const seen = new Set();
  const first = await list('invoices', {}, 40);
  for (let page = 1; page <= first.pages; page++) {
    const r = await list('invoices', { page: String(page) }, 40);
    for (const t of r.rows) { assert.ok(!seen.has(t.txn_id)); seen.add(t.txn_id); }
    for (let i = 1; i < r.rows.length; i++) assert.ok(r.rows[i - 1].txn_date >= r.rows[i].txn_date);
  }
  assert.equal(seen.size, first.count);
});

test('filters: status, type, date, customer/vendor, find, sort — and junk is ignored', async () => {
  const overdue = await list('invoices', { status: 'overdue' }, 1000);
  assert.ok(overdue.rows.length > 0);
  for (const t of overdue.rows) assert.match(txnStatus(t, TODAY).text, /^Overdue/);
  const home = await homeData(pool, { ...scope, today: TODAY });
  assert.equal(overdue.open, home.ar.overdue, 'overdue invoices = Home’s overdue');
  const unpaid = await list('invoices', { status: 'unpaid' });
  const notDue = await list('invoices', { status: 'not_due' });
  assert.equal(unpaid.open, overdue.open + notDue.open);
  const billsOverdue = await list('bills', { status: 'overdue' });
  assert.equal(billsOverdue.open, home.ap.overdue);
  for (const t of (await list('invoices', { status: 'paid' }, 1000)).rows) assert.equal(t.open_cents, 0);
  for (const t of (await list('estimates', { status: 'converted' }, 1000)).rows) assert.ok(t.open_cents < t.total_cents);

  const pays = await list('sales-transactions', { type: 'payment' }, 1000);
  assert.ok(pays.rows.every(t => t.type === 'payment'));
  const { from, to } = dateRange('last_quarter', TODAY);
  const lq = await list('sales-transactions', { date: 'last_quarter' }, 1000);
  assert.ok(lq.rows.length && lq.rows.every(t => t.txn_date >= from && t.txn_date <= to));
  const y = await list('expense-transactions', { date: 'y2025' }, 1000);
  assert.ok(y.rows.every(t => t.txn_date.startsWith('2025')));

  const c = await one(`SELECT customer_id FROM txn WHERE org_id = $1 AND type = 'invoice' LIMIT 1`, [scope.orgId]);
  const mine = await list('invoices', { party: String(c.customer_id) }, 1000);
  assert.ok(mine.rows.length && mine.rows.every(t => t.customer_id === c.customer_id));
  const v = await one(`SELECT vendor_id FROM txn WHERE org_id = $1 AND type = 'bill' LIMIT 1`, [scope.orgId]);
  assert.ok((await list('bills', { party: String(v.vendor_id) }, 1000)).rows.every(t => t.vendor_id === v.vendor_id));

  const doc = mine.rows[0].doc_number;
  const found = await list('invoices', { q: doc });
  assert.ok(found.rows.some(t => t.doc_number === doc));
  assert.equal((await list('invoices', { q: '%' })).count, 0, '% is literal');

  const byAmount = await list('bills', { sort: 'amount', dir: 'asc' }, 1000);
  for (let i = 1; i < byAmount.rows.length; i++) assert.ok(byAmount.rows[i - 1].total_cents <= byAmount.rows[i].total_cents);
  const junk = listFilters('bills', { sort: 'amount; drop table txn', status: 'nope', type: 'invoice', party: '1 or 1=1', date: 'forever', page: '-3' }, TODAY);
  assert.deepEqual([junk.sort, junk.status, junk.type, junk.party, junk.date, junk.page], ['date', 'all', 'all', null, 'all', 1]);
  assert.equal(parseTxnFilters({ date: 'custom', from: '2026-05-01', to: '2026-04-01' }, TODAY).from, null, 'backwards custom range ignored');
});

test('the pages render with totals, paging and phone labels', async () => {
  for (const slug of [...Object.keys(LISTS), 'projects', 'overview/sales', 'overview/expenses', 'overview/customers', 'overview/projects', 'overview/inventory']) {
    const res = await app.get(`/${slug}`);
    assert.equal(res.status, 200, slug);
    const body = await res.text();
    assert.match(body, /class="rail"/, slug);
  }
  const inv = await (await app.get('/sales-transactions')).text();
  assert.match(inv, /1–100 of \d+/);
  assert.match(inv, /Next ›<\/a><a href="\/sales-transactions\?page=\d+">Last<\/a>/);
  assert.match(inv, /class="total-row"/);
  const p2 = await (await app.get('/sales-transactions?page=2')).text();
  assert.match(p2, /101–200 of/);
  assert.match(p2, /<a href="\/sales-transactions">First<\/a>/);
  // Menu entries are real pages now.
  const nav = GROUPS.flatMap(g => g.items);
  for (const label of ['Invoices', 'Bills', 'Bill payments', 'Expense transactions', 'Sales transactions', 'Estimates', 'Item receipts']) {
    assert.ok(nav.find(i => i.label === label).href, label);
  }
});

test('open invoices offer Receive payment; open bills offer Schedule payment', async () => {
  const body = await (await app.get('/invoices?status=unpaid')).text();
  assert.match(body, /href="\/txns\/new\?type=payment&amp;customer=\d+">Receive payment/);
  const bills = await (await app.get('/bills?status=unpaid')).text();
  assert.match(bills, /href="\/pay-bills\?vendor=\d+">Schedule payment/);
});

test('all projects: income, costs and what’s owed agree with each project page', async () => {
  // The sample has no projects: start two and tag a few invoices, a credit memo and bill lines to them.
  const cust = await one(`SELECT customer_id FROM txn WHERE org_id = $1 AND type = 'invoice' AND open_cents > 0 LIMIT 1`, [scope.orgId]);
  const mk = async (name, status) => (await one(`INSERT INTO project (org_id, customer_id, name, status) VALUES ($1, $2, $3, $4) RETURNING project_id`,
    [scope.orgId, cust.customer_id, name, status])).project_id;
  const [a, b] = [await mk('Barn rebuild', 'in_progress'), await mk('Fence line', 'completed')];
  await pool.query(`UPDATE txn SET project_id = $2 WHERE txn_id IN (SELECT txn_id FROM txn WHERE customer_id = $1 AND type IN ('invoice', 'credit_memo') ORDER BY txn_id LIMIT 3)`, [cust.customer_id, a]);
  await pool.query(`UPDATE txn SET project_id = $2 WHERE txn_id IN (SELECT txn_id FROM txn WHERE customer_id = $1 AND type = 'invoice' AND project_id IS NULL ORDER BY txn_id DESC LIMIT 2)`, [cust.customer_id, b]);
  const tagged = (await pool.query(`UPDATE txn_line SET project_id = $1 WHERE txn_id IN (SELECT txn_id FROM txn WHERE org_id = $2 AND type IN ('bill', 'expense') ORDER BY txn_id LIMIT 2)
    RETURNING txn_id`, [a, scope.orgId])).rows;
  // Re-post so the ledger carries the project on those lines (as saving through the app does).
  for (const id of new Set([...tagged.map(r => r.txn_id), ...(await pool.query('SELECT txn_id FROM txn WHERE project_id IN ($1, $2)', [a, b])).rows.map(r => r.txn_id)])) {
    await withTransaction(pool, tx => repost(tx, scope.orgId, id));
  }
  const all = await listAllProjects(pool, { ...scope });
  assert.equal(all.length, 2);
  assert.ok(all.find(p => p.project_id === a).cost_cents > 0);
  for (const p of all) {
    const one = await getProject(pool, { ...scope, projectId: p.project_id });
    // Costs as on the Project Profitability report: everything posted to cost and expense accounts for the project.
    const costs = { totalCents: Number((await pool.query(`SELECT coalesce(sum(ps.amount_cents), 0)::bigint AS c FROM posting ps JOIN account ac ON ac.account_id = ps.account_id
      WHERE ps.project_id = $1 AND ac.type IN ('cost_of_goods_sold', 'expense', 'other_expense')`, [p.project_id])).rows[0].c) };
    const purchases = await projectCosts(pool, { orgId: scope.orgId, projectId: p.project_id });
    assert.ok(p.cost_cents >= Number(purchases.totalCents) || purchases.rows.some(r => r.category), 'purchases charged to it are included');
    assert.equal(p.income_cents, Number(one.invoiced_cents) - Number(one.credit_cents), p.name);
    assert.equal(p.open_cents, Number(one.open_cents), p.name);
    assert.equal(p.cost_cents, Number(costs.totalCents), p.name);
    assert.equal(p.profit_cents, p.income_cents - p.cost_cents);
  }
  const ov = await projectsOverview(pool, scope);
  assert.equal(ov.count, all.length);
  assert.equal(ov.inProgress + ov.completed + ov.canceled, all.length);
  assert.ok((await listAllProjects(pool, { ...scope, status: 'completed' })).every(p => p.status === 'completed'));
});

test('overviews agree with Home and the books', async () => {
  const home = await homeData(pool, { ...scope, today: TODAY });
  const s = await salesOverview(pool, { ...scope, today: TODAY });
  assert.equal(s.ar.open, home.ar.open);
  assert.equal(s.ar.overdue, home.ar.overdue);
  assert.equal(s.ar.overdue + s.ar.notDue + s.ar.credits, s.ar.open);
  assert.equal(s.months.at(-1).value, home.months.at(-1).revenue);
  const e = await expensesOverview(pool, { ...scope, today: TODAY });
  assert.equal(e.ap.open, home.ap.open);
  assert.equal(e.ap.overdue, home.ap.overdue);
  assert.equal(e.months.at(-1).value, home.months.at(-1).expenses);
  const inv = await inventoryOverview(pool, scope);
  assert.equal(inv.value, (await inventorySummary(pool, scope)).filter(i => i.active).reduce((t, i) => t + Number(i.value_cents), 0));
});

test('who can open which list', () => {
  for (const p of ['/sales-transactions', '/invoices', '/estimates', '/projects', '/overview/sales', '/overview/customers', '/overview/projects']) {
    assert.ok(canAccess('customers', 'GET', p), p);
    assert.ok(!canAccess('vendors', 'GET', p), p);
  }
  for (const p of ['/expense-transactions', '/bills', '/bill-payments', '/item-receipts', '/overview/expenses']) {
    assert.ok(canAccess('vendors', 'GET', p), p);
    assert.ok(!canAccess('customers', 'GET', p), p);
  }
  assert.ok(!canAccess('customers', 'GET', '/overview/inventory'));
  assert.ok(canAccess('reports', 'GET', '/bills'));
  assert.ok(!canAccess('reports', 'POST', '/bills'));
});
