import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './app-harness.js';
import { freshDb } from './harness.js';
import { tieout, TODAY } from './tieout.js';
import { postingsFor } from '../lib/domain/ledger.js';
import { CREATE, SOON } from '../lib/views/nav.js';
import { buildSampleFeed, writeLedgerlineSample, sampleUuid } from '../lib/bankfeed/sample.js';
import { pullCompany } from '../lib/bankfeed/pull.js';
import { linkCompany, saveMappings } from '../lib/data/bankfeeds.js';
import { addItem, undoItem } from '../lib/data/banking.js';
import { learnedHistory, payeeKey } from '../lib/bankfeed/rules.js';
import { wordingHistory } from '../lib/bankfeed/wording.js';

// Credit card credit (build 1): a refund onto a company card — the card's balance owed goes down and the categories
// are credited, the mirror of a card expense. Made from its form (create, edit, void, delete, copy), shown wherever expenses
// are, and written by the bank review for money into a card. Every step is checked with the deep tie-out; the expected
// amounts come from the debits and credits, never from the app. (QuickBooks' "Credit Card Credit" importing as one is
// covered in import-qbo.test.js, on its fixtures.)
let app, llDb, ll, feed, S, t, A, V, I;
const actor = 'tester';
const llId = name => feed.accounts.find(a => a.name === name).id;

before(async () => {
  llDb = await freshDb({ migrate: false });
  ll = llDb.pool;
  app = await startApp({ ledgerline: ll });
  S = { orgId: app.ids.orgId, entityId: app.ids.entityId };
  A = app.ids.accounts; V = app.ids.vendors; I = app.ids.items;
  feed = await buildSampleFeed(app.db.pool, { ...S, asOf: '2026-10-12' });
  await writeLedgerlineSample(ll, feed);
  await app.db.pool.query('UPDATE org SET ledgerline_org_id = $1 WHERE org_id = $2', [feed.org, app.ids.orgId]);
  await linkCompany(app.db.pool, ll, { ...S, llEntityId: feed.entities[0].id, actor });
  await pullCompany(app.db.pool, ll, S);
  await saveMappings(app.db.pool, { ...S, actor, choices: [
    { id: llId('Operating Checking'), choice: String(A.checking) }, { id: llId('Business Savings'), choice: String(A.savings) },
    { id: llId('Business Card'), choice: String(A.card) }, { id: llId('Equipment Loan'), choice: String(A.equipment_loan) }] });
  await pullCompany(app.db.pool, ll, S);
  t = tieout(app);
  t.checkTied(await t.snapshot(), 'sample');
});
after(async () => { await app.close(); await llDb.drop(); });

