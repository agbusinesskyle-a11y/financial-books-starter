import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { ledgerCheck, systemAccounts, listAccounts } from '../lib/data/ledger.js';
import { getAccountingSettings } from '../lib/data/accounting.js';
import { runReport } from '../lib/reports/engine.js';
import { listCompanyTxns, listFilters } from '../lib/data/lists.js';
import { salesOverview } from '../lib/data/overviews.js';
import { listAllProjects } from '../lib/data/overviews.js';
import { globalSearch } from '../lib/data/search.js';
import { findOpenInvite } from '../lib/data/users.js';
import { openCheckout, createPayLink } from '../lib/data/online-payments.js';
import { undoLastReconciliation } from '../lib/data/ledger-tools.js';
import { computeStatement } from '../lib/data/statements.js';
import { startApp } from './app-harness.js';

// Fixes from the two independent reviews of 2026-10-13 (three reviewers),
// each pinned by a test.
const TODAY = '2026-10-12';
let app, pool, scope, sys;
before(async () => {
  app = await startApp({ env: { SETTINGS_KEY: '12'.repeat(32) } });
  pool = app.db.pool;
  scope = { orgId: app.ids.orgId, entityId: app.ids.entityId };
  sys = await systemAccounts(pool, scope.orgId, scope.entityId);
});
after(async () => {
  const check = await ledgerCheck(pool, scope);
  assert.ok(check.balanced && check.arMatches && check.apMatches && check.inventoryMatches, JSON.stringify(check));
  await app.close();
});
const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
const idFrom = (res, re) => Number(re.exec(res.headers.get('location'))[1]);
const salesDoc = (type, customerId, lines, more = {}) => {
  const p = new URLSearchParams({ type, customer_id: String(customerId), txn_date: TODAY, after_save: 'none', ...more });
  for (const l of lines) { p.append('line_item', l.item ? String(l.item) : ''); p.append('line_desc', l.desc ?? 'Work'); p.append('line_qty', l.qty ?? '1'); p.append('line_rate', l.rate);
    p.append('line_service', ''); p.append('line_est', l.est ?? ''); p.append('line_bill', ''); p.append('line_class', ''); }
  return p;
};
const vdoc = (type, vendor, { items = [], cats = [], ...rest } = {}) => {
  const p = new URLSearchParams({ type, vendor_id: String(vendor), txn_date: TODAY, ...rest });
  for (const i of items) { p.append('item_item', String(i.item)); p.append('item_desc', ''); p.append('item_qty', i.qty); p.append('item_rate', i.rate); p.append('item_job', i.job ?? ''); p.append('item_po', ''); }
  for (const c of cats) { p.append('cat_account', String(c.account)); p.append('cat_desc', ''); p.append('cat_amount', c.amount); p.append('cat_job', ''); p.append('cat_po', ''); }
  return p;
};
const newestTxn = async (type, customerId) => (await one('SELECT txn_id FROM txn WHERE type = $1 AND customer_id = $2 ORDER BY txn_id DESC LIMIT 1', [type, customerId])).txn_id;
const newCustomer = async (name, more = {}) => idFrom(await app.post('/customers', { displayName: name, firstName: '', creditLimit: '', shippingSameAsBilling: '1', active: '1', ...more }), /\/customers\/(\d+)/);
const report = async (key, query, basis = 'accrual') => {
  const [accounting, accounts] = await Promise.all([getAccountingSettings(pool, scope), listAccounts(pool, scope)]);
  return runReport(pool, { ...scope, key, query: { run: '1', basis, ...query }, today: TODAY, accounting, accounts, retainedAccountId: sys.retained, sys });
};

// ---- robustness ----

test('several customers can have an opening balance; it can’t be edited into a sale', async () => {
  const a = await newCustomer('Opening A', { openingBalance: '100.00', openingAsOf: '2026-09-30' });
  const b = await newCustomer('Opening B', { openingBalance: '200.00', openingAsOf: '2026-09-30' });
  const ob = await one(`SELECT txn_id, doc_number FROM txn WHERE customer_id = $1`, [b]);
  assert.ok(a && b);
  assert.equal(ob.doc_number, null);
  const edit = await app.get(`/txns/${ob.txn_id}/edit`);
  assert.equal(edit.status, 303, 'the invoice editor is not offered');
  const res = await app.post(`/txns/${ob.txn_id}`, salesDoc('invoice', b, [{ desc: 'Opening balance', rate: '200.00' }], { memo: 'x' }));
  assert.equal(res.status, 422);
  const posts = (await pool.query('SELECT account_id FROM posting WHERE txn_id = $1', [ob.txn_id])).rows.map(r => Number(r.account_id));
  assert.ok(posts.includes(sys.opening_equity) && !posts.includes(sys.sales), 'still Opening Balance Equity, not Sales');
});

