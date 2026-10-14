import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './app-harness.js';
import { tieout, TODAY } from './tieout.js';

// QuickBooks' Receive payment "Deposit to": Undeposited Funds (waits for a bank deposit) or straight into a bank account.
let app, t, t2, A, C, item;
before(async () => {
  app = await startApp();
  t = tieout(app);
  t2 = t;
  A = app.ids.accounts;
  C = Object.values(app.ids.customers)[0];
  item = Object.values(app.ids.items)[0];
});
after(async () => { await app.close(); });

const newestPayment = async () => (await app.db.pool.query(`SELECT * FROM txn WHERE type = 'payment' AND customer_id = $1 ORDER BY txn_id DESC LIMIT 1`, [C])).rows[0];

test('a payment deposited straight to the bank posts there and never waits in Undeposited Funds', async () => {
  const form = await (await app.get(`/txns/new?type=payment&customer=${C}`)).text();
  assert.match(form, /name="deposit_to"/);
  assert.match(form, /<option value="\d+" selected>Undeposited Funds<\/option>/, 'Undeposited Funds is the default');
  const p = new URLSearchParams({ type: 'invoice', customer_id: String(C), txn_date: TODAY, then: 'save' });
  p.append('line_item', String(item)); p.append('line_desc', 'Feed'); p.append('line_qty', '1'); p.append('line_rate', '80.00'); p.append('line_service', ''); p.append('line_est', '');
  const inv = Number(/\/txns\/(\d+)/.exec((await app.post('/txns', p)).headers.get('location'))[1]);
  const before = await t.snapshot();
  const r = await app.post('/txns', { type: 'payment', customer_id: String(C), txn_date: TODAY, amount: '80', payment_method: 'Check', payment_ref: '881',
    deposit_to: String(A.checking), [`apply_${inv}`]: '80' });
  assert.equal(r.status, 303, await r.clone().text());
  const pay = await newestPayment();
  assert.equal(Number(pay.account_id), A.checking);
  const after = await t.snapshot();
  t.checkTied(after, 'payment to the bank');
  assert.equal((after.accounts.get(A.checking) ?? 0) - (before.accounts.get(A.checking) ?? 0), 8000);
  const waiting = await (await app.get('/deposits/new')).text();
  assert.doesNotMatch(waiting, new RegExp(`name="source" value="${pay.txn_id}"`), 'not waiting to be deposited');
  // The edit form remembers it; switching back to Undeposited Funds moves it there.
  const edit = await (await app.get(`/txns/${pay.txn_id}/edit`)).text();
  assert.match(edit, new RegExp(`<option value="${A.checking}" selected>`));
  const back = await app.post(`/txns/${pay.txn_id}`, { type: 'payment', customer_id: String(C), txn_date: TODAY, amount: '80', payment_method: 'Check', payment_ref: '881',
    deposit_to: '', [`apply_${inv}`]: '80' });
  assert.equal(back.status, 303, await back.clone().text());
  assert.equal((await newestPayment()).account_id, null);
  assert.match(await (await app.get('/deposits/new')).text(), new RegExp(`name="source" value="${pay.txn_id}"`), 'now it waits');
  t.checkTied(await t.snapshot(), 'payment back to Undeposited Funds');
});

test('only Undeposited Funds or a bank account', async () => {
  const r = await app.post('/txns', { type: 'payment', customer_id: String(C), txn_date: TODAY, amount: '5', deposit_to: String(A.feed_sales) });
  assert.equal(r.status, 422);
  assert.match(await r.text(), /Deposit to Undeposited Funds or a bank account/);
});

test('Deposit Detail shows a payment deposited straight to the bank; a deposited payment can’t move past its deposit', async () => {
  const pay = await app.post('/txns', { type: 'payment', customer_id: String(C), txn_date: TODAY, amount: '33', payment_method: 'Check', payment_ref: '990', deposit_to: String(A.checking) });
  assert.equal(pay.status, 303);
  const direct = await newestPayment();
  const dd = await t.run('deposit_detail', { period: 'today' });
  const row = dd.rows.find(r => r.txnId === Number(direct.txn_id) && !r.sub);
  assert.equal(row?.cells.type, 'Payment (straight to the bank)');
  assert.equal(row.cells.amount, 3300);
  // A payment waiting in Undeposited Funds, deposited, then redated after the deposit: refused.
  await app.post('/txns', { type: 'payment', customer_id: String(C), txn_date: '2026-10-01', amount: '12', payment_method: 'Cash', deposit_to: '' });
  const waiting = await newestPayment();
  const dep = new URLSearchParams({ account_id: String(A.checking), txn_date: '2026-10-02', memo: '' });
  dep.append('source', String(waiting.txn_id));
  assert.equal((await app.post('/deposits', dep)).status, 303);
  const late = await app.post(`/txns/${waiting.txn_id}`, { type: 'payment', customer_id: String(C), txn_date: '2026-10-05', amount: '12', payment_method: 'Cash', deposit_to: '' });
  assert.equal(late.status, 422);
  assert.match(await late.text(), /can’t be dated after its deposit \(2026-10-02\)/);
});

test('Deposit Detail shows what reached the bank from a direct payment, after the processor’s fee', async () => {
  const { repost } = await import('../lib/data/ledger.js');
  // An online-style payment (the processor keeps 3.00, the customer paid 1.00 on top) deposited straight to the bank.
  const { rows: [pay] } = await app.db.pool.query(`INSERT INTO txn (org_id, entity_id, customer_id, type, txn_date, total_cents, open_cents, account_id, fee_cents, surcharge_cents, payment_method)
    VALUES ($1, $2, $3, 'payment', $4, 10000, 10000, $5, 300, 100, 'Credit card') RETURNING txn_id`, [app.ids.orgId, app.ids.entityId, C, TODAY, A.checking]);
  const client = await app.db.pool.connect();
  try { await client.query('BEGIN'); await repost(client, app.ids.orgId, pay.txn_id); await client.query('COMMIT'); } finally { client.release(); }
  const dd = await t2.run('deposit_detail', { period: 'today' });
  const head = dd.rows.find(r => r.txnId === Number(pay.txn_id) && !r.sub);
  assert.equal(head.cells.amount, 9800, 'what the bank got');
  const sub = dd.rows[dd.rows.indexOf(head) + 1];
  assert.notEqual(sub.cells.account, 'Undeposited Funds');
});
