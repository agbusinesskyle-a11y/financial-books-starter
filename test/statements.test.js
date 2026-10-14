import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildStatement, aging, validateStatementRequest } from '../lib/domain/statements.js';
import { computeStatement } from '../lib/data/statements.js';
import { getSummary } from '../lib/data/customers.js';
import { startApp } from './app-harness.js';

const TODAY = '2026-10-12';
const t = (id, type, date, total, open, due = null) => ({ txn_id: id, type, doc_number: `D${id}`, payment_ref: null, txn_date: date, due_date: due, total_cents: total, open_cents: open });

// ---- pure statement math ----

test('balance forward runs a balance from the opening amount', () => {
  const s = buildStatement({ kind: 'balance_forward', statementDate: '2026-10-31', startDate: '2026-10-01', endDate: '2026-10-31', openingCents: 1000,
    inRange: [t(2, 'payment', '2026-10-20', 300, 0), t(1, 'invoice', '2026-10-05', 500, 500, '2026-11-04')] });
  assert.deepEqual(s.rows.map(r => [r.number, r.amount_cents, r.balance_cents]), [['D1', 500, 1500], ['D2', -300, 1200]]);
  assert.equal(s.total_due_cents, 1200);
  assert.equal(s.opening_cents, 1000);
});

test('open item lists only what is open; credits count against it', () => {
  const s = buildStatement({ kind: 'open_item', statementDate: TODAY,
    openItems: [t(1, 'invoice', '2026-09-01', 900, 400, '2026-10-01'), t(2, 'invoice', '2026-09-02', 100, 0, '2026-10-02'), t(3, 'credit_memo', '2026-09-03', 250, 50)] });
  assert.deepEqual(s.rows.map(r => r.open_cents), [400, -50]);
  assert.equal(s.total_due_cents, 350);
  assert.equal(s.start_date, null);
});

test('transaction statement totals what is still open in the period', () => {
  const s = buildStatement({ kind: 'transaction', statementDate: TODAY, startDate: '2026-09-01', endDate: TODAY,
    inRange: [t(1, 'invoice', '2026-09-01', 900, 400, '2026-10-01'), t(2, 'payment', '2026-09-15', 500, 0)] });
  assert.deepEqual(s.rows.map(r => [r.amount_cents, r.open_cents]), [[900, 400], [-500, -0]]);
  assert.equal(s.total_due_cents, 400);
});

test('aging buckets by days past due on the statement date', () => {
  const due = days => ({ open_cents: 1, due_date: new Date(Date.UTC(2026, 9, 12) - days * 86_400_000).toISOString().slice(0, 10) });
  assert.deepEqual(aging([due(-5), due(0), due(1), due(30), due(31), due(60), due(61), due(90), due(91)], TODAY),
    { current: 2, d1_30: 2, d31_60: 2, d61_90: 2, over_90: 1 });
});

test('statement requests are validated', () => {
  const ok = { kind: 'balance_forward', statementDate: TODAY, startDate: '2026-09-01', endDate: TODAY };
  assert.equal(validateStatementRequest(ok), null);
  assert.equal(validateStatementRequest({ kind: 'open_item', statementDate: TODAY }), null);
  assert.match(validateStatementRequest({ ...ok, kind: 'x' }), /type/);
  assert.match(validateStatementRequest({ ...ok, startDate: '2026-10-13' }), /on or before/);
  assert.match(validateStatementRequest({ ...ok, endDate: '2026-10-13' }), /after the statement date/);
  assert.match(validateStatementRequest({ ...ok, startDate: '2020-01-01' }), /five years/);
  assert.match(validateStatementRequest({ ...ok, statementDate: '2026-02-30' }), /statement date/);
});

// ---- against the sample books, through the app ----