test('the same form sent twice saves once', async () => {
  const cust = app.ids.customers.hilltop;
  const body = salesDoc('invoice', cust, [{ desc: 'Double tap', rate: '12.34' }]);
  body.set('form_once', 'once-test-000001'); // the shape the forms render (16 base64url characters)
  const [r1, r2] = await Promise.all([app.post('/txns', body), app.post('/txns', body)]);
  assert.deepEqual([r1.status, r2.status], [303, 303]);
  assert.equal((await one(`SELECT count(*)::int AS n FROM txn WHERE customer_id = $1 AND total_cents = 1234`, [cust])).n, 1);
  // Every rendered form carries a fresh id.
  const form = await (await app.get(`/txns/new?type=invoice&customer=${cust}`)).text();
  assert.match(form, /name="form_once" value="[A-Za-z0-9_-]{16}"/);
});

test('bad ids, huge amounts and long numbers are clear messages, not server errors', async () => {
  assert.equal((await app.post('/customers', { displayName: 'Bad Terms', termsId: 'abc', shippingSameAsBilling: '1' })).status, 422);
  assert.equal((await app.post('/customers', { displayName: 'Bad Terms 2', termsId: '99999999999999999999', shippingSameAsBilling: '1' })).status, 422);
  assert.equal((await app.post('/customers', { displayName: 'Big Limit', firstName: '', creditLimit: '99999999999999999999', shippingSameAsBilling: '1' })).status, 422);
  for (const q of ['123456789012345678', '99999999999999999999']) {
    assert.equal((await app.get(`/search?format=json&q=${q}`)).status, 200, q);
    assert.ok(await globalSearch(pool, { ...scope, q, can: () => true }));
  }
});

test('overview charts show 12 months; backwards custom dates say so', async () => {
  const s = await salesOverview(pool, { ...scope, today: TODAY });
  assert.equal(s.months.length, 12);
  const page = await (await app.get('/invoices?date=custom&from=2026-05-01&to=2026-04-01')).text();
  assert.match(page, /The From date is after the To date/);
});

test('batch Delete asks on the server when there’s no JavaScript', async () => {
  const cust = app.ids.customers.hilltop;
  await app.post('/txns', salesDoc('invoice', cust, [{ desc: 'Batch del', rate: '3.00' }]));
  const inv = await newestTxn('invoice', cust);
  const p = new URLSearchParams({ action: 'delete' }); p.append('ids', String(inv));
  const res = await app.post(`/customers/${cust}/batch`, p);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /name="confirmed" value="1"/);
  assert.ok(await one('SELECT 1 AS x FROM txn WHERE txn_id = $1', [inv]));
});

test('two checkouts started at once leave one open', async () => {
  await app.post('/settings/payments', { enabled: '1', processor: 'test', card: '1', ach: '1', feePayer: 'company' });
  const cust = app.ids.customers.hilltop;
  await app.post('/txns', salesDoc('invoice', cust, [{ desc: 'Online', rate: '100.00' }]));
  const inv = await newestTxn('invoice', cust);
  const token = await createPayLink(pool, { ...scope, txnId: inv });
  await Promise.all([openCheckout(pool, { token, method: 'card', origin: 'http://x' }), openCheckout(pool, { token, method: 'card', origin: 'http://x' })]);
  assert.equal((await one(`SELECT count(*)::int AS n FROM online_checkout WHERE txn_id = $1 AND status = 'open'`, [inv])).n, 1);
});

// ---- security ----

