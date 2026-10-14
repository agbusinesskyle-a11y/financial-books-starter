import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerCheck, listAccounts, systemAccounts } from '../lib/data/ledger.js';
import { getAccountingSettings, unbilledExpenses } from '../lib/data/accounting.js';
import { unbilledTime } from '../lib/data/time.js';
import { getSummary } from '../lib/data/customers.js';
import { canAccess } from '../lib/domain/roles.js';
import { ledgerLines } from '../lib/reports/ledger-data.js';
import { runReport } from '../lib/reports/engine.js';
import { REPORTS } from '../lib/reports/registry.js';
import { addDays } from '../lib/domain/dates.js';
import { escapeHtml } from '../lib/views/html.js';
import { startApp } from './app-harness.js';

// Reports R2a — who owes you, sales and customers — proven against the ledger and each customer's own page.
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
const q = async (sql, params = [scope.orgId, scope.entityId]) => (await pool.query(sql, params)).rows;
const grandOf = (report, key = 'open') => report.rows.find(r => r.kind === 'total' && r.grand)?.cells[key] ?? 0;
const arOn = async date => (await ledgerLines(pool, { ...scope, to: date })).filter(l => l.accountId === ctx.sys.ar).reduce((s, l) => s + l.amount, 0);
const customers = () => q('SELECT customer_id, display_name FROM customer WHERE org_id = $1 AND entity_id = $2 ORDER BY customer_id');

test('A/R aging equals the A/R account today and at each past month-end; buckets add up; every A/R report agrees', async () => {
  const dates = [TODAY, '2026-09-30', '2026-06-30', '2026-03-31', '2025-12-31'];
  for (const date of dates) {
    const aging = await run('ar_aging_summary', { period: 'custom', to: date, run: '1' });
    const total = aging.rows.at(-1).values;
    assert.equal(total.at(-1), await arOn(date), `aging as of ${date}`);
    assert.equal(total.slice(0, -1).reduce((s, x) => s + x, 0), total.at(-1));
    for (const r of aging.rows) assert.equal(r.values.slice(0, -1).reduce((s, x) => s + x, 0), r.values.at(-1), r.label);
    const detail = await run('ar_aging_detail', { period: 'custom', to: date, run: '1' });
    assert.equal(grandOf(detail), total.at(-1));
    const open = await run('open_invoices', { period: 'custom', to: date, run: '1' });
    assert.equal(grandOf(open), total.at(-1));
    const bal = await run('customer_balance_summary', { period: 'custom', to: date, run: '1' });
    assert.equal(bal.rows.at(-1).values[0], total.at(-1));
    const balDetail = await run('customer_balance_detail', { period: 'custom', to: date, run: '1' });
    assert.equal(grandOf(balDetail), total.at(-1));
  }
  const wide = await run('ar_aging_summary', { period: 'today', aging_days: '15', aging_periods: '6', run: '1' });
  assert.equal(wide.columns.length, 8);
  assert.equal(wide.columns[6].label, '76 and over');
  assert.equal(wide.rows.at(-1).values.at(-1), await arOn(TODAY));
  // Aging uses the due date: nothing in Current is past due, nothing in "1 - 30" is more than 30 days past due.
  const detail = await run('ar_aging_detail', { period: 'today', run: '1' });
  let section = null;
  for (const r of detail.rows) {
    if (r.kind === 'section') section = r.label;
    if (r.kind === 'line' && section === 'Current') assert.equal(r.cells.past_due, '');
    if (r.kind === 'line' && section?.startsWith('1 - 30')) assert.ok(Number(r.cells.past_due) >= 1 && Number(r.cells.past_due) <= 30);
  }
});

test('each customer: the reports show exactly what their customer page shows', async () => {
  const aging = await run('ar_aging_summary', { period: 'today', run: '1' });
  const collections = await run('collections_report', { period: 'today', run: '1' });
  let checked = 0;
  for (const c of await customers()) {
    const id = Number(c.customer_id);
    const summary = await getSummary(pool, { orgId: scope.orgId, customerId: id, today: TODAY });
    const row = aging.rows.find(r => r.partyId === id);
    assert.equal(row?.values.at(-1) ?? 0, summary.openCents, `${c.display_name} open balance`);
    const one = await run('collections_report', { period: 'today', customer: String(id), run: '1' });
    assert.equal(grandOf(one), summary.overdueCents, `${c.display_name} overdue`);
    const mine = await run('open_invoices', { period: 'today', customer: String(id), run: '1' });
    assert.ok(mine.rows.filter(r => r.kind === 'section').every(r => r.label === c.display_name));
    assert.equal(grandOf(mine), summary.openCents);
    if (summary.openCents) checked++;
  }
  assert.ok(checked > 3, 'several customers owe money');
  assert.ok(collections.rows.some(r => r.kind === 'section' && / · /.test(r.label)), 'collections shows phone/email');
  // The customer page links to its reports, already filtered to the customer.
  const c = (await customers())[0];
  const page = await (await app.get(`/customers/${c.customer_id}`)).text();
  assert.match(page, new RegExp(`/reports/r/open_invoices\\?period=today&amp;customer=${c.customer_id}`));
  const linked = await (await app.get(`/reports/r/open_invoices?period=today&customer=${c.customer_id}`)).text();
  assert.ok(linked.includes(`<option value="${c.customer_id}" selected>${escapeHtml(c.display_name)}</option>`), 'the report opens filtered to the customer');
  assert.ok(!canAccess('customers', 'GET', '/reports/r/open_invoices'), 'customers-only people don’t get report links');
});

