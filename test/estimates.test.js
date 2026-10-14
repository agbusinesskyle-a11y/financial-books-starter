import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerCheck } from '../lib/data/ledger.js';
import { rulePrice } from '../lib/data/writes.js';
import { startApp } from './app-harness.js';

const TODAY = '2026-10-12';
const sent = [];
const mailer = { kind: 'smtp', from: 'books@sample.example', async send(m) { sent.push(m); return { status: 'sent' }; } };
let app, scope;
before(async () => {
  app = await startApp({ mailer });
  scope = { orgId: app.ids.orgId, entityId: app.ids.entityId };
  await app.post('/settings/sales', { customNumbers: '1', deposit: '1', defaultDelivery: 'none', statementKind: 'balance_forward', statementAging: '1' });
});
after(async () => {
  const check = await ledgerCheck(app.db.pool, scope);
  assert.ok(check.balanced && check.arMatches && check.apMatches && check.inventoryMatches, JSON.stringify(check));
  await app.close();
});

const q = async (sql, params = []) => (await app.db.pool.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];

async function newCustomer(name) {
  const res = await app.post('/customers', { displayName: name, email: `${name.toLowerCase().replace(/\W+/g, '.')}@example.com`, active: '1' });
  return Number(/\/customers\/(\d+)/.exec(res.headers.get('location'))[1]);
}

function doc(type, customerId, lines, more = {}, path = '/txns') {
  const p = new URLSearchParams({ type, customer_id: String(customerId), txn_date: TODAY, after_save: 'none', ...more });
  for (const l of lines) {
    p.append('line_item', l.item ?? ''); p.append('line_desc', l.desc ?? ''); p.append('line_qty', l.qty ?? '1'); p.append('line_rate', l.rate ?? '');
    p.append('line_service', ''); p.append('line_est', l.est ?? '');
  }
  return app.post(path, p);
}

// Reads the invoice editor the app pre-filled from an estimate and posts it back as-is (or with rates changed).
async function invoiceFrom(estimateId, query, change = rates => rates) {
  const res = await app.get(`/txns/${estimateId}/invoice?${query}`);
  const html = (await res.text()).replace(/<template[\s\S]*?<\/template>/g, ''); // row templates aren't form values
  assert.equal(res.status, 200, html.slice(0, 500));
  const vals = name => [...html.matchAll(new RegExp(`name="${name}" value="([^"]*)"`, 'g'))].map(m => m[1]);
  const descs = vals('line_desc'), rates = change(vals('line_rate')), ests = vals('line_est'), qtys = vals('line_qty');
  const cust = /name="customer_id" value="(\d+)"/.exec(html)[1];
  const lines = descs.map((desc, i) => ({ desc: desc.replace(/&amp;/g, '&'), qty: qtys[i], rate: rates[i], est: ests[i] })).filter(l => l.desc);
  return doc('invoice', cust, lines, { estimate_id: String(estimateId) });
}

test('price rules: the newest matching rule gives a fixed price or a percent off', () => {
  const rules = [{ name: 'Promo', kind: 'percent_off', percent_off: 10, item_ids: [], customer_ids: [] }, { name: 'Fixed', kind: 'fixed', price_cents: 900, item_ids: [5], customer_ids: [] }];
  assert.deepEqual(rulePrice(rules, { itemId: 5, rateCents: 2000 }), { rateCents: 1800, rule: 'Promo' });
  assert.deepEqual(rulePrice(rules.slice(1), { itemId: 5, rateCents: 2000 }), { rateCents: 900, rule: 'Fixed' });
  assert.equal(rulePrice(rules.slice(1), { itemId: 6, rateCents: 2000 }), null);
});

