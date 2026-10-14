import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { amountInWords, checkWords } from '../lib/domain/checks.js';
import { postingsFor } from '../lib/domain/ledger.js';
import { ledgerCheck, listAccounts } from '../lib/data/ledger.js';
import { startApp } from './app-harness.js';

const TODAY = '2026-10-12';

test('amount in words for checks', () => {
  assert.equal(amountInWords(123456), 'One thousand two hundred thirty-four and 56/100');
  assert.equal(amountInWords(5), 'Zero and 05/100');
  assert.equal(amountInWords(100000000), 'One million and 00/100');
  assert.equal(amountInWords(2101), 'Twenty-one and 01/100');
  assert.equal(amountInWords(91354950), 'Nine hundred thirteen thousand five hundred forty-nine and 50/100');
  assert.match(checkWords(100, 30), /^One and 00\/100 \*+$/);
  assert.equal(checkWords(100, 30).length, 30);
});

test('posting rules for vendor documents', () => {
  const sys = { ap: 1, cogs: 2 };
  const lines = [{ line_no: 1, account_id: 10, amount_cents: 700, project_id: 5, customer_id: 6 }, { line_no: 2, item_id: 3, amount_cents: 300 }];
  const by = ps => ps.reduce((m, p) => ({ ...m, [p.accountId]: (m[p.accountId] ?? 0) + p.amountCents }), {});
  const t = (type, extra = {}) => ({ txn_id: 1, type, total_cents: 1000, vendor_id: 9, ...extra });
  assert.deepEqual(by(postingsFor({ txn: t('bill'), lines, sys, expenseAccount: () => null })), { 10: 700, 2: 300, 1: -1000 });
  assert.deepEqual(by(postingsFor({ txn: t('bill'), lines, sys, expenseAccount: () => 11 })), { 10: 700, 11: 300, 1: -1000 });
  assert.deepEqual(by(postingsFor({ txn: t('vendor_credit'), lines, sys })), { 10: -700, 2: -300, 1: 1000 });
  assert.deepEqual(by(postingsFor({ txn: t('check', { account_id: 20 }), lines, sys })), { 10: 700, 2: 300, 20: -1000 });
  assert.deepEqual(by(postingsFor({ txn: t('bill_payment', { account_id: 20 }), sys })), { 1: 1000, 20: -1000 });
  const tagged = postingsFor({ txn: t('expense', { account_id: 20 }), lines, sys }).find(p => p.accountId === 10);
  assert.deepEqual([tagged.projectId, tagged.customerId, tagged.vendorId], [5, 6, 9], 'job costing tags travel with the line');
});

let app, scope;
before(async () => {
  app = await startApp();
  scope = { orgId: app.ids.orgId, entityId: app.ids.entityId };
});
after(async () => {
  const check = await ledgerCheck(app.db.pool, scope);
  assert.ok(check.balanced, 'debits = credits');
  assert.ok(check.arMatches, 'A/R matches');
  assert.ok(check.apMatches, `A/P ${check.apLedger} = open bills less credits ${check.apOpen}`);
  await app.close();
});

const bal = async name => (await listAccounts(app.db.pool, scope)).find(a => a.name === name || a.system_key === name).balance_cents;
const docForm = ({ type = 'bill', vendor, date = TODAY, cats = [], items = [], ...rest }) => {
  const p = new URLSearchParams({ type, vendor_id: vendor ? String(vendor) : '', txn_date: date, ...rest });
  for (const c of cats) { p.append('cat_account', String(c.account)); p.append('cat_desc', c.desc ?? ''); p.append('cat_amount', c.amount); p.append('cat_job', c.job ?? ''); }
  for (const i of items) { p.append('item_item', String(i.item)); p.append('item_desc', ''); p.append('item_qty', i.qty); p.append('item_rate', i.rate); p.append('item_job', i.job ?? ''); }
  return p;
};
const created = res => Number(/\/vtxns\/(\d+)/.exec(res.headers.get('location'))[1]);

test('seeded payables: A/P matches, overdue bills show on the vendor list and the vendor page', async () => {
  const check = await ledgerCheck(app.db.pool, scope);
  assert.ok(check.apMatches);
  assert.ok(check.apLedger > 0);
  const list = await (await app.get('/vendors')).text();
  assert.match(list, /2 overdue/);
  assert.match(list, /paid last 30 days/);
  const mill = await (await app.get(`/vendors/${app.ids.vendors.mill}?tab=transactions&type=overdue`)).text();
  assert.match(mill, /Overdue \d+ days?/);
  const hay = await (await app.get(`/vendors/${app.ids.vendors.hayfarm}?tab=transactions&type=awaiting`)).text();
  assert.match(hay, /Awaiting approval/);
  assert.match(await (await app.get('/vendors?show=overdue')).text(), /Lone Star Feed Mill/);
});