test('sales: by customer, product, class and location all add up to the same sales, and each detail matches its summary', async () => {
  for (const basis of ['accrual', 'cash']) {
    const base = { period: 'this_year_to_date', basis, run: '1' };
    const totals = [];
    for (const g of ['customer', 'product', 'class', 'location']) {
      const sum = await run(`sales_by_${g}_summary`, base);
      const total = g === 'product' ? sum.rows.at(-1).cells[1].v : sum.rows.at(-1).values[0];
      totals.push(total);
      const det = await run(`sales_by_${g}_detail`, base);
      assert.equal(grandOf(det, 'amount'), total, `${basis} ${g} detail = summary`);
      // Every group's detail total matches its summary row.
      for (const r of det.rows.filter(x => x.kind === 'total' && !x.grand)) {
        const label = r.label.replace(/^Total for /, '');
        const row = sum.rows.find(x => x.label === label);
        assert.equal(g === 'product' ? row.cells[1].v : row.values[0], r.cells.amount, `${basis} ${g} ${label}`);
      }
    }
    assert.ok(totals[0] > 0);
    assert.ok(totals.every(t => t === totals[0]), `${basis}: ${totals.join(', ')}`);
    // Independently: the income-account lines of invoices, sales receipts and credit memos.
    const lines = await ledgerLines(pool, { ...scope, to: TODAY, basis });
    const income = new Set(ctx.accounts.filter(a => a.type === 'income').map(a => a.account_id));
    const direct = -lines.filter(l => l.date >= '2026-01-01' && ['invoice', 'sales_receipt', 'credit_memo'].includes(l.type) && income.has(l.accountId))
      .reduce((s, l) => s + l.amount, 0);
    assert.equal(totals[0], direct);
  }
  const byMonth = await run('sales_by_customer_summary', { period: 'this_year_to_date', columns: 'months', run: '1' });
  for (const r of byMonth.rows) assert.equal(r.values.slice(0, -1).reduce((s, x) => s + x, 0), r.values.at(-1), r.label);
});

test('sales by product: quantities match the invoices, and gross margin is sales less cost', async () => {
  const rep = await run('sales_by_product_summary', { period: 'this_year_to_date', run: '1' });
  const qty = await q(`SELECT l.item_id, i.name, sum(CASE WHEN t.type = 'credit_memo' THEN -l.quantity ELSE l.quantity END)::float AS qty
      FROM txn_line l JOIN txn t ON t.txn_id = l.txn_id JOIN item i ON i.item_id = l.item_id
     WHERE l.org_id = $1 AND t.entity_id = $2 AND t.type IN ('invoice', 'sales_receipt', 'credit_memo') AND t.voided_at IS NULL AND t.txn_date >= '2026-01-01' GROUP BY 1, 2`);
  let matched = 0;
  for (const r of rep.rows.filter(x => x.kind === 'account')) {
    const want = qty.find(x => Number(x.item_id) === r.groupId);
    if (want) { assert.equal(r.cells[0].qty, want.qty, r.label); matched++; }
    assert.equal(r.cells[5].v, r.cells[1].v - r.cells[4].v);
  }
  assert.ok(matched > 1);
  assert.equal(rep.rows.at(-1).cells[2].pct, 1);
});

test('income by customer adds up to net income; invoice reports agree with the invoices', async () => {
  for (const basis of ['accrual', 'cash']) {
    const ibc = await run('income_by_customer_summary', { period: 'this_year_to_date', basis, run: '1' });
    const pl = await run('profit_and_loss', { period: 'this_year_to_date', basis, run: '1' });
    assert.equal(ibc.rows.at(-1).values[2], pl.totals.netIncome[0], basis);
  }
  const list = await run('invoice_list', { period: 'this_year_to_date', run: '1' });
  const invoices = await q(`SELECT txn_id, total_cents::bigint AS total, open_cents::bigint AS open FROM txn
     WHERE org_id = $1 AND entity_id = $2 AND type = 'invoice' AND voided_at IS NULL AND txn_date BETWEEN '2026-01-01' AND '${TODAY}'`);
  const lines = list.rows.filter(r => r.kind === 'line');
  assert.equal(lines.length, invoices.length);
  for (const r of lines) assert.equal(r.cells.open, Number(invoices.find(i => Number(i.txn_id) === r.txnId).open), 'open today = the invoice’s open balance');
  const ip = await run('invoices_and_received_payments', { period: 'this_year_to_date', run: '1' });
  assert.equal(grandOf(ip, 'amount'), lines.reduce((s, r) => s + r.cells.open, 0) +
    Number((await q(`SELECT coalesce(sum(open_cents), 0) AS n FROM txn WHERE org_id = $1 AND entity_id = $2 AND type = 'late_fee' AND voided_at IS NULL AND txn_date >= '2026-01-01'`))[0].n));
});