const pool = () => app.db.pool;
const q = async (sql, params = []) => (await pool().query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const vtxnId = res => Number(/\/vtxns\/(\d+)/.exec(res.headers.get('location') ?? '')?.[1] ?? NaN);
const errorOf = async res => (/class="error[^"]*"[^>]*>([\s\S]*?)<\//.exec(await res.clone().text()) ?? [])[1] ?? '';
const ok303 = async (res, what) => assert.equal(res.status, 303, `${what}: ${res.status} ${res.status === 303 ? '' : await errorOf(res)}`);
const flashError = async res => {
  const loc = res.headers.get('location');
  if (!loc) return '';
  const page = await (await app.get(loc)).text();
  return (/class="flash error"[^>]*>([\s\S]*?)<\//.exec(page) ?? /role="alert"[^>]*>([\s\S]*?)<\//.exec(page) ?? [])[1] ?? '';
};
// The vendor form the way the editor posts it.
function doc({ type = 'cc_credit', vendor, date = TODAY, cats = [], items = [], ...rest }) {
  const p = new URLSearchParams({ type, vendor_id: vendor ? String(vendor) : '', txn_date: date, ...rest });
  for (const c of cats) {
    p.append('cat_account', String(c.account)); p.append('cat_desc', c.desc ?? ''); p.append('cat_amount', c.amount); p.append('cat_job', '');
    p.append('cat_po', ''); p.append('cat_billable', ''); p.append('cat_class', '');
  }
  for (const i of items) {
    p.append('item_item', String(i.item)); p.append('item_desc', i.desc ?? ''); p.append('item_qty', i.qty); p.append('item_rate', i.rate); p.append('item_job', '');
    p.append('item_po', ''); p.append('item_billable', ''); p.append('item_class', '');
  }
  return p;
}
const netOf = (s, basis) => (basis === 'cash' ? s.plCash : s.pl).rows.find(row => /^Net Income$/.test(row.label ?? ''))?.values.at(-1) ?? 0;
// Snapshot, act, snapshot: the books tie every way and moved exactly as expected (cash: the cash-basis net income change).
async function step(label, action, expected = {}) {
  const a = await t.snapshot();
  const out = await action();
  const b = await t.snapshot();
  t.checkTied(b, label);
  const { cash, ...want } = expected;
  t.expectChange(a, b, { label, ...want });
  if (cash !== undefined) assert.equal(netOf(b, 'cash') - netOf(a, 'cash'), cash, `${label}: cash-basis net income change`);
  return out;
}
const postingsOf = async txnId => (await q('SELECT account_id, amount_cents FROM posting WHERE txn_id = $1 ORDER BY account_id', [txnId]))
  .map(p => [Number(p.account_id), Number(p.amount_cents)]);
const st = {};

test('posting: the card is debited by the total, each category line credited (the mirror of a card expense)', () => {
  const txn = { txn_id: 1, type: 'cc_credit', total_cents: 5000, account_id: 10, vendor_id: 3 };
  const lines = [{ line_no: 1, account_id: 20, amount_cents: 3000 }, { line_no: 2, account_id: 21, amount_cents: 2500 }, { line_no: 3, account_id: 22, amount_cents: -500 }];
  assert.deepEqual(postingsFor({ txn, lines, sys: {} }).map(p => [p.accountId, p.amountCents, p.vendorId]), [[10, 5000, 3], [20, -3000, 3], [21, -2500, 3], [22, 500, 3]]);
  // A product line goes to the product's expense account (Cost of Goods Sold if none); voided posts nothing.
  assert.deepEqual(postingsFor({ txn: { ...txn, total_cents: 700 }, lines: [{ line_no: 1, item_id: 5, amount_cents: 700 }], sys: { cogs: 50 } })
    .map(p => [p.accountId, p.amountCents]), [[10, 700], [50, -700]]);
  assert.deepEqual(postingsFor({ txn: { ...txn, voided_at: new Date() }, lines, sys: {} }), []);
  assert.throws(() => postingsFor({ txn, lines: lines.slice(0, 2), sys: {} }), /add to 5500, not the total 5000/);
});

test('the Create menu opens the form; the Soon page is gone', async () => {
  const vendors = CREATE.find(([h]) => h === 'Vendors')[1];
  assert.deepEqual(vendors.find(i => i.label === 'Credit card credit'), { label: 'Credit card credit', href: '/vtxns/new?type=cc_credit', slug: null });
  assert.ok(!Object.hasOwn(SOON, 'credit-card-credit'));
  assert.equal((await app.get('/soon/credit-card-credit')).status, 404);
  const body = await (await app.get('/customers')).text();
  assert.match(body, /href="\/vtxns\/new\?type=cc_credit"/);
  // The form: only credit card accounts to refund to, an optional payee, category and product lines.
  const form = await (await app.get('/vtxns/new?type=cc_credit')).text();
  assert.match(form, /New credit card credit/);
  assert.match(form, /<span>Credit card account<\/span>/);
  assert.match(form, /<span>Payee \(vendor\)<\/span>/);
  assert.match(form, /name="cat_account"/);
  assert.match(form, /name="item_item"/);
  assert.match(form, /<span>Memo<\/span>/);
  const accountSelect = /<select name="account_id"[\s\S]*?<\/select>/.exec(form)[0];
  assert.ok(accountSelect.includes(`value="${A.card}"`), 'the card is offered');
  assert.ok(!accountSelect.includes(`value="${A.checking}"`), 'a bank account is not');
  assert.doesNotMatch(form, /Payment method/);
  // The expense transactions list offers it too.
  assert.match(await (await app.get('/expense-transactions')).text(), /href="\/vtxns\/new\?type=cc_credit"/);
});

test('create from the form: card debited, categories and products credited; shown wherever expenses are', async () => {
  // Fuel 45.10 + 1 tub @ 20.00 (a product with no expense account → Cost of Goods Sold) = 65.10 back on the card.
  st.c1 = await step('card credit with a vendor', async () => {
    const res = await app.post('/vtxns', doc({ vendor: V.fuel, account_id: String(A.card), doc_number: 'R-77', memo: 'Fuel refund CC-ONE',
      cats: [{ account: A.fuel, amount: '45.10' }], items: [{ item: I.tub, qty: '1', rate: '20.00' }] }));
    await ok303(res, 'card credit');
    return vtxnId(res);
  }, { accounts: { [A.card]: 6510, [A.fuel]: -4510, cogs: -2000 }, net: 6510, cash: 6510 });
  const row = await one('SELECT type, vendor_id, account_id, total_cents, open_cents, payment_method, doc_number FROM txn WHERE txn_id = $1', [st.c1]);
  assert.deepEqual([row.type, Number(row.vendor_id), Number(row.account_id), Number(row.total_cents), Number(row.open_cents), row.payment_method, row.doc_number],
    ['cc_credit', V.fuel, A.card, 6510, 0, null, 'R-77']);
  await t.expectHistory(st.c1);
  // Its page, the vendor's transactions, the expense transactions list (and its type filter), the card's register, search.
  const page = await (await app.get(`/vtxns/${st.c1}`)).text();
  assert.match(page, /<h1>Credit Card Credit R-77<\/h1>/);
  assert.match(page, /<dt>Payee<\/dt>/);
  assert.match(page, /Posted/);
  assert.match(page, new RegExp(`href="/vtxns/${st.c1}/edit"`));
  assert.ok((await (await app.get(`/vendors/${V.fuel}?tab=transactions&date=all`)).text()).includes(`/vtxns/${st.c1}`), 'vendor page');
  assert.ok((await (await app.get(`/vendors/${V.fuel}?tab=transactions&date=all&type=cc_credit`)).text()).includes(`/vtxns/${st.c1}`), 'vendor page, filtered');
  for (const path of ['/expense-transactions?date=all', '/expense-transactions?date=all&type=cc_credit']) {
    const list = await (await app.get(path)).text();
    assert.ok(list.includes(`/vtxns/${st.c1}`), path);
    assert.match(list, /Credit Card Credit/, path);
  }
  assert.ok((await (await app.get(`/settings/accounts/${A.card}`)).text()).includes(`/vtxns/${st.c1}`), 'card register links to it');
  assert.ok((await (await app.get('/search?q=CC-ONE')).text()).includes(`/vtxns/${st.c1}`), 'search');
  assert.equal((await app.get(`/txns/${st.c1}`)).headers.get('location'), `/vtxns/${st.c1}`);
  // Copy opens a new one filled in the same.
  const copy = await (await app.get(`/vtxns/new?copy=${st.c1}`)).text();
  assert.match(copy, /New credit card credit/);
  assert.match(copy, /value="45\.10"/);
});

test('a bank account, a customer or no lines are refused; the vendor is optional', async () => {
  const bank = await app.post('/vtxns', doc({ account_id: String(A.checking), cats: [{ account: A.office, amount: '10.00' }] }));
  assert.equal(bank.status, 422);
  assert.match(await bank.text(), /Choose the credit card account the refund went to\./);
  const none = await app.post('/vtxns', doc({ account_id: String(A.card) }));
  assert.equal(none.status, 422);
  // The database holds the same rules: never a customer, always the card it went back to.
  await assert.rejects(pool().query(`INSERT INTO txn (org_id, entity_id, type, txn_date, total_cents, open_cents, customer_id, account_id)
    VALUES ($1, $2, 'cc_credit', $3, 100, 0, $4, $5)`, [S.orgId, S.entityId, TODAY, Object.values(app.ids.customers)[0], A.card]), /txn_party_check/);
  await assert.rejects(pool().query(`INSERT INTO txn (org_id, entity_id, type, txn_date, total_cents, open_cents) VALUES ($1, $2, 'cc_credit', $3, 100, 0)`,
    [S.orgId, S.entityId, TODAY]), /txn_paid_from/);
  st.c2 = await step('card credit with no vendor', async () => {
    const res = await app.post('/vtxns', doc({ account_id: String(A.card), memo: 'Office return', cats: [{ account: A.office, amount: '12.34' }] }));
    await ok303(res, 'no vendor');
    return vtxnId(res);
  }, { accounts: { [A.card]: 1234, [A.office]: -1234 }, net: 1234 });
  assert.equal((await one('SELECT vendor_id FROM txn WHERE txn_id = $1', [st.c2])).vendor_id, null);
  // Reference numbers repeat, like an expense's.
  const again = await app.post('/vtxns', doc({ account_id: String(A.card), doc_number: 'R-77', cats: [{ account: A.office, amount: '1.00' }] }));
  await ok303(again, 'same ref no.');
  await step('delete it', async () => assert.equal(await flashError(await app.post(`/vtxns/${vtxnId(again)}/delete`)), ''),
    { accounts: { [A.card]: -100, [A.office]: 100 }, net: -100 });
});

test('edit, void and delete like an expense', async () => {
  const edit = await (await app.get(`/vtxns/${st.c1}/edit`)).text();
  assert.match(edit, /Edit credit card credit R-77/);
  // Fuel 45.10 → 50.00: 4.90 more back on the card.
  await step('edit', async () => ok303(await app.post(`/vtxns/${st.c1}`, doc({ vendor: V.fuel, account_id: String(A.card), doc_number: 'R-77', memo: 'Fuel refund CC-ONE',
    cats: [{ account: A.fuel, amount: '50.00' }], items: [{ item: I.tub, qty: '1', rate: '20.00' }] })), 'edit'),
  { accounts: { [A.card]: 490, [A.fuel]: -490 }, net: 490 });
  assert.deepEqual(await postingsOf(st.c1), [[A.card, 7000], [A.fuel, -5000], [t.sys().cogs, -2000]].sort((x, y) => x[0] - y[0]));
  await step('void', async () => assert.equal(await flashError(await app.post(`/vtxns/${st.c1}/void`)), ''),
    { accounts: { [A.card]: -7000, [A.fuel]: 5000, cogs: 2000 }, net: -7000 });
  const v = await one('SELECT voided_at, total_cents FROM txn WHERE txn_id = $1', [st.c1]);
  assert.ok(v.voided_at);
  assert.equal(Number(v.total_cents), 0);
  assert.deepEqual(await postingsOf(st.c1), []);
  await t.expectHistory(st.c1);
  await step('delete', async () => assert.equal(await flashError(await app.post(`/vtxns/${st.c2}/delete`)), ''),
    { accounts: { [A.card]: -1234, [A.office]: 1234 }, net: -1234 });
  assert.equal((await q('SELECT 1 FROM txn WHERE txn_id = $1', [st.c2])).length, 0);
});

test('stock returned on a card credit leaves inventory at its cost', async () => {
  const add = await app.post('/settings/items', { name: 'CC Wormer', kind: 'inventory', rate: '9.99', cost: '4.25', sku: 'CCW-1', startQty: '10', asOf: '2026-10-01', active: '1' });
  assert.equal(add.status, 303);
  const item = Number((await one(`SELECT item_id FROM item WHERE name = 'CC Wormer'`)).item_id);
  // 2 back to the store at 4.25 each: Dr card 850, Cr Inventory Asset 850; 8 left worth 34.00.
  const id = await step('return stock', async () => {
    const res = await app.post('/vtxns', doc({ vendor: V.office, account_id: String(A.card), items: [{ item, qty: '2', rate: '4.25' }] }));
    await ok303(res, 'return');
    return vtxnId(res);
  }, { accounts: { [A.card]: 850, inventory: -850 } });
  const i = await one('SELECT qty_on_hand, value_cents FROM item WHERE item_id = $1', [item]);
  assert.deepEqual([Number(i.qty_on_hand), Number(i.value_cents)], [8, 3400]);
  await step('delete the return', async () => assert.equal(await flashError(await app.post(`/vtxns/${id}/delete`)), ''), { accounts: { [A.card]: -850, inventory: 850 } });
  assert.equal(Number((await one('SELECT qty_on_hand FROM item WHERE item_id = $1', [item])).qty_on_hand), 10);
});

// ---- the bank review ----

async function bankSays(rows) {
  for (const r of rows) {
    await ll.query(`INSERT INTO core.transaction (org_id, transaction_id, account_id, amount, currency, posted_date, pending, description_raw, status, revision)
      VALUES ($1, $2, $3, $4, 'USD', $5, false, $6, 'active', 1)`, [feed.org, sampleUuid('cc-credit', r.key), llId(r.account), r.amount, r.date, r.description]);
  }
  await pullCompany(pool(), ll, S);
  return Promise.all(rows.map(async r => Number((await one('SELECT item_id FROM bank_feed_item WHERE entity_id = $1 AND description = $2', [S.entityId, r.description])).item_id)));
}

test('bank review: money into a card is a credit card credit (vendor or none); a customer keeps the journal entry; Undo deletes it', async () => {
  const [withVendor, noPayee, fromCustomer] = await bankSays([
    { key: 'v', account: 'Business Card', amount: '15.37', date: '2026-10-10', description: 'CCC FUELSTOP REFUND' },
    { key: 'n', account: 'Business Card', amount: '21.19', date: '2026-10-10', description: 'CCC OFFICEMART RETURN' },
    { key: 'c', account: 'Business Card', amount: '9.83', date: '2026-10-10', description: 'CCC CUSTOMER PAID ON CARD' }]);
  const page = await (await app.get(`/banking/item/${withVendor}`)).text();
  assert.match(page, /Records a credit card credit \(a journal entry when the payee is a customer\) on Business Card/);
  st.b1 = await step('card refund from a vendor', () => addItem(pool(), { ...S, itemId: withVendor, payee: `v:${V.fuel}`, lines: [{ accountId: A.fuel, amount: '' }], actor }),
    { accounts: { [A.card]: 1537, [A.fuel]: -1537 }, net: 1537 });
  const b1 = await one('SELECT type, vendor_id, account_id, memo FROM txn WHERE txn_id = $1', [st.b1]);
  assert.deepEqual([b1.type, Number(b1.vendor_id), Number(b1.account_id), b1.memo], ['cc_credit', V.fuel, A.card, 'CCC FUELSTOP REFUND']);
  await t.expectHistory(st.b1);
  // With no payee, split, a negative line taking some off: 25.00 office − 3.81 fees = 21.19.
  const b2 = await step('card refund, no payee, split', () => addItem(pool(), { ...S, itemId: noPayee, actor,
    lines: [{ accountId: A.office, amount: '25.00' }, { accountId: A.bank_fees, amount: '-3.81' }] }),
  { accounts: { [A.card]: 2119, [A.office]: -2500, [A.bank_fees]: 381 }, net: 2119 });
  const row2 = await one('SELECT type, vendor_id FROM txn WHERE txn_id = $1', [b2]);
  assert.deepEqual([row2.type, row2.vendor_id], ['cc_credit', null]);
  const customerId = Object.values(app.ids.customers)[0];
  const b3 = await step('money from a customer onto the card', () => addItem(pool(), { ...S, itemId: fromCustomer, payee: `c:${customerId}`, lines: [{ accountId: A.office, amount: '' }], actor }),
    { accounts: { [A.card]: 983, [A.office]: -983 }, net: 983 });
  assert.equal((await one('SELECT type FROM txn WHERE txn_id = $1', [b3])).type, 'journal_entry');
  // Undo deletes the card credit and the line waits for review again.
  await step('undo', () => undoItem(pool(), { ...S, itemId: noPayee, actor }), { accounts: { [A.card]: -2119, [A.office]: 2500, [A.bank_fees]: -381 }, net: -2119 });
  assert.equal((await q('SELECT 1 FROM txn WHERE txn_id = $1', [b2])).length, 0);
  assert.equal((await one('SELECT review_state FROM bank_feed_item WHERE item_id = $1', [noPayee])).review_state, 'new');
});

test('bank review learns from a card credit as it does from an expense', async () => {
  const history = await learnedHistory(pool(), S);
  const learned = history.get(`in|${payeeKey('CCC FUELSTOP REFUND')}`);
  assert.ok(learned?.some(e => e.payee === `v:${V.fuel}` && e.accountId === A.fuel), JSON.stringify(learned));
  const wording = await wordingHistory(pool(), S);
  const doc1 = wording.docs.find(d => d.txnId === st.b1);
  assert.ok(doc1, 'the card credit is in the wording history');
  assert.deepEqual([doc1.out, doc1.party, doc1.accountId], [false, `v:${V.fuel}`, A.fuel]);
});

test('reports: a card credit counts against purchases the same in the Purchase List, the Expenses builder and Purchases by Vendor', async () => {
  // A new vendor: a 100.00 expense on the card, then 20.00 of it refunded to the card — 80.00 bought from them.
  const res = await app.post('/vendors', { displayName: 'CC Cross Check' });
  const vendor = Number(/\/vendors\/(\d+)/.exec(res.headers.get('location'))[1]);
  await ok303(await app.post('/vtxns', doc({ type: 'expense', vendor, account_id: String(A.card), payment_method: 'Credit card', cats: [{ account: A.office, amount: '100.00' }] })), 'expense');
  await ok303(await app.post('/vtxns', doc({ vendor, account_id: String(A.card), cats: [{ account: A.office, amount: '20.00' }] })), 'card credit');
  const query = { period: 'custom', from: TODAY, to: TODAY, vendor: String(vendor) };
  const grand = rep => rep.rows.find(r => r.grand)?.cells?.amount;
  const list = await t.run('purchase_list', query);
  assert.deepEqual(list.rows.filter(r => r.kind === 'line').map(r => [r.txnType, r.cells.amount]).sort(), [['cc_credit', -2000], ['expense', 10000]]);
  assert.equal(grand(list), 8000, 'Purchase List');
  const builder = await t.run('report_builder', { ...query, b_source: 'expenses' });
  assert.equal(grand(builder), 8000, 'Expenses builder');
  const byVendor = await t.run('purchases_by_vendor_summary', query);
  assert.equal(byVendor.rows.find(r => Number(r.groupId) === vendor).values.at(-1), 8000, 'Purchases by Vendor');
});