test('bill: create with category + product lines and a project, approve, pay by check, print', async () => {
  const cust = app.ids.customers.hilltop;
  const project = (await app.db.pool.query(`INSERT INTO project (org_id, customer_id, name) VALUES ($1, $2, 'Hay barn') RETURNING project_id`, [scope.orgId, cust])).rows[0].project_id;
  const apBefore = await bal('ap'), checkingBefore = await bal('Operating Checking');
  const res = await app.post('/vtxns', docForm({ vendor: app.ids.vendors.trucking, doc_number: 'CP-77',
    cats: [{ account: app.ids.accounts.freight_in, desc: 'Haul to Hilltop', amount: '450.00', job: `p:${project}` }],
    items: [{ item: app.ids.items.tub, qty: '2', rate: '60' }] }));
  assert.equal(res.status, 303);
  const bill = created(res);
  const view = await (await app.get(`/vtxns/${bill}`)).text();
  assert.match(view, /Awaiting approval/);
  assert.match(view, /Hay barn/);
  assert.equal(await bal('ap') - apBefore, 57000);

  // Not payable until approved.
  const early = await app.post('/pay-bills', { account_id: String(app.ids.accounts.checking), txn_date: TODAY, method: 'Check', bill: String(bill) });
  assert.equal(early.status, 422);
  assert.equal((await app.post(`/vtxns/${bill}/approve`)).status, 303);
  assert.match(await (await app.get(`/vtxns/${bill}`)).text(), /Approved/);

  const form = await (await app.get(`/pay-bills?bills=${bill}`)).text();
  assert.match(form, new RegExp(`name="pay_${bill}" value="570.00"`));
  const paid = await app.post('/pay-bills', { account_id: String(app.ids.accounts.checking), txn_date: TODAY, method: 'Check', bill: String(bill), [`pay_${bill}`]: '570.00', then: 'print' });
  assert.equal(paid.status, 303);
  assert.equal(paid.headers.get('location'), '/checks');
  assert.equal(await bal('ap'), apBefore);
  assert.equal(checkingBefore - await bal('Operating Checking'), 57000);
  const payment = (await app.db.pool.query(`SELECT txn_id, doc_number FROM txn WHERE type = 'bill_payment' AND vendor_id = $1 ORDER BY txn_id DESC LIMIT 1`, [app.ids.vendors.trucking])).rows[0];
  assert.match(payment.doc_number, /^\d+$/);
  assert.match(await (await app.get('/checks')).text(), new RegExp(`>${payment.doc_number}<`));
  const pdf = await app.get(`/vtxns/${payment.txn_id}/check.pdf`);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
  assert.equal((await app.post('/checks/printed', { ids: String(payment.txn_id) })).status, 303);
  assert.doesNotMatch(await (await app.get('/checks')).text(), new RegExp(`>${payment.doc_number}<`));

  // Project page shows the cost and the profit.
  const pp = await (await app.get(`/projects/${project}`)).text();
  assert.match(pp, /<dt>Costs<\/dt><dd>\$450\.00<\/dd>/);
  assert.match(pp, /Haul to Hilltop/);

  // Voiding the payment reopens the bill; a paid bill can't be deleted.
  const del = await app.post(`/vtxns/${bill}/delete`);
  assert.equal(del.headers.get('location'), `/vtxns/${bill}`);
  assert.equal((await app.post(`/vtxns/${payment.txn_id}/void`)).status, 303);
  assert.equal((await app.db.pool.query('SELECT open_cents FROM txn WHERE txn_id = $1', [bill])).rows[0].open_cents, 57000);
  assert.equal(await bal('Operating Checking'), checkingBefore);
});

