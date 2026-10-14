import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { startApp } from './app-harness.js';
import { getSummary } from '../lib/data/customers.js';
import { getTransaction } from '../lib/data/transactions.js';

const TODAY = '2026-10-12';
let app, cust;
before(async () => {
  app = await startApp();
  cust = app.ids.customers.brazos;
});
after(async () => { await app.close(); });

const summary = () => getSummary(app.db.pool, { orgId: app.ids.orgId, customerId: cust, today: TODAY });
const txn = id => getTransaction(app.db.pool, { orgId: app.ids.orgId, id });
const flashOf = async () => /class="flash (ok|error)" role="status">([^<]*)</.exec(await (await app.get(`/customers/${cust}`)).text())?.slice(1);
const newest = async type => (await app.db.pool.query(
  `SELECT txn_id FROM txn WHERE customer_id = $1 AND type = $2 ORDER BY txn_id DESC LIMIT 1`, [cust, type])).rows[0].txn_id;

function invoiceForm(lines, extra = {}) {
  const p = new URLSearchParams({ type: 'invoice', customer_id: String(cust), txn_date: TODAY, due_date: '', terms_id: '', doc_number: '', memo: 'Test memo', ...extra });
  for (const l of lines) { p.append('line_item', l.item ?? ''); p.append('line_desc', l.desc ?? ''); p.append('line_qty', l.qty ?? ''); p.append('line_rate', l.rate ?? ''); }
  return p;
}

test('new invoice form renders with items and terms', async () => {
  const res = await app.get(`/txns/new?type=invoice&customer=${cust}`);
  assert.equal(res.status, 200);
  const page = await res.text();
  assert.match(page, /New invoice/);
  assert.match(page, /Range Cubes 20% \(ton\)/);
  assert.match(page, /Net 30/);
  assert.match(page, /name="line_qty"/);
});

test('create invoice through the form', async () => {
  const before = await summary();
  const res = await app.post('/txns', invoiceForm([{ desc: 'Hay', qty: '10', rate: '85' }, { desc: '', qty: '', rate: '' }]));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), `/customers/${cust}`);
  const [kind, text] = await flashOf();
  assert.equal(kind, 'ok');
  assert.match(text, /Invoice INV-\d+ saved\./);
  assert.equal((await summary()).openCents, before.openCents + 85000);
});

test('validation errors re-render the form with what was typed', async () => {
  const res = await app.post('/txns', invoiceForm([{ desc: 'Bad', qty: 'two', rate: '5' }], { memo: 'keep me' }));
  assert.equal(res.status, 422);
  const page = await res.text();
  assert.match(page, /Line 1: quantity/);
  assert.match(page, /value="keep me"/);
  assert.match(page, /value="two"/);
});

test('every POST needs CSRF', async () => {
  assert.equal((await app.post('/txns', invoiceForm([{ desc: 'x', qty: '1', rate: '1' }]))).status, 303); // with csrf it works
  const params = invoiceForm([{ desc: 'x', qty: '1', rate: '1' }]);
  params.set('csrf', 'nope');
  assert.equal((await app.post('/txns', params)).status, 403);
  const id = await newest('invoice');
  for (const action of ['void', 'delete', 'send']) {
    const p = new URLSearchParams({ csrf: 'nope' });
    assert.equal((await app.post(`/txns/${id}/${action}`, p)).status, 403, action);
  }
});

test('receive payment from a row prefills that invoice and applies it', async () => {
  const inv = await newest('invoice');
  const open = (await txn(inv)).open_cents;
  const page = await (await app.get(`/txns/new?type=payment&customer=${cust}&charge=${inv}`)).text();
  assert.match(page, new RegExp(`name="apply_${inv}" value="${(open / 100).toFixed(2)}"`));
  const before = await summary();
  const res = await app.post('/txns', { type: 'payment', customer_id: String(cust), txn_date: TODAY, payment_method: 'Check', payment_ref: 'Check 777',
    amount: (open / 100).toFixed(2), memo: '', [`apply_${inv}`]: (open / 100).toFixed(2) });
  assert.equal(res.status, 303);
  assert.equal((await txn(inv)).open_cents, 0);
  assert.equal((await summary()).openCents, before.openCents - open);
  const edit = await (await app.get(`/txns/${await newest('payment')}/edit`)).text();
  assert.match(edit, /Edit payment/);
  assert.match(edit, new RegExp(`name="apply_${inv}" value="${(open / 100).toFixed(2)}"`));
});

test('payment over-application shows the error on the form', async () => {
  const inv = (await app.db.pool.query(`SELECT txn_id, open_cents FROM txn WHERE customer_id = $1 AND type = 'invoice' AND open_cents > 0 ORDER BY txn_id LIMIT 1`, [cust])).rows[0];
  const res = await app.post('/txns', { type: 'payment', customer_id: String(cust), txn_date: TODAY, amount: '1.00', [`apply_${inv.txn_id}`]: '5.00' });
  assert.equal(res.status, 422);
  assert.match(await res.text(), /only received \$1\.00/);
});