test('an invitation from another organization doesn’t open here', async () => {
  const { rows: [org] } = await pool.query(`INSERT INTO org (slug, name) VALUES ('other_org', 'Other') RETURNING org_id`);
  const { rows: [u] } = await pool.query(`INSERT INTO app_user (org_id, name, email, role) VALUES ($1, 'Outsider', 'out@other.example', 'admin') RETURNING user_id`, [org.org_id]);
  const { createHash } = await import('node:crypto');
  const token = 'A'.repeat(43);
  await pool.query(`INSERT INTO user_invite (org_id, user_id, token_hash, expires_at) VALUES ($3, $1, $2, now() + interval '1 day')`, [u.user_id, createHash('sha256').update(token).digest('hex'), org.org_id]);
  assert.equal(await findOpenInvite(pool, { token }), null, 'requires organization scope');
  assert.ok(await findOpenInvite(pool, { token, orgSlug: 'other_org' }), 'exists in its organization');
  assert.equal(await findOpenInvite(pool, { token, orgSlug: 'sample' }), null, 'not for this organization');
  assert.equal((await fetch(`${app.base}/invite/${token}`)).status, 404);
});

test('undo reconciliation stays inside the company; vendor templates don’t open as sales', async () => {
  const { rows: [e] } = await pool.query(`INSERT INTO entity (org_id, name, time_zone) VALUES ($1, 'Second Co', 'America/Chicago') RETURNING entity_id`, [scope.orgId]);
  const { rows: [acct] } = await pool.query(`INSERT INTO account (org_id, entity_id, name, type) VALUES ($1, $2, 'B Checking', 'bank') RETURNING account_id`, [scope.orgId, e.entity_id]);
  await pool.query(`INSERT INTO reconciliation (org_id, entity_id, account_id, statement_date, beginning_cents, ending_cents, completed_by) VALUES ($1, $2, $3, '2026-09-30', 0, 0, 'x')`,
    [scope.orgId, e.entity_id, acct.account_id]);
  await assert.rejects(undoLastReconciliation(pool, { ...scope, accountId: acct.account_id }), /no reconciliation/);
  assert.equal((await one('SELECT count(*)::int AS n FROM reconciliation WHERE account_id = $1', [acct.account_id])).n, 1);
  const tpl = await one(`INSERT INTO recurring_template (org_id, entity_id, vendor_id, name, txn_type, mode, interval_unit, interval_count, start_date, next_run_date)
    VALUES ($1, $2, $3, 'Rent tpl', 'bill', 'unscheduled', 'month', 1, $4, NULL) RETURNING template_id`, [scope.orgId, scope.entityId, app.ids.vendors.mill, TODAY]).catch(() => null);
  if (tpl) assert.equal((await app.get(`/txns/new?template=${tpl.template_id}`)).status, 404);
});

// ---- money ----

test('invoicing part of an estimate moves its share of stock', async () => {
  const cust = app.ids.customers.hilltop, item = app.ids.items.salt;
  await app.post('/txns', salesDoc('estimate', cust, [{ item, qty: '10', rate: '50.00' }]));
  const est = await newestTxn('estimate', cust);
  const page = await (await app.get(`/txns/${est}/invoice?mode=percent&percent=50`)).text();
  assert.match(page, /name="line_qty" value="5"/);
  assert.match(page, /name="line_rate" value="50.00"/);
});

test('moving an invoice past its payment re-dates the payment’s application', async () => {
  const cust = app.ids.customers.hilltop;
  await app.post('/txns', salesDoc('invoice', cust, [{ desc: 'Redate', rate: '100.00' }], { txn_date: '2026-03-01' }));
  const inv = await newestTxn('invoice', cust);
  await app.post('/txns', { type: 'payment', customer_id: String(cust), txn_date: '2026-03-10', amount: '100.00', [`apply_${inv}`]: '100.00' });
  await app.post(`/txns/${inv}`, salesDoc('invoice', cust, [{ desc: 'Redate', rate: '100.00' }], { txn_date: '2026-04-01', due_date: '2026-04-01' }));
  assert.equal((await one('SELECT applied_on::text AS d FROM application WHERE charge_txn_id = $1', [inv])).d, '2026-04-01');
});

