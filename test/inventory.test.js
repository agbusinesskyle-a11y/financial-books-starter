import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { replay } from '../lib/domain/inventory.js';
import { ledgerCheck, listAccounts } from '../lib/data/ledger.js';
import { startApp } from './app-harness.js';

const TODAY = '2026-10-12';
const Q = n => BigInt(Math.round(n * 10000));

test('average cost: purchases, sales, returns, adjustments, running out, going negative', () => {
  const r = replay([
    { key: 'p1', kind: 'purchase', qty: Q(10), amountCents: 5000 },
    { key: 'p2', kind: 'purchase', qty: Q(10), amountCents: 7000 },
    { key: 's1', kind: 'sale', qty: Q(5) },              // avg $6.00
    { key: 'c1', kind: 'customer_return', qty: Q(1) },   // back at $6.00
    { key: 'a1', kind: 'adjust', qty: Q(-2) },           // shrink 2 at $6.00
    { key: 's2', kind: 'sale', qty: Q(14) },             // the rest, exactly
    { key: 's3', kind: 'sale', qty: Q(2) },              // below zero: last known cost
    { key: 'p3', kind: 'purchase', qty: Q(4), amountCents: 3200 },
  ]);
  assert.equal(r.costs.get('s1'), -3000);
  assert.equal(r.costs.get('c1'), 600);
  assert.equal(r.costs.get('a1'), -1200);
  assert.equal(r.costs.get('s2'), -8400, 'selling everything takes exactly what was left');
  assert.equal(r.costs.get('s3'), -1200, 'selling below zero uses the last average');
  assert.equal(r.qty, Q(2));
  assert.equal(r.value, 2000);
  const thirds = replay([{ key: 'p', kind: 'purchase', qty: Q(3), amountCents: 1000 }, { key: 's', kind: 'sale', qty: Q(1) }]);
  assert.equal(thirds.costs.get('s'), -333, 'rounded to the cent');
  assert.equal(thirds.value, 667);
  const opening = replay([{ key: 'o', kind: 'adjust', qty: Q(5), amountCents: 2500 }]);
  assert.deepEqual([opening.costs.get('o'), opening.value], [2500, 2500]);
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
  assert.ok(check.apMatches, `A/P ${check.apLedger} vs ${check.apOpen}`);
  assert.ok(check.inventoryMatches, `inventory asset ${check.inventoryLedger} = items on hand ${check.inventoryOnHand}`);
  await app.close();
});

const item = async id => (await app.db.pool.query('SELECT qty_on_hand::float AS qty, value_cents FROM item WHERE item_id = $1', [id])).rows[0];
const bal = async name => (await listAccounts(app.db.pool, scope)).find(a => a.name === name || a.system_key === name).balance_cents;
const sell = async (itemId, qty, rate, date = TODAY) => {
  const p = new URLSearchParams({ type: 'sales_receipt', customer_id: String(app.ids.customers.hilltop), txn_date: date });
  p.append('line_item', String(itemId)); p.append('line_desc', ''); p.append('line_qty', qty); p.append('line_rate', rate);
  const res = await app.post('/txns', p);
  assert.equal(res.status, 303);
  return (await app.db.pool.query(`SELECT txn_id FROM txn WHERE type = 'sales_receipt' ORDER BY txn_id DESC LIMIT 1`)).rows[0].txn_id;
};
const vdoc = ({ type, vendor = app.ids.vendors.mill, date = TODAY, items = [], ...rest }) => {
  const p = new URLSearchParams({ type, vendor_id: String(vendor), txn_date: date, ...rest });
  for (const i of items) { p.append('item_item', String(i.item)); p.append('item_desc', ''); p.append('item_qty', i.qty); p.append('item_rate', i.rate); p.append('item_job', ''); p.append('item_po', i.po ?? ''); }
  return p;
};
const created = res => Number(/\/vtxns\/(\d+)/.exec(res.headers.get('location'))[1]);

