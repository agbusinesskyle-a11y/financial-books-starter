import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerCheck } from '../lib/data/ledger.js';
import { listTransactions } from '../lib/data/transactions.js';
import { parseTxnFilters } from '../lib/domain/filters.js';
import { startApp } from './app-harness.js';

// Stages C2–C3: the customer's Transaction List matches QBO — Type/Status/Date choices, a main action and ▾ menu per row,
// Batch actions, Sent dates, a Total row, 100-row pages — plus the New transaction menu and the Statements and
// Recurring tab layouts.
const TODAY = '2026-10-12';
let app, pool, scope, cust;
before(async () => {
  app = await startApp({ env: { SETTINGS_KEY: 'ab'.repeat(32) } });
  pool = app.db.pool;
  scope = { orgId: app.ids.orgId, entityId: app.ids.entityId };
  cust = app.ids.customers.redriver;
});
after(async () => {
  const check = await ledgerCheck(pool, scope);
  assert.ok(check.balanced && check.arMatches && check.apMatches && check.inventoryMatches, JSON.stringify(check));
  await app.close();
});
const list = (q = {}, pageSize = 1000) => listTransactions(pool, { orgId: scope.orgId, customerId: cust, filters: parseTxnFilters(q, TODAY), today: TODAY, pageSize });
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const tab = async (q = '') => (await app.get(`/customers/${cust}?tab=transactions${q}`)).text();

test('QBO type choices: money received, recently paid, all plus deposits', async () => {
  const money = await list({ type: 'money_received' });
  assert.ok(money.rows.length && money.rows.every(t => ['payment', 'sales_receipt'].includes(t.type)));
  const recent = await list({ type: 'recently_paid' });
  for (const t of recent.rows) {
    assert.equal(t.open_cents, 0);
    const last = await one('SELECT max(applied_on)::text AS d FROM application WHERE charge_txn_id = $1', [t.txn_id]);
    assert.ok(last.d >= '2026-09-13', `${t.doc_number} paid ${last.d}`);
  }
  const plain = await list();
  const plus = await list({ type: 'all_deposits' });
  const deposits = plus.rows.filter(t => t.type === 'deposit');
  assert.equal(plus.rows.length, plain.rows.length + deposits.length);
  for (const d of deposits) {
    const mine = await one(`SELECT count(*)::int AS n FROM deposit_line dl LEFT JOIN txn s ON s.txn_id = dl.source_txn_id
      WHERE dl.deposit_txn_id = $1 AND (dl.customer_id = $2 OR s.customer_id = $2)`, [d.txn_id, cust]);
    assert.ok(mine.n > 0, 'only deposits holding this customer’s money');
  }
  assert.equal(parseTxnFilters({ type: "invoice' OR 1=1 --" }, TODAY).type, 'all');
});

test('QBO status choices include the estimate statuses', async () => {
  const est = await one(`SELECT txn_id FROM txn WHERE customer_id = $1 AND type = 'estimate' LIMIT 1`, [cust])
    ?? await one(`INSERT INTO txn (org_id, entity_id, customer_id, type, doc_number, txn_date, due_date, total_cents, open_cents, estimate_status)
      VALUES ($1, $2, $3, 'estimate', 'EST-T1', '2026-09-01', '2026-09-30', 50000, 50000, 'pending') RETURNING txn_id`, [scope.orgId, scope.entityId, cust]);
  await pool.query(`UPDATE txn SET due_date = '2026-09-30', estimate_status = 'pending', open_cents = total_cents WHERE txn_id = $1`, [est.txn_id]);
  assert.ok((await list({ status: 'expired' })).rows.some(t => t.txn_id === est.txn_id), 'past its expiry date');
  assert.ok(!(await list({ status: 'pending' })).rows.some(t => t.txn_id === est.txn_id));
  await pool.query(`UPDATE txn SET estimate_status = 'accepted' WHERE txn_id = $1`, [est.txn_id]);
  assert.ok((await list({ status: 'accepted' })).rows.some(t => t.txn_id === est.txn_id));
  assert.ok(!(await list({ status: 'open' })).rows.some(t => t.type === 'estimate'), 'Open means money owed or unapplied, not estimates');
  const html = await tab();
  for (const s of ['Pending', 'Accepted', 'Converted', 'Declined', 'Expired']) assert.match(html, new RegExp(`<option value="${s.toLowerCase()}">${s}</option>`));
  for (const d of ['Today', 'Yesterday', 'This week', 'Last 30 days', 'This quarter', 'Last 12 months', 'Year to date', '2025', '2022']) assert.match(html, new RegExp(`>${d}</option>`), d);
});