const outbox = [];
const mailer = { kind: 'smtp', from: '"Sample Feed Co." <billing@samplefeed.example>', async send(m) { outbox.push(m); return { status: 'sent' }; } };
let app, cust, scope;
before(async () => {
  app = await startApp({ mailer });
  cust = app.ids.customers.redriver;
  scope = { orgId: app.ids.orgId, entityId: app.ids.entityId, customerId: cust };
});
after(async () => { await app.close(); });

test('statement totals agree with the customer’s open balance', async () => {
  const { openCents } = await getSummary(app.db.pool, { orgId: scope.orgId, customerId: cust, today: TODAY });
  const open = await computeStatement(app.db.pool, { ...scope, request: { kind: 'open_item', statementDate: TODAY } });
  assert.equal(open.total_due_cents, openCents);
  const all = await computeStatement(app.db.pool, { ...scope, request: { kind: 'balance_forward', statementDate: TODAY, startDate: '2022-01-01', endDate: TODAY } });
  assert.equal(all.total_due_cents, openCents);
  // Splitting the period moves rows into the opening balance without changing the ending balance.
  const recent = await computeStatement(app.db.pool, { ...scope, request: { kind: 'balance_forward', statementDate: TODAY, startDate: '2026-07-01', endDate: TODAY } });
  assert.equal(recent.total_due_cents, openCents);
  assert.ok(recent.rows.length < all.rows.length);
  assert.equal(open.aging.current + open.aging.d1_30 + open.aging.d31_60 + open.aging.d61_90 + open.aging.over_90,
    open.rows.filter(r => r.open_cents > 0).reduce((s, r) => s + r.open_cents, 0));
});

test('create, list, print, and send a statement', async () => {
  const tab = await (await app.get(`/customers/${cust}?tab=statements`)).text();
  assert.match(tab, /Create statement/);
  assert.match(tab, /No statements yet/);
  const preview = await app.post(`/customers/${cust}/statements`, { action: 'preview', kind: 'open_item', statementDate: TODAY });
  assert.equal(preview.headers.get('content-type'), 'application/pdf');
  assert.equal(await app.db.pool.query('SELECT 1 FROM statement').then(r => r.rowCount), 0, 'preview saves nothing');

  const saved = await app.post(`/customers/${cust}/statements`, { action: 'save', kind: 'balance_forward', statementDate: TODAY, startDate: '2026-09-01', endDate: TODAY });
  assert.equal(saved.headers.get('location'), `/customers/${cust}?tab=statements`);
  const st = (await app.db.pool.query('SELECT * FROM statement WHERE customer_id = $1', [cust])).rows[0];
  assert.equal(st.kind, 'balance_forward');
  const list = await (await app.get(`/customers/${cust}?tab=statements`)).text();
  assert.match(list, /Statement saved\./);
  assert.match(list, /Balance forward/);
  assert.match(list, /Not sent/);
  const pdf = await app.get(`/statements/${st.statement_id}.pdf`);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');

  outbox.length = 0;
  assert.equal((await app.post(`/statements/${st.statement_id}/send`)).status, 303);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].subject, 'Statement from Sample Feed Co.');
  assert.equal(outbox[0].attachments[0].filename, `statement-${TODAY}.pdf`);
  const after = (await app.db.pool.query('SELECT sent_at, sent_to FROM statement WHERE statement_id = $1', [st.statement_id])).rows[0];
  assert.ok(after.sent_at);
  const msg = (await app.db.pool.query('SELECT status FROM message WHERE related_statement_id = $1', [st.statement_id])).rows[0];
  assert.equal(msg.status, 'sent');
  assert.match(await (await app.get(`/customers/${cust}?tab=activity`)).text(), /Statement dated .* emailed to/);
  assert.match(await (await app.get(`/customers/${cust}?tab=statements`)).text(), /Send again/);
});

