import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerCheck, listAccounts, systemAccounts } from '../lib/data/ledger.js';
import { getAccountingSettings } from '../lib/data/accounting.js';
import { getVendor } from '../lib/data/vendors.js';
import { list1099 } from '../lib/data/ten99.js';
import { canAccess } from '../lib/domain/roles.js';
import { ledgerLines } from '../lib/reports/ledger-data.js';
import { runReport } from '../lib/reports/engine.js';
import { REPORTS } from '../lib/reports/registry.js';
import { startApp } from './app-harness.js';

// Reports R2b — what you owe, expenses and vendors, lists — proven against the ledger and each vendor's own page.
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
const apOn = async date => 0 - (await ledgerLines(pool, { ...scope, to: date })).filter(l => l.accountId === ctx.sys.ap).reduce((s, l) => s + l.amount, 0);
const vendors = () => q('SELECT vendor_id, display_name FROM vendor WHERE org_id = $1 AND entity_id = $2 ORDER BY vendor_id');

test('A/P aging equals the A/P account today and at each past month-end; every A/P report agrees', async () => {
  for (const date of [TODAY, '2026-09-30', '2026-06-30', '2026-03-31', '2025-12-31']) {
    const aging = await run('ap_aging_summary', { period: 'custom', to: date, run: '1' });
    const total = aging.rows.at(-1).values;
    assert.equal(total.at(-1), await apOn(date), `aging as of ${date}`);
    assert.equal(total.slice(0, -1).reduce((s, x) => s + x, 0), total.at(-1));
    assert.equal(grandOf(await run('ap_aging_detail', { period: 'custom', to: date, run: '1' })), total.at(-1));
    assert.equal(grandOf(await run('unpaid_bills', { period: 'custom', to: date, run: '1' })), total.at(-1));
    assert.equal((await run('vendor_balance_summary', { period: 'custom', to: date, run: '1' })).rows.at(-1).values[0], total.at(-1));
    assert.equal(grandOf(await run('vendor_balance_detail', { period: 'custom', to: date, run: '1' })), total.at(-1));
  }
});

test('each vendor: the reports show exactly what their vendor page shows', async () => {
  const aging = await run('ap_aging_summary', { period: 'today', run: '1' });
  let owed = 0;
  for (const v of await vendors()) {
    const id = Number(v.vendor_id);
    const page = await getVendor(pool, { ...scope, vendorId: id, today: TODAY });
    const row = aging.rows.find(r => r.partyId === id);
    assert.equal(row?.values.at(-1) ?? 0, Number(page.open_cents), `${v.display_name} open balance`);
    const detail = await run('unpaid_bills', { period: 'today', vendor: String(id), run: '1' });
    assert.equal(grandOf(detail), Number(page.open_cents));
    const overdue = detail.rows.filter(r => r.kind === 'line' && r.cells.past_due && r.cells.open > 0).reduce((s, r) => s + r.cells.open, 0);
    assert.equal(overdue, Number(page.overdue_cents), `${v.display_name} overdue`);
    if (Number(page.open_cents)) owed++;
  }
  assert.ok(owed >= 2, 'several vendors are owed money');
  // The item receipt waiting for its bill is owed to that vendor, on the vendor page and the reports alike.
  const [receipt] = await q(`SELECT vendor_id, open_cents FROM txn WHERE org_id = $1 AND entity_id = $2 AND type = 'item_receipt' AND open_cents > 0 LIMIT 1`);
  if (receipt) assert.ok(Number((await getVendor(pool, { ...scope, vendorId: Number(receipt.vendor_id), today: TODAY })).open_cents) >= Number(receipt.open_cents));
  const v = (await vendors())[0];
  const html = await (await app.get(`/vendors/${v.vendor_id}`)).text();
  assert.match(html, new RegExp(`/reports/r/unpaid_bills\\?period=today&amp;vendor=${v.vendor_id}`));
  assert.ok(!canAccess('vendors', 'GET', '/reports/r/unpaid_bills'), 'vendors-only people don’t get report links');
});

test('purchases by vendor, product, class and location add up to the same total; expenses by vendor = P&L expenses', async () => {
  for (const basis of ['accrual', 'cash']) {
    const base = { period: 'this_year_to_date', basis, run: '1' };
    const totals = [];
    for (const g of ['vendor', 'product']) {
      const sum = await run(`purchases_by_${g}_summary`, base);
      totals.push(sum.rows.at(-1).values[0]);
      const det = await run(`purchases_by_${g}_detail`, base);
      assert.equal(grandOf(det, 'amount'), sum.rows.at(-1).values[0], `${basis} ${g}`);
      for (const r of det.rows.filter(x => x.kind === 'total' && !x.grand)) {
        assert.equal(sum.rows.find(x => x.label === r.label.replace(/^Total for /, '')).values[0], r.cells.amount, `${basis} ${g} ${r.label}`);
      }
    }
    for (const g of ['class', 'location']) totals.push(grandOf(await run(`purchases_by_${g}_detail`, base), 'amount'));
    assert.ok(totals[0] > 0);
    assert.ok(totals.every(t => t === totals[0]), `${basis}: ${totals.join(', ')}`);
    const exp = await run('expenses_by_vendor_summary', base);
    const pl = await run('profit_and_loss', base);
    assert.equal(exp.rows.at(-1).values[0], pl.totals.cogs[0] + pl.totals.expenses[0] + pl.totals.other_expenses[0], basis);
    assert.equal(grandOf(await run('expenses_by_vendor_detail', base), 'amount'), exp.rows.at(-1).values[0]);
  }
});

