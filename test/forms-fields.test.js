import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './app-harness.js';
import { computeStatement } from '../lib/data/statements.js';

// Stage F4: QBO's other sales form fields — Cc/Bcc, Bill to / Ship to, shipping, P.O. number, internal and statement
// memos, print later / send later (and their queues), estimate acceptance and deposit — plus the Email and Payor previews.
const TODAY = '2026-10-12';
const sent = [];
const mailer = { kind: 'smtp', from: 'books@sample.example', async send(m) { sent.push(m); return { status: 'sent' }; } };
let app, C, item, scope;
before(async () => {
  app = await startApp({ mailer });
  C = Object.values(app.ids.customers)[0];
  item = Object.values(app.ids.items)[0];
  scope = { orgId: app.ids.orgId, entityId: app.ids.entityId };
  await app.db.pool.query(`UPDATE customer SET email = 'ap@customer.example', cc = 'boss@customer.example', bcc = NULL WHERE customer_id = $1`, [C]);
});
after(async () => { await app.close(); });

const sale = (type, extras = null, more = {}) => {
  const p = new URLSearchParams({ type, customer_id: String(C), txn_date: TODAY, then: 'save', ...more });
  p.append('line_item', String(item)); p.append('line_desc', 'Thing'); p.append('line_qty', '1'); p.append('line_rate', '40.00'); p.append('line_service', ''); p.append('line_est', '');
  if (extras) { p.set('extras', '1'); for (const [k, v] of Object.entries(extras)) p.set(k, v); }
  return p;
};
const idOf = r => Number(/\/txns\/(\d+)/.exec(r.headers.get('location'))[1]);
const row = async id => (await app.db.pool.query('SELECT * FROM txn WHERE txn_id = $1', [id])).rows[0];
const html = async path => { const r = await app.get(path); assert.equal(r.status, 200, path); return r.text(); };

test('the extra fields save, show, edit and print', async () => {
  const r = await app.post('/txns', sale('invoice', { email_cc: 'a@x.example, b@x.example', email_bcc: 'me@books.example', bill_to: 'Red River Feed\n1 Main St',
    ship_to: 'North barn\nRoute 9', ship_via: 'UPS', ship_date: '2026-10-14', tracking_no: '1Z999', po_number: 'PO-77', internal_note: 'Slow payer',
    statement_memo: 'October hay', print_later: '1' }));
  assert.equal(r.status, 303, await r.clone().text());
  const id = idOf(r);
  const t = await row(id);
  assert.deepEqual([t.email_cc, t.email_bcc, t.bill_to, t.ship_to, t.ship_via, t.tracking_no, t.po_number, t.internal_note, t.statement_memo, t.print_later, t.send_later],
    ['a@x.example, b@x.example', 'me@books.example', 'Red River Feed\n1 Main St', 'North barn\nRoute 9', 'UPS', '1Z999', 'PO-77', 'Slow payer', 'October hay', true, false]);
  const view = await html(`/txns/${id}`);
  for (const s of ['PO-77', 'UPS', '1Z999', 'Slow payer', 'October hay']) assert.ok(view.includes(s), s);
  const edit = await html(`/txns/${id}/edit`);
  assert.match(edit, /name="po_number"[^>]*value="PO-77"/);
  assert.match(edit, /name="print_later" value="1" checked/);
  const pdf = await app.get(`/txns/${id}.pdf`);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  // A copy doesn't carry the one-off details (P.O., tracking, print later).
  const copy = await html(`/txns/new?copy=${id}`);
  assert.doesNotMatch(copy, /value="PO-77"/);
  assert.match(copy, /October hay/);
});

test('bad copies, dates and deposits are refused', async () => {
  for (const [extras, msg] of [[{ email_cc: 'not an email' }, /Cc: enter email addresses/], [{ ship_date: '2026-13-40' }, /Ship date isn’t a valid date/]]) {
    const r = await app.post('/txns', sale('invoice', extras));
    assert.equal(r.status, 422);
    assert.match(await r.text(), msg);
  }
  const r = await app.post('/txns', sale('estimate', { deposit_request: '150' }));
  assert.equal(r.status, 422);
  assert.match(await r.text(), /Deposit request/);
});