test('save-and-send in one step, and bad dates keep the form', async () => {
  outbox.length = 0;
  assert.equal((await app.post(`/customers/${cust}/statements`, { action: 'send', kind: 'open_item', statementDate: TODAY })).status, 303);
  assert.equal(outbox.length, 1);
  const bad = await app.post(`/customers/${cust}/statements`, { action: 'save', kind: 'transaction', statementDate: TODAY, startDate: '2026-10-10', endDate: '2026-09-01' });
  assert.equal(bad.status, 422);
  const page = await bad.text();
  assert.match(page, /on or before the end date/);
  assert.match(page, /name="startDate" value="2026-10-10"/);
  assert.equal((await app.get('/statements/999999.pdf')).status, 404);
});

test('a statement for another company’s customer is not reachable', async () => {
  const other = await app.db.pool.query(`INSERT INTO entity (org_id, name) VALUES ($1, 'Other Co') RETURNING entity_id`, [scope.orgId]);
  const c = await app.db.pool.query(`INSERT INTO customer (org_id, entity_id, display_name) VALUES ($1, $2, 'Elsewhere') RETURNING customer_id`, [scope.orgId, other.rows[0].entity_id]);
  const s = await app.db.pool.query(
    `INSERT INTO statement (org_id, entity_id, customer_id, kind, statement_date, total_due_cents, content) VALUES ($1,$2,$3,'open_item',$4,0,'{}') RETURNING statement_id`,
    [scope.orgId, other.rows[0].entity_id, c.rows[0].customer_id, TODAY]);
  assert.equal((await app.get(`/statements/${s.rows[0].statement_id}.pdf`)).status, 404);
});

// ---- Conversations ----

test('compose an email, log a reply, and see the thread', async () => {
  outbox.length = 0;
  const conv = await (await app.get(`/customers/${cust}?tab=conversations`)).text();
  assert.match(conv, /New email/);
  assert.ok(!conv.includes('recorded only. <a'), 'no setup notice when email is connected');
  const missing = await app.post(`/customers/${cust}/messages`, { action: 'send', to: 'ap@redriver.example', subject: '', body: 'Keep this text' });
  assert.equal(missing.status, 422);
  const kept = await missing.text();
  assert.match(kept, /Enter a subject/);
  assert.match(kept, />Keep this text</);

  const sent = await app.post(`/customers/${cust}/messages`, { action: 'send', to: 'ap@redriver.example', subject: 'Delivery Friday', body: 'Hi,\n<b>Truck</b> comes Friday.' });
  assert.equal(sent.status, 303);
  assert.equal(outbox.length, 1);
  assert.deepEqual([outbox[0].to, outbox[0].subject, outbox[0].attachments.length], ['ap@redriver.example', 'Delivery Friday', 0]);

  assert.equal((await app.post(`/customers/${cust}/messages`, { action: 'reply', from: 'ap@redriver.example', subject: 'Re: Delivery Friday', body: 'Thanks, see you then.' })).status, 303);
  const thread = await (await app.get(`/customers/${cust}?tab=conversations`)).text();
  assert.match(thread, /Reply saved to the conversation\./);
  assert.ok(thread.indexOf('Thanks, see you then.') < thread.indexOf('comes Friday'), 'newest first');
  assert.match(thread, /&lt;b&gt;Truck&lt;\/b&gt;/);
  assert.match(thread, /Statement<\/a>/, 'statement sends appear in the thread');
  assert.equal((await app.post(`/customers/${cust}/messages`, { action: 'reply', from: 'nope', body: 'x' })).status, 422);
  const kinds = (await app.db.pool.query(`SELECT kind FROM activity_event WHERE customer_id = $1 AND kind IN ('email_sent', 'reply_logged')`, [cust])).rows.map(r => r.kind).sort();
  assert.deepEqual(kinds, ['email_sent', 'reply_logged']);
});

test('the email button on the header opens compose', async () => {
  const page = await (await app.get(`/customers/${cust}`)).text();
  assert.match(page, new RegExp(`href="/customers/${cust}\\?tab=conversations#compose"`));
  assert.match(page, new RegExp(`href="/customers/${cust}\\?tab=statements#new-statement">Statement<`));
});