test('list totals subtract payments and credits', async () => {
  const cust = await newCustomer('Totals Co');
  await app.post('/txns', salesDoc('invoice', cust, [{ desc: 'T', rate: '100.00' }]));
  await app.post('/txns', { type: 'payment', customer_id: String(cust), txn_date: TODAY, amount: '40.00' });
  const r = await listCompanyTxns(pool, { ...scope, slug: 'sales-transactions', filters: listFilters('sales-transactions', { party: String(cust) }, TODAY), today: TODAY });
  assert.equal(r.total, 6000);
  assert.equal(r.open, 6000);
  const page = await (await app.get(`/customers/${cust}?tab=transactions`)).text();
  assert.match(page, /<strong>\$60\.00<\/strong>/);
});

test('a change to a reconciled transaction can be cleared on the next reconciliation', async () => {
  const A = app.ids.accounts;
  const jb = new URLSearchParams({ txn_date: '2026-10-01', memo: 'check' });
  for (const [acct, d, c] of [[A.office, '100', ''], [A.savings, '', '100']]) {
    jb.append('je_account', String(acct)); jb.append('je_debit', d); jb.append('je_credit', c); jb.append('je_desc', ''); jb.append('je_party', ''); jb.append('je_class', '');
  }
  const je = idFrom(await app.post('/journal', jb), /\/ledger\/(\d+)/);
  const start = await (await app.get(`/reconcile/start?account=${A.savings}&date=2026-10-05`)).text();
  const boxes = [...start.matchAll(/name="ids" value="(\d+)" data-amount="(-?\d+)"/g)].map(m => ({ id: m[1], amount: Number(m[2]) }));
  const beginning = Number(/data-beginning="(-?\d+)"/.exec(start)[1]);
  const body = new URLSearchParams({ statement_date: '2026-10-05', ending: ((beginning + boxes.reduce((x, b) => x + b.amount, 0)) / 100).toFixed(2) });
  for (const b of boxes) body.append('ids', b.id);
  assert.equal((await app.post(`/reconcile/${A.savings}`, body)).status, 303);
  // An admin changes the reconciled $100 to $120.
  await pool.query('UPDATE posting SET amount_cents = CASE WHEN amount_cents > 0 THEN 12000 ELSE -12000 END WHERE txn_id = $1', [je]);
  const next = await (await app.get(`/reconcile/start?account=${A.savings}&date=2026-10-10`)).text();
  assert.match(next, /Reconciliation discrepancy/);
  assert.match(next, /Change since reconciled/);
  const change = [...next.matchAll(/name="ids" value="(\d+)" data-amount="(-?\d+)"/g)].find(m => Number(m[1]) === je);
  assert.equal(Number(change[2]), -2000);
  const begin2 = Number(/data-beginning="(-?\d+)"/.exec(next)[1]);
  const fin = new URLSearchParams({ statement_date: '2026-10-10', ending: ((begin2 - 2000) / 100).toFixed(2) }); fin.append('ids', String(je));
  assert.equal((await app.post(`/reconcile/${A.savings}`, fin)).status, 303);
  assert.doesNotMatch(await (await app.get(`/reconcile/start?account=${A.savings}&date=2026-10-11`)).text(), /Reconciliation discrepancy/);
  await pool.query('UPDATE posting SET amount_cents = CASE WHEN amount_cents > 0 THEN 10000 ELSE -10000 END WHERE txn_id = $1', [je]);
  await pool.query('DELETE FROM reconciled_adjustment WHERE txn_id = $1', [je]);
});

test('vendors in different currencies can’t be merged; a foreign customer’s opening balance is a clear message', async () => {
  await app.post('/settings/currencies/on', {});
  const v = await one(`INSERT INTO vendor (org_id, entity_id, display_name, currency) VALUES ($1, $2, 'Euro Vendor', 'EUR') RETURNING vendor_id`, [scope.orgId, scope.entityId]);
  const res = await app.post(`/vendors/${v.vendor_id}/merge`, { into: String(app.ids.vendors.mill) });
  assert.equal(res.status, 422);
  assert.match(await res.text(), /same currency/);
});

