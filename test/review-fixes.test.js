import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { replay } from '../lib/domain/inventory.js';
import { ledgerCheck } from '../lib/data/ledger.js';
import { startApp } from './app-harness.js';

const TODAY = '2026-10-12';
const Q = n => BigInt(n * 10000);

test('an emptied shelf carries no leftover value: the move that empties it takes it', () => {
  const a = replay([{ key: 'p', kind: 'purchase', qty: Q(1), amountCents: 1000 }, { key: 'r', kind: 'vendor_return', qty: Q(1), amountCents: 800 }]);
  assert.equal(a.costs.get('r'), -1000);
  assert.equal(a.value, 0);
  const b = replay([{ key: 'o', kind: 'adjust', qty: Q(2), amountCents: 1000 }, { key: 's1', kind: 'sale', qty: Q(3) },
    { key: 'p', kind: 'purchase', qty: Q(1), amountCents: 1000 }]);
  assert.equal(b.costs.get('s1'), -1500, 'one unit sold below zero at the last cost');
  assert.equal(b.costs.get('p'), 500, 'the bill fills the hole; the rest is cost of goods');
  assert.equal(b.value, 0);
});

let app, scope;
before(async () => {
  app = await startApp({ env: { SETTINGS_KEY: 'ef'.repeat(32) } });
  scope = { orgId: app.ids.orgId, entityId: app.ids.entityId };
});
after(async () => {
  const check = await ledgerCheck(app.db.pool, scope);
  assert.ok(check.balanced && check.arMatches && check.apMatches && check.inventoryMatches, JSON.stringify(check));
  await app.close();
});

const vdoc = (type, vendor, { items = [], cats = [], ...rest } = {}) => {
  const p = new URLSearchParams({ type, vendor_id: String(vendor), txn_date: TODAY, ...rest });
  for (const i of items) { p.append('item_item', String(i.item)); p.append('item_desc', ''); p.append('item_qty', i.qty); p.append('item_rate', i.rate); p.append('item_job', ''); p.append('item_po', ''); }
  for (const c of cats) { p.append('cat_account', String(c.account)); p.append('cat_desc', ''); p.append('cat_amount', c.amount); p.append('cat_job', ''); p.append('cat_po', ''); }
  return p;
};
const created = res => Number(/\/vtxns\/(\d+)/.exec(res.headers.get('location'))[1]);

test('inventory stays equal to the ledger when stock runs to exactly zero (return, negative stock)', async () => {
  const add = await app.post('/settings/items', { name: 'Hoof Pick', kind: 'inventory', rate: '5', cost: '2', active: '1' });
  assert.equal(add.status, 303);
  const item = (await app.db.pool.query(`SELECT item_id FROM item WHERE name = 'Hoof Pick'`)).rows[0].item_id;
  await app.post('/vtxns', vdoc('bill', app.ids.vendors.mill, { items: [{ item, qty: '1', rate: '10.00' }] }));
  await app.post('/vtxns', vdoc('vendor_credit', app.ids.vendors.mill, { items: [{ item, qty: '1', rate: '8.00' }] }));
  assert.ok((await ledgerCheck(app.db.pool, scope)).inventoryMatches, 'returned at less than cost');
  const sale = new URLSearchParams({ type: 'sales_receipt', customer_id: String(app.ids.customers.hilltop), txn_date: TODAY });
  sale.append('line_item', String(item)); sale.append('line_desc', ''); sale.append('line_qty', '2'); sale.append('line_rate', '5');
  await app.post('/txns', sale);
  await app.post('/vtxns', vdoc('bill', app.ids.vendors.mill, { items: [{ item, qty: '2', rate: '7.00' }] }));
  const check = await ledgerCheck(app.db.pool, scope);
  assert.ok(check.inventoryMatches, `sold before the bill arrived: ${check.inventoryLedger} vs ${check.inventoryOnHand}`);
});

test('customer void/delete routes refuse vendor documents; vendor batch delete refuses customer ones', async () => {
  const bill = created(await app.post('/vtxns', vdoc('bill', app.ids.vendors.office, { cats: [{ account: app.ids.accounts.office, amount: '40.00' }] })));
  for (const action of ['void', 'delete']) {
    await app.post(`/txns/${bill}/${action}`);
    assert.equal((await app.db.pool.query('SELECT voided_at FROM txn WHERE txn_id = $1', [bill])).rows[0]?.voided_at, null, action);
  }
  const invoice = (await app.db.pool.query(`SELECT txn_id FROM txn WHERE type = 'invoice' AND voided_at IS NULL LIMIT 1`)).rows[0].txn_id;
  const body = new URLSearchParams({ action: 'delete', back: `/vendors/${app.ids.vendors.office}?tab=transactions` });
  body.append('ids', String(invoice));
  assert.equal((await app.post('/vtxns/batch', body)).status, 303);
  assert.equal((await app.db.pool.query('SELECT count(*)::int AS n FROM txn WHERE txn_id = $1', [invoice])).rows[0].n, 1, 'the invoice survives');
});

