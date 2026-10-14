import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerCheck } from '../lib/data/ledger.js';
import { allocate, toHome, formatMoney } from '../lib/domain/fx.js';
import { startApp } from './app-harness.js';

const TODAY = '2026-10-12';
let app, scope, eur, euroVendor;
before(async () => {
  app = await startApp();
  scope = { orgId: app.ids.orgId, entityId: app.ids.entityId };
});
after(async () => {
  const check = await ledgerCheck(app.db.pool, scope);
  assert.ok(check.balanced && check.arMatches && check.apMatches && check.inventoryMatches, JSON.stringify(check));
  await app.close();
});

const q = async (sql, params = []) => (await app.db.pool.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const sys = async key => (await one(`SELECT account_id FROM account WHERE system_key = $1 AND entity_id = $2`, [key, app.ids.entityId])).account_id;
const posted = async (txnId, key) => Number((await one(`SELECT coalesce(sum(p.amount_cents), 0)::bigint AS n FROM posting p JOIN account a ON a.account_id = p.account_id
  WHERE p.txn_id = $1 AND a.system_key = $2`, [txnId, key])).n);
const books = async () => {
  const c = await ledgerCheck(app.db.pool, scope);
  assert.ok(c.balanced && c.arMatches && c.apMatches, JSON.stringify(c));
};

function invoice(customerId, rate, more = {}, type = 'invoice') {
  const p = new URLSearchParams({ type, customer_id: String(customerId), txn_date: TODAY, after_save: 'none', ...more });
  p.append('line_item', ''); p.append('line_desc', 'Export order'); p.append('line_qty', '1'); p.append('line_rate', rate);
  return app.post('/txns', p);
}
const pay = (customerId, amount, apply, more = {}) => app.post('/txns', { type: 'payment', customer_id: String(customerId), txn_date: TODAY, amount,
  payment_method: 'Wire', ...Object.fromEntries(Object.entries(apply).map(([id, a]) => [`apply_${id}`, a])), ...more });

test('allocation keeps foreign lines adding up to the converted total', () => {
  const { lines, total } = allocate([3333, 3333, 3334], 1.0837);
  assert.equal(total, toHome(10000, 1.0837));
  assert.equal(lines.reduce((s, x) => s + x, 0), total);
  assert.equal(formatMoney(123456, 'EUR'), 'EUR 1,234.56');
  assert.equal(formatMoney(-500, null), '-$5.00');
});

test('turn on multicurrency, add EUR with rates by date; a customer’s currency is fixed once used', async () => {
  assert.match(await (await app.get('/settings/currencies')).text(), /can’t be turned off/);
  assert.equal((await app.post('/settings/currencies', { code: 'EUR', rate: '1.1', date: TODAY })).status, 422, 'not on yet');
  assert.equal((await app.post('/settings/currencies/on')).status, 303);
  assert.equal((await app.post('/settings/currencies', { code: 'EUR', rate: '1.10', date: '2026-10-01' })).status, 303);
  assert.equal((await app.post('/settings/currencies/EUR/rate', { rate: '1.05', date: '2026-10-11' })).status, 303);
  assert.equal((await app.post('/settings/currencies/EUR/rate', { rate: 'lots', date: TODAY })).status, 422);
  assert.match(await (await app.get('/settings/currencies')).text(), /EUR<\/strong> Euro/);
  const res = await app.post('/customers', { displayName: 'Lyon Haras', currency: 'EUR', active: '1' });
  eur = Number(/\/customers\/(\d+)/.exec(res.headers.get('location'))[1]);
  assert.equal((await one('SELECT currency FROM customer WHERE customer_id = $1', [eur])).currency, 'EUR');
  const v = await app.post('/vendors', { displayName: 'Amsterdam Seeds', currency: 'EUR' });
  euroVendor = Number(/\/vendors\/(\d+)/.exec(v.headers.get('location'))[1]);
});

test('a EUR invoice is booked in USD at its rate; a payment at another rate posts the realized exchange loss', async () => {
  const editor = await (await app.get(`/txns/new?type=invoice&customer=${eur}`)).text();
  assert.match(editor, /data-currency="EUR"/);
  assert.match(editor, /Exchange rate \(USD per 1 EUR\)/);
  assert.equal((await invoice(eur, '100', { exchange_rate: '1.10' })).status, 303);
  const inv = await one(`SELECT * FROM txn WHERE customer_id = $1 AND type = 'invoice'`, [eur]);
  assert.equal(inv.currency, 'EUR');
  assert.deepEqual([Number(inv.foreign_total_cents), Number(inv.total_cents), Number(inv.foreign_open_cents)], [10000, 11000, 10000]);
  assert.equal(await posted(inv.txn_id, 'ar'), 11000);
  assert.match(await (await app.get(`/txns/${inv.txn_id}`)).text(), /EUR 100\.00/);
  assert.equal((await app.post(`/customers/${eur}`, { displayName: 'Lyon Haras', currency: '', active: '1' })).status, 422, 'currency fixed after use');

  // The rate on 10/12 is 1.05 (from 10/11): EUR 40 now, then EUR 60.
  assert.equal((await pay(eur, '40', { [inv.txn_id]: '40' })).status, 303);
  const p1 = await one(`SELECT * FROM txn WHERE customer_id = $1 AND type = 'payment' ORDER BY txn_id DESC LIMIT 1`, [eur]);
  assert.equal(Number(p1.exchange_rate), 1.05);
  assert.equal(Number(p1.total_cents), 4400, 'took EUR 40 off A/R at the invoice’s 1.10');
  assert.equal(await posted(p1.txn_id, 'undeposited'), 4200, 'worth EUR 40 at 1.05');
  assert.equal(await posted(p1.txn_id, 'fx_gain_loss'), 200, 'realized loss');
  let i = await one('SELECT open_cents, foreign_open_cents FROM txn WHERE txn_id = $1', [inv.txn_id]);
  assert.deepEqual([Number(i.foreign_open_cents), Number(i.open_cents)], [6000, 6600]);
  await books();
  assert.equal((await pay(eur, '60', { [inv.txn_id]: '60' }, { exchange_rate: '1.20' })).status, 303);
  i = await one('SELECT open_cents, foreign_open_cents FROM txn WHERE txn_id = $1', [inv.txn_id]);
  assert.deepEqual([Number(i.foreign_open_cents), Number(i.open_cents)], [0, 0]);
  const p2 = await one(`SELECT txn_id FROM txn WHERE customer_id = $1 AND type = 'payment' ORDER BY txn_id DESC LIMIT 1`, [eur]);
  assert.equal(await posted(p2.txn_id, 'fx_gain_loss'), -600, 'realized gain at 1.20');
  await books();
  // The deposit list shows what the money is worth in USD.
  assert.match(await (await app.get('/deposits/new')).text(), /\$72\.00/);

  // Voiding the second payment reopens EUR 60 at the invoice's carrying amount.
  assert.equal((await app.post(`/txns/${p2.txn_id}/void`)).status, 303);
  i = await one('SELECT open_cents, foreign_open_cents FROM txn WHERE txn_id = $1', [inv.txn_id]);
  assert.deepEqual([Number(i.foreign_open_cents), Number(i.open_cents)], [6000, 6600]);
  await books();
});

test('a EUR credit memo and an unapplied EUR payment applied later both settle at the invoice’s rate', async () => {
  assert.equal((await invoice(eur, '50', { exchange_rate: '1.10' })).status, 303);
  const inv = await one(`SELECT txn_id FROM txn WHERE customer_id = $1 AND type = 'invoice' AND foreign_total_cents = 5000`, [eur]);
  const cm = new URLSearchParams({ type: 'credit_memo', customer_id: String(eur), txn_date: TODAY, after_save: 'none', exchange_rate: '1.00' });
  cm.append('line_item', ''); cm.append('line_desc', 'Return'); cm.append('line_qty', '1'); cm.append('line_rate', '20');
  assert.equal((await app.post('/txns', cm)).status, 303);
  const credit = await one(`SELECT txn_id FROM txn WHERE customer_id = $1 AND type = 'credit_memo'`, [eur]);
  const apply = new URLSearchParams({ [`apply_${inv.txn_id}`]: '20' });
  assert.equal((await app.post(`/txns/${credit.txn_id}/apply`, apply)).status, 303);
  const after = await one('SELECT foreign_open_cents, open_cents FROM txn WHERE txn_id = $1', [inv.txn_id]);
  assert.deepEqual([Number(after.foreign_open_cents), Number(after.open_cents)], [3000, 3300]);
  assert.equal(await posted(credit.txn_id, 'fx_gain_loss'), 200, 'credited at 1.00 against an invoice at 1.10');
  const tooMuch = await app.post(`/txns/${credit.txn_id}/apply`, new URLSearchParams({ [`apply_${inv.txn_id}`]: '5' }));
  assert.equal(tooMuch.status, 303);
  await books();
});

test('a EUR bill paid through Pay bills at another rate: A/P relieved at the bill’s rate, the bank at the payment’s', async () => {
  const p = new URLSearchParams({ type: 'bill', vendor_id: String(euroVendor), txn_date: TODAY, doc_number: 'AS-1', exchange_rate: '1.10' });
  p.append('cat_account', String(app.ids.accounts.feed_purchases)); p.append('cat_desc', 'Seed'); p.append('cat_amount', '200'); p.append('cat_job', ''); p.append('cat_po', '');
  const saved = await app.post('/vtxns', p);
  assert.equal(saved.status, 303, (/error-banner[^>]*>([^<]+)/.exec(await saved.clone().text()) ?? [])[1]);
  const bill = await one(`SELECT * FROM txn WHERE vendor_id = $1 AND type = 'bill'`, [euroVendor]);
  assert.deepEqual([Number(bill.total_cents), Number(bill.foreign_total_cents)], [22000, 20000]);
  await app.post(`/vtxns/${bill.txn_id}/approve`);
  const page = await (await app.get(`/pay-bills?vendor=${euroVendor}`)).text();
  assert.match(page, /EUR 200\.00/);
  assert.match(page, /name="rate_EUR"/);
  const res = await app.post('/pay-bills', { account_id: String(app.ids.accounts.checking), txn_date: TODAY, method: 'Other', bill: String(bill.txn_id),
    [`pay_${bill.txn_id}`]: '200', rate_EUR: '1.00' });
  assert.equal(res.status, 303, (/error-banner[^>]*>([^<]+)/.exec(await res.clone().text()) ?? [])[1]);
  const bp = await one(`SELECT * FROM txn WHERE vendor_id = $1 AND type = 'bill_payment'`, [euroVendor]);
  assert.equal(Number(bp.total_cents), 22000);
  assert.equal(await posted(bp.txn_id, 'ap'), 22000);
  assert.equal(await posted(bp.txn_id, 'fx_gain_loss'), -2000, 'gain: the euro got cheaper');
  const bank = Number((await one('SELECT sum(amount_cents)::bigint AS n FROM posting WHERE txn_id = $1 AND account_id = $2', [bp.txn_id, app.ids.accounts.checking])).n);
  assert.equal(bank, -20000);
  assert.equal(Number((await one('SELECT open_cents FROM txn WHERE txn_id = $1', [bill.txn_id])).open_cents), 0);
  await books();
});

test('revaluation posts the unrealized gain or loss at a date and reverses it the next day', async () => {
  // Open: EUR 60 on the first invoice and EUR 30 on the second, both carried at 1.10.
  assert.equal((await app.post('/settings/currencies/EUR/rate', { rate: '1.20', date: '2026-10-31' })).status, 303);
  const res = await app.post('/settings/currencies/revalue', { date: '2026-10-31' });
  assert.equal(res.status, 303);
  const [rev, back] = await q(`SELECT txn_id, txn_date FROM txn WHERE type = 'fx_revaluation' ORDER BY txn_date`);
  assert.equal(rev.txn_date, '2026-10-31');
  assert.equal(back.txn_date, '2026-11-01');
  assert.equal(await posted(rev.txn_id, 'ar'), 900, 'EUR 90 is worth $9.00 more at 1.20');
  assert.equal(await posted(rev.txn_id, 'fx_unrealized'), -900);
  assert.equal(await posted(back.txn_id, 'ar'), -900);
  await books();
});

test('a EUR customer’s statement is in euros, and late fees skip foreign invoices', async () => {
  const res = await app.post(`/customers/${eur}/statements`, { kind: 'open_item', statementDate: TODAY, startDate: '2026-09-12', endDate: TODAY, action: 'save' });
  assert.equal(res.status, 303);
  const st = await one('SELECT content FROM statement WHERE customer_id = $1 ORDER BY statement_id DESC LIMIT 1', [eur]);
  assert.equal(st.content.currency, 'EUR');
  assert.equal(st.content.total_due_cents, 9000, 'EUR 60 + EUR 30 still open, in euros');
  const pdf = await app.get(`/statements/${(await one('SELECT statement_id FROM statement WHERE customer_id = $1 ORDER BY statement_id DESC LIMIT 1', [eur])).statement_id}.pdf`);
  assert.equal(pdf.status, 200);
  const { rows } = await app.db.pool.query(`SELECT count(*)::int AS n FROM txn WHERE type = 'late_fee' AND customer_id = $1`, [eur]);
  assert.equal(rows[0].n, 0);
});
