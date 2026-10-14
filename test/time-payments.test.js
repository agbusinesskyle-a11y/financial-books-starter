import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerCheck } from '../lib/data/ledger.js';
import { parseHours, weekStart } from '../lib/data/time.js';
import { PROCESSORS, webhookSecret } from '../lib/payments/processors.js';
import { settingsKey } from '../lib/secrets.js';
import { canAccess } from '../lib/domain/roles.js';
import { startApp } from './app-harness.js';

const TODAY = '2026-10-12';
const KEY = '12'.repeat(32);
const sent = [];
const mailer = { kind: 'smtp', from: 'books@sample.example', async send(m) { sent.push(m); return { status: 'sent' }; } };
let app, scope;
before(async () => {
  app = await startApp({ mailer, env: { SETTINGS_KEY: KEY } });
  scope = { orgId: app.ids.orgId, entityId: app.ids.entityId };
});
after(async () => {
  const check = await ledgerCheck(app.db.pool, scope);
  assert.ok(check.balanced && check.arMatches && check.apMatches && check.inventoryMatches, JSON.stringify(check));
  await app.close();
});

const q = async (sql, params = []) => (await app.db.pool.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];

test('hours parse from 1.5, 1:30 and 90m; weeks start on Monday; everyone can keep time', () => {
  assert.equal(parseHours('1.5'), 90);
  assert.equal(parseHours('1:30'), 90);
  assert.equal(parseHours('90m'), 90);
  assert.equal(parseHours('2h'), 120);
  assert.equal(parseHours('abc'), null);
  assert.equal(weekStart('2026-10-12'), '2026-10-12');
  assert.equal(weekStart('2026-10-18'), '2026-10-12');
  for (const role of ['customers', 'vendors']) assert.ok(canAccess(role, 'POST', '/time'));
  assert.ok(canAccess('reports', 'GET', '/time'));
  assert.ok(!canAccess('reports', 'POST', '/time'), 'reports-only looks but doesn’t change');
});

test('time entries and the weekly timesheet; billable time goes on an invoice once', async () => {
  const service = (await one(`SELECT item_id, rate_cents FROM item WHERE org_id = $1 AND kind = 'service' AND rate_cents > 0 ORDER BY item_id LIMIT 1`, [app.ids.orgId]));
  const c = app.ids.customers.hilltop;
  assert.equal((await app.post('/time', { date: TODAY, job: `c:${c}`, item_id: String(service.item_id), hours: '2:30', billable: '1', notes: 'Fence repair' })).status, 303);
  const noCustomer = await app.post('/time', { date: TODAY, job: '', hours: '1', billable: '1' });
  assert.equal(noCustomer.status, 422);
  assert.match(await app.get(`/time?date=${TODAY}`).then(r => r.text()), /Fence repair/);

  const sheet = new URLSearchParams({ monday: '2026-10-12' });
  const row = (job, item, billable, days) => {
    sheet.append('ts_job', job); sheet.append('ts_item', item); sheet.append('ts_billable', billable);
    for (let d = 0; d < 7; d++) sheet.append(`ts_d${d}`, days[d] ?? '');
  };
  row(`c:${c}`, String(service.item_id), '1', ['2:30', '1', '', '', '', '', '']);
  row('', '', '', ['', '', '0.5', '', '', '', '']);
  assert.equal((await app.post('/time/week', sheet)).status, 303);
  const entries = await q(`SELECT minutes, billable FROM time_entry WHERE entry_date BETWEEN '2026-10-12' AND '2026-10-18' ORDER BY entry_date, minutes`);
  assert.deepEqual(entries.map(e => [e.minutes, e.billable]), [[150, true], [60, true], [30, false]], 'the sheet replaced the week');

  assert.match(await (await app.get(`/customers/${c}`)).text(), /Unbilled time: 3\.5 hours/);
  const editor = await (await app.get(`/txns/new?type=invoice&customer=${c}&billable=1`)).text();
  const times = [...editor.matchAll(/name="line_time" value="(\d+)"/g)].map(m => m[1]);
  assert.equal(times.length, 2);
  const p = new URLSearchParams({ type: 'invoice', customer_id: String(c), txn_date: TODAY, after_save: 'none' });
  for (const [i, t] of times.entries()) {
    p.append('line_item', String(service.item_id)); p.append('line_desc', 'Labor'); p.append('line_qty', i ? '1' : '2.5'); p.append('line_rate', '');
    p.append('line_service', ''); p.append('line_est', ''); p.append('line_bill', ''); p.append('line_time', t);
  }
  assert.equal((await app.post('/txns', p)).status, 303);
  assert.doesNotMatch(await (await app.get(`/customers/${c}`)).text(), /Unbilled time/);
  assert.equal((await app.post('/txns', p)).status, 422, 'time is billed once');
  const billed = await one(`SELECT entry_id FROM time_entry WHERE minutes = 150`);
  assert.equal((await app.post(`/time/${billed.entry_id}`, { date: TODAY, hours: '3' })).status, 422, 'billed time is locked');
});