test('an estimate doesn’t post, can be accepted, and is invoiced by percent then the rest; its deposit goes to the first invoice', async () => {
  const c = await newCustomer('Estimate Orchard');
  const res = await doc('estimate', c, [{ desc: 'Fence posts', qty: '10', rate: '30' }, { desc: 'Labor', qty: '8', rate: '50' }],
    { due_date: '2026-11-12', deposit_amount: '100', deposit_method: 'Check' });
  assert.equal(res.status, 303, await res.clone().text());
  const est = await one(`SELECT * FROM txn WHERE customer_id = $1 AND type = 'estimate'`, [c]);
  assert.match(est.doc_number, /^EST-\d{4}$/);
  assert.equal(est.estimate_status, 'pending');
  assert.equal(Number(est.open_cents), 70000);
  assert.equal((await one('SELECT count(*)::int AS n FROM posting WHERE txn_id = $1', [est.txn_id])).n, 0, 'estimates don’t post');
  const dep = await one('SELECT * FROM txn WHERE deposit_for_txn_id = $1', [est.txn_id]);
  assert.equal(Number(dep.open_cents), 10000, 'deposit held as a credit');

  const page = await (await app.get(`/txns/${est.txn_id}`)).text();
  assert.match(page, /Pending/);
  assert.match(page, /Create invoice/);
  assert.equal((await app.post(`/txns/${est.txn_id}/status`, { status: 'accepted' })).status, 303);
  assert.equal((await one('SELECT estimate_status FROM txn WHERE txn_id = $1', [est.txn_id])).estimate_status, 'accepted');

  // 50% progress invoice.
  assert.equal((await invoiceFrom(est.txn_id, 'mode=percent&percent=50')).status, 303);
  const inv1 = await one(`SELECT * FROM txn WHERE customer_id = $1 AND type = 'invoice' ORDER BY txn_id DESC LIMIT 1`, [c]);
  assert.equal(Number(inv1.total_cents), 35000);
  assert.equal(Number(inv1.open_cents), 25000, 'the estimate deposit was applied to the first invoice');
  let e = await one('SELECT open_cents, estimate_status FROM txn WHERE txn_id = $1', [est.txn_id]);
  assert.equal(Number(e.open_cents), 35000);
  assert.match(await (await app.get(`/txns/${est.txn_id}`)).text(), /Partially invoiced/);

  // Over-invoicing a line is refused.
  const over = await invoiceFrom(est.txn_id, 'mode=lines', rates => rates.map(r => (r ? String(Number(r) + 10) : r)));
  assert.equal(over.status, 422);
  assert.match(await over.text(), /more than its/);

  // The rest closes it.
  assert.equal((await invoiceFrom(est.txn_id, 'mode=full')).status, 303);
  e = await one('SELECT open_cents, estimate_status FROM txn WHERE txn_id = $1', [est.txn_id]);
  assert.equal(Number(e.open_cents), 0);
  assert.equal(e.estimate_status, 'closed');

  // Voiding the second invoice reopens what it took.
  const inv2 = await one(`SELECT txn_id FROM txn WHERE customer_id = $1 AND type = 'invoice' ORDER BY txn_id DESC LIMIT 1`, [c]);
  assert.equal((await app.post(`/txns/${inv2.txn_id}/void`)).status, 303);
  e = await one('SELECT open_cents, estimate_status FROM txn WHERE txn_id = $1', [est.txn_id]);
  assert.equal(Number(e.open_cents), 35000);
  assert.equal(e.estimate_status, 'accepted');
});

test('estimates email with their template, print as ESTIMATE, and can be rejected and reopened', async () => {
  const c = await newCustomer('Estimate Mill');
  await doc('estimate', c, [{ desc: 'Grain bin repair', qty: '1', rate: '1200' }]);
  const est = await one(`SELECT * FROM txn WHERE customer_id = $1 AND type = 'estimate'`, [c]);
  sent.length = 0;
  assert.equal((await app.post(`/txns/${est.txn_id}/send`)).status, 303);
  assert.equal(sent[0].subject, `Estimate ${est.doc_number} from Sample Feed Co.`);
  assert.equal((await app.get(`/txns/${est.txn_id}.pdf`)).headers.get('content-type'), 'application/pdf');
  assert.equal((await app.post(`/txns/${est.txn_id}/status`, { status: 'rejected' })).status, 303);
  assert.equal((await app.get(`/txns/${est.txn_id}/invoice?mode=full`)).status, 303, 'rejected estimates can’t be invoiced');
  assert.equal((await app.post(`/txns/${est.txn_id}/status`, { status: 'pending' })).status, 303);
  const list = await (await app.get(`/customers/${c}?type=estimate`)).text();
  assert.match(list, new RegExp(est.doc_number));
  const check = await ledgerCheck(app.db.pool, scope);
  assert.ok(check.balanced && check.arMatches, JSON.stringify(check));
});

test('price rules: settings validate, and a blank rate takes the rule price for that customer and date', async () => {
  const item = await one(`SELECT item_id, rate_cents FROM item WHERE org_id = $1 AND kind <> 'inventory' AND rate_cents > 0 ORDER BY item_id LIMIT 1`, [app.ids.orgId]);
  const c = await newCustomer('Rule Ranch');
  const other = await newCustomer('No Rule Ranch');
  const bad = await app.post('/settings/price-rules', { name: 'Bad', kind: 'fixed', price: '5' });
  assert.equal(bad.status, 422);
  assert.match(await bad.text(), /needs at least one product/);
  const body = new URLSearchParams({ name: 'Wholesale', kind: 'percent_off', percentOff: '20', startDate: '2026-10-01', endDate: '2026-12-31', active: '1' });
  body.append('customerIds', String(c));
  assert.equal((await app.post('/settings/price-rules', body)).status, 303);
  assert.match(await (await app.get('/settings/price-rules')).text(), /Wholesale[\s\S]*20% off[\s\S]*Rule Ranch/);
  const editor = await (await app.get(`/txns/new?type=invoice&customer=${c}`)).text();
  assert.match(editor, /data-price-rules="[^"]*Wholesale/);

  for (const cust of [c, other]) await doc('invoice', cust, [{ item: String(item.item_id), qty: '1', rate: '' }]);
  const ruled = await one(`SELECT total_cents FROM txn WHERE customer_id = $1 AND type = 'invoice'`, [c]);
  const plain = await one(`SELECT total_cents FROM txn WHERE customer_id = $1 AND type = 'invoice'`, [other]);
  assert.equal(Number(ruled.total_cents), Math.round(Number(item.rate_cents) * 0.8));
  assert.equal(Number(plain.total_cents), Number(item.rate_cents));
  // Outside the dates the rule doesn't apply.
  await doc('invoice', c, [{ item: String(item.item_id), qty: '1', rate: '' }], { txn_date: '2027-01-05' });
  const later = await one(`SELECT total_cents FROM txn WHERE customer_id = $1 AND type = 'invoice' AND txn_date = '2027-01-05'`, [c]);
  assert.equal(Number(later.total_cents), Number(item.rate_cents));
});