test('deposits, estimates, unbilled charges and time, statements and transaction lists by customer', async () => {
  const dep = await run('deposit_detail', { period: 'this_year_to_date', run: '1' });
  const deposits = await q(`SELECT coalesce(sum(total_cents), 0)::bigint AS n, count(*) AS c FROM txn WHERE org_id = $1 AND entity_id = $2 AND type = 'deposit' AND voided_at IS NULL AND txn_date >= '2026-01-01'`);
  assert.equal(grandOf(dep, 'amount'), Number(deposits[0].n));
  for (const r of dep.rows.filter(x => x.kind === 'line' && !x.sub)) {
    const parts = dep.rows.slice(dep.rows.indexOf(r) + 1).filter((x, i, all) => all.slice(0, i + 1).every(y => y.sub));
    assert.equal(-parts.reduce((s, x) => s + x.cells.amount, 0), r.cells.amount, 'a deposit equals what went into it');
  }
  const est = await run('estimates_progress_invoicing', { period: 'all', run: '1' });
  for (const r of est.rows.filter(x => x.kind === 'line')) assert.equal(r.cells.invoiced + r.cells.open, r.cells.amount);
  assert.equal((await run('estimates_by_customer', { period: 'all', run: '1' })).rows.filter(r => r.kind === 'line').length,
    Number((await q(`SELECT count(*) AS n FROM txn WHERE org_id = $1 AND entity_id = $2 AND type = 'estimate' AND voided_at IS NULL`))[0].n));

  // Unbilled charges and time match what each customer's invoice editor would offer.
  const charges = await run('unbilled_charges', { period: 'today', run: '1' });
  const time = await run('unbilled_time', { period: 'today', run: '1' });
  let wantCharges = 0, wantMinutes = 0;
  for (const c of await customers()) {
    wantCharges += (await unbilledExpenses(pool, { ...scope, customerId: Number(c.customer_id) })).reduce((s, e) => s + Number(e.amount_cents), 0);
    wantMinutes += (await unbilledTime(pool, { ...scope, customerId: Number(c.customer_id) })).reduce((s, e) => s + e.minutes, 0);
  }
  assert.equal(grandOf(charges, 'amount'), wantCharges);
  assert.equal(time.rows.filter(r => r.kind === 'line').reduce((s, r) => s + Math.round(Number(r.cells.hours) * 60), 0), wantMinutes);

  const sl = await run('statement_list', { period: 'all', run: '1' });
  assert.equal(sl.rows.length, Number((await q('SELECT count(*) AS n FROM statement WHERE org_id = $1 AND entity_id = $2'))[0].n));

  const byCust = await run('transaction_list_by_customer', { period: 'this_year_to_date', run: '1' });
  const names = new Map((await customers()).map(c => [Number(c.customer_id), c.display_name]));
  let section = null, count = 0;
  for (const r of byCust.rows) {
    if (r.kind === 'section') section = r.label;
    if (r.kind === 'line') { assert.equal(names.get(r.customerId), section); count++; }
  }
  assert.equal(count, Number((await q(`SELECT count(*) AS n FROM txn WHERE org_id = $1 AND entity_id = $2 AND customer_id IS NOT NULL AND txn_date BETWEEN '2026-01-01' AND '${TODAY}'`))[0].n));
});

test('every R2a report opens, exports and drills down', async () => {
  const keys = REPORTS.filter(r => ['who_owes_you', 'sales_customers'].includes(r.group)).map(r => r.key);
  assert.ok(keys.length >= 24);
  for (const key of keys) for (const ext of ['', '.csv', '.xlsx', '.pdf']) assert.equal((await app.get(`/reports/r/${key}${ext}`)).status, 200, key + ext);
  const page = await (await app.get('/reports/r/ar_aging_summary')).text();
  const drill = /href="(\/reports\/r\/ar_aging_detail\?[^"]+)"/.exec(page)[1].replace(/&amp;/g, '&');
  assert.match(drill, /customer=\d+/);
  assert.equal((await app.get(drill)).status, 200);
  const sales = await (await app.get('/reports/r/sales_by_customer_summary')).text();
  assert.match(sales, /href="\/reports\/r\/sales_by_customer_detail\?[^"]*customer=\d+/);
  assert.ok(addDays(TODAY, 1) > TODAY);
});