test('Total row, 100-row pages and First/Last', async () => {
  const all = await list();
  const sum = await one(`SELECT coalesce(sum(CASE WHEN type IN ('payment', 'credit_memo') THEN -total_cents ELSE total_cents END), 0)::bigint AS s
    FROM txn WHERE customer_id = $1 AND voided_at IS NULL AND type NOT IN ('estimate', 'deposit', 'journal_entry')`, [cust]);
  assert.equal(all.sumCents, Number(sum.s));
  assert.equal(all.total, all.rows.length);
  const page = await list({}, 100);
  assert.ok(page.rows.length <= 100);
  const html = await tab();
  assert.match(html, new RegExp(`<strong>\\$${(all.sumCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 }).replace('.', '\\.')}</strong>`));
  if (all.total > 100) {
    assert.match(html, />Last<\/a>/);
    const p2 = await tab('&page=2');
    assert.match(p2, />First<\/a>/);
    assert.match(p2, /101–/);
  }
});

test('rows: main action and ▾ menu by what the transaction is', async () => {
  const open = await one(`SELECT txn_id FROM txn WHERE customer_id = $1 AND type = 'invoice' AND open_cents > 0 AND voided_at IS NULL ORDER BY txn_date DESC LIMIT 1`, [cust]);
  const paid = await one(`SELECT txn_id FROM txn WHERE customer_id = $1 AND type = 'invoice' AND open_cents = 0 AND voided_at IS NULL ORDER BY txn_date DESC LIMIT 1`, [cust]);
  const pay = await one(`SELECT txn_id FROM txn WHERE customer_id = $1 AND type = 'payment' AND voided_at IS NULL ORDER BY txn_date DESC LIMIT 1`, [cust]);
  const html = await tab('&type=all&page=1');
  const all = [await tab('&type=invoice'), await tab('&type=payment')].join('');
  const row = id => { const i = all.indexOf(`name="ids" value="${id}"`); return all.slice(i, all.indexOf('</tr>', i)); };
  const o = row(open.txn_id);
  for (const s of ['Receive payment', 'Send reminder', 'Share invoice link', 'Make recurring', 'Print packing slip', 'Duplicate', 'View activity', 'Void', 'Delete']) assert.ok(o.includes(s), `open invoice: ${s}`);
  const p = row(paid.txn_id);
  assert.match(p, /View\/Edit<\/a> · <a href="\/txns\/\d+\.pdf"[^>]*>Print<\/a>/);
  assert.ok(p.includes('Refund') && !p.includes('Send reminder'));
  const y = row(pay.txn_id);
  assert.ok(!y.includes('Duplicate') && !y.includes('>Send<') && y.includes('Void') && y.includes('View activity'));
  assert.match(html, /Batch actions ▾/);
});

test('Send reminder, Sent date, packing slips, pay link and Make recurring', async () => {
  const open = await one(`SELECT txn_id, doc_number FROM txn WHERE customer_id = $1 AND type = 'invoice' AND open_cents > 0 AND voided_at IS NULL ORDER BY txn_date DESC LIMIT 1`, [cust]);
  const paid = await one(`SELECT txn_id FROM txn WHERE customer_id = $1 AND type = 'invoice' AND open_cents = 0 AND voided_at IS NULL LIMIT 1`, [cust]);
  let res = await app.post(`/txns/${open.txn_id}/reminder`);
  assert.equal(res.status, 303);
  const msg = await one(`SELECT status FROM message WHERE related_txn_id = $1 ORDER BY message_id DESC LIMIT 1`, [open.txn_id]);
  assert.ok(['logged', 'sent'].includes(msg.status));
  assert.equal((await one(`SELECT count(*)::int AS n FROM activity_event WHERE txn_id = $1 AND kind = 'reminder_sent'`, [open.txn_id])).n, 1);
  assert.match(await tab('&type=invoice'), /<small class="sent">Sent \d+\/\d+\/\d+<\/small>/);
  res = await app.post(`/txns/${paid.txn_id}/reminder`);
  assert.match(await (await app.get(res.headers.get('location'))).text(), /has nothing left to pay/);

  res = await app.get(`/txns/${open.txn_id}/packing-slip.pdf`);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
  const pay = await one(`SELECT txn_id FROM txn WHERE customer_id = $1 AND type = 'payment' LIMIT 1`, [cust]);
  assert.equal((await app.get(`/txns/${pay.txn_id}/packing-slip.pdf`)).status, 404);

  res = await app.post(`/txns/${open.txn_id}/share`);
  assert.match(await (await app.get(res.headers.get('location'))).text(), /Turn on online payments/);
  const on = await app.post('/settings/payments', { enabled: '1', processor: 'test', card: '1', ach: '1', feePayer: 'company' });
  assert.equal(on.status, 303, await on.text());
  const shareRes = await app.post(`/txns/${open.txn_id}/share`);
  assert.equal(shareRes.status, 200, shareRes.headers.get('location') ?? '');
  const share = await shareRes.text();
  const link = /value="(http[^"]+\/pay\/[A-Za-z0-9_-]+)"/.exec(share)[1];
  assert.equal((await fetch(link.replace(/^http:\/\/[^/]+/, app.base))).status, 200, 'the shared link opens the pay page');

  const rec = await (await app.get(`/customers/${cust}/recurring/new?from=${open.txn_id}`)).text();
  assert.match(rec, new RegExp(`value="Invoice ${open.doc_number}"`));
  assert.match(rec, /name="line_desc" value="[^"]+"/);
  assert.equal((await app.get(`/customers/${app.ids.customers.hilltop}/recurring/new?from=${open.txn_id}`)).status, 404, 'another customer’s invoice');
});

