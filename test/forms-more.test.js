import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './app-harness.js';

// Stage F2: QBO's More menu on saved transactions — copy (and copy a bill to a vendor credit), make recurring, transaction
// journal, audit history, reminders and share links, void and delete.
const TODAY = '2026-10-12';
let app, C, V, A, item;
before(async () => {
  app = await startApp();
  C = Object.values(app.ids.customers)[0];
  V = Object.values(app.ids.vendors)[0];
  A = app.ids.accounts;
  item = Object.values(app.ids.items)[0];
});
after(async () => { await app.close(); });

const html = async path => { const r = await app.get(path); assert.equal(r.status, 200, path); return r.text(); };
const menu = page => {
  const m = /<details class="more-menu">([\s\S]*?)<\/details>/.exec(page);
  assert.ok(m, 'More menu present');
  return [...m[1].matchAll(/(?:role="menuitem"[^>]*>|<button class="[^"]*menuitem[^"]*">)([^<]+)</g)].map(x => x[1].trim());
};
const idFrom = r => Number(/\/(\d+)(?:\/edit)?$/.exec(r.headers.get('location'))[1]);

test('an invoice: More has copy, make recurring, reminder, share link, preview, packing slip, journal, history, void, delete', async () => {
  const p = new URLSearchParams({ type: 'invoice', customer_id: String(C), txn_date: TODAY, then: 'save' });
  p.append('line_item', String(item)); p.append('line_desc', 'Bale'); p.append('line_qty', '3'); p.append('line_rate', '10.00'); p.append('line_service', ''); p.append('line_est', '');
  const id = idFrom(await app.post('/txns', p));
  const items = menu(await html(`/txns/${id}`));
  assert.deepEqual(items, ['Copy', 'Make recurring', 'Send reminder', 'Share invoice link', 'Preview email', 'Print packing slip', 'Transaction journal', 'Audit history', 'Void', 'Delete']);
  // The transaction journal: A/R debit and income credit, equal totals.
  const j = await html(`/transactions/${id}/journal`);
  assert.match(j, /Accounts Receivable/);
  assert.match(j, /<tfoot><tr><th colspan="5">Total<\/th><th class="num">\$30\.00<\/th><th class="num">\$30\.00<\/th>/);
  // Audit history: created, then the change made below.
  await app.post(`/txns/${id}`, (() => { const q = new URLSearchParams(p); q.set('memo', 'Changed memo'); q.set('then', 'save'); return q; })());
  const h = await html(`/transactions/${id}/history`);
  assert.match(h, /Added/);
  assert.match(h, /Changed/);
  assert.match(h, /memo: — → Changed memo/);
  // Make recurring opens a template started from it.
  const rec = await html(`/customers/${C}/recurring/new?from=${id}`);
  assert.match(rec, /value="Invoice/);
});

test('a bill: copy to vendor credit, make recurring; history and journal for vendor, ledger and deposit transactions', async () => {
  const b = new URLSearchParams({ type: 'bill', vendor_id: String(V), txn_date: TODAY, doc_number: 'F2-B1', then: 'save' });
  b.append('cat_account', String(A.office)); b.append('cat_desc', 'Toner'); b.append('cat_amount', '44.00'); b.append('cat_job', ''); b.append('cat_po', ''); b.append('cat_billable', ''); b.append('cat_class', '');
  let r = await app.post('/vtxns', b);
  assert.equal(r.status, 303, await r.clone().text());
  const { rows: [bill] } = await app.db.pool.query(`SELECT txn_id FROM txn WHERE doc_number = 'F2-B1' AND type = 'bill'`);
  const items = menu(await html(`/vtxns/${bill.txn_id}`));
  assert.deepEqual(items, ['Copy', 'Copy to vendor credit', 'Make recurring', 'Transaction journal', 'Audit history', 'Delete']);
  const credit = await html(`/vtxns/new?copy=${bill.txn_id}&as=vendor_credit`);
  assert.match(credit, /name="type" value="vendor_credit"/);
  assert.match(credit, /value="44.00"/);
  const rec = await html(`/vendors/${V}/recurring/new?from=${bill.txn_id}`);
  assert.match(rec, /value="Bill F2-B1/);
  assert.match(rec, /value="44.00"/);
  assert.equal((await app.get(`/vendors/${V + 999}/recurring/new?from=${bill.txn_id}`)).status, 404);
  assert.match(await html(`/transactions/${bill.txn_id}/journal`), /Accounts Payable/);
  // A journal entry: copy and the More menu.
  const je = new URLSearchParams({ txn_date: TODAY, doc_number: '', memo: 'F2 JE', then: 'close' });
  for (const [acct, d, c] of [[A.office, '7.00', ''], [A.checking, '', '7.00']]) {
    je.append('je_account', String(acct)); je.append('je_debit', d); je.append('je_credit', c); je.append('je_desc', ''); je.append('je_party', ''); je.append('je_class', '');
  }
  r = await app.post('/journal', je);
  const jeId = idFrom(r);
  assert.deepEqual(menu(await html(`/ledger/${jeId}`)), ['Copy', 'Transaction journal', 'Audit history', 'Void', 'Delete']);
  const copy = await html(`/journal/new?copy=${jeId}`);
  assert.match(copy, /value="7.00"/);
  assert.match(copy, /value="F2 JE"/);
  // A deposit page has journal and history too.
  const dep = new URLSearchParams({ account_id: String(A.checking), txn_date: TODAY, memo: '', then: 'close' });
  dep.append('other_account', String(A.interest_income)); dep.append('other_customer', ''); dep.append('other_desc', 'Interest'); dep.append('other_amount', '1.00');
  const depId = idFrom(await app.post('/deposits', dep));
  assert.deepEqual(menu(await html(`/deposits/${depId}`)), ['Transaction journal', 'Audit history', 'Delete deposit']);
});

test('the journal and history pages belong to this company and its people', async () => {
  assert.equal((await app.get('/transactions/999999999/journal')).status, 404);
  const { rows: [t] } = await app.db.pool.query('SELECT txn_id FROM txn LIMIT 1');
  await app.db.pool.query('UPDATE txn SET entity_id = entity_id WHERE txn_id = $1', [t.txn_id]);
  const { canAccess } = await import('../lib/domain/roles.js');
  assert.equal(canAccess('customers', 'GET', `/transactions/${t.txn_id}/journal`), false);
  assert.equal(canAccess('reports', 'GET', `/transactions/${t.txn_id}/history`), true);
});