test('a new form starts with the customer’s copies and addresses; the page carries them for a changed customer', async () => {
  const page = await html(`/txns/new?type=invoice&customer=${C}`);
  assert.match(page, /name="email_cc"[^>]*value="boss@customer\.example"/);
  assert.match(page, /data-cc="boss@customer\.example"/);
  assert.match(page, /data-bill="/);
});

test('sending uses the transaction’s Cc and Bcc', async () => {
  const id = idOf(await app.post('/txns', sale('invoice', { email_cc: 'cc1@x.example', email_bcc: 'hidden@x.example' })));
  sent.length = 0;
  const r = await app.post(`/txns/${id}/send`, new URLSearchParams());
  assert.equal(r.status, 303);
  assert.equal(sent.length, 1);
  assert.match(sent[0].cc, /cc1@x\.example/);
  assert.match(sent[0].bcc, /hidden@x\.example/);
  // Without the section posted (an older form), the customer's own copies are used.
  const id2 = idOf(await app.post('/txns', sale('invoice')));
  sent.length = 0;
  await app.post(`/txns/${id2}/send`, new URLSearchParams());
  assert.match(sent[0].cc, /boss@customer\.example/);
});

test('an estimate with “Accepted by” is accepted, and shows its deposit', async () => {
  const id = idOf(await app.post('/txns', sale('estimate', { accepted_by: 'Pat Rancher', accepted_date: TODAY, deposit_request: '25' })));
  const t = await row(id);
  assert.equal(t.estimate_status, 'accepted');
  assert.equal(Number(t.deposit_request_percent), 25);
  const view = await html(`/txns/${id}`);
  assert.ok(view.includes('Pat Rancher'));
});

test('the statement shows the statement memo', async () => {
  const id = idOf(await app.post('/txns', sale('invoice', { statement_memo: 'Fall feed contract' })));
  const st = await computeStatement(app.db.pool, { ...scope, customerId: C, request: { kind: 'open_item', statementDate: TODAY } });
  assert.equal(st.rows.find(x => Number(x.txn_id) === id)?.memo, 'Fall feed contract');
});

test('Print later and Send later queues', async () => {
  await app.db.pool.query('UPDATE txn SET print_later = false, send_later = false WHERE entity_id = $1', [scope.entityId]);
  const p = idOf(await app.post('/txns', sale('invoice', { print_later: '1' })));
  const s = idOf(await app.post('/txns', sale('invoice', { send_later: '1' })));
  const printPage = await html('/sales-queue?which=print');
  assert.match(printPage, new RegExp(`name="ids" value="${p}"`));
  assert.match(printPage, /Print later \(1\)/);
  assert.match(printPage, /Send later \(1\)/);
  const pr = await app.post('/sales-queue/print', new URLSearchParams([['ids', String(p)], ['ids', String(s)]]));
  assert.equal(pr.status, 200);
  assert.equal(pr.headers.get('content-type'), 'application/pdf');
  assert.equal((await row(p)).print_later, false);
  assert.equal((await row(s)).send_later, true, 'only queued ones are touched');
  sent.length = 0;
  const sr = await app.post('/sales-queue/send', new URLSearchParams([['ids', String(s)]]));
  assert.equal(sr.status, 303);
  assert.equal(sent.length, 1);
  assert.equal((await row(s)).send_later, false);
  assert.match(await html('/sales-queue?which=send'), /Nothing waiting to send/);
  const none = await app.post('/sales-queue/send', new URLSearchParams());
  assert.equal(none.status, 303);
});

test('Email and Payor previews send nothing', async () => {
  const id = idOf(await app.post('/txns', sale('invoice', { email_cc: 'cc2@x.example' })));
  sent.length = 0;
  const email = await html(`/txns/${id}/preview`);
  assert.ok(email.includes('ap@customer.example'));
  assert.ok(email.includes('cc2@x.example'));
  assert.match(email, /<pre class="email-body">/);
  const payor = await html(`/txns/${id}/preview?view=payor`);
  assert.match(payor, /Nothing here can be paid/);
  assert.equal(sent.length, 0);
  const t = await html(`/txns/${id}`);
  assert.ok(t.includes(`/txns/${id}/preview`), 'in the More menu');
  assert.equal((await app.get('/txns/999999999/preview')).status, 404);
});