test('pay bills applies vendor credit first-in-first-out, one payment per vendor', async () => {
  const repair = app.ids.vendors.repair;
  const bill = created(await app.post('/vtxns', docForm({ vendor: repair, cats: [{ account: app.ids.accounts.repairs, amount: '600.00' }] })));
  await app.post(`/vtxns/${bill}/approve`);
  const page = await (await app.get(`/pay-bills?vendor=${repair}`)).text();
  assert.match(page, /\$150\.00/, 'the seeded vendor credit shows as available');
  const res = await app.post('/pay-bills', { account_id: String(app.ids.accounts.checking), txn_date: TODAY, method: 'ACH', bill: String(bill),
    [`pay_${bill}`]: '450.00', [`credit_${bill}`]: '150.00' });
  assert.equal(res.status, 303);
  const rows = (await app.db.pool.query(`SELECT type, open_cents FROM txn WHERE vendor_id = $1 AND txn_id IN ($2, (SELECT txn_id FROM txn WHERE doc_number = 'RD-CR1'))`, [repair, bill])).rows;
  assert.ok(rows.every(r => r.open_cents === 0), 'bill paid and credit used up');
  const tooMuch = created(await app.post('/vtxns', docForm({ vendor: repair, cats: [{ account: app.ids.accounts.repairs, amount: '100.00' }] })));
  await app.post(`/vtxns/${tooMuch}/approve`);
  const over = await app.post('/pay-bills', { account_id: String(app.ids.accounts.checking), txn_date: TODAY, method: 'ACH', bill: String(tooMuch),
    [`pay_${tooMuch}`]: '50.00', [`credit_${tooMuch}`]: '50.00' });
  assert.equal(over.status, 422);
  assert.match(await over.text(), /vendor credit available/);
});

test('expenses, checks, check numbers, copy, edit', async () => {
  const cardBefore = await bal('Business Card');
  const exp = await app.post('/vtxns', docForm({ type: 'expense', vendor: app.ids.vendors.fuel, account_id: String(app.ids.accounts.card), payment_method: 'Credit card',
    cats: [{ account: app.ids.accounts.fuel, amount: '82.40' }, { account: app.ids.accounts.office, amount: '-2.40', desc: 'Discount' }] }));
  assert.equal(exp.status, 303);
  assert.equal(await bal('Business Card') - cardBefore, 8000, 'credit card balance goes up (credit-normal)');

  const chk = created(await app.post('/vtxns', docForm({ type: 'check', vendor: app.ids.vendors.landlord, account_id: String(app.ids.accounts.checking),
    cats: [{ account: app.ids.accounts.rent, amount: '3500.00' }] })));
  const no = (await app.db.pool.query('SELECT doc_number FROM txn WHERE txn_id = $1', [chk])).rows[0].doc_number;
  const max = (await app.db.pool.query(`SELECT max(doc_number::int) AS n FROM txn WHERE account_id = $1 AND payment_method = 'Check' AND txn_id <> $2`, [app.ids.accounts.checking, chk])).rows[0].n;
  assert.equal(Number(no), max + 1, 'next check number on that account');
  const dup = await app.post('/vtxns', docForm({ type: 'check', vendor: app.ids.vendors.landlord, account_id: String(app.ids.accounts.checking), doc_number: no,
    cats: [{ account: app.ids.accounts.rent, amount: '1.00' }] }));
  assert.equal(dup.status, 422);
  assert.match(await dup.text(), /already used/);
  const noPayee = await app.post('/vtxns', docForm({ type: 'expense', account_id: String(app.ids.accounts.checking), cats: [{ account: app.ids.accounts.bank_fees, amount: '12.00' }] }));
  assert.equal(noPayee.status, 303, 'an expense can have no payee');

  const copy = await (await app.get(`/vtxns/new?copy=${chk}`)).text();
  assert.match(copy, /value="3500\.00"/);
  assert.match(copy, /New check/);
  assert.equal((await app.get(`/vtxns/${chk}/check.pdf`)).status, 200);
  assert.equal((await app.get(`/txns/${chk}`)).headers.get('location'), `/vtxns/${chk}`, 'old links redirect');
});