test('seeded stock: opening quantities, the books agree, list shows on hand and value', async () => {
  const check = await ledgerCheck(app.db.pool, scope);
  assert.ok(check.inventoryMatches);
  assert.ok(check.apMatches, 'the unbilled item receipt counts in A/P');
  assert.deepEqual(await item(app.ids.items.salt), { qty: 120, value_cents: 78000 });
  assert.deepEqual(await item(app.ids.items.flyspray), { qty: 64, value_cents: 72000 + 44400 }, '40 opening + 24 received');
  const list = await (await app.get('/settings/items')).text();
  assert.match(list, /SKU SALT-50/);
  assert.match(list, /\$780\.00/);
  assert.match(await (await app.get('/vendors')).text(), /1 open purchase order/);
});

test('selling stock posts cost of goods at average cost; a back-dated purchase re-costs later sales', async () => {
  const salt = app.ids.items.salt;
  const cogsBefore = await bal('cogs');
  const sale = await sell(salt, '20', '11.95');
  assert.equal(await bal('cogs') - cogsBefore, 13000, '20 × $6.50');
  assert.deepEqual(await item(salt), { qty: 100, value_cents: 65000 });

  // A purchase dated before the sale lowers the average the sale used.
  const bill = created(await app.post('/vtxns', vdoc({ type: 'bill', date: '2026-10-01', items: [{ item: salt, qty: '80', rate: '5.00' }] })));
  const cost = (await app.db.pool.query('SELECT cost_cents FROM txn_line WHERE txn_id = $1', [sale])).rows[0].cost_cents;
  assert.equal(cost, -11800, '20 × average of (120 × 6.50 + 80 × 5.00) / 200 = $5.90 each');
  assert.equal(await bal('cogs') - cogsBefore, 11800);
  assert.deepEqual(await item(salt), { qty: 180, value_cents: 78000 + 40000 - 11800 });

  // Deleting that purchase puts the sale back at $6.50.
  assert.equal((await app.post(`/vtxns/${bill}/delete`)).status, 303);
  assert.equal((await app.db.pool.query('SELECT cost_cents FROM txn_line WHERE txn_id = $1', [sale])).rows[0].cost_cents, -13000);
  // Voiding the sale returns the stock.
  assert.equal((await app.post(`/txns/${sale}/void`)).status, 303);
  assert.deepEqual(await item(salt), { qty: 120, value_cents: 78000 });
});

test('purchase order: partial receipt, turn the receipt into a bill, bill the rest, closed', async () => {
  const salt = app.ids.items.salt;
  const po = created(await app.post('/vtxns', vdoc({ type: 'purchase_order', due_date: '2026-10-20', items: [{ item: salt, qty: '50', rate: '6.00' }] })));
  const page = await (await app.get(`/vtxns/${po}`)).text();
  assert.match(page, /Purchase Order PO-\d{4}/);
  assert.match(page, /Open/);
  const apBefore = await bal('ap');
  assert.equal(apBefore, await bal('ap'), 'a purchase order posts nothing');

  // Receive 30 of 50 on an item receipt.
  const form = await (await app.get(`/vtxns/new?type=item_receipt&from_po=${po}`)).text();
  assert.match(form, new RegExp(`name="item_po" value="${po}:1"`));
  assert.match(form, /name="item_qty" value="50"/);
  const receipt = created(await app.post('/vtxns', vdoc({ type: 'item_receipt', items: [{ item: salt, qty: '30', rate: '6.00', po: `${po}:1` }] })));
  assert.match(await (await app.get(`/vtxns/${po}`)).text(), /Partially received, \$120\.00 to come/);
  assert.equal((await app.post(`/vtxns/${po}/delete`)).headers.get('location'), `/vtxns/${po}`, 'a received purchase order can’t be deleted');
  assert.equal(await bal('ap') - apBefore, 18000, 'goods received are owed');
  assert.equal((await item(salt)).qty, 150);

  // The bill for the receipt arrives.
  assert.equal((await app.post(`/vtxns/${receipt}/convert`, { txn_date: TODAY, doc_number: 'LS-5501' })).status, 303);
  const asBill = (await app.db.pool.query('SELECT type, doc_number, approval_status, due_date FROM txn WHERE txn_id = $1', [receipt])).rows[0];
  assert.deepEqual([asBill.type, asBill.doc_number, asBill.approval_status], ['bill', 'LS-5501', 'awaiting']);
  assert.equal(await bal('ap') - apBefore, 18000, 'converting doesn’t count it twice');

  // Bill the remaining 20 straight from the purchase order: it closes.
  const rest = await (await app.get(`/vtxns/new?type=bill&from_po=${po}`)).text();
  assert.match(rest, /name="item_qty" value="20"/);
  await app.post('/vtxns', vdoc({ type: 'bill', items: [{ item: salt, qty: '20', rate: '6.00', po: `${po}:1` }] }));
  assert.match(await (await app.get(`/vtxns/${po}`)).text(), /Closed/);

  // PDF and email.
  const pdf = await app.get(`/vtxns/${po}/po.pdf`);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal((await app.post(`/vtxns/${po}/email`)).status, 303);
  const msg = (await app.db.pool.query(`SELECT status, to_addr FROM message WHERE related_txn_id = $1`, [po])).rows[0];
  assert.deepEqual([msg.status, msg.to_addr], ['logged', 'ar@lonestarmill.example']);
});