test('voiding a bill payment also takes back the vendor credit it applied', async () => {
  const v = app.ids.vendors.repair;
  const bill = created(await app.post('/vtxns', vdoc('bill', v, { cats: [{ account: app.ids.accounts.repairs, amount: '150.00' }] })));
  await app.post(`/vtxns/${bill}/approve`);
  const res = await app.post('/pay-bills', { account_id: String(app.ids.accounts.checking), txn_date: TODAY, method: 'Check', bill: String(bill),
    [`pay_${bill}`]: '0.00', [`credit_${bill}`]: '150.00' });
  assert.equal(res.status, 303);
  const pay = (await app.db.pool.query(`SELECT txn_id FROM txn WHERE type = 'bill_payment' AND vendor_id = $1 ORDER BY txn_id DESC LIMIT 1`, [v])).rows[0].txn_id;
  assert.equal((await app.db.pool.query('SELECT open_cents FROM txn WHERE txn_id = $1', [bill])).rows[0].open_cents, 0);
  assert.equal((await app.post(`/vtxns/${pay}/void`)).status, 303);
  const after = (await app.db.pool.query(`SELECT txn_id, open_cents FROM txn WHERE txn_id = $1 OR doc_number = 'RD-CR1' ORDER BY txn_id`, [bill])).rows;
  assert.deepEqual(after.map(r => r.open_cents).sort(), [15000, 15000], 'bill open again, credit available again');
});

test('the info link isn’t kept in the message record; bank details from a link must be confirmed before ACH', async () => {
  const v = app.ids.vendors.hayfarm;
  const page = await (await app.post(`/vendors/${v}/ask`)).text();
  const token = /vendor-info\/([A-Za-z0-9_-]{43})/.exec(page)[1];
  const msg = (await app.db.pool.query('SELECT body FROM message WHERE vendor_id = $1 ORDER BY message_id DESC LIMIT 1', [v])).rows[0].body;
  assert.doesNotMatch(msg, new RegExp(token));
  assert.match(msg, /one-time link, not kept/);

  const form = await fetch(`${app.base}/vendor-info/${token}`);
  const cookie = form.headers.getSetCookie()[0].split(';')[0];
  const nonce = /name="nonce" value="([^"]+)"/.exec(await form.text())[1];
  await fetch(`${app.base}/vendor-info/${token}`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ nonce, bankRouting: '111000025', bankAccount: '55554444', bankAccount2: '55554444' }).toString() });
  const vp = await (await app.get(`/vendors/${v}`)).text();
  const href = /href="(\/vendors\/\d+\/info\/\d+)"/.exec(vp)[1];
  await app.post(href, new URLSearchParams([['do', 'accept'], ['accept', 'bank']]));
  assert.match(await (await app.get(`/vendors/${v}`)).text(), /Call them at a number you already have on file/);

  const bill = created(await app.post('/vtxns', vdoc('bill', v, { cats: [{ account: app.ids.accounts.hay_purchases, amount: '100.00' }] })));
  await app.post(`/vtxns/${bill}/approve`);
  const ach = await app.post('/pay-bills', { account_id: String(app.ids.accounts.checking), txn_date: TODAY, method: 'ACH', bill: String(bill), [`pay_${bill}`]: '100.00' });
  assert.equal(ach.status, 422);
  assert.match(await ach.text(), /Confirm them on the vendor page/);
  assert.equal((await app.post(`/vendors/${v}/bank-verified`)).status, 303);
  assert.equal((await app.post('/pay-bills', { account_id: String(app.ids.accounts.checking), txn_date: TODAY, method: 'ACH', bill: String(bill), [`pay_${bill}`]: '100.00' })).status, 303);
});

test('merging vendors with clashing names or bill numbers is a clear message, not an error page', async () => {
  const a = Number(/\/vendors\/(\d+)/.exec((await app.post('/vendors', { displayName: 'Dup Supply A' })).headers.get('location'))[1]);
  const b = Number(/\/vendors\/(\d+)/.exec((await app.post('/vendors', { displayName: 'Dup Supply B' })).headers.get('location'))[1]);
  // Vendor credits must keep unique numbers per vendor, so a clash there is a clear message. (Bills may share a number,
  // as in QBO — two vendors with bill INV-9, or both with an opening balance, merge fine; see tieout-purchases.)
  for (const id of [a, b]) await app.post('/vtxns', vdoc('vendor_credit', id, { doc_number: 'VC-9', cats: [{ account: app.ids.accounts.office, amount: '5.00' }] }));
  const res = await app.post(`/vendors/${a}/merge`, { into: String(b) });
  assert.equal(res.status, 422);
  assert.match(await res.text(), /vendor credit numbered VC-9/);
  assert.equal((await app.get('/vendors?page=100000000000000000000')).status, 200, 'absurd page numbers are clamped');
});