test('batch actions: packing slips, reminders, convert one estimate, delete', async () => {
  const invs = (await pool.query(`SELECT txn_id FROM txn WHERE customer_id = $1 AND type = 'invoice' AND open_cents > 0 AND voided_at IS NULL ORDER BY txn_id LIMIT 2`, [cust])).rows;
  const body = ids => { const p = new URLSearchParams(); for (const i of ids) p.append('ids', String(i)); return p; };
  let p = body(invs.map(r => r.txn_id)); p.set('action', 'packing');
  let res = await app.post(`/customers/${cust}/batch`, p);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  p = body(invs.map(r => r.txn_id)); p.set('action', 'reminder');
  res = await app.post(`/customers/${cust}/batch`, p);
  assert.match(await (await app.get(res.headers.get('location'))).text(), /2 of 2 reminders sent/);
  const est = await one(`INSERT INTO txn (org_id, entity_id, customer_id, type, doc_number, txn_date, total_cents, open_cents, estimate_status)
    VALUES ($1, $2, $3, 'estimate', 'EST-T2', $4, 1000, 1000, 'pending') RETURNING txn_id`, [scope.orgId, scope.entityId, cust, TODAY]);
  p = body([est.txn_id]); p.set('action', 'convert');
  res = await app.post(`/customers/${cust}/batch`, p);
  assert.equal(res.headers.get('location'), `/txns/${est.txn_id}/invoice`);
  p = body([est.txn_id]); p.set('action', 'delete');
  // Without the browser's confirm (no JavaScript), the server asks first and deletes nothing.
  res = await app.post(`/customers/${cust}/batch`, p);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Delete 1 transaction\?/);
  assert.ok(await one('SELECT 1 AS x FROM txn WHERE txn_id = $1', [est.txn_id]));
  p.set('confirmed', '1');
  res = await app.post(`/customers/${cust}/batch`, p);
  assert.match(await (await app.get(res.headers.get('location'))).text(), /1 of 1 deleted/);
  assert.equal(await one('SELECT 1 FROM txn WHERE txn_id = $1', [est.txn_id]), undefined);
  p = body([invs[0].txn_id + 999999]); p.set('action', 'delete'); p.set('confirmed', '1');
  assert.equal((await app.post(`/customers/${cust}/batch`, p)).status, 404, 'only this customer’s transactions');
});

test('New transaction menu, Statements and Recurring tabs follow QBO', async () => {
  const page = await (await app.get(`/customers/${cust}`)).text();
  const menu = page.slice(page.indexOf('New transaction</summary>'), page.indexOf('</details>', page.indexOf('New transaction</summary>')));
  const labels = [...menu.matchAll(/<a href="[^"]+"[^>]*>([^<]+)/g)].map(m => m[1]);
  assert.deepEqual(labels, ['Invoice', 'Multiple invoices', 'Payment', 'Recurring payment', 'Estimate', 'Sales receipt',
    'Credit memo', 'Time activity', 'Statement']);
  for (const m of menu.matchAll(/href="(\/soon\/[a-z-]+)"/g)) assert.equal((await app.get(m[1])).status, 200, m[1]);
  const st = await (await app.get(`/customers/${cust}?tab=statements`)).text();
  if (st.includes('<th>Date</th>')) assert.match(st, /<th>Date<\/th><th>No\.<\/th><th>Customer<\/th><th>Start date<\/th><th>End date<\/th><th>Statement type<\/th>/);
  await app.post(`/customers/${cust}/recurring`, { name: 'Monthly mineral', txnType: 'invoice', mode: 'scheduled', unit: 'month', count: '1', startDate: TODAY,
    line_item: '', line_desc: 'Mineral', line_qty: '1', line_rate: '40' });
  const rec = await (await app.get(`/customers/${cust}?tab=recurring`)).text();
  assert.match(rec, /<th>Name<\/th><th>Type<\/th><th>Txn type<\/th><th>Interval<\/th><th>Previous date<\/th><th>Next date<\/th>/);
  assert.match(rec, /data-filter-rows="#recurring-list"/);
  assert.match(rec, /data-filter-text="monthly mineral"/);
});