test('purchase orders can be closed by hand and reopened, and can’t be edited once received', async () => {
  const po = created(await app.post('/vtxns', vdoc({ type: 'purchase_order', items: [{ item: app.ids.items.flyspray, qty: '10', rate: '18' }] })));
  assert.equal((await app.get(`/vtxns/${po}/edit`)).status, 200);
  assert.equal((await app.post(`/vtxns/${po}/close`)).status, 303);
  assert.equal((await app.db.pool.query('SELECT open_cents FROM txn WHERE txn_id = $1', [po])).rows[0].open_cents, 0);
  assert.equal((await app.post(`/vtxns/${po}/reopen`)).status, 303);
  assert.equal((await app.db.pool.query('SELECT open_cents FROM txn WHERE txn_id = $1', [po])).rows[0].open_cents, 18000);
  await app.post('/vtxns', vdoc({ type: 'item_receipt', items: [{ item: app.ids.items.flyspray, qty: '4', rate: '18', po: `${po}:1` }] }));
  assert.equal((await app.get(`/vtxns/${po}/edit`)).headers.get('location'), `/vtxns/${po}`);
  // Someone else's purchase order can't be received on this vendor's bill.
  const other = await app.post('/vtxns', vdoc({ type: 'bill', vendor: app.ids.vendors.hayfarm, items: [{ item: app.ids.items.flyspray, qty: '1', rate: '18', po: `${po}:1` }] }));
  assert.equal(other.status, 422);
});

test('adjust quantity after a count; new inventory item with opening stock', async () => {
  const spray = app.ids.items.flyspray;
  const before = await item(spray);
  const page = await (await app.get(`/settings/items/${spray}/adjust`)).text();
  assert.match(page, /New quantity on hand/);
  const shrinkBefore = await bal('shrinkage');
  const res = await app.post(`/settings/items/${spray}/adjust`, { txn_date: TODAY, newQty: String(before.qty - 3), accountId: '', memo: 'Cycle count' });
  assert.equal(res.status, 303);
  const after = await item(spray);
  assert.equal(after.qty, before.qty - 3);
  assert.ok(await bal('shrinkage') > shrinkBefore, 'the missing cans are written off');
  assert.match(await (await app.get(`/settings/items/${spray}`)).text(), /Inventory Adjustment/);

  const obeBefore = await bal('opening_equity');
  const add = await app.post('/settings/items', { name: 'Wormer Paste', kind: 'inventory', rate: '9.99', cost: '4.25', sku: 'WRM-1', reorderPoint: '10',
    startQty: '36', asOf: '2026-10-01', active: '1' });
  assert.equal(add.status, 303);
  const id = (await app.db.pool.query(`SELECT item_id FROM item WHERE name = 'Wormer Paste'`)).rows[0].item_id;
  assert.deepEqual(await item(id), { qty: 36, value_cents: 15300 });
  assert.equal(await bal('opening_equity') - obeBefore, 15300);
  const dup = await app.post('/settings/items', { name: 'Other', kind: 'inventory', sku: 'wrm-1', active: '1' });
  assert.equal(dup.status, 422, 'SKUs are unique, ignoring case');
  // A product that's been sold can't start tracking quantity.
  const conv = await app.post(`/settings/items/${app.ids.items.cubes}`, { name: 'Range Cubes 20% (ton)', kind: 'inventory', rate: '485', active: '1' });
  assert.equal(conv.status, 422);
});
