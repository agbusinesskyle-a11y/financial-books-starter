import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { startApp } from './app-harness.js';
import { tieout, TODAY } from './tieout.js';
import { makeTotp } from '../lib/auth.js';
import { listCompanyTxns, listFilters } from '../lib/data/lists.js';
import { salesOverview, expensesOverview, customersOverview, projectsOverview, inventoryOverview, listAllProjects } from '../lib/data/overviews.js';
import { homeData } from '../lib/data/home.js';
import { getReconciliation } from '../lib/data/ledger-tools.js';
import { formatCents } from '../lib/domain/money.js';

// Deep tie-out for banking, ledger tools and the rest: every step is done through the app the way a person would, then
// every view of the books must agree with every other (checkTied), and the step must have moved exactly what accounting
// says it should — figured here from first principles, never read back from the app (expectChange).

const sent = [];
const mailer = { kind: 'smtp', from: 'books@sample.example', async send(m) { sent.push(m); return { status: 'sent' }; } };
let app, t, A, S;
const ids = {};

before(async () => {
  app = await startApp({ mailer, env: { SETTINGS_KEY: 'ef'.repeat(32) } });
  t = tieout(app);
  A = app.ids.accounts;
  await t.snapshot();
  S = t.sys();
});
after(async () => { await app.close(); });

