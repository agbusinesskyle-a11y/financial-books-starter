import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './app-harness.js';
import { tieout, TODAY } from './tieout.js';

// Stage F5: QBO's deposit form extras — Cash back (part of the deposit kept as cash, into another account), the deposit
// slip and summary PDFs, and Save and print.
let app, t, A, C, item;
before(async () => {
  app = await startApp();
  t = tieout(app);
  A = app.ids.accounts;
  C = Object.values(app.ids.customers)[0];
  item = Object.values(app.ids.items)[0];
});
after(async () => { await app.close(); });

const idIn = (r, re) => {
  const m = re.exec(r.headers.get('location') ?? '');
  assert.ok(m, `${r.status} ${r.headers.get('location')}`);
  return Number(m[1]);
};
// Two customer payments waiting in Undeposited Funds: $300 cash and $200 by check.
async function twoPayments() {
  const p = new URLSearchParams({ type: 'invoice', customer_id: String(C), txn_date: TODAY, then: 'save' });
  p.append('line_item', String(item)); p.append('line_desc', 'Feed'); p.append('line_qty', '1'); p.append('line_rate', '500.00'); p.append('line_service', ''); p.append('line_est', '');
  const inv = idIn(await app.post('/txns', p), /\/txns\/(\d+)/);
  const out = [];
  for (const [amt, method, ref] of [['300', 'Cash', ''], ['200', 'Check', '4411']]) {
    const r = await app.post('/txns', { type: 'payment', customer_id: String(C), txn_date: TODAY, amount: amt, payment_method: method, payment_ref: ref, [`apply_${inv}`]: amt });
    assert.equal(r.status, 303, await r.clone().text());
    out.push(Number((await app.db.pool.query(`SELECT max(txn_id) AS id FROM txn WHERE type = 'payment' AND customer_id = $1`, [C])).rows[0].id));
  }
  return out;
}
const body = (sources, more = {}) => {
  const p = new URLSearchParams({ account_id: String(A.checking), txn_date: TODAY, memo: 'Friday bank run', ...more });
  for (const s of sources) p.append('source', String(s));
  return p;
};

test('cash back: the bank gets the rest, the cash goes to its account, and the books tie', async () => {
  const pays = await twoPayments();
  const before = await t.snapshot();
  const r = await app.post('/deposits', body(pays, { cash_back_account: String(A.owner_equity), cash_back_memo: 'Owner took cash', cash_back_amount: '50.00', then: 'close' }));
  assert.equal(r.status, 303, await r.clone().text());
  const id = idIn(r, /\/deposits\/(\d+)/);
  const { rows: [d] } = await app.db.pool.query('SELECT total_cents, cash_back_cents, cash_back_account_id, cash_back_memo FROM txn WHERE txn_id = $1', [id]);
  assert.deepEqual([Number(d.total_cents), Number(d.cash_back_cents), Number(d.cash_back_account_id), d.cash_back_memo], [45000, 5000, A.owner_equity, 'Owner took cash']);
  const after = await t.snapshot();
  t.checkTied(after, 'deposit with cash back');
  const moved = k => (after.accounts.get(k) ?? 0) - (before.accounts.get(k) ?? 0);
  assert.equal(moved(A.checking), 45000, 'the bank gets the net');
  assert.equal(moved(A.owner_equity), 5000, 'cash back to its account');
  const page = await (await app.get(`/deposits/${id}`)).text();
  assert.match(page, /Cash back/);
  assert.match(page, /\$50\.00 to Owner’s Equity · Owner took cash/);
  // Deposit Detail: the rows still add up to the deposit.
  const dd = await t.run('deposit_detail', { period: 'today' });
  const head = dd.rows.findIndex(x => x.txnId === id && x.txnType === 'deposit');
  assert.equal(dd.rows[head].cells.amount, 45000);
  const subs = [];
  for (let i = head + 1; dd.rows[i]?.sub; i++) subs.push(dd.rows[i]);
  assert.equal(subs.reduce((s, x) => s + x.cells.amount, 0), -45000);
  assert.ok(subs.some(x => x.cells.type === 'Cash back'));
  // Deleting it puts everything back.
  assert.equal((await app.post(`/deposits/${id}/delete`)).status, 303);
  t.checkTied(await t.snapshot(), 'cash back deposit deleted');
});

test('cash back is checked', async () => {
  const pays = await twoPayments();
  for (const [more, msg] of [
    [{ cash_back_amount: '500.00', cash_back_account: String(A.owner_equity) }, /Cash back must be less than the \$500\.00/],
    [{ cash_back_amount: '20.00' }, /choose the account the cash goes to/],
    [{ cash_back_amount: '20.00', cash_back_account: String(A.checking) }, /can’t go to Undeposited Funds, A\/R, A\/P or the deposit’s own bank account/],
    [{ cash_back_amount: 'lots', cash_back_account: String(A.owner_equity) }, /Cash back: enter an amount/],
  ]) {
    const r = await app.post('/deposits', body(pays, more));
    assert.equal(r.status, 422, JSON.stringify(more));
    assert.match(await r.text(), msg);
  }
  // A blank cash back is no cash back.
  const r = await app.post('/deposits', body(pays, { cash_back_account: String(A.owner_equity), cash_back_amount: '' }));
  assert.equal(r.status, 303);
  const { rows: [d] } = await app.db.pool.query('SELECT total_cents, cash_back_cents, cash_back_account_id FROM txn WHERE txn_id = $1', [idIn(r, /\/deposits\/(\d+)/)]);
  assert.deepEqual([Number(d.total_cents), Number(d.cash_back_cents), d.cash_back_account_id], [50000, 0, null]);
});

test('deposit slip and summary PDFs; Save and print opens the slip', async () => {
  const pays = await twoPayments();
  const page = await (await app.get('/deposits/new')).text();
  assert.match(page, /name="then" value="print"[^>]*>Save and print/);
  assert.match(page, /name="cash_back_amount"/);
  const r = await app.post('/deposits', body(pays, { then: 'print' }));
  assert.equal(r.status, 303);
  const loc = r.headers.get('location');
  assert.match(loc, /^\/deposits\/\d+\/slip\.pdf$/);
  for (const path of [loc, `${loc}?summary=1`]) {
    const pdf = await app.get(path);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.ok((await pdf.arrayBuffer()).byteLength > 1000);
  }
  const id = Number(/\/deposits\/(\d+)/.exec(loc)[1]);
  const view = await (await app.get(`/deposits/${id}`)).text();
  assert.ok(view.includes(`/deposits/${id}/slip.pdf?summary=1`));
  assert.equal((await app.get('/deposits/999999999/slip.pdf')).status, 404);
});
