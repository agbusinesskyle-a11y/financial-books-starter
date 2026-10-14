import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerCheck } from '../lib/data/ledger.js';
import { setDateFormat } from '../lib/domain/dates.js';
import { startApp } from './app-harness.js';

const TODAY = '2026-10-12';
let app, scope;
before(async () => {
  app = await startApp();
  scope = { orgId: app.ids.orgId, entityId: app.ids.entityId };
});
after(async () => {
  const check = await ledgerCheck(app.db.pool, scope);
  assert.ok(check.balanced && check.arMatches && check.apMatches && check.inventoryMatches, JSON.stringify(check));
  setDateFormat('mdy');
  await app.close();
});

const q = async (sql, params = []) => (await app.db.pool.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const ON = { fiscalStartMonth: '1', method: 'accrual', dateFormat: 'mdy', showAccountNumbers: '1', classesOn: '1', classMode: 'txn', locationsOn: '1',
  locationLabel: 'Store', billableOn: '1', billableMarkup: '10', billableIncomeAccountId: '', autoApplyCustomer: '', autoApplyVendor: '', warnDuplicateBills: '1' };
const settings = (more = {}) => app.post('/settings/accounting', { ...ON, ...more });

async function newCustomer(name) {
  const res = await app.post('/customers', { displayName: name, active: '1' });
  return Number(/\/customers\/(\d+)/.exec(res.headers.get('location'))[1]);
}

function invoice(customerId, lines, more = {}, extra = []) {
  const p = new URLSearchParams({ type: 'invoice', customer_id: String(customerId), txn_date: TODAY, after_save: 'none', ...more });
  for (const l of lines) {
    p.append('line_item', ''); p.append('line_desc', l.desc ?? 'Work'); p.append('line_qty', '1'); p.append('line_rate', l.rate);
    p.append('line_service', ''); p.append('line_est', ''); p.append('line_bill', l.bill ?? ''); p.append('line_class', l.cls ?? '');
  }
  for (const [k, v] of extra) p.append(k, v);
  return app.post('/txns', p);
}

function vendorDoc(type, vendorId, cats, more = {}) {
  const p = new URLSearchParams({ type, vendor_id: String(vendorId), txn_date: TODAY, ...more });
  for (const c of cats) {
    p.append('cat_account', String(c.account)); p.append('cat_desc', c.desc ?? ''); p.append('cat_amount', c.amount); p.append('cat_job', c.job ?? '');
    p.append('cat_po', ''); p.append('cat_billable', c.billable ? '1' : ''); p.append('cat_class', '');
  }
  return app.post('/vtxns', p);
}

test('accounting settings: date format and account numbers change what pages show', async () => {
  assert.equal((await settings({ dateFormat: 'dmy', showAccountNumbers: '' })).status, 303);
  const page = await (await app.get(`/customers/${app.ids.customers.hilltop}`)).text();
  assert.match(page, /\b\d{1,2}\/\d{1,2}\/26\b/);
  const coa = await (await app.get('/settings/accounts')).text();
  assert.doesNotMatch(coa, /<td>1200<\/td>/, 'numbers hidden');
  assert.equal((await settings({ fiscalStartMonth: '13' })).status, 422);
  assert.equal((await settings()).status, 303);
});

test('classes (one level of sub-classes), locations and grouped tags', async () => {
  assert.equal((await app.post('/settings/classes', { name: 'Retail' })).status, 303);
  const retail = (await one(`SELECT class_id FROM class WHERE name = 'Retail'`)).class_id;
  assert.equal((await app.post('/settings/classes', { name: 'Feed store', parentId: String(retail) })).status, 303);
  const sub = (await one(`SELECT class_id FROM class WHERE name = 'Feed store'`)).class_id;
  const deep = await app.post('/settings/classes', { name: 'Too deep', parentId: String(sub) });
  assert.equal(deep.status, 422);
  assert.match(await deep.text(), /one level deep/);
  assert.equal((await app.post('/settings/classes', { name: 'retail' })).status, 422, 'duplicate name');
  assert.equal((await app.post('/settings/locations', { name: 'North store' })).status, 303);
  assert.equal((await app.post('/settings/tags', { name: 'Spring promo', newGroup: 'Campaign' })).status, 303);
  assert.equal((await app.post('/settings/tags', { name: 'Fair booth', groupId: String((await one(`SELECT group_id FROM tag_group WHERE name = 'Campaign'`)).group_id) })).status, 303);
  assert.match(await (await app.get('/settings/tags')).text(), /Campaign:<\/span> Fair booth/);
  assert.match(await (await app.get('/settings/classes')).text(), /Retail:<\/span> Feed store/);
});

test('class, location and tags on an invoice reach its postings, and lists filter by tag', async () => {
  const cls = (await one(`SELECT class_id FROM class WHERE name = 'Feed store'`)).class_id;
  const loc = (await one(`SELECT location_id FROM location WHERE name = 'North store'`)).location_id;
  const tag = (await one(`SELECT tag_id FROM tag WHERE name = 'Spring promo'`)).tag_id;
  const c = await newCustomer('Tagged Barn');
  const editor = await (await app.get(`/txns/new?type=invoice&customer=${c}`)).text();
  assert.match(editor, /name="class_id"/);
  assert.match(editor, /<span>Store<\/span>/);
  assert.match(editor, /name="tag_ids"/);
  const res = await invoice(c, [{ rate: '40' }], { class_id: String(cls), location_id: String(loc), tags_shown: '1' }, [['tag_ids', String(tag)]]);
  assert.equal(res.status, 303, await res.clone().text());
  await invoice(c, [{ rate: '15' }], { tags_shown: '1' });
  const inv = await one(`SELECT txn_id FROM txn WHERE customer_id = $1 AND total_cents = 4000`, [c]);
  const posts = await q('SELECT class_id, location_id FROM posting WHERE txn_id = $1', [inv.txn_id]);
  assert.ok(posts.length >= 2 && posts.every(p => p.class_id === cls && p.location_id === loc));
  const list = await (await app.get(`/customers/${c}?tag=${tag}`)).text();
  assert.match(list, /\$40\.00/);
  assert.doesNotMatch(list, /\$15\.00/);
  assert.match(await (await app.get(`/txns/${inv.txn_id}/edit`)).text(), new RegExp(`<option value="${tag}" selected`));
});

test('classes per line post per line', async () => {
  assert.equal((await settings({ classMode: 'line' })).status, 303);
  const [a, b] = (await q(`SELECT class_id FROM class ORDER BY class_id LIMIT 2`)).map(r => r.class_id);
  const c = await newCustomer('Line Class Farm');
  assert.match(await (await app.get(`/txns/new?type=invoice&customer=${c}`)).text(), /name="line_class"/);
  assert.equal((await invoice(c, [{ rate: '10', cls: String(a) }, { rate: '20', cls: String(b) }])).status, 303);
  const inv = await one(`SELECT txn_id FROM txn WHERE customer_id = $1`, [c]);
  const byLine = await q('SELECT line_no, class_id FROM posting WHERE txn_id = $1 AND line_no IS NOT NULL ORDER BY line_no', [inv.txn_id]);
  assert.deepEqual(byLine.map(r => r.class_id), [a, b]);
  assert.equal((await settings()).status, 303);
});

test('billable expenses: marked on a bill, offered on the invoice with markup, billed once, back after a void', async () => {
  const c = await newCustomer('Billable Ranch');
  const noCustomer = await vendorDoc('bill', app.ids.vendors.office, [{ account: app.ids.accounts.office, amount: '50', billable: true }]);
  assert.equal(noCustomer.status, 422);
  assert.match(await noCustomer.text(), /choose the customer to bill/);
  assert.equal((await vendorDoc('bill', app.ids.vendors.office, [{ account: app.ids.accounts.office, desc: 'Gate parts', amount: '50', billable: true, job: `c:${c}` }],
    { doc_number: 'GP-1' })).status, 303);
  assert.match(await (await app.get(`/customers/${c}`)).text(), /Unbilled expenses: 1 for \$50\.00/);
  const editor = await (await app.get(`/txns/new?type=invoice&customer=${c}&billable=1`)).text();
  const bill = /name="line_bill" value="(\d+:\d+)"/.exec(editor)[1];
  assert.match(editor, /name="line_rate" value="55.00"/, '10% markup');
  assert.equal((await invoice(c, [{ desc: 'Gate parts', rate: '55', bill }])).status, 303);
  const inv = await one(`SELECT txn_id FROM txn WHERE customer_id = $1 AND type = 'invoice'`, [c]);
  assert.doesNotMatch(await (await app.get(`/customers/${c}`)).text(), /Unbilled expenses/);
  const again = await invoice(c, [{ desc: 'Gate parts', rate: '55', bill }]);
  assert.equal(again.status, 422);
  assert.match(await again.text(), /already on another invoice/);
  const other = await newCustomer('Not The Customer');
  assert.equal((await invoice(other, [{ desc: 'Gate parts', rate: '55', bill }])).status, 422);
  assert.equal((await app.post(`/txns/${inv.txn_id}/void`)).status, 303);
  assert.match(await (await app.get(`/customers/${c}`)).text(), /Unbilled expenses: 1/);
});

test('auto-apply: new payments, credit memos and vendor credits go to the oldest open items', async () => {
  assert.equal((await settings({ autoApplyCustomer: '1', autoApplyVendor: '1' })).status, 303);
  const c = await newCustomer('Auto Apply Acres');
  await invoice(c, [{ rate: '100' }], { due_date: '2026-10-20' });
  await invoice(c, [{ rate: '80' }], { due_date: '2026-10-15' });
  const res = await app.post('/txns', { type: 'payment', customer_id: String(c), txn_date: TODAY, amount: '90', payment_method: 'Check' });
  assert.equal(res.status, 303);
  const opens = await q(`SELECT total_cents, open_cents FROM txn WHERE customer_id = $1 AND type = 'invoice' ORDER BY due_date`, [c]);
  assert.deepEqual(opens.map(r => Number(r.open_cents)), [0, 9000], 'oldest due first');
  const cm = new URLSearchParams({ type: 'credit_memo', customer_id: String(c), txn_date: TODAY, after_save: 'none' });
  cm.append('line_item', ''); cm.append('line_desc', 'Return'); cm.append('line_qty', '1'); cm.append('line_rate', '20');
  assert.equal((await app.post('/txns', cm)).status, 303);
  assert.equal(Number((await one(`SELECT open_cents FROM txn WHERE customer_id = $1 AND type = 'invoice' AND due_date = '2026-10-20'`, [c])).open_cents), 7000);

  const v = app.ids.vendors.repair;
  await vendorDoc('bill', v, [{ account: app.ids.accounts.repairs, amount: '30' }], { doc_number: 'AA-1', due_date: '2026-10-13' });
  const bill = await one(`SELECT txn_id FROM txn WHERE vendor_id = $1 AND doc_number = 'AA-1'`, [v]);
  await app.post(`/vtxns/${bill.txn_id}/approve`);
  assert.equal((await vendorDoc('vendor_credit', v, [{ account: app.ids.accounts.repairs, amount: '12' }], { doc_number: 'AA-CR' })).status, 303);
  const credit = await one(`SELECT open_cents FROM txn WHERE vendor_id = $1 AND doc_number = 'AA-CR'`, [v]);
  assert.ok(Number(credit.open_cents) < 1200, 'the credit was applied');
  assert.equal((await settings()).status, 303);
});

test('a duplicate bill number for the same vendor is a warning you can save past', async () => {
  const v = app.ids.vendors.hayfarm;
  assert.equal((await vendorDoc('bill', v, [{ account: app.ids.accounts.hay_purchases, amount: '10' }], { doc_number: 'DUP-7' })).status, 303);
  const warn = await vendorDoc('bill', v, [{ account: app.ids.accounts.hay_purchases, amount: '11' }], { doc_number: 'DUP-7' });
  assert.equal(warn.status, 422);
  const page = await warn.text();
  assert.match(page, /already has bill DUP-7/);
  assert.match(page, /name="allow_duplicate" value="1"/);
  assert.equal((await vendorDoc('bill', v, [{ account: app.ids.accounts.hay_purchases, amount: '11' }], { doc_number: 'DUP-7', allow_duplicate: '1' })).status, 303);
  assert.equal((await settings({ warnDuplicateBills: '' })).status, 303);
  assert.equal((await vendorDoc('bill', v, [{ account: app.ids.accounts.hay_purchases, amount: '12' }], { doc_number: 'DUP-7' })).status, 303);
  assert.equal((await one(`SELECT count(*)::int AS n FROM txn WHERE vendor_id = $1 AND doc_number = 'DUP-7'`, [v])).n, 3);
});