test('approval: changing an approved bill’s amount needs approval again; reject; settings turn it off', async () => {
  const v = app.ids.vendors.electric;
  const bill = created(await app.post('/vtxns', docForm({ vendor: v, cats: [{ account: app.ids.accounts.utilities, amount: '700.00' }] })));
  await app.post(`/vtxns/${bill}/approve`);
  assert.equal((await app.post(`/vtxns/${bill}`, docForm({ vendor: v, cats: [{ account: app.ids.accounts.utilities, amount: '700.00' }], memo: 'same amount' }))).status, 303);
  assert.equal((await app.db.pool.query('SELECT approval_status FROM txn WHERE txn_id = $1', [bill])).rows[0].approval_status, 'approved');
  await app.post(`/vtxns/${bill}`, docForm({ vendor: v, cats: [{ account: app.ids.accounts.utilities, amount: '750.00' }] }));
  assert.equal((await app.db.pool.query('SELECT approval_status FROM txn WHERE txn_id = $1', [bill])).rows[0].approval_status, 'awaiting');
  assert.equal((await app.post(`/vtxns/${bill}/reject`, { reason: '' })).headers.get('location'), `/vtxns/${bill}`);
  await app.post(`/vtxns/${bill}/reject`, { reason: 'Wrong meter' });
  assert.match(await (await app.get(`/vtxns/${bill}`)).text(), /Rejected: Wrong meter/);

  assert.equal((await app.post('/settings/bills', { nextCheckNumber: '1001' })).status, 303);
  const auto = created(await app.post('/vtxns', docForm({ vendor: v, cats: [{ account: app.ids.accounts.utilities, amount: '10.00' }] })));
  assert.equal((await app.db.pool.query('SELECT approval_status FROM txn WHERE txn_id = $1', [auto])).rows[0].approval_status, 'approved');
  assert.equal((await app.post(`/vtxns/${auto}/mark-paid`, { account_id: String(app.ids.accounts.checking) })).status, 303);
  assert.equal((await app.db.pool.query('SELECT open_cents FROM txn WHERE txn_id = $1', [auto])).rows[0].open_cents, 0);
  await app.post('/settings/bills', { requireApproval: '1', nextCheckNumber: '1001' });
});

test('batch approve and delete from the vendor Transaction List', async () => {
  const v = app.ids.vendors.office;
  const a = created(await app.post('/vtxns', docForm({ vendor: v, cats: [{ account: app.ids.accounts.office, amount: '20.00' }] })));
  const b = created(await app.post('/vtxns', docForm({ vendor: v, cats: [{ account: app.ids.accounts.office, amount: '30.00' }] })));
  const body = new URLSearchParams({ action: 'approve', back: `/vendors/${v}?tab=transactions` });
  body.append('ids', String(a)); body.append('ids', String(b));
  assert.equal((await app.post('/vtxns/batch', body)).status, 303);
  assert.equal((await app.db.pool.query(`SELECT count(*)::int AS n FROM txn WHERE txn_id = ANY($1) AND approval_status = 'approved'`, [[a, b]])).rows[0].n, 2);
  body.set('action', 'pay');
  assert.equal((await app.post('/vtxns/batch', body)).headers.get('location'), `/pay-bills?bills=${a},${b}`);
  body.set('action', 'delete');
  assert.equal((await app.post('/vtxns/batch', body)).status, 303);
  assert.equal((await app.db.pool.query('SELECT count(*)::int AS n FROM txn WHERE txn_id = ANY($1)', [[a, b]])).rows[0].n, 0);
});

test('a new vendor can start with an opening balance', async () => {
  const apBefore = await bal('ap');
  const res = await app.post('/vendors', { displayName: 'Old Mill Supply', openingBalance: '1,250.00', openingAsOf: '2026-09-30' });
  assert.equal(res.status, 303);
  const id = Number(/\/vendors\/(\d+)/.exec(res.headers.get('location'))[1]);
  assert.equal(await bal('ap') - apBefore, 125000);
  assert.match(await (await app.get(`/vendors/${id}?tab=transactions`)).text(), /Opening balance/);
  assert.match(await (await app.get(`/vendors/${id}`)).text(), /data-testid="open-balance">\$1,250\.00/);
});

test('vendor transaction pages and forms render', async () => {
  for (const type of ['bill', 'expense', 'check', 'vendor_credit']) {
    const res = await app.get(`/vtxns/new?type=${type}&vendor=${app.ids.vendors.mill}`);
    assert.equal(res.status, 200, type);
  }
  assert.match(await (await app.get(`/vtxns/new?type=bill&vendor=${app.ids.vendors.mill}`)).text(), /<option value="\d+" selected>5010 · Feed Purchases<\/option>/,
    'the vendor’s default category fills the first line');
  for (const path of ['/pay-bills', '/checks', '/settings/bills', `/vendors/${app.ids.vendors.hayfarm}?tab=transactions`]) {
    assert.equal((await app.get(path)).status, 200, path);
  }
  const register = await (await app.get(`/settings/accounts/${app.ids.accounts.checking}`)).text();
  assert.match(register, /href="\/vtxns\/\d+"/);
  assert.match(register, /Bill Payment/);
});