const q = async (sql, params = []) => (await app.db.pool.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const loc = res => res.headers.get('location') ?? '';
const idIn = (res, re) => { const m = re.exec(loc(res)); assert.ok(m, `no id in redirect “${loc(res)}”`); return Number(m[1]); };
const errorOf = html => (/class="[^"]*error[^"]*"[^>]*>([\s\S]{0,300}?)</.exec(html) ?? [])[1] ?? html.slice(0, 300);
async function ok303(res, label = '') {
  if (res.status !== 303) assert.fail(`${label}: expected 303, got ${res.status}: ${errorOf(await res.text())}`);
  return res;
}
const lastRow = (r, re) => r.rows.find(x => re.test(x.label ?? ''));
const netIncome = r => lastRow(r, /^Net Income$/).values.at(-1);
const acctRow = (r, id) => r.rows.find(x => x.kind === 'account' && x.accountId === id);
const sumPostings = async (where, params) => Number((await one(`SELECT coalesce(sum(amount_cents), 0)::bigint AS n FROM posting WHERE ${where}`, params)).n);

// One user action between two snapshots: the books must tie afterwards and move exactly `expected` (a value or a
// function of the action's result).
async function step(label, action, expected = {}) {
  const a = await t.snapshot();
  const r = await action();
  const b = await t.snapshot();
  t.checkTied(b, label);
  if (expected !== null) t.expectChange(a, b, { label, ...(typeof expected === 'function' ? expected(r) : expected) });
  return { a, b, r };
}

function jeBody(lines, more = {}) {
  const p = new URLSearchParams({ txn_date: TODAY, memo: 'Tie-out entry', ...more });
  for (const l of lines) {
    p.append('je_account', String(l.account)); p.append('je_debit', l.debit ?? ''); p.append('je_credit', l.credit ?? '');
    p.append('je_desc', l.desc ?? ''); p.append('je_party', l.party ?? ''); p.append('je_class', l.cls ? String(l.cls) : '');
  }
  for (const [k, v] of more.extra ?? []) p.append(k, v);
  p.delete('extra');
  return p;
}
const ledgerId = res => idIn(res, /\/ledger\/(\d+)/);

function salesDoc(type, customerId, lines, more = {}, extra = []) {
  const p = new URLSearchParams({ type, customer_id: String(customerId), txn_date: TODAY, after_save: 'none', ...more });
  for (const l of lines) {
    p.append('line_item', l.item ? String(l.item) : ''); p.append('line_desc', l.desc ?? 'Work'); p.append('line_qty', l.qty ?? '1'); p.append('line_rate', l.rate);
    p.append('line_service', ''); p.append('line_est', ''); p.append('line_bill', ''); p.append('line_class', l.cls ? String(l.cls) : '');
    if (l.time !== undefined) p.append('line_time', l.time);
  }
  for (const [k, v] of extra) p.append(k, v);
  return p;
}
const newestTxn = async (type, more = '', params = []) => (await one(`SELECT * FROM txn WHERE org_id = $1 AND type = $2 ${more} ORDER BY txn_id DESC LIMIT 1`,
  [app.ids.orgId, type, ...params]));

function vendorDoc(type, vendorId, cats, more = {}) {
  const p = new URLSearchParams({ type, vendor_id: String(vendorId), txn_date: TODAY, ...more });
  for (const c of cats) {
    p.append('cat_account', String(c.account)); p.append('cat_desc', c.desc ?? ''); p.append('cat_amount', c.amount); p.append('cat_job', c.job ?? '');
    p.append('cat_po', ''); p.append('cat_billable', ''); p.append('cat_class', '');
  }
  return p;
}

const ACCOUNTING = { fiscalStartMonth: '1', method: 'accrual', dateFormat: 'mdy', showAccountNumbers: '1', classesOn: '1', classMode: 'txn', locationsOn: '1',
  locationLabel: 'Location', billableOn: '', billableMarkup: '', billableIncomeAccountId: '', autoApplyCustomer: '', autoApplyVendor: '', warnDuplicateBills: '1' };

// ---------------------------------------------------------------------------------------------------------------------
test('1. chart of accounts: create, edit, inactive, delete unused, refuse used; sub-accounts roll up', async () => {
  const { r: vehicle } = await step('create account', async () =>
    idIn(await ok303(await app.post('/settings/accounts', { name: 'Vehicle Costs', number: '6900', type: 'expense', active: '1' }), 'create'), /\/settings\/accounts\/(\d+)/));
  ids.vehicle = vehicle;
  assert.equal((await one('SELECT name, type, active FROM account WHERE account_id = $1', [vehicle])).type, 'expense');
  assert.ok((await one(`SELECT count(*)::int AS n FROM audit_log WHERE table_name = 'account' AND row_id = $1 AND action = 'insert'`, [vehicle])).n > 0, 'account creation audited');

  await step('edit account', async () => ok303(await app.post(`/settings/accounts/${vehicle}/edit`, { name: 'Vehicle Expenses', number: '6900', type: 'expense', active: '1' }), 'edit'));
  assert.equal((await one('SELECT name FROM account WHERE account_id = $1', [vehicle])).name, 'Vehicle Expenses');
  const upd = await one(`SELECT actor, before, after FROM audit_log WHERE table_name = 'account' AND row_id = $1 AND action = 'update' ORDER BY audit_id DESC LIMIT 1`, [vehicle]);
  assert.deepEqual([upd.before.name, upd.after.name, upd.actor], ['Vehicle Costs', 'Vehicle Expenses', 'operator']);

  const { r: subs } = await step('create sub-accounts', async () => ({
    truck: idIn(await ok303(await app.post('/settings/accounts', { name: 'Truck Fuel', number: '6910', type: 'expense', parentId: String(vehicle), active: '1' }), 'sub'), /accounts\/(\d+)/),
    petty: idIn(await ok303(await app.post('/settings/accounts', { name: 'Petty Cash', number: '1015', type: 'bank', parentId: String(A.checking), active: '1' }), 'petty'), /accounts\/(\d+)/),
  }));
  Object.assign(ids, subs);

  // Delete an unused account; refuse to delete a used one.
  const temp = idIn(await ok303(await app.post('/settings/accounts', { name: 'Temp Account', number: '6990', type: 'expense', active: '1' })), /accounts\/(\d+)/);
  await step('delete unused account', async () => {
    const res = await app.post(`/settings/accounts/${temp}/delete`);
    assert.equal(loc(res), '/settings/accounts');
  });
  assert.equal((await q('SELECT 1 FROM account WHERE account_id = $1', [temp])).length, 0);
  assert.ok((await one(`SELECT count(*)::int AS n FROM audit_log WHERE table_name = 'account' AND row_id = $1 AND action = 'delete'`, [temp])).n > 0);
  await step('refuse delete of a used account', async () => {
    const res = await app.post(`/settings/accounts/${A.feed_sales}/delete`);
    assert.equal(loc(res), `/settings/accounts/${A.feed_sales}/edit`);
    assert.match(await (await app.get(loc(res))).text(), /has been used|still has a balance/);
  });
  assert.equal((await q('SELECT 1 FROM account WHERE account_id = $1', [A.feed_sales])).length, 1);

  // Inactive: an unused account can be; one with a balance can't.
  const old = idIn(await ok303(await app.post('/settings/accounts', { name: 'Old Supplies', number: '6980', type: 'expense', active: '1' })), /accounts\/(\d+)/);
  await step('make inactive', async () => ok303(await app.post(`/settings/accounts/${old}/edit`, { name: 'Old Supplies', number: '6980', type: 'expense' })));
  assert.equal((await one('SELECT active FROM account WHERE account_id = $1', [old])).active, false);
  assert.equal((await app.post(`/settings/accounts/${A.rent}/edit`, { name: 'Rent', number: '6500', type: 'expense' })).status, 422);
  assert.equal((await one('SELECT active FROM account WHERE account_id = $1', [A.rent])).active, true);
  // An inactive account isn't offered for a journal entry.
  const jeInactive = await app.post('/journal', jeBody([{ account: old, debit: '5' }, { account: A.checking, credit: '5' }]));
  assert.equal(jeInactive.status, 422);

  // Sub-accounts roll up: Truck Fuel under Vehicle Expenses on the P&L, Petty Cash under Operating Checking on the BS.
  const { r: je } = await step('post to sub-accounts', async () => ledgerId(await ok303(await app.post('/journal', jeBody([
    { account: subs.truck, debit: '120' }, { account: vehicle, debit: '30' }, { account: subs.petty, debit: '200' }, { account: A.checking, credit: '350' }])), 'je')),
  { accounts: { [subs.truck]: 12000, [vehicle]: 3000, [subs.petty]: 20000, [A.checking]: -35000 }, net: -15000 });
  await t.expectHistory(je, { activity: false });
  const pl = await t.run('profit_and_loss', { period: 'this_year_to_date' });
  const parent = pl.rows.find(r => r.accountId === vehicle);
  assert.ok(parent?.parent, 'Vehicle Expenses shows as a parent');
  assert.equal(parent.values[0], 3000, 'parent’s own amount');
  assert.equal(acctRow(pl, subs.truck).values[0], 12000);
  assert.equal(acctRow(pl, subs.truck).depth, parent.depth + 1, 'sub-account indented under its parent');
  assert.equal(lastRow(pl, /^Total for 6900 Vehicle Expenses$/).values[0], 15000, 'parent total = own + sub-accounts');
  const bs = await t.run('balance_sheet', { period: 'today' });
  const s = await t.snapshot();
  assert.equal(lastRow(bs, /^Total for 1010 Operating Checking$/).values[0], s.accounts.get(A.checking) + s.accounts.get(subs.petty), 'checking total = checking + petty cash');
  assert.equal(acctRow(bs, subs.petty).values[0], 20000);
  // The register shows the entry with its running balance.
  const reg = await (await app.get(`/settings/accounts/${subs.truck}`)).text();
  assert.match(reg, new RegExp(`/ledger/${je}`));
  assert.match(reg, /\$120\.00/);
});

// ---------------------------------------------------------------------------------------------------------------------
test('1b. an account used only on a voided entry can’t be deleted out from under it (refused cleanly)', async () => {
  const ghost = idIn(await ok303(await app.post('/settings/accounts', { name: 'Ghost Expense', number: '6960', type: 'expense', active: '1' })), /accounts\/(\d+)/);
  const { r: je } = await step('JE on the new account', async () => ledgerId(await ok303(await app.post('/journal', jeBody([{ account: ghost, debit: '10' }, { account: A.checking, credit: '10' }])))),
    { accounts: { [ghost]: 1000, [A.checking]: -1000 }, net: -1000 });
  await step('void it', async () => ok303(await app.post(`/ledger/${je}/void`)), { accounts: { [ghost]: -1000, [A.checking]: 1000 }, net: 1000 });
  await step('delete the account', async () => {
    const res = await app.post(`/settings/accounts/${ghost}/delete`);
    assert.notEqual(res.status, 500, 'deleting an account a (voided) transaction still uses is refused with a message, not a server error');
  });
  assert.equal((await q('SELECT 1 FROM account WHERE account_id = $1', [ghost])).length, 1);
  assert.equal((await app.get(`/ledger/${je}`)).status, 200, 'the voided entry still opens');
});

// ---------------------------------------------------------------------------------------------------------------------
test('2. journal entries: multi-line with names, classes and location; edit, void, delete; adjusting entries', async () => {
  await ok303(await app.post('/settings/accounting', ACCOUNTING), 'accounting on');
  for (const name of ['Retail', 'Wholesale']) await ok303(await app.post('/settings/classes', { name }), name);
  await ok303(await app.post('/settings/locations', { name: 'North yard' }));
  await ok303(await app.post('/settings/tags', { name: 'Promo', newGroup: 'Campaign' }));
  ids.retail = (await one(`SELECT class_id FROM class WHERE name = 'Retail'`)).class_id;
  ids.wholesale = (await one(`SELECT class_id FROM class WHERE name = 'Wholesale'`)).class_id;
  ids.north = (await one(`SELECT location_id FROM location WHERE name = 'North yard'`)).location_id;
  ids.promo = (await one(`SELECT tag_id FROM tag WHERE name = 'Promo'`)).tag_id;
  const hilltop = app.ids.customers.hilltop, landlord = app.ids.vendors.landlord;

  // A/R can't be on a journal entry (its subledger is kept by invoices and payments): refused, nothing posts.
  await step('JE on A/R refused', async () => {
    const res = await app.post('/journal', jeBody([{ account: S.ar, debit: '10', party: `c:${hilltop}` }, { account: A.checking, credit: '10' }]));
    assert.equal(res.status, 422);
  });
  await step('unbalanced JE refused', async () => assert.equal((await app.post('/journal', jeBody([{ account: A.rent, debit: '10' }, { account: A.checking, credit: '9' }]))).status, 422));

  const lines = rent => [
    { account: A.rent, debit: rent, party: `v:${landlord}`, cls: ids.retail, desc: 'October rent' },
    { account: A.office, debit: '75', cls: ids.wholesale },
    { account: A.checking, debit: '100' },
    { account: A.feed_sales, credit: '100', party: `c:${hilltop}`, cls: ids.retail },
    { account: A.checking, credit: String(Number(rent) - 100) },
    { account: A.card, credit: '175' },
  ];
  const dims = { location_id: String(ids.north), tags_shown: '1', extra: [['tag_ids', String(ids.promo)]] };
  const { r: je } = await step('multi-line JE', async () => ledgerId(await ok303(await app.post('/journal', jeBody(lines('500'), { memo: 'Tieout banana memo', ...dims })), 'je')),
    { accounts: { [A.rent]: 50000, [A.office]: 7500, [A.checking]: 10000 - 40000, [A.feed_sales]: -10000, [A.card]: -17500 }, net: -47500 });
  ids.je = je;
  await t.expectHistory(je, { activity: false });
  const posts = await q('SELECT account_id, amount_cents, customer_id, vendor_id, class_id, location_id FROM posting WHERE txn_id = $1', [je]);
  const rentPost = posts.find(p => p.account_id === A.rent), salesPost = posts.find(p => p.account_id === A.feed_sales);
  assert.deepEqual([rentPost.vendor_id, rentPost.class_id, rentPost.location_id], [landlord, ids.retail, ids.north]);
  assert.deepEqual([salesPost.customer_id, salesPost.class_id], [hilltop, ids.retail]);
  await step('edit JE', async () => ok303(await app.post(`/journal/${je}`, jeBody(lines('600'), { memo: 'Tieout banana memo', ...dims })), 'edit'),
    { accounts: { [A.rent]: 10000, [A.checking]: -10000 }, net: -10000 });
  assert.equal(Number((await one('SELECT total_cents FROM txn WHERE txn_id = $1', [je])).total_cents), 77500, 'total = debits');
  assert.equal((await one(`SELECT count(*)::int AS n FROM audit_log WHERE table_name = 'txn' AND row_id = $1 AND action = 'update'`, [je])).n > 0, true);

  // Adjusting entry: shows in the Adjusted Trial Balance's adjustment columns, and only it does.
  const { r: adj } = await step('adjusting JE', async () => ledgerId(await ok303(await app.post('/journal', jeBody([
    { account: A.insurance, debit: '250' }, { account: A.equipment_loan, credit: '250' }], { adjusting: '1', memo: 'Accrue insurance' })))),
  { accounts: { [A.insurance]: 25000, [A.equipment_loan]: -25000 }, net: -25000 });
  ids.adj = adj;
  const atb = await t.run('adjusted_trial_balance', { period: 'this_fiscal_year_to_date' });
  const ins = acctRow(atb, A.insurance), loan = acctRow(atb, A.equipment_loan);
  assert.equal(ins.values[2] - ins.values[3], 25000, 'insurance adjustment');
  assert.equal(loan.values[3] - loan.values[2], 25000, 'loan adjustment');
  for (const r of atb.rows.filter(x => x.kind === 'account' && ![A.insurance, A.equipment_loan].includes(x.accountId))) {
    assert.equal(r.values[2] - r.values[3], 0, `${r.label}: only the adjusting entry is an adjustment`);
  }
  const tb = await t.run('trial_balance', { period: 'today' });
  for (const r of atb.rows.filter(x => x.kind === 'account')) {
    assert.equal((r.values[0] - r.values[1]) + (r.values[2] - r.values[3]), r.values[4] - r.values[5], `${r.label}: unadjusted + adjustments = adjusted`);
    const tr = tb.rows.find(x => x.accountId === r.accountId);
    if (tr) assert.equal(r.values[4] - r.values[5], tr.values[0] - tr.values[1], `${r.label}: adjusted = trial balance`);
  }
  const atbTotal = atb.rows.find(r => r.label === 'Total');
  assert.equal(atbTotal.values[2], atbTotal.values[3], 'adjustment columns balance');

  // Reversing entry: posted in October 1-4, gone from the 5th.
  const { r: rev } = await step('JE with automatic reversal', async () => ledgerId(await ok303(await app.post('/journal', jeBody([
    { account: A.utilities, debit: '80' }, { account: A.card, credit: '80' }], { txn_date: '2026-10-01', reverse_on: '2026-10-05' })))), { accounts: {}, net: 0 });
  const early = await t.run('profit_and_loss', { period: 'custom', from: '2026-10-01', to: '2026-10-04' });
  assert.ok(acctRow(early, A.utilities).values[0] >= 8000);
  const pair = await q('SELECT txn_id FROM txn WHERE reverses_txn_id = $1', [rev]);
  assert.equal(pair.length, 1);
  assert.equal(await sumPostings('txn_id = ANY($1) AND account_id = $2', [[rev, pair[0].txn_id], A.utilities]), 0);

  // A prior-year entry: this year's P&L doesn't move; Retained Earnings does.
  const reBefore = lastRow(await t.run('balance_sheet', { period: 'today' }), /^Retained Earnings$/).values[0];
  await step('prior-year JE', async () => ok303(await app.post('/journal', jeBody([{ account: A.rent, debit: '100' }, { account: A.checking, credit: '100' }], { txn_date: '2025-12-31' }))),
    { accounts: { [A.rent]: 10000, [A.checking]: -10000 }, net: 0 });
  assert.equal(lastRow(await t.run('balance_sheet', { period: 'today' }), /^Retained Earnings$/).values[0], reBefore - 10000, 'last year’s expense lowers Retained Earnings');
  const pl2025 = await t.run('profit_and_loss', { period: 'custom', from: '2025-01-01', to: '2025-12-31' });
  assert.ok(acctRow(pl2025, A.rent).values[0] >= 10000);

  await step('void JE', async () => ok303(await app.post(`/ledger/${je}/void`)),
    { accounts: { [A.rent]: -60000, [A.office]: -7500, [A.checking]: 40000, [A.feed_sales]: 10000, [A.card]: 17500 }, net: 57500 });
  assert.ok((await one('SELECT voided_at FROM txn WHERE txn_id = $1', [je])).voided_at);

  const { r: del } = await step('JE to delete', async () => ledgerId(await ok303(await app.post('/journal', jeBody([{ account: A.bank_fees, debit: '15' }, { account: A.checking, credit: '15' }])))),
    { accounts: { [A.bank_fees]: 1500, [A.checking]: -1500 }, net: -1500 });
  await step('delete JE', async () => ok303(await app.post(`/ledger/${del}/delete`)), { accounts: { [A.bank_fees]: -1500, [A.checking]: 1500 }, net: 1500 });
  assert.equal((await q('SELECT 1 FROM txn WHERE txn_id = $1', [del])).length, 0);
  assert.ok((await one(`SELECT count(*)::int AS n FROM audit_log WHERE table_name = 'txn' AND row_id = $1 AND action = 'delete'`, [del])).n > 0, 'delete audited');
});

// ---------------------------------------------------------------------------------------------------------------------
test('2b. a journal entry line’s customer or vendor name ties it to that customer and vendor everywhere', async () => {
  const hilltop = app.ids.customers.hilltop, landlord = app.ids.vendors.landlord;
  const { r: je } = await step('JE with names on lines', async () => ledgerId(await ok303(await app.post('/journal', jeBody([
    { account: A.checking, debit: '25' }, { account: A.feed_sales, credit: '25', party: `c:${hilltop}` },
    { account: A.rent, debit: '40', party: `v:${landlord}` }, { account: A.checking, credit: '40' }], { memo: 'Named lines' })))),
  { accounts: { [A.checking]: -1500, [A.feed_sales]: -2500, [A.rent]: 4000 }, net: -1500 });
  // P&L by Customer / Expenses by Vendor attribute the lines to the names (postings carry them)…
  const plc = await t.run('pl_by_customer', { period: 'custom', from: TODAY, to: TODAY, columns: 'customer', customer: String(hilltop) });
  assert.ok(acctRow(plc, A.feed_sales).values.at(-1) >= 2500, 'P&L by Customer counts the JE line for Hilltop');
  // …so the transaction lists by name must show the entry too (QBO lists a journal entry under each line’s name).
  const byCust = await t.run('transaction_list_by_customer', { period: 'all', customer: String(hilltop) });
  const byVend = await t.run('transaction_list_by_vendor', { period: 'all', vendor: String(landlord) });
  const custPage = await (await app.get(`/customers/${hilltop}?tab=transactions&date=all`)).text();
  assert.deepEqual({
    'Transaction List by Customer': byCust.rows.some(x => Number(x.txnId) === je),
    'Transaction List by Vendor': byVend.rows.some(x => Number(x.txnId) === je),
    'customer page transactions': custPage.includes(`/ledger/${je}`),
  }, { 'Transaction List by Customer': true, 'Transaction List by Vendor': true, 'customer page transactions': true },
  'a JE with names on its lines is listed under those names');
});

// ---------------------------------------------------------------------------------------------------------------------
test('3. transfers and credit card payments; edit, void, delete', async () => {
  await step('card payment from savings refused', async () =>
    assert.equal((await app.post('/card-payments', { from_account: String(A.savings), to_account: String(A.checking), amount: '5', txn_date: TODAY })).status, 422));
  const { r: tr } = await step('transfer', async () => ledgerId(await ok303(await app.post('/transfers', { from_account: String(A.checking), to_account: String(A.savings),
    amount: '250', txn_date: TODAY, memo: 'To savings', class_id: String(ids.wholesale) }))), { accounts: { [A.checking]: -25000, [A.savings]: 25000 }, net: 0 });
  await t.expectHistory(tr, { activity: false });
  await step('edit transfer', async () => ok303(await app.post(`/transfers/${tr}`, { from_account: String(A.checking), to_account: String(A.savings), amount: '300', txn_date: TODAY })),
    { accounts: { [A.checking]: -5000, [A.savings]: 5000 } });
  const { r: cc } = await step('credit card payment', async () => ledgerId(await ok303(await app.post('/card-payments', { from_account: String(A.checking), to_account: String(A.card),
    amount: '400', txn_date: TODAY }))), { accounts: { [A.checking]: -40000, [A.card]: 40000 }, net: 0 });
  await t.expectHistory(cc, { activity: false });
  await step('void card payment', async () => ok303(await app.post(`/ledger/${cc}/void`)), { accounts: { [A.checking]: 40000, [A.card]: -40000 } });
  await step('delete transfer', async () => ok303(await app.post(`/ledger/${tr}/delete`)), { accounts: { [A.checking]: 30000, [A.savings]: -30000 } });
  const { r: keep } = await step('transfer to keep', async () => ledgerId(await ok303(await app.post('/transfers', { from_account: String(A.checking), to_account: String(A.savings),
    amount: '1000', txn_date: TODAY, memo: 'Reserve' }))), { accounts: { [A.checking]: -100000, [A.savings]: 100000 } });
  ids.transfer = keep;
});

// ---------------------------------------------------------------------------------------------------------------------
test('4. bank deposits: undeposited payments + other income; delete puts payments back', async () => {
  ids.ranch = idIn(await ok303(await app.post('/customers', { displayName: 'Tieout Ranch', active: '1' })), /\/customers\/(\d+)/);
  const ranch = ids.ranch;
  await step('invoice', async () => ok303(await app.post('/txns', salesDoc('invoice', ranch, [{ desc: 'Feed', rate: '1000' }]))),
    { accounts: { ar: 100000, sales: -100000 }, customers: { [ranch]: 100000 }, net: 100000 });
  const inv = await newestTxn('invoice', 'AND customer_id = $3', [ranch]);
  await t.expectHistory(inv.txn_id);
  const pays = [];
  for (const amt of [600, 400]) {
    await step(`payment ${amt}`, async () => ok303(await app.post('/txns', { type: 'payment', customer_id: String(ranch), txn_date: TODAY, amount: String(amt),
      payment_method: 'Check', payment_ref: `CHK-${amt}`, [`apply_${inv.txn_id}`]: String(amt) })),
    { accounts: { undeposited: amt * 100, ar: -amt * 100 }, customers: { [ranch]: -amt * 100 }, net: 0 });
    pays.push((await newestTxn('payment', 'AND customer_id = $3', [ranch])).txn_id);
    await t.expectHistory(pays.at(-1));
  }
  const body = () => {
    const p = new URLSearchParams({ account_id: String(A.savings), txn_date: TODAY, memo: 'Tieout deposit' });
    for (const id of pays) p.append('source', String(id));
    for (const [acc, amt, desc] of [[String(A.interest_income), '12.34', 'Interest'], ['', '', '']]) {
      p.append('other_customer', ''); p.append('other_account', acc); p.append('other_desc', desc); p.append('other_amount', amt);
    }
    return p;
  };
  const expected = { accounts: { [A.savings]: 101234, undeposited: -100000, [A.interest_income]: -1234 }, net: 1234 };
  const { r: dep } = await step('deposit', async () => idIn(await ok303(await app.post('/deposits', body()), 'deposit'), /\/deposits\/(\d+)/), expected);
  await t.expectHistory(dep, { activity: false });
  assert.match(await (await app.get('/deposits')).text(), /\$1,012\.34/);
  assert.match(await (await app.get(`/customers/${ranch}?tab=activity`)).text(), /deposited to Savings/);
  const dd = await t.run('deposit_detail', { period: 'today' });
  const head = dd.rows.findIndex(r => r.txnId === dep && r.txnType === 'deposit');
  assert.equal(dd.rows[head].cells.amount, 101234, 'Deposit Detail total');
  const subs = [];
  for (let i = head + 1; dd.rows[i]?.sub; i++) subs.push(dd.rows[i]);
  assert.equal(subs.reduce((x, r) => x + r.cells.amount, 0), -101234, 'Deposit Detail lines add up to the deposit');
  await step('deposit twice refused', async () => assert.equal((await app.post('/deposits', body())).status, 422));
  await step('delete deposit', async () => ok303(await app.post(`/deposits/${dep}/delete`)),
    { accounts: { [A.savings]: -101234, undeposited: 100000, [A.interest_income]: 1234 }, net: -1234 });
  const waiting = await (await app.get('/deposits/new')).text();
  for (const id of pays) assert.match(waiting, new RegExp(`name="source" value="${id}"`), 'back in Undeposited Funds');
  const { r: dep2 } = await step('deposit again', async () => idIn(await ok303(await app.post('/deposits', body())), /\/deposits\/(\d+)/), expected);
  ids.deposit = dep2;
});

// ---------------------------------------------------------------------------------------------------------------------
test('5. reconcile: start, clear, finish at 0 difference; locked; admin override; undo; report matches', async () => {
  const startPage = await (await app.get(`/reconcile/start?account=${A.savings}&date=${TODAY}`)).text();
  const boxes = [...startPage.matchAll(/name="ids" value="(\d+)" data-amount="(-?\d+)"/g)].map(m => ({ id: Number(m[1]), amount: Number(m[2]) }));
  const beginning = Number(/data-beginning="(-?\d+)"/.exec(startPage)[1]);
  assert.ok(boxes.some(b => b.id === ids.deposit) && boxes.some(b => b.id === ids.transfer), 'deposit and transfer are waiting to clear');
  const s0 = await t.snapshot();
  const ending = beginning + boxes.reduce((s, b) => s + b.amount, 0);
  assert.equal(ending, s0.accounts.get(A.savings), 'clearing everything through today = the savings balance in the ledger');
  const body = end => { const p = new URLSearchParams({ statement_date: TODAY, ending: end }); for (const b of boxes) p.append('ids', String(b.id)); return p; };
  await step('reconcile with a difference refused', async () => {
    const res = await app.post(`/reconcile/${A.savings}`, body(((ending + 100) / 100).toFixed(2)));
    assert.equal(res.status, 422);
    assert.match(await res.text(), /The difference is \$1\.00/);
  });
  assert.equal((await q('SELECT 1 FROM reconciliation WHERE account_id = $1', [A.savings])).length, 0);
  await step('finish reconciliation', async () => ok303(await app.post(`/reconcile/${A.savings}`, body((ending / 100).toFixed(2)))));
  const rec = await one('SELECT * FROM reconciliation WHERE account_id = $1 ORDER BY rec_id DESC LIMIT 1', [A.savings]);
  assert.deepEqual([Number(rec.beginning_cents), Number(rec.ending_cents), rec.completed_by], [beginning, ending, 'operator']);
  const full = await getReconciliation(app.db.pool, { ...t.scope, recId: rec.rec_id });
  assert.equal(full.items.length, boxes.length);
  assert.equal(Number(full.beginning_cents) + full.items.reduce((s, i) => s + i.amount, 0), Number(full.ending_cents), 'report: beginning + cleared = ending');
  const pdf = await app.get(`/reconcile/report/${rec.rec_id}.pdf`);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
  const list = await t.run('reconciliation_reports', { period: 'all' });
  const line = list.rows.find(r => r.href === `/reconcile/report/${rec.rec_id}.pdf`);
  assert.deepEqual([line.cells.beginning, line.cells.ending, Number(line.cells.items)], [beginning, ending, boxes.length]);
  assert.match(await (await app.get(`/reconcile/${A.savings}/history`)).text(), new RegExp(formatCents(ending).replace(/[$.]/g, '\\$&')));
  assert.ok((await one(`SELECT count(*)::int AS n FROM audit_log WHERE table_name = 'reconciliation' AND row_id = $1`, [rec.rec_id])).n > 0, 'reconciliation audited');
  const again = await (await app.get(`/reconcile/start?account=${A.savings}&date=${TODAY}`)).text();
  assert.equal(Number(/data-beginning="(-?\d+)"/.exec(again)[1]), ending, 'next reconciliation starts at this ending balance');
  assert.doesNotMatch(again, /name="ids"/, 'nothing left to clear');

  // Locked: void, edit and deposit delete are refused (nothing changes) unless an admin overrides.
  await step('void reconciled transfer refused', async () => assert.equal((await app.post(`/ledger/${ids.transfer}/void`)).status, 303));
  assert.equal((await one('SELECT voided_at FROM txn WHERE txn_id = $1', [ids.transfer])).voided_at, null);
  await step('edit reconciled transfer refused', async () => {
    const res = await app.post(`/transfers/${ids.transfer}`, { from_account: String(A.checking), to_account: String(A.savings), amount: '1010', txn_date: TODAY });
    assert.equal(res.status, 422);
    const html = await res.text();
    assert.match(html, /was reconciled/);
    assert.match(html, /name="edit_reconciled"/);
  });
  await step('admin override edit', async () => ok303(await app.post(`/transfers/${ids.transfer}`, { from_account: String(A.checking), to_account: String(A.savings),
    amount: '1010', txn_date: TODAY, edit_reconciled: '1' })), { accounts: { [A.checking]: -1000, [A.savings]: 1000 } });
  await step('admin override edit back', async () => ok303(await app.post(`/transfers/${ids.transfer}`, { from_account: String(A.checking), to_account: String(A.savings),
    amount: '1000', txn_date: TODAY, edit_reconciled: '1' })), { accounts: { [A.checking]: 1000, [A.savings]: -1000 } });

  await step('undo last reconciliation', async () => ok303(await app.post(`/reconcile/${A.savings}/undo`)));
  assert.equal((await q('SELECT 1 FROM reconciliation WHERE rec_id = $1', [rec.rec_id])).length, 0);
  assert.equal((await q('SELECT 1 FROM reconciled_item WHERE txn_id = $1', [ids.transfer])).length, 0);
  await step('void after undo', async () => ok303(await app.post(`/ledger/${ids.transfer}/void`)), { accounts: { [A.checking]: 100000, [A.savings]: -100000 } });
  assert.ok((await one('SELECT voided_at FROM txn WHERE txn_id = $1', [ids.transfer])).voided_at);

  // Reconcile again (statement through today) so a non-admin can be tested against it later.
  const { r: tr2 } = await step('another transfer', async () => ledgerId(await ok303(await app.post('/transfers', { from_account: String(A.checking), to_account: String(A.savings),
    amount: '50', txn_date: TODAY }))), { accounts: { [A.checking]: -5000, [A.savings]: 5000 } });
  ids.transfer2 = tr2;
  const p2 = await (await app.get(`/reconcile/start?account=${A.savings}&date=${TODAY}`)).text();
  const b2 = [...p2.matchAll(/name="ids" value="(\d+)" data-amount="(-?\d+)"/g)].map(m => ({ id: Number(m[1]), amount: Number(m[2]) }));
  const beg2 = Number(/data-beginning="(-?\d+)"/.exec(p2)[1]);
  const body2 = new URLSearchParams({ statement_date: TODAY, ending: ((beg2 + b2.reduce((s, b) => s + b.amount, 0)) / 100).toFixed(2) });
  for (const b of b2) body2.append('ids', String(b.id));
  await step('reconcile again', async () => ok303(await app.post(`/reconcile/${A.savings}`, body2)));
});

// ---------------------------------------------------------------------------------------------------------------------
test('5b. a reconciled deposit: delete is refused cleanly (nothing changes), not a server error', async () => {
  const rec = await one('SELECT 1 FROM reconciled_item WHERE txn_id = $1', [ids.deposit]);
  assert.ok(rec, 'the deposit is reconciled');
  await step('delete reconciled deposit', async () => {
    const res = await app.post(`/deposits/${ids.deposit}/delete`);
    assert.notEqual(res.status, 500, 'deleting a reconciled deposit is refused with a message (or an admin override), not a server error');
  });
  assert.equal((await q('SELECT 1 FROM txn WHERE txn_id = $1', [ids.deposit])).length, 1, 'reconciled deposit still there');
});

// ---------------------------------------------------------------------------------------------------------------------
test('5c. reconcile a credit card through a past date, then through today: each ending = the Balance Sheet on that date', async () => {
  const reconcileThrough = async date => {
    const page = await (await app.get(`/reconcile/start?account=${A.card}&date=${date}`)).text();
    const boxes = [...page.matchAll(/name="ids" value="(\d+)" data-amount="(-?\d+)"/g)].map(m => ({ id: m[1], amount: Number(m[2]) }));
    const beginning = Number(/data-beginning="(-?\d+)"/.exec(page)[1]);
    const ending = beginning + boxes.reduce((x, b) => x + b.amount, 0);
    const body = new URLSearchParams({ statement_date: date, ending: (ending / 100).toFixed(2) });
    for (const b of boxes) body.append('ids', b.id);
    await step(`reconcile card through ${date}`, async () => ok303(await app.post(`/reconcile/${A.card}`, body)));
    return ending;
  };
  const owedOn = async date => acctRow(await t.run('balance_sheet', { period: 'custom', to: date }), A.card)?.values[0] ?? 0;
  assert.equal(await reconcileThrough('2026-09-30'), await owedOn('2026-09-30'), 'card statement through 9/30 = BS card balance on 9/30');
  assert.equal(await reconcileThrough(TODAY), await owedOn(TODAY), 'card statement through today = BS card balance today');
  const s = await t.snapshot();
  assert.equal(await owedOn(TODAY), -s.accounts.get(A.card), 'what’s owed on the card = credit balance in the ledger');
});

test('5d. an admin deleting a reconciled transaction leaves the finished reconciliation report adding up', async () => {
  const { r: je } = await step('card charge', async () => ledgerId(await ok303(await app.post('/journal', jeBody([{ account: A.office, debit: '20' }, { account: A.card, credit: '20' }])))),
    { accounts: { [A.office]: 2000, [A.card]: -2000 }, net: -2000 });
  const page = await (await app.get(`/reconcile/start?account=${A.card}&date=2026-10-13`)).text();
  const boxes = [...page.matchAll(/name="ids" value="(\d+)" data-amount="(-?\d+)"/g)].map(m => ({ id: m[1], amount: Number(m[2]) }));
  const beginning = Number(/data-beginning="(-?\d+)"/.exec(page)[1]);
  const ending = beginning + boxes.reduce((x, b) => x + b.amount, 0);
  const body = new URLSearchParams({ statement_date: '2026-10-13', ending: (ending / 100).toFixed(2) });
  for (const b of boxes) body.append('ids', b.id);
  await step('reconcile the charge', async () => ok303(await app.post(`/reconcile/${A.card}`, body)));
  const rec = await one('SELECT rec_id FROM reconciliation WHERE account_id = $1 ORDER BY rec_id DESC LIMIT 1', [A.card]);
  await step('admin deletes it anyway', async () => ok303(await app.post(`/ledger/${je}/delete`, { edit_reconciled: '1' })),
    { accounts: { [A.office]: -2000, [A.card]: 2000 }, net: 2000 });
  const r = await getReconciliation(app.db.pool, { ...t.scope, recId: rec.rec_id });
  assert.equal(Number(r.beginning_cents) + r.items.reduce((x, i) => x + i.amount, 0), Number(r.ending_cents),
    'the finished reconciliation report still adds up (beginning + cleared = ending) after a cleared transaction is deleted');
  assert.ok(r.items.some(i => i.deleted && i.amount !== 0), 'the deleted item stays on the report, from its snapshot');
  // The next reconciliation starts from the last ending and shows the deleted item as a discrepancy (as QBO).
  const next = await (await app.get(`/reconcile/start?account=${A.card}&date=2026-10-14`)).text();
  assert.match(next, /Reconciliation discrepancy/);
  assert.match(next, /now deleted/);
});

// ---------------------------------------------------------------------------------------------------------------------
test('6. time tracking: entries do not post; billable time invoiced once; weekly timesheet', async () => {
  const ranch = ids.ranch, item = app.ids.items.freight;
  const { a, b } = await step('time entry', async () => ok303(await app.post('/time', { date: TODAY, job: `c:${ranch}`, item_id: String(item), hours: '2', billable: '1', notes: 'Hauling' })));
  assert.equal(b.counts.txns, a.counts.txns, 'time is not a transaction');
  assert.equal(b.counts.postings, a.counts.postings);
  const sheet = new URLSearchParams({ monday: '2026-10-12' });
  sheet.append('ts_job', `c:${ranch}`); sheet.append('ts_item', String(item)); sheet.append('ts_billable', '1');
  for (const [d, h] of ['2', '', '', '', '', '', ''].entries()) sheet.append(`ts_d${d}`, h);
  sheet.append('ts_job', `c:${ranch}`); sheet.append('ts_item', String(item)); sheet.append('ts_billable', '1');
  for (const [d, h] of ['', '1:30', '', '', '', '', ''].entries()) sheet.append(`ts_d${d}`, h);
  sheet.append('ts_job', ''); sheet.append('ts_item', ''); sheet.append('ts_billable', '');
  for (const [d, h] of ['0.5', '', '', '', '', '', ''].entries()) sheet.append(`ts_d${d}`, h);
  await step('weekly timesheet', async () => ok303(await app.post('/time/week', sheet)));
  const week = await q(`SELECT minutes, billable FROM time_entry WHERE entry_date BETWEEN '2026-10-12' AND '2026-10-18' ORDER BY minutes DESC`);
  assert.deepEqual(week.map(e => [e.minutes, e.billable]), [[120, true], [90, true], [30, false]]);
  const editor = await (await app.get(`/txns/new?type=invoice&customer=${ranch}&billable=1`)).text();
  const times = [...editor.matchAll(/name="line_time" value="(\d+)"/g)].map(m => m[1]);
  assert.equal(times.length, 2);
  const lines = times.map((time, i) => ({ item, desc: 'Hauling', qty: i ? '1.5' : '2', rate: '150', time }));
  await step('invoice billable time', async () => ok303(await app.post('/txns', salesDoc('invoice', ranch, lines))),
    { accounts: { ar: 52500, [A.delivery_income]: -52500 }, customers: { [ranch]: 52500 }, net: 52500 });
  const inv = await newestTxn('invoice', 'AND customer_id = $3', [ranch]);
  await t.expectHistory(inv.txn_id);
  await step('time billed once', async () => assert.equal((await app.post('/txns', salesDoc('invoice', ranch, lines))).status, 422));
  const unbilled = await t.run('unbilled_time', { period: 'today' });
  assert.ok(!JSON.stringify(unbilled.rows).includes('Tieout Ranch'), 'nothing unbilled left for the ranch');
  // Voiding the invoice frees the time to bill again (and takes the income back out).
  await step('void time invoice', async () => ok303(await app.post(`/txns/${inv.txn_id}/void`)),
    { accounts: { ar: -52500, [A.delivery_income]: 52500 }, customers: { [ranch]: -52500 }, net: -52500 });
  assert.match(await (await app.get(`/customers/${ranch}`)).text(), /Unbilled time: 3\.5 hours/);
  await step('re-invoice billable time', async () => ok303(await app.post('/txns', salesDoc('invoice', ranch, lines))),
    { accounts: { ar: 52500, [A.delivery_income]: -52500 }, customers: { [ranch]: 52500 }, net: 52500 });
});

// ---------------------------------------------------------------------------------------------------------------------
test('7. classes, locations, tags: by-class and by-location P&L add up to the plain P&L; tags filter', async () => {
  const ranch = ids.ranch;
  await step('classed, located, tagged invoice', async () => ok303(await app.post('/txns', salesDoc('invoice', ranch, [{ desc: 'Retail feed', rate: '200' }],
    { class_id: String(ids.retail), location_id: String(ids.north), tags_shown: '1' }, [['tag_ids', String(ids.promo)]]))),
  { accounts: { ar: 20000, sales: -20000 }, customers: { [ranch]: 20000 }, net: 20000 });
  ids.promoInvoice = (await newestTxn('invoice', 'AND customer_id = $3', [ranch])).txn_id;
  await step('classed JE', async () => ok303(await app.post('/journal', jeBody([{ account: A.rent, debit: '300', cls: ids.wholesale }, { account: A.checking, credit: '300' }]))),
    { accounts: { [A.rent]: 30000, [A.checking]: -30000 }, net: -30000 });

  const plain = await t.run('profit_and_loss', { period: 'this_year_to_date' });
  for (const [key, columns, dim, wanted] of [['pl_by_class', 'class', 'class', { [ids.retail]: 20000, [ids.wholesale]: -30000 }],
    ['pl_by_location', 'location', 'location', { [ids.north]: 20000 }]]) {
    const r = await t.run(key, { period: 'this_year_to_date', columns });
    const parts = r.columns.map((c, i) => ({ ...c, i })).filter(c => !c.base?.total);
    const totalCol = r.columns.findIndex(c => c.base?.total);
    for (const row of r.rows.filter(x => x.values)) {
      assert.equal(parts.reduce((s, c) => s + row.values[c.i], 0), row.values[totalCol], `${key} ${row.label}: columns add up to total`);
      const p = row.accountId ? acctRow(plain, row.accountId) : lastRow(plain, new RegExp(`^${row.label.replace(/[()]/g, '\\$&')}$`));
      if (p && row.kind !== 'section') assert.equal(row.values[totalCol], p.values[0], `${key} ${row.label}: total = plain P&L`);
    }
    const ni = lastRow(r, /^Net Income$/);
    for (const [id, cents] of Object.entries(wanted)) {
      const col = r.columns.findIndex(c => c.base?.dim?.[1] === Number(id));
      assert.ok(col >= 0, `${key}: a column for ${id}`);
      assert.equal(ni.values[col], cents, `${key}: net income of ${dim} ${id}`);
    }
    // Filtering by one class / location gives that column.
    for (const [id, cents] of Object.entries(wanted)) assert.equal(netIncome(await t.run('profit_and_loss', { period: 'this_year_to_date', [dim]: id })), cents);
  }
  assert.equal(netIncome(await t.run('profit_and_loss', { period: 'this_year_to_date', tag: String(ids.promo) })), 20000, 'tag filter: only the tagged invoice');
  const tagged = await (await app.get(`/customers/${ranch}?tab=transactions&date=all&tag=${ids.promo}`)).text();
  assert.match(tagged, new RegExp(`/txns/${ids.promoInvoice}`));
  assert.doesNotMatch(tagged, /\$1,000\.00/, 'the untagged invoice is filtered out');
});

// ---------------------------------------------------------------------------------------------------------------------
test('8. budgets: amounts don’t post; Budget vs Actuals actual column = the P&L', async () => {
  const { r: id } = await step('create budget', async () => idIn(await ok303(await app.post('/budgets', { name: 'FY2026 tie-out', fiscalYear: '2026', subdivide: 'none', startFrom: 'blank' })),
    /\/budgets\/(\d+)/));
  const cells = {};
  for (let m = 1; m <= 12; m++) cells[`c_${A.rent}_${m}`] = '2500';
  cells[`c_${A.feed_sales}_1`] = '10000';
  await step('budget amounts', async () => ok303(await app.post(`/budgets/${id}`, cells)));
  const bva = await t.run('budget_vs_actuals', { period: 'this_fiscal_year_to_date', budget: String(id) });
  const pl = await t.run('profit_and_loss', { period: 'this_fiscal_year_to_date' });
  for (const r of pl.rows.filter(x => x.kind === 'account' && x.values[0] !== 0)) {
    assert.equal(acctRow(bva, r.accountId)?.values[0], r.values[0], `BvA actual ${r.label} = P&L`);
  }
  assert.equal(lastRow(bva, /^Net Income$/).values[0], netIncome(pl), 'BvA actual net income = P&L');
  assert.equal(acctRow(bva, A.rent).values[1], 10 * 250000, 'budget Jan-Oct for rent');
  assert.equal(acctRow(bva, A.feed_sales).values[1], 1000000);
});

// ---------------------------------------------------------------------------------------------------------------------
test('9. multicurrency: foreign invoice/payment and bill/payment, revaluation and its reversal; A/R and A/P tie', async () => {
  await step('turn on multicurrency + EUR', async () => {
    await ok303(await app.post('/settings/currencies/on'));
    await ok303(await app.post('/settings/currencies', { code: 'EUR', rate: '1.10', date: '2026-10-01' }));
  });
  const lyon = idIn(await ok303(await app.post('/customers', { displayName: 'Lyon Haras', currency: 'EUR', active: '1' })), /\/customers\/(\d+)/);
  const ams = idIn(await ok303(await app.post('/vendors', { displayName: 'Amsterdam Seeds', currency: 'EUR' })), /\/vendors\/(\d+)/);
  await step('EUR invoice 100 @1.10', async () => ok303(await app.post('/txns', salesDoc('invoice', lyon, [{ desc: 'Export', rate: '100' }], { txn_date: '2026-10-02', exchange_rate: '1.10' }))),
    { accounts: { ar: 11000, sales: -11000 }, customers: { [lyon]: 11000 }, net: 11000 });
  const inv = await newestTxn('invoice', 'AND customer_id = $3', [lyon]);
  await t.expectHistory(inv.txn_id);
  await step('EUR payment 40 @1.05', async () => ok303(await app.post('/txns', { type: 'payment', customer_id: String(lyon), txn_date: '2026-10-05', amount: '40',
    payment_method: 'Wire', exchange_rate: '1.05', [`apply_${inv.txn_id}`]: '40' })),
  { accounts: { ar: -4400, undeposited: 4200, fx_gain_loss: 200 }, customers: { [lyon]: -4400 }, net: -200 });
  await step('EUR bill 200 @1.10', async () => ok303(await app.post('/vtxns', vendorDoc('bill', ams, [{ account: A.feed_purchases, amount: '200', desc: 'Seed' }],
    { txn_date: '2026-10-03', doc_number: 'AS-77', exchange_rate: '1.10' }))),
  { accounts: { ap: -22000, [A.feed_purchases]: 22000 }, vendors: { [ams]: 22000 }, net: -22000 });
  const bill = await newestTxn('bill', 'AND vendor_id = $3', [ams]);
  await t.expectHistory(bill.txn_id);
  await app.post(`/vtxns/${bill.txn_id}/approve`);
  await step('EUR bill payment 50 @1.00', async () => ok303(await app.post('/pay-bills', { account_id: String(A.checking), txn_date: '2026-10-06', method: 'Other',
    bill: String(bill.txn_id), [`pay_${bill.txn_id}`]: '50', rate_EUR: '1.00' })),
  { accounts: { ap: 5500, [A.checking]: -5000, fx_gain_loss: -500 }, vendors: { [ams]: -5500 }, net: 500 });

  // The EUR payment banks at what it was worth when received (EUR 40 x 1.05), not at the invoice's rate.
  const eurPay = await newestTxn('payment', 'AND customer_id = $3', [lyon]);
  const depBody = new URLSearchParams({ account_id: String(A.checking), txn_date: '2026-10-06', source: String(eurPay.txn_id) });
  await step('deposit the EUR payment', async () => ok303(await app.post('/deposits', depBody)), { accounts: { [A.checking]: 4200, undeposited: -4200 }, net: 0 });

  // Unrealized: EUR 60 open on the invoice (carried 6,600) and EUR 150 on the bill (carried 16,500), revalued at 1.20.
  await ok303(await app.post('/settings/currencies/EUR/rate', { rate: '1.20', date: '2026-10-08' }));
  const ufx = S.fx_unrealized;
  await step('revalue at 10/08', async () => ok303(await app.post('/settings/currencies/revalue', { date: '2026-10-08' }), 'revalue'), { accounts: {}, net: 0 });
  const [rev, back] = await q(`SELECT txn_id, txn_date FROM txn WHERE type = 'fx_revaluation' ORDER BY txn_date`);
  assert.deepEqual([rev.txn_date, back.txn_date], ['2026-10-08', '2026-10-09']);
  assert.equal(await sumPostings('txn_id = $1 AND account_id = $2', [rev.txn_id, S.ar]), 600, 'A/R up EUR 60 x 0.10');
  assert.equal(await sumPostings('txn_id = $1 AND account_id = $2', [rev.txn_id, S.ap]), -1500, 'A/P up EUR 150 x 0.10');
  assert.equal(await sumPostings('txn_id = $1 AND account_id = $2', [rev.txn_id, ufx]), 900, 'unrealized loss 900');
  assert.equal(await sumPostings('txn_id = $1', [back.txn_id]) , 0);
  assert.equal(await sumPostings('txn_id = ANY($1) AND account_id = ANY($2)', [[rev.txn_id, back.txn_id], [S.ar, S.ap, ufx]]), 0, 'the pair nets to zero');
  await t.expectHistory(rev.txn_id, { activity: false });
  // Why ledgerCheck leaves revaluations out of the A/R-A/P subledger check: open items stay at their booked (historic)
  // amounts; the revaluation and its next-day reversal net to zero in the all-time ledger. On the revaluation date the
  // Balance Sheet carries A/R and A/P at the new rate while the agings stay at the booked amounts — exactly the revaluation apart.
  const on = async (key, to) => t.run(key, { period: 'custom', from: '2026-01-01', to });
  const agingTotal = r => r.rows.filter(x => x.partyId).reduce((s, x) => s + x.values.at(-1), 0);
  const bsOn = await on('balance_sheet', '2026-10-08');
  assert.equal(lastRow(bsOn, /^Total for Accounts Receivable$/).values[0] - agingTotal(await on('ar_aging_summary', '2026-10-08')), 600, 'BS A/R - aging = revaluation (10/08)');
  assert.equal(lastRow(bsOn, /^Total for Accounts Payable$/).values[0] - agingTotal(await on('ap_aging_summary', '2026-10-08')), 1500, 'BS A/P - aging = revaluation (10/08)');
  const bsNext = await on('balance_sheet', '2026-10-09');
  assert.equal(lastRow(bsNext, /^Total for Accounts Receivable$/).values[0], agingTotal(await on('ar_aging_summary', '2026-10-09')), 'reversed the next day: BS A/R = aging');
  assert.equal(lastRow(bsNext, /^Total for Accounts Payable$/).values[0], agingTotal(await on('ap_aging_summary', '2026-10-09')), 'reversed: BS A/P = aging');
  const unreal = await t.run('unrealized_gains_losses', { period: 'custom', to: '2026-10-08' });
  assert.equal(unreal.rows.find(r => r.kind === 'total').cells.amount, -900, 'Unrealized Gains & Losses report = the revaluation entry');
  const plOct8 = await t.run('profit_and_loss', { period: 'custom', from: '2026-10-08', to: '2026-10-08' });
  assert.equal(acctRow(plOct8, ufx)?.values[0], 900, 'unrealized loss on the P&L that day');
  const realized = await t.run('realized_gains_losses', { period: 'custom', from: '2026-10-01', to: TODAY });
  const realTotal = realized.rows.find(r => r.kind === 'total')?.cells?.amount;
  assert.equal(Math.abs(realTotal), 300, 'realized: 200 loss on the payment, 500 gain on the bill payment');
  await step('revaluation can’t be voided', async () => assert.equal((await app.post(`/ledger/${rev.txn_id}/void`)).status, 303));
  assert.equal((await one('SELECT voided_at FROM txn WHERE txn_id = $1', [rev.txn_id])).voided_at, null);
  await step('second revaluation same date refused', async () => assert.equal((await app.post('/settings/currencies/revalue', { date: '2026-10-08' })).status, 422));
});

// ---------------------------------------------------------------------------------------------------------------------
test('10. import lists (no postings) and export: the workbook equals the ledger and trial balance', async () => {
  const upload = (path, fields) => { const fd = new FormData(); fd.set('csrf', app.csrf); for (const [k, v] of Object.entries(fields)) fd.set(k, v); return app.raw(path, { method: 'POST', body: fd }); };
  const { a, b } = await step('import customers, items, accounts', async () => {
    await ok303(await upload('/import/customers', { csv: 'Name,Email\nImported Farm,if@example.com\n', step: 'import' }));
    await ok303(await upload('/import/items', { csv: 'Name,Type,Price,Income account\nImported Bale,Product,12.50,Hay Sales\n', step: 'import' }));
    await ok303(await upload('/import/accounts', { csv: 'Name,Number,Type,Parent\nImported Expense,6970,Expense,\n', step: 'import' }));
  });
  assert.equal(b.counts.txns, a.counts.txns);
  const imported = (await one(`SELECT customer_id FROM customer WHERE display_name = 'Imported Farm'`)).customer_id;
  assert.equal(b.cust.get(imported).openCents, 0);

  const res = await app.get('/export/books.xlsx');
  assert.equal(res.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  const s = await t.snapshot();
  const cents = v => Math.round(Number(v ?? 0) * 100);
  const coa = wb.getWorksheet('Chart of accounts');
  const byName = new Map((await q('SELECT account_id, name FROM account WHERE entity_id = $1', [app.ids.entityId])).map(r => [r.name, r.account_id]));
  coa.eachRow((row, i) => {
    if (i === 1) return;
    const id = byName.get(row.getCell(2).value);
    assert.equal(cents(row.getCell(5).value), s.accounts.get(id) ?? 0, `export CoA balance ${row.getCell(2).value}`);
  });
  const glBy = new Map();
  let debits = 0, credits = 0;
  wb.getWorksheet('General ledger').eachRow((row, i) => {
    if (i === 1) return;
    const d = cents(row.getCell(8).value), c = cents(row.getCell(9).value);
    debits += d; credits += c;
    const id = byName.get(row.getCell(6).value);
    glBy.set(id, (glBy.get(id) ?? 0) + d - c);
  });
  assert.equal(debits, s.check.debits, 'exported GL debits = ledger debits');
  assert.equal(credits, s.check.credits);
  for (const r of s.tb.rows.filter(x => x.accountId && !s.pnlIds.has(x.accountId) && x.accountId !== S.retained)) {
    assert.equal(glBy.get(r.accountId) ?? 0, r.values[0] - r.values[1], `exported GL ${r.label} = trial balance`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
const cookieOf = res => (res.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).filter(c => !/=$/.test(c)).join('; ');
const formPost = (path, body, cookie) => fetch(app.base + path, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  body: (body instanceof URLSearchParams ? body : new URLSearchParams(body)).toString() });
async function invitedClient(name, email, role) {
  const res = await app.post('/settings/users', { name, email, role, canApproveBills: '' });
  assert.equal(res.status, 200);
  const path = /\/invite\/([A-Za-z0-9_-]{43})/.exec(await res.text())[0];
  const pageRes = await fetch(app.base + path);
  const nonceCookie = cookieOf(pageRes);
  const html = await pageRes.text();
  const nonce = /name="nonce" value="([^"]+)"/.exec(html)[1];
  const secret = /class="secret">([A-Z2-7 ]+)</.exec(html)[1].replace(/ /g, '');
  app.advance(30_000);
  const done = await formPost(path, { nonce, password: 'correct horse battery', password2: 'correct horse battery', code: makeTotp(secret).generate({ timestamp: app.clock() }) }, nonceCookie);
  assert.equal(done.status, 303);
  const cookie = cookieOf(done).split('; ').find(c => c.startsWith('fb_session='));
  let csrf = null;
  const get = p => fetch(app.base + p, { redirect: 'manual', headers: { cookie } });
  return {
    get,
    async post(p, body = {}) {
      if (!csrf) { const home = loc(await get('/')); csrf = /name="csrf" value="([0-9a-f]+)"/.exec(await (await get(home)).text())[1]; }
      const params = body instanceof URLSearchParams ? new URLSearchParams(body) : new URLSearchParams(body);
      params.set('csrf', csrf);
      return formPost(p, params, cookie);
    },
  };
}
const actorOf = async txnId => (await one(`SELECT actor FROM audit_log WHERE table_name = 'txn' AND row_id = $1 AND action = 'insert' ORDER BY audit_id LIMIT 1`, [txnId]))?.actor;

test('11. users and roles: each does only what the role allows, and is the actor for it', async () => {
  const sam = await invitedClient('Sam Standard', 'sam@sample.example', 'standard');
  const cara = await invitedClient('Cara Customers', 'cara@sample.example', 'customers');
  const vic = await invitedClient('Vic Vendors', 'vic@sample.example', 'vendors');
  const rita = await invitedClient('Rita Reports', 'rita@sample.example', 'reports');
  const forbidden = async (label, who, path, body) => {
    const { a, b } = await step(label, async () => assert.equal((await who.post(path, body)).status, 403, label));
    assert.deepEqual(b.counts.txns, a.counts.txns, `${label}: nothing created`);
  };
  // Standard: journal entries yes; chart of accounts, currencies and undoing a reconciliation no.
  const { r: samJe } = await step('standard posts a JE', async () => ledgerId(await ok303(await sam.post('/journal', jeBody([{ account: A.office, debit: '12.34' }, { account: A.checking, credit: '12.34' }])))),
    { accounts: { [A.office]: 1234, [A.checking]: -1234 }, net: -1234 });
  assert.equal(await actorOf(samJe), 'Sam Standard');
  await forbidden('standard: new account', sam, '/settings/accounts', { name: 'Sneaky', type: 'expense', active: '1' });
  await forbidden('standard: revalue', sam, '/settings/currencies/revalue', { date: TODAY });
  await forbidden('standard: undo reconciliation', sam, `/reconcile/${A.savings}/undo`, {});
  assert.equal((await q('SELECT 1 FROM reconciliation WHERE account_id = $1', [A.savings])).length, 1, 'reconciliation still there');
  // A reconciled transaction stays locked for a non-admin even if they send the override.
  await step('standard: override ignored', async () => assert.equal((await sam.post(`/ledger/${ids.transfer2}/void`, { edit_reconciled: '1' })).status, 303));
  assert.equal((await one('SELECT voided_at FROM txn WHERE txn_id = $1', [ids.transfer2])).voided_at, null, 'reconciled transfer not voided by a standard user');
  await step('standard: edit with override ignored', async () => assert.equal((await sam.post(`/transfers/${ids.transfer2}`, { from_account: String(A.checking),
    to_account: String(A.savings), amount: '55', txn_date: TODAY, edit_reconciled: '1' })).status, 422));

  // Customers only: invoices and deposits yes; journal entries, bills, transfers no.
  await forbidden('customers: JE', cara, '/journal', jeBody([{ account: A.office, debit: '1' }, { account: A.checking, credit: '1' }]));
  await forbidden('customers: bill', cara, '/vtxns', vendorDoc('bill', app.ids.vendors.office, [{ account: A.office, amount: '5' }]));
  await forbidden('customers: transfer', cara, '/transfers', { from_account: String(A.checking), to_account: String(A.savings), amount: '5', txn_date: TODAY });
  await step('customers: invoice', async () => ok303(await cara.post('/txns', salesDoc('invoice', ids.ranch, [{ desc: 'Cara sale', rate: '45' }]))),
    { accounts: { ar: 4500, sales: -4500 }, customers: { [ids.ranch]: 4500 }, net: 4500 });
  const caraInv = (await newestTxn('invoice', 'AND customer_id = $3', [ids.ranch])).txn_id;
  assert.equal(await actorOf(caraInv), 'Cara Customers');
  assert.equal((await one('SELECT actor FROM activity_event WHERE txn_id = $1 ORDER BY event_id LIMIT 1', [caraInv]))?.actor, 'Cara Customers');

  // Vendors only: bills yes; invoices and journal entries no.
  await forbidden('vendors: invoice', vic, '/txns', salesDoc('invoice', ids.ranch, [{ desc: 'x', rate: '5' }]));
  await forbidden('vendors: JE', vic, '/journal', jeBody([{ account: A.office, debit: '1' }, { account: A.checking, credit: '1' }]));
  await forbidden('vendors: deposit', vic, '/deposits', { account_id: String(A.savings), txn_date: TODAY, other_account: String(A.interest_income), other_amount: '1' });
  const office = app.ids.vendors.office;
  await step('vendors: bill', async () => ok303(await vic.post('/vtxns', vendorDoc('bill', office, [{ account: A.office, amount: '33', desc: 'Paper' }], { doc_number: 'VIC-1' }))),
    { accounts: { ap: -3300, [A.office]: 3300 }, vendors: { [office]: 3300 }, net: -3300 });
  const vicBill = (await newestTxn('bill', 'AND vendor_id = $3', [office])).txn_id;
  assert.equal(await actorOf(vicBill), 'Vic Vendors');

  // Reports only: looks, never changes.
  await forbidden('reports: deposit', rita, '/deposits', { account_id: String(A.savings), txn_date: TODAY, other_account: String(A.interest_income), other_amount: '1' });
  await forbidden('reports: invoice', rita, '/txns', salesDoc('invoice', ids.ranch, [{ desc: 'x', rate: '5' }]));
  await forbidden('reports: time', rita, '/time', { date: TODAY, hours: '1' });
  assert.equal((await rita.get('/reports/r/trial_balance')).status, 200);
  const audit = await t.run('audit_log', { period: 'custom', from: '2026-01-01', to: '2027-12-31' });
  for (const name of ['Sam Standard', 'Cara Customers', 'Vic Vendors']) assert.ok(JSON.stringify(audit.rows).includes(name), `${name} in the audit log report`);
});

// ---------------------------------------------------------------------------------------------------------------------
test('12. settings that change postings: cash vs accrual, default terms, discount and shipping', async () => {
  // Cash basis: the reports switch by default; Home follows.
  await step('switch to cash', async () => ok303(await app.post('/settings/accounting', { ...ACCOUNTING, method: 'cash' })));
  const dflt = await t.run('profit_and_loss', { period: 'this_year_to_date' }, null);
  const cash = await t.run('profit_and_loss', { period: 'this_year_to_date' }, 'cash');
  const accrual = await t.run('profit_and_loss', { period: 'this_year_to_date' }, 'accrual');
  assert.equal(dflt.basisLabel, 'Cash basis');
  assert.equal(netIncome(dflt), netIncome(cash));
  assert.notEqual(netIncome(cash), netIncome(accrual), 'open invoices make the bases differ');
  assert.equal((await homeData(app.db.pool, { ...t.scope, today: TODAY })).basis, 'cash');
  // An unpaid invoice moves the accrual P&L only.
  const before = { cash: netIncome(cash), accrual: netIncome(accrual) };
  await step('invoice under cash method', async () => ok303(await app.post('/txns', salesDoc('invoice', ids.ranch, [{ desc: 'Cash-basis check', rate: '70' }]))),
    { accounts: { ar: 7000, sales: -7000 }, customers: { [ids.ranch]: 7000 }, net: 7000 });
  assert.equal(netIncome(await t.run('profit_and_loss', { period: 'this_year_to_date' }, 'cash')), before.cash, 'cash P&L unchanged by an unpaid invoice');
  assert.equal(netIncome(await t.run('profit_and_loss', { period: 'this_year_to_date' }, 'accrual')), before.accrual + 7000);
  await step('back to accrual', async () => ok303(await app.post('/settings/accounting', ACCOUNTING)));
  assert.equal((await t.run('profit_and_loss', { period: 'this_year_to_date' }, null)).basisLabel, 'Accrual basis');

  // Default terms and discount / shipping accounts.
  const net30 = (await one('SELECT terms_id FROM terms WHERE org_id = $1 AND due_days = 30', [app.ids.orgId])).terms_id;
  await ok303(await app.post('/settings/sales', { customNumbers: '1', discount: '1', shipping: '1', defaultTermsId: String(net30), defaultDelivery: 'none',
    statementKind: 'balance_forward', statementAging: '1' }));
  const plain = idIn(await ok303(await app.post('/customers', { displayName: 'Terms Test Farm', active: '1' })), /\/customers\/(\d+)/);
  await step('discounted invoice with shipping', async () => ok303(await app.post('/txns', salesDoc('invoice', plain, [{ desc: 'Feed', qty: '2', rate: '50' }],
    { discount_kind: 'percent', discount_value: '10', shipping: '15' }))),
  { accounts: { ar: 10500, sales: -10000, discounts: 1000, shipping_income: -1500 }, customers: { [plain]: 10500 }, net: 10500 });
  const inv = await newestTxn('invoice', 'AND customer_id = $3', [plain]);
  assert.equal(inv.due_date, '2026-11-11', 'company default terms Net 30');
  const pl = await t.run('profit_and_loss', { period: 'custom', from: TODAY, to: TODAY, customer: String(plain) });
  assert.equal(netIncome(pl), 10500, 'P&L for the customer: sales − discount + shipping');
  await ok303(await app.post('/settings/sales', { customNumbers: '1', defaultDelivery: 'none', statementKind: 'balance_forward', statementAging: '1' }));
});

// ---------------------------------------------------------------------------------------------------------------------
test('13. Home, Overview and list pages agree with the ledger and agings', async () => {
  const s = await t.snapshot();
  t.checkTied(s, 'before lists');
  const ar = s.accounts.get(S.ar), ap = -s.accounts.get(S.ap), uf = s.accounts.get(S.undeposited);
  const list = (slug, query = {}) => listCompanyTxns(app.db.pool, { ...t.scope, slug, filters: listFilters(slug, query, TODAY), today: TODAY, pageSize: 1 });
  const unpaidInv = await list('invoices', { status: 'unpaid' });
  const unappliedSales = await list('sales-transactions', { status: 'unapplied' });
  assert.equal(unpaidInv.open + unappliedSales.open, ar, 'unpaid invoices + unapplied credits (signed negative) = A/R');
  const unpaidBills = await list('bills', { status: 'unpaid' }), receipts = await list('item-receipts', { status: 'unpaid' });
  const unappliedExp = await list('expense-transactions', { type: 'vendor_credit', status: 'open' });
  assert.equal(unpaidBills.open + receipts.open + unappliedExp.open, ap, 'unpaid bills + item receipts + vendor credits (signed negative) = A/P');
  assert.ok(unappliedSales.open <= 0 && unappliedExp.open <= 0, 'credits count against the balance');
  const overdue = await list('invoices', { status: 'overdue' }), notDue = await list('invoices', { status: 'not_due' });
  assert.equal(overdue.open + notDue.open, unpaidInv.open, 'overdue + not due = unpaid');
  // The pages show the same totals.
  assert.match(await (await app.get('/invoices?status=unpaid')).text(), new RegExp(formatCents(unpaidInv.open).replace(/[$.]/g, '\\$&')));
  assert.match(await (await app.get('/bills?status=unpaid')).text(), new RegExp(formatCents(unpaidBills.open).replace(/[$.]/g, '\\$&')));
  for (const p of ['/sales-transactions', '/expense-transactions', '/bill-payments', '/item-receipts', '/estimates', '/projects', '/home',
    '/overview/sales', '/overview/expenses', '/overview/customers', '/overview/projects', '/overview/inventory']) {
    assert.equal((await app.get(p)).status, 200, p);
  }
  // Every invoice in the company list is one the A/R aging knows about.
  const allInv = await listCompanyTxns(app.db.pool, { ...t.scope, slug: 'invoices', filters: listFilters('invoices', { status: 'unpaid' }, TODAY), today: TODAY, pageSize: 5000 });
  assert.equal(allInv.rows.reduce((x, r) => x + r.open_cents, 0), unpaidInv.open);

  const so = await salesOverview(app.db.pool, { ...t.scope, today: TODAY });
  assert.equal(so.ar.open, ar, 'Sales overview A/R = ledger');
  assert.equal(so.ar.overdue + so.ar.notDue + so.ar.credits, ar, "overdue + not due + (negative) unapplied credits = A/R");
  assert.equal(so.undeposited, uf, 'Sales overview undeposited = ledger');
  const thisMonth = await t.run('profit_and_loss', { period: 'custom', from: '2026-10-01', to: TODAY });
  assert.equal(so.months.at(-1).value, lastRow(thisMonth, /^Total for Income$/).values[0], 'Sales overview this month = P&L income');
  const eo = await expensesOverview(app.db.pool, { ...t.scope, today: TODAY });
  assert.equal(eo.ap.open, ap, 'Expenses overview A/P = ledger');
  const exp30 = await t.run('profit_and_loss', { period: 'custom', from: '2026-09-13', to: TODAY });
  const spend = ['Total for Cost of Goods Sold', 'Total for Expenses', 'Total for Other Expenses'].reduce((x, l) => x + (lastRow(exp30, new RegExp(`^${l}$`))?.values[0] ?? 0), 0);
  assert.equal(eo.spent30, spend, 'Expenses overview last 30 days = P&L COGS + expenses');
  const co = await customersOverview(app.db.pool, { ...t.scope, today: TODAY });
  assert.equal(co.ar.open, ar);
  const io = await inventoryOverview(app.db.pool, t.scope);
  assert.equal(io.value, s.check.inventoryOnHand, 'Inventory overview = inventory on hand');
  const po = await projectsOverview(app.db.pool, t.scope);
  const projects = await listAllProjects(app.db.pool, t.scope);
  assert.equal(po.income, projects.reduce((x, p) => x + p.income_cents, 0));
  const home = await homeData(app.db.pool, { ...t.scope, today: TODAY });
  for (const b of home.banks) assert.equal(b.balance, (s.accounts.get(b.id) ?? 0) * (b.type === 'credit_card' ? -1 : 1), `Home ${b.name} = ledger`);
  assert.equal(home.months.at(-1).net, netIncome(thisMonth), 'Home this month = P&L');
  assert.equal(home.ap.open, ap);
  // Statement of Cash Flows: cash = the bank accounts; the change is explained by the sections.
  const cf = await t.run('statement_of_cash_flows', { period: 'this_year_to_date' });
  const cfv = re => lastRow(cf, re).values[0];
  const bankIds = (await q(`SELECT account_id FROM account WHERE entity_id = $1 AND type = 'bank'`, [app.ids.entityId])).map(r => r.account_id);
  assert.equal(cfv(/^Cash at end of period$/), bankIds.reduce((x, id) => x + (s.accounts.get(id) ?? 0), 0), 'cash at end = bank balances');
  const bsStart = await t.run('balance_sheet', { period: 'custom', to: '2025-12-31' });
  assert.equal(cfv(/^Cash at beginning of period$/), lastRow(bsStart, /^Total for Bank Accounts$/)?.values[0] ?? 0, 'cash at beginning = bank balances on 12/31');
  assert.equal(cfv(/^Cash at end of period$/) - cfv(/^Cash at beginning of period$/), cfv(/^Net cash increase for period$/));
  assert.equal(cfv(/^Net cash provided by operating activities$/) + cfv(/^Net cash provided by investing activities$/) + cfv(/^Net cash provided by financing activities$/),
    cfv(/^Net cash increase for period$/));
  // Account List and the General Ledger end where the ledger does.
  const DEBIT_NORMAL = ['bank', 'accounts_receivable', 'other_current_asset', 'inventory', 'fixed_asset', 'other_asset'];
  const typeOf = new Map((await q('SELECT account_id, type FROM account WHERE entity_id = $1', [app.ids.entityId])).map(r => [r.account_id, r.type]));
  const normal = id => (s.accounts.get(id) ?? 0) * (DEBIT_NORMAL.includes(typeOf.get(id)) ? 1 : -1);
  const al = await t.run('account_list', { period: 'today' });
  for (const r of al.rows.filter(x => x.accountId && !s.pnlIds.has(x.accountId) && x.accountId !== S.retained)) {
    assert.equal(r.cells.balance, normal(r.accountId), `Account List ${r.cells.account} = ledger`);
  }
  const gl = await t.run('general_ledger', { period: 'this_month' });
  let section = null;
  for (const r of gl.rows) {
    if (r.kind === 'section') section = r.accountId;
    if (r.kind === 'total' && section && !s.pnlIds.has(section) && section !== S.retained && /^Total for /.test(r.label)) {
      assert.equal(r.cells.balance, normal(section), `GL ${r.label} ends at the ledger balance`);
    }
  }
  const journal = await t.run('journal', { period: 'this_month' });
  const jt = journal.rows.find(r => r.kind === 'total' && r.grand);
  const octDebits = Number((await one(`SELECT coalesce(sum(amount_cents) FILTER (WHERE amount_cents > 0), 0)::bigint AS n FROM posting
    WHERE org_id = $1 AND entity_id = $2 AND txn_date BETWEEN '2026-10-01' AND $3`, [app.ids.orgId, app.ids.entityId, TODAY])).n);
  assert.equal(jt.cells.debit, jt.cells.credit, 'journal balances');
  assert.equal(jt.cells.debit, octDebits, 'journal debits = October postings');
  // Each account register's running balance ends at the account's ledger balance.
  for (const [id, sign] of [[A.checking, 1], [A.savings, 1], [A.card, -1], [S.ar, 1], [S.undeposited, 1], [S.ap, -1]]) {
    const page = await (await app.get(`/settings/accounts/${id}`)).text();
    assert.match(page, new RegExp(formatCents(sign * s.accounts.get(id)).replace(/[$.]/g, '\\$&')), `register ${id} shows the balance`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
test('14. global search finds a created transaction by number, memo and amount', async () => {
  const { r: id } = await step('JE to search for', async () => ledgerId(await ok303(await app.post('/journal', jeBody([{ account: A.repairs, debit: '1234.56' }, { account: A.checking, credit: '1234.56' }],
    { memo: 'Kumquat gasket rebuild', doc_number: 'TIE-9917' })))), { accounts: { [A.repairs]: 123456, [A.checking]: -123456 }, net: -123456 });
  const find = async text => {
    const res = await app.get(`/search?format=json&q=${encodeURIComponent(text)}`);
    assert.match(res.headers.get('content-type'), /json/);
    const body = await res.json();
    return (body.sections.find(([title]) => title === 'Transactions')?.[1] ?? []).some(r => r.href === `/ledger/${id}`);
  };
  assert.ok(await find('TIE-9917'), 'by number');
  assert.ok(await find('kumquat gasket'), 'by memo');
  assert.ok(await find('1,234.56'), 'by amount');
  assert.ok(await find('$1234.56'), 'by amount with $');
});

test('the books still tie at the end', async () => {
  t.checkTied(await t.snapshot(), 'end');
});