test('bill payments, bills and applied payments, checks and the purchase list agree with the documents', async () => {
  const bp = await run('bill_payment_list', { period: 'this_year_to_date', run: '1' });
  const [{ n: paid }] = await q(`SELECT coalesce(sum(total_cents), 0)::bigint AS n FROM txn WHERE org_id = $1 AND entity_id = $2 AND type = 'bill_payment' AND voided_at IS NULL AND txn_date >= '2026-01-01'`);
  assert.equal(grandOf(bp, 'amount'), Number(paid));
  const bap = await run('bills_and_applied_payments', { period: 'this_year_to_date', run: '1' });
  const [{ n: stillOwed }] = await q(`SELECT coalesce(sum(open_cents), 0)::bigint AS n FROM txn WHERE org_id = $1 AND entity_id = $2 AND type IN ('bill', 'item_receipt') AND voided_at IS NULL AND txn_date >= '2026-01-01'`);
  assert.equal(grandOf(bap, 'amount'), Number(stillOwed));

  const checks = await run('check_detail', { period: 'this_year_to_date', run: '1' });
  const heads = checks.rows.filter(r => r.kind === 'line' && !r.sub);
  assert.ok(heads.length);
  for (const h of heads) {
    const at = checks.rows.indexOf(h);
    let sum = 0;
    for (let i = at + 1; i < checks.rows.length && checks.rows[i].sub; i++) sum += checks.rows[i].cells.amount;
    assert.equal(-sum, h.cells.amount, `check ${h.cells.num} = what it paid for`);
  }
  const list = await run('purchase_list', { period: 'this_year_to_date', run: '1' });
  const [{ n }] = await q(`SELECT count(*) AS n FROM txn WHERE org_id = $1 AND entity_id = $2 AND type IN ('bill', 'expense', 'check', 'vendor_credit', 'item_receipt', 'purchase_order') AND txn_date BETWEEN '2026-01-01' AND '${TODAY}'`);
  assert.equal(list.rows.filter(r => r.kind === 'line').length, Number(n));
});

test('1099 reports match Vendors → 1099 summary', async () => {
  const summary = await run('contractor_1099_summary', { period: 'this_year', run: '1' });
  const detail = await run('contractor_1099_detail', { period: 'this_year', run: '1' });
  const official = await list1099(pool, { ...scope, year: 2026 });
  const tracked = official.tracked.filter(r => Number(r.paid_cents) > 0);
  assert.equal(summary.rows.filter(r => r.kind === 'line').length, tracked.length);
  for (const t of tracked) assert.equal(summary.rows.find(r => r.partyId === Number(t.vendor_id)).cells.amount, Number(t.paid_cents), t.display_name);
  assert.equal(grandOf(detail, 'amount'), grandOf(summary, 'amount'));
});

test('lists: contacts, phones, products, terms, payment methods, classes, locations, employees, tags', async () => {
  const count = async sql => Number((await q(sql))[0].n);
  assert.equal((await run('customer_contact_list')).rows.length, await count('SELECT count(*) AS n FROM customer WHERE org_id = $1 AND entity_id = $2 AND active'));
  assert.equal((await run('vendor_phone_list')).rows.length, await count('SELECT count(*) AS n FROM vendor WHERE org_id = $1 AND entity_id = $2 AND active'));
  assert.equal((await run('customer_contact_list', { show: 'all', run: '1' })).rows.length, await count('SELECT count(*) AS n FROM customer WHERE org_id = $1 AND entity_id = $2'));
  assert.equal((await run('product_service_list')).rows.length, await count(`SELECT count(*) AS n FROM item WHERE org_id = $1 AND entity_id = $2 AND active AND kind <> 'system'`));
  assert.equal((await run('terms_list')).rows.length, Number((await q('SELECT count(*) AS n FROM terms WHERE org_id = $1', [scope.orgId]))[0].n));
  assert.ok((await run('payment_method_list')).rows.length > 0);
  for (const key of ['class_list', 'location_list', 'employee_contact_list']) await run(key);
  const tagged = await run('transaction_list_by_tag_group', { period: 'all', run: '1' });
  const tagOf = new Map((await q('SELECT x.txn_id, t.name FROM txn_tag x JOIN tag t ON t.tag_id = x.tag_id WHERE x.org_id = $1', [scope.orgId])).map(r => [`${r.txn_id}:${r.name}`, true]));
  let section = null;
  for (const r of tagged.rows) {
    if (r.kind === 'section') section = r.label.replace(/^.*: /, '');
    if (r.kind === 'line') assert.ok(tagOf.has(`${r.txnId}:${section}`), `txn ${r.txnId} has tag ${section}`);
  }
});

test('every R2b report opens, exports and drills down', async () => {
  const keys = REPORTS.filter(r => ['what_you_owe', 'expenses_vendors', 'employees', 'lists'].includes(r.group) || r.key === 'transaction_list_by_tag_group').map(r => r.key);
  assert.ok(keys.length >= 30);
  for (const key of keys) for (const ext of ['', '.csv', '.xlsx', '.pdf']) assert.equal((await app.get(`/reports/r/${key}${ext}`)).status, 200, key + ext);
  const page = await (await app.get('/reports/r/ap_aging_summary')).text();
  const drill = /href="(\/reports\/r\/ap_aging_detail\?[^"]+)"/.exec(page)[1].replace(/&amp;/g, '&');
  assert.match(drill, /vendor=\d+/);
  assert.equal((await app.get(drill)).status, 200);
});