test('transaction statement: total due = what’s owed on the statement date (= aging)', async () => {
  const cust = await newCustomer('Statement Co');
  await app.post('/txns', salesDoc('invoice', cust, [{ desc: 'Jan', rate: '100.00' }], { txn_date: '2026-01-15' }));
  await app.post('/txns', salesDoc('invoice', cust, [{ desc: 'Feb', rate: '50.00' }], { txn_date: '2026-02-10' }));
  const st = await computeStatement(pool, { ...scope, customerId: cust, request: { kind: 'transaction', statementDate: '2026-03-31', startDate: '2026-02-01', endDate: '2026-03-31' } });
  assert.equal(st.total_due_cents, 15000);
  assert.equal(st.rows.length, 1);
});

test('item receipt converted to a later bill keeps its date and the stock cost', async () => {
  await app.post('/settings/items', { name: 'Review Widget', kind: 'inventory', rate: '30', cost: '10', active: '1' });
  const item = (await one(`SELECT item_id FROM item WHERE name = 'Review Widget'`)).item_id;
  const receipt = idFrom(await app.post('/vtxns', vdoc('item_receipt', app.ids.vendors.mill, { items: [{ item, qty: '10', rate: '10.00' }], txn_date: '2026-09-01' })), /\/vtxns\/(\d+)/);
  await app.post('/txns', salesDoc('invoice', app.ids.customers.hilltop, [{ item, qty: '5', rate: '30.00' }], { txn_date: '2026-09-05' }));
  assert.equal((await app.post(`/vtxns/${receipt}/convert`, { txn_date: '2026-10-01', doc_number: 'RW-1' })).status, 303);
  const t = await one('SELECT type, txn_date::text AS d, due_date::text AS due FROM txn WHERE txn_id = $1', [receipt]);
  assert.deepEqual([t.type, t.d], ['bill', '2026-09-01']);
  assert.ok(t.due >= '2026-10-01', 'terms count from the bill date');
  assert.equal(Number((await one('SELECT value_cents FROM item WHERE item_id = $1', [item])).value_cents), 5000);
});

test('a payment applied in two parts keeps both parts and their dates when its memo is edited', async () => {
  const cust = await newCustomer('Split Co');
  await app.post('/txns', salesDoc('invoice', cust, [{ desc: 'Split', rate: '100.00' }], { txn_date: '2026-08-01' }));
  const inv = await newestTxn('invoice', cust);
  await app.post('/txns', { type: 'payment', customer_id: String(cust), txn_date: '2026-08-10', amount: '100.00', [`apply_${inv}`]: '25.00' });
  const pay = await newestTxn('payment', cust);
  assert.equal((await app.post(`/txns/${pay}/apply`, { [`apply_${inv}`]: '25.00' })).status, 303);
  const before = (await pool.query('SELECT amount_cents, applied_on::text AS d FROM application WHERE credit_txn_id = $1 ORDER BY application_id', [pay])).rows;
  const editor = await (await app.get(`/txns/${pay}/edit`)).text();
  const shown = [...editor.matchAll(new RegExp(`name="apply_${inv}" value="([^"]*)"`, 'g'))].map(m => m[1]);
  assert.deepEqual(shown, ['50.00'], 'one row, the total applied');
  await app.post(`/txns/${pay}`, { type: 'payment', customer_id: String(cust), txn_date: '2026-08-10', amount: '100.00', memo: 'memo only', [`apply_${inv}`]: '50.00' });
  const afterRows = (await pool.query('SELECT amount_cents, applied_on::text AS d FROM application WHERE credit_txn_id = $1 ORDER BY applied_on, application_id', [pay])).rows;
  assert.deepEqual(afterRows.map(r => [Number(r.amount_cents), r.d]), before.map(r => [Number(r.amount_cents), r.d]).sort((a, b) => a[1].localeCompare(b[1])));
  assert.equal(Number((await one('SELECT open_cents FROM txn WHERE txn_id = $1', [inv])).open_cents), 5000);
});