test('void and delete from the row menu', async () => {
  await app.post('/txns', invoiceForm([{ desc: 'To void', qty: '1', rate: '10' }]));
  const inv = await newest('invoice');
  const before = await summary();
  assert.equal((await app.post(`/txns/${inv}/void`)).status, 303);
  assert.ok((await txn(inv)).voided_at);
  assert.equal((await summary()).openCents, before.openCents - 1000);
  assert.equal((await app.post(`/txns/${inv}/delete`)).status, 303);
  assert.equal(await txn(inv), null);
  // As in QBO, a paid invoice can be deleted: its payment stays, now an unapplied credit for the customer.
  const { rows: [link] } = await app.db.pool.query(`SELECT a.charge_txn_id, a.credit_txn_id, a.amount_cents FROM application a JOIN txn t ON t.txn_id = a.charge_txn_id
    WHERE t.customer_id = $1 AND t.type = 'invoice' AND NOT EXISTS (SELECT 1 FROM txn f WHERE f.source_txn_id = t.txn_id) LIMIT 1`, [cust]);
  const openBefore = (await txn(link.credit_txn_id)).open_cents;
  const res = await app.post(`/txns/${link.charge_txn_id}/delete`);
  assert.equal(res.status, 303);
  assert.equal(await txn(link.charge_txn_id), null);
  assert.equal((await txn(link.credit_txn_id)).open_cents, openBefore + Number(link.amount_cents), 'the payment is a credit again');
});

test('copy prefills a new invoice from an old one', async () => {
  const src = (await app.db.pool.query(`SELECT txn_id FROM txn WHERE customer_id = $1 AND type = 'invoice' AND voided_at IS NULL ORDER BY txn_id LIMIT 1`, [cust])).rows[0].txn_id;
  const t = await txn(src);
  const page = await (await app.get(`/txns/new?copy=${src}`)).text();
  assert.match(page, /New invoice/);
  assert.ok(page.includes(`value="${t.lines[0].description}"`));
  assert.match(page, new RegExp(`name="txn_date" value="${TODAY}"`));
  assert.equal((await app.get(`/txns/new?copy=${await newest('payment')}`)).status, 404);
});

test('print one, print many, send many', async () => {
  const inv = await newest('invoice');
  const one = await app.get(`/txns/${inv}.pdf`);
  assert.equal(one.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await one.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  const ids = (await app.db.pool.query(`SELECT txn_id FROM txn WHERE customer_id = $1 AND voided_at IS NULL ORDER BY txn_id DESC LIMIT 2`, [cust])).rows.map(r => String(r.txn_id));
  const batch = (action) => { const p = new URLSearchParams({ action }); ids.forEach(id => p.append('ids', id)); return app.post(`/customers/${cust}/batch`, p); };
  const many = await batch('print');
  assert.equal(many.headers.get('content-type'), 'application/pdf');
  const sent = await batch('send');
  assert.equal(sent.status, 303);
  const [kind, text] = await flashOf();
  assert.equal(kind, 'ok');
  assert.match(text, /2 of 2 sent \(recorded only/);
  const msgs = await app.db.pool.query('SELECT count(*)::int AS n FROM message WHERE customer_id = $1', [cust]);
  assert.equal(msgs.rows[0].n, 2);
  // Another customer's transaction can't ride along.
  const foreign = (await app.db.pool.query(`SELECT txn_id FROM txn WHERE customer_id <> $1 LIMIT 1`, [cust])).rows[0].txn_id;
  const p = new URLSearchParams({ action: 'print' }); p.append('ids', String(foreign));
  assert.equal((await app.post(`/customers/${cust}/batch`, p)).status, 404);
});

test('apply an unapplied payment from its page', async () => {
  const prepay = (await app.db.pool.query(`SELECT txn_id, open_cents FROM txn WHERE customer_id = $1 AND type = 'payment' AND open_cents > 0 LIMIT 1`, [cust])).rows[0];
  await app.post('/txns', invoiceForm([{ desc: 'For prepay', qty: '1', rate: '100' }]));
  const inv = await newest('invoice');
  const page = await (await app.get(`/txns/${prepay.txn_id}`)).text();
  assert.match(page, /Apply \$[\d,.]+ unapplied/);
  assert.equal((await app.post(`/txns/${prepay.txn_id}/apply`, { [`apply_${inv}`]: '100.00' })).status, 303);
  assert.equal((await txn(inv)).open_cents, 0);
  assert.equal((await txn(prepay.txn_id)).open_cents, prepay.open_cents - 10000);
});

test('customer create, edit, duplicate', async () => {
  const res = await app.post('/customers', { displayName: 'Brand New Farm', email: 'hi@newfarm.example', phone: '(940) 555-1111', billingLine1: '1 Road', billingCity: 'Krum', billingState: 'TX', billingPostal: '76249', shippingSameAsBilling: '1', active: '1', lateFeesEnabled: '1', preferredDelivery: 'email' });
  assert.equal(res.status, 303);
  const id = Number(/\/customers\/(\d+)/.exec(res.headers.get('location'))[1]);
  const page = await (await app.get(`/customers/${id}`)).text();
  assert.match(page, /Customer Brand New Farm created\./);
  assert.match(page, /1 Road, Krum, TX 76249/);
  const edit = await (await app.get(`/customers/${id}/edit`)).text();
  assert.match(edit, /value="Brand New Farm"/);
  assert.equal((await app.post(`/customers/${id}`, { displayName: 'Brand New Farm', email: 'changed@newfarm.example', active: '1' })).status, 303);
  assert.match(await (await app.get(`/customers/${id}?tab=details`)).text(), /changed@newfarm\.example/);
  const dup = await app.post('/customers', { displayName: 'Hilltop Dairy' });
  assert.equal(dup.status, 422);
  assert.match(await dup.text(), /already exists/);
});

test('export still matches after writes', async () => {
  const res = await app.get(`/customers/${cust}/export.xlsx`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  const n = (await app.db.pool.query('SELECT count(*)::int AS n FROM txn WHERE customer_id = $1', [cust])).rows[0].n;
  assert.equal(wb.getWorksheet('Transactions').rowCount, n + 1);
});