test('online payments: settings, a Pay now link in the invoice email, the test checkout, a signed webhook, a receipt', async () => {
  assert.equal((await app.post('/settings/payments', { enabled: '1', processor: 'stripe', card: '1' })).status, 422, 'not connected');
  assert.equal((await app.post('/settings/payments', { enabled: '1', processor: 'test', card: '1', ach: '1', feePayer: 'company' })).status, 303);
  const c = app.ids.customers.hilltop;
  await app.db.pool.query(`UPDATE customer SET email = 'hilltop@example.com' WHERE customer_id = $1`, [c]);
  const p = new URLSearchParams({ type: 'invoice', customer_id: String(c), txn_date: TODAY, after_save: 'email' });
  p.append('line_item', ''); p.append('line_desc', 'Feed order'); p.append('line_qty', '1'); p.append('line_rate', '200');
  sent.length = 0;
  assert.equal((await app.post('/txns', p)).status, 303);
  const inv = await one(`SELECT txn_id, doc_number FROM txn WHERE customer_id = $1 AND type = 'invoice' ORDER BY txn_id DESC LIMIT 1`, [c]);
  const link = /Pay online: http:\/\/127\.0\.0\.1:\d+(\/pay\/[A-Za-z0-9_-]{43})/.exec(sent[0].text)[1];
  const record = await one('SELECT body FROM message WHERE related_txn_id = $1 ORDER BY message_id DESC LIMIT 1', [inv.txn_id]);
  assert.doesNotMatch(record.body, /\/pay\//, 'the link isn’t kept in the message record');

  const page = await (await fetch(app.base + link)).text();
  assert.match(page, /Balance due <strong>\$200\.00/);
  assert.match(page, /Test mode/);
  const open = await fetch(app.base + link, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'method=card' });
  assert.equal(open.status, 303);
  const checkoutPath = new URL(open.headers.get('location'), app.base).pathname;
  const checkoutId = /co_[A-Za-z0-9_-]{24}/.exec(checkoutPath)[0];
  assert.match(await (await fetch(app.base + checkoutPath)).text(), /Pay \$200\.00 \(test\)/);

  // A forged webhook is refused.
  const forged = JSON.stringify({ type: 'checkout.paid', checkout_id: checkoutId });
  const bad = await fetch(`${app.base}/webhooks/payments/test`, { method: 'POST', body: forged, headers: { 'x-fb-signature': 'deadbeef', 'content-type': 'application/json' } });
  assert.equal(bad.status, 400);
  assert.equal((await one('SELECT status FROM online_checkout WHERE checkout_id = $1', [checkoutId])).status, 'open');

  sent.length = 0;
  const pay = await fetch(app.base + checkoutPath, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'action=pay' });
  assert.equal(pay.status, 303);
  assert.match(await (await fetch(app.base + pay.headers.get('location'))).text(), /Thank you!/);
  const co = await one('SELECT * FROM online_checkout WHERE checkout_id = $1', [checkoutId]);
  assert.equal(co.status, 'paid');
  const payment = await one('SELECT * FROM txn WHERE txn_id = $1', [co.payment_txn_id]);
  assert.equal(Number(payment.total_cents), 20000);
  assert.equal(Number(payment.fee_cents), Math.round(20000 * 0.029) + 30);
  assert.equal(Number((await one('SELECT open_cents FROM txn WHERE txn_id = $1', [inv.txn_id])).open_cents), 0);
  const fees = await one(`SELECT sum(p.amount_cents)::bigint AS n FROM posting p JOIN account a ON a.account_id = p.account_id WHERE a.system_key = 'merchant_fees' AND p.txn_id = $1`, [payment.txn_id]);
  assert.equal(Number(fees.n), 610);
  assert.equal(sent.filter(m => /Payment receipt/.test(m.subject)).length, 1, 'a receipt was emailed');

  // A replayed (correctly signed) webhook doesn't record it twice; the deposit list shows what actually arrived.
  const secret = webhookSecret(settingsKey({ SETTINGS_KEY: KEY }));
  const replay = await fetch(`${app.base}/webhooks/payments/test`, { method: 'POST', body: forged, headers: { 'x-fb-signature': PROCESSORS.test.sign(forged, secret) } });
  assert.equal(replay.status, 200);
  assert.equal((await one(`SELECT count(*)::int AS n FROM txn WHERE payment_ref = $1`, [checkoutId.slice(0, 50)])).n, 1);
  const deposit = await (await app.get('/deposits/new')).text();
  assert.match(deposit, /\$193\.90/, 'Undeposited Funds holds the payment less the fee');
  assert.match(await (await fetch(app.base + link)).text(), /Nothing is due/);
});

test('when the customer pays the fee, it’s added to what they pay and booked as income', async () => {
  assert.equal((await app.post('/settings/payments', { enabled: '1', processor: 'test', ach: '1', feePayer: 'customer' })).status, 303);
  const c = app.ids.customers.hilltop;
  const p = new URLSearchParams({ type: 'invoice', customer_id: String(c), txn_date: TODAY, after_save: 'email' });
  p.append('line_item', ''); p.append('line_desc', 'Hay'); p.append('line_qty', '1'); p.append('line_rate', '1000');
  sent.length = 0;
  await app.post('/txns', p);
  const link = /(\/pay\/[A-Za-z0-9_-]{43})/.exec(sent[0].text)[1];
  assert.match(await (await fetch(app.base + link)).text(), /includes a \$5\.00 processing fee/);
  const open = await fetch(app.base + link, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'method=ach' });
  await fetch(new URL(open.headers.get('location'), app.base), { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'action=pay' });
  const pay = await one(`SELECT * FROM txn WHERE type = 'payment' AND surcharge_cents > 0 ORDER BY txn_id DESC LIMIT 1`);
  assert.equal(Number(pay.total_cents), 100000);
  assert.equal(Number(pay.surcharge_cents), 500);
  assert.equal(Number(pay.fee_cents), 500, 'ACH fee is capped at $5');
  const check = await ledgerCheck(app.db.pool, scope);
  assert.ok(check.balanced && check.arMatches, JSON.stringify(check));
});