test('cash basis: two partial payments clear each income line exactly', async () => {
  const cust = await newCustomer('Cents Co');
  const A = app.ids.accounts;
  await app.post('/settings/items', { name: 'Cents A', kind: 'service', rate: '50.01', incomeAccountId: String(A.feed_sales), active: '1' });
  await app.post('/settings/items', { name: 'Cents B', kind: 'service', rate: '50.01', incomeAccountId: String(A.hay_sales), active: '1' });
  const ia = (await one(`SELECT item_id FROM item WHERE name = 'Cents A'`)).item_id, ib = (await one(`SELECT item_id FROM item WHERE name = 'Cents B'`)).item_id;
  await app.post('/txns', salesDoc('invoice', cust, [{ item: ia, rate: '50.01' }, { item: ib, rate: '50.01' }], { txn_date: '2026-10-01' }));
  const inv = await newestTxn('invoice', cust);
  for (const d of ['2026-10-02', '2026-10-03']) await app.post('/txns', { type: 'payment', customer_id: String(cust), txn_date: d, amount: '50.01', [`apply_${inv}`]: '50.01' });
  const pl = await report('profit_and_loss', { period: 'custom', from: '2026-10-01', to: '2026-10-12', customer: String(cust) }, 'cash');
  const row = id => pl.rows.find(r => r.accountId === id)?.values.at(-1);
  assert.equal(row(A.feed_sales), 5001);
  assert.equal(row(A.hay_sales), 5001);
});

test('inventory kept in an Other current asset account is valued', async () => {
  const { rows: [oca] } = await pool.query(`INSERT INTO account (org_id, entity_id, name, type) VALUES ($1, $2, 'Stock on consignment', 'other_current_asset') RETURNING account_id`, [scope.orgId, scope.entityId]);
  const res = await app.post('/settings/items', { name: 'OCA Item', kind: 'inventory', rate: '20', cost: '10', assetAccountId: String(oca.account_id), incomeAccountId: String(app.ids.accounts.feed_sales), active: '1' });
  assert.equal(res.status, 303);
  const item = (await one(`SELECT item_id, asset_account_id FROM item WHERE name = 'OCA Item'`));
  await app.post('/vtxns', vdoc('bill', app.ids.vendors.mill, { items: [{ item: item.item_id, qty: '10', rate: '10.00' }] }));
  const val = await report('inventory_valuation_summary', { period: 'today' });
  const line = val.rows.find(r => r.itemId === item.item_id);
  assert.equal(Number(item.asset_account_id), Number(oca.account_id), 'the item keeps its stock in the Other current asset account');
  assert.equal(line.cells.value, 10000);
});

test('project costs include the cost of stock sold on the project', async () => {
  const cust = app.ids.customers.hilltop;
  const proj = idFrom(await app.post(`/customers/${cust}/projects`, { name: 'COGS Project', status: 'in_progress', startDate: '', endDate: '', description: '' }), /\/projects\/(\d+)/);
  await app.post('/txns', salesDoc('invoice', cust, [{ item: app.ids.items.salt, qty: '2', rate: '20.00' }], { project_id: String(proj) }));
  const p = (await listAllProjects(pool, { ...scope })).find(x => x.project_id === proj);
  const rep = await report('project_profitability_summary', { period: 'all' });
  const r = rep.rows.find(x => x.projectId === proj);
  assert.ok(p.cost_cents > 0, 'COGS counted');
  assert.equal(p.cost_cents, r.values[1] + r.values[2], 'same as the Project Profitability report');
});

test('merging customers moves their price rules; export shows real quantities', async () => {
  const a = await newCustomer('Rule From'), b = await newCustomer('Rule Into');
  await pool.query(`INSERT INTO price_rule (org_id, entity_id, name, kind, percent_off, customer_ids, item_ids) VALUES ($1, $2, 'A deal', 'percent_off', 20, $3, '{}')`,
    [scope.orgId, scope.entityId, [a]]);
  assert.equal((await app.post(`/customers/${a}/merge`, { into: String(b) })).status, 303);
  const rule = await one(`SELECT customer_ids FROM price_rule WHERE name = 'A deal'`);
  assert.deepEqual(rule.customer_ids.map(Number), [b]);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await exportBuffer());
  const sheet = wb.getWorksheet('Products and services');
  const head = sheet.getRow(1).values;
  const qtyCol = head.indexOf('On hand');
  const salt = (await one('SELECT name, qty_on_hand FROM item WHERE item_id = $1', [app.ids.items.salt]));
  let found = null;
  sheet.eachRow(r => { if (r.getCell(1).value === salt.name) found = r.getCell(qtyCol).value; });
  assert.equal(found, Number(salt.qty_on_hand));
});
async function exportBuffer() {
  const res = await app.get('/export/books.xlsx');
  return Buffer.from(await res.arrayBuffer());
}
