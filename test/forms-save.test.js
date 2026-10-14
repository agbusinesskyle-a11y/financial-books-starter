import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './app-harness.js';
import { FORM_SAVE, chosen, safeBack } from '../lib/domain/save-choices.js';

// Stage F1: every form saves the QBO way — a split button with that form's choices, Ctrl+Alt shortcuts, the person's last
// choice as the main button, and each choice landing where QBO lands.
const TODAY = '2026-10-12';
const sent = [];
const mailer = { kind: 'smtp', from: 'books@sample.example', async send(m) { sent.push(m); return { status: 'sent' }; } };
let app, C, V, A, item;
before(async () => {
  app = await startApp({ mailer });
  C = Object.values(app.ids.customers)[0];
  V = Object.values(app.ids.vendors)[0];
  A = app.ids.accounts;
  item = Object.values(app.ids.items)[0];
});
after(async () => { await app.close(); });

const html = async path => { const r = await app.get(path); assert.equal(r.status, 200, path); return r.text(); };
// The buttons in a form's save bar, main first.
const bar = page => {
  const m = /<div class="form-actions save-bar">([\s\S]*?)<\/div>\s*<\/form>/.exec(page) ?? /<div class="form-actions save-bar">([\s\S]*?)<\/details>/.exec(page);
  assert.ok(m, 'save bar present');
  return [...m[1].matchAll(/name="then" value="(\w+)"(?: data-shortcut="(\w)")?>([^<]+)/g)].map(x => ({ value: x[1], key: x[2] ?? null, label: x[3].trim() }));
};
const sale = (type, more = {}, lines = [{ rate: '25.00' }]) => {
  const p = new URLSearchParams({ type, customer_id: String(C), txn_date: TODAY, ...more });
  for (const l of lines) { p.append('line_item', String(item)); p.append('line_desc', 'Thing'); p.append('line_qty', '1'); p.append('line_rate', l.rate); p.append('line_service', ''); p.append('line_est', ''); }
  return p;
};
const vend = (type, more = {}) => {
  const p = new URLSearchParams({ type, vendor_id: String(V), txn_date: TODAY, ...more });
  p.append('cat_account', String(A.office)); p.append('cat_desc', 'Paper'); p.append('cat_amount', '12.00'); p.append('cat_job', ''); p.append('cat_po', ''); p.append('cat_billable', ''); p.append('cat_class', '');
  return p;
};

test('every form shows its own save choices, with the QBO labels and shortcuts', async () => {
  const want = {
    '/txns/new?type=invoice': ['Save and close', 'Save and new', 'Save', 'Save and send'],
    '/txns/new?type=estimate': ['Save', 'Save and new', 'Save and close', 'Save and send'],
    '/txns/new?type=sales_receipt': ['Record and close', 'Record and new', 'Record and send'],
    '/txns/new?type=credit_memo': ['Save and close', 'Save and new', 'Save and send'],
    '/txns/new?type=payment': ['Record and close', 'Record and new'],
    '/vtxns/new?type=bill': ['Save and close', 'Save and new', 'Save and submit for approval', 'Save and schedule payment'],
    '/vtxns/new?type=expense': ['Save and close', 'Save and new'],
    '/vtxns/new?type=check': ['Save and close', 'Save and new', 'Save and print'],
    '/vtxns/new?type=vendor_credit': ['Save and close', 'Save and new'],
    '/vtxns/new?type=purchase_order': ['Save and close', 'Save and new', 'Save and send'],
    '/journal/new': ['Save and close', 'Save and new'],
    '/transfers/new': ['Save and close', 'Save and new'],
    '/card-payments/new': ['Save and close', 'Save and new'],
    '/deposits/new': ['Save and close', 'Save and new', 'Save and print'],
  };
  for (const [path, labels] of Object.entries(want)) {
    const b = bar(await html(path));
    assert.deepEqual(b.map(x => x.label), labels, path);
    for (const x of b) assert.equal(x.key, { new: 's', close: 'd', send: 'm' }[x.value] ?? null, `${path} ${x.value} shortcut`);
  }
  const page = await html('/txns/new?type=invoice');
  assert.doesNotMatch(page, /name="after_save"/, 'the old “After saving” choice is gone');
  assert.match(page, /<kbd>Ctrl\+Alt\+S<\/kbd>/);
});

test('choices: the button, the old after_save values, and a safe way back', () => {
  assert.equal(chosen(new URLSearchParams({ then: 'new' }), 'invoice'), 'new');
  assert.equal(chosen(new URLSearchParams({ then: 'schedule' }), 'invoice'), 'close', 'not an invoice choice');
  assert.equal(chosen(new URLSearchParams({ after_save: 'email' }), 'invoice'), 'send');
  assert.equal(chosen(new URLSearchParams({}), 'estimate'), 'save', 'an estimate’s main button is Save');
  assert.equal(safeBack('/invoices?status=open'), '/invoices?status=open');
  assert.equal(safeBack('https://evil.example/'), null);
  assert.equal(safeBack('//evil.example'), null);
  assert.equal(safeBack('/logout'), null);
  for (const [type, f] of Object.entries(FORM_SAVE)) assert.ok(f.choices.length >= 2, type);
});

test('invoice: save and new, save (stays open), save and close (back where it came from), save and send', async () => {
  let r = await app.post('/txns', sale('invoice', { then: 'new' }));
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/txns/new?type=invoice');
  // The last choice becomes the main button.
  assert.equal(bar(await html('/txns/new?type=invoice'))[0].value, 'new');
  r = await app.post('/txns', sale('invoice', { then: 'save' }));
  assert.match(r.headers.get('location'), /^\/txns\/\d+\/edit$/);
  r = await app.post('/txns', sale('invoice', { then: 'close', back: '/invoices' }));
  assert.equal(r.headers.get('location'), '/invoices');
  r = await app.post('/txns', sale('invoice', { then: 'close', back: 'https://evil.example/' }));
  assert.equal(r.headers.get('location'), `/customers/${C}`, 'only this app’s pages');
  sent.length = 0;
  r = await app.post('/txns', sale('invoice', { then: 'send' }));
  assert.equal(r.status, 303);
  assert.equal(sent.length, 1, 'emailed');
  // Editing an invoice offers the same choices; Save and new from an edit opens a blank invoice.
  const id = Number(/\/txns\/(\d+)\/edit/.exec((await app.post('/txns', sale('invoice', { then: 'save' }))).headers.get('location'))[1]);
  const edit = await html(`/txns/${id}/edit`);
  assert.ok(bar(edit).some(b => b.value === 'send'));
  r = await app.post(`/txns/${id}`, sale('invoice', { then: 'new' }));
  assert.equal(r.headers.get('location'), '/txns/new?type=invoice');
});

test('the main button is each person’s own', async () => {
  // The owner chose Save and new above; a fresh form type still starts at its usual main button.
  assert.equal(bar(await html('/txns/new?type=credit_memo'))[0].value, 'close');
  await app.post('/txns', sale('credit_memo', { then: 'new' }));
  assert.equal(bar(await html('/txns/new?type=credit_memo'))[0].value, 'new');
  const { rows } = await app.db.pool.query(`SELECT form_type, choice FROM form_save_pref WHERE user_key = 'owner' ORDER BY form_type`);
  assert.deepEqual(rows.map(r => [r.form_type, r.choice]), [['credit_memo', 'new'], ['invoice', 'new']]);
});

test('sales receipt and payment record; estimate saves and stays open', async () => {
  let r = await app.post('/txns', sale('sales_receipt', { then: 'new' }));
  assert.equal(r.headers.get('location'), '/txns/new?type=sales_receipt');
  r = await app.post('/txns', sale('estimate', {}));
  assert.match(r.headers.get('location'), /^\/txns\/\d+\/edit$/, 'Save is the estimate’s main button');
  r = await app.post('/txns', new URLSearchParams({ type: 'payment', customer_id: String(C), txn_date: TODAY, amount: '10.00', then: 'new' }));
  assert.equal(r.headers.get('location'), '/txns/new?type=payment');
});

test('bill: save and new, submit for approval, schedule payment', async () => {
  let r = await app.post('/vtxns', vend('bill', { doc_number: 'F1-1', then: 'new' }));
  assert.equal(r.headers.get('location'), '/vtxns/new?type=bill');
  r = await app.post('/vtxns', vend('bill', { doc_number: 'F1-2', then: 'submit' }));
  assert.equal(r.status, 303);
  const { rows: [b] } = await app.db.pool.query(`SELECT txn_id, approval_status FROM txn WHERE doc_number = 'F1-2' AND type = 'bill'`);
  assert.equal(b.approval_status, 'awaiting');
  r = await app.post('/vtxns', vend('bill', { doc_number: 'F1-3', then: 'schedule' }));
  assert.match(r.headers.get('location'), /^\/vtxns\/\d+#schedule$/);
  // A bill has no plain Save (as in QBO): an unknown choice is its main button, Save and close.
  r = await app.post('/vtxns', vend('bill', { doc_number: 'F1-4', then: 'save' }));
  assert.match(r.headers.get('location'), /^\/vtxns\/\d+$/);
  const edit = await html(`/vtxns/${b.txn_id}/edit`);
  assert.ok(bar(edit).some(x => x.value === 'schedule'));
  r = await app.post('/vtxns', vend('bill', { doc_number: 'F1-5', then: 'close' }));
  assert.match(r.headers.get('location'), /^\/vtxns\/\d+$/, 'no page to go back to: the saved bill');
  r = await app.post('/vtxns', vend('bill', { doc_number: 'F1-6', then: 'close', back: `/vendors/${V}` }));
  assert.equal(r.headers.get('location'), `/vendors/${V}`);
});

test('check prints, purchase order sends, expense closes', async () => {
  let r = await app.post('/vtxns', vend('check', { account_id: String(A.checking), then: 'print' }));
  assert.equal(r.headers.get('location'), '/checks');
  await app.db.pool.query(`UPDATE vendor SET email = 'orders@vendor.example' WHERE vendor_id = $1`, [V]);
  sent.length = 0;
  const po = new URLSearchParams({ type: 'purchase_order', vendor_id: String(V), txn_date: TODAY, then: 'send' });
  po.append('item_item', String(item)); po.append('item_desc', 'Stock'); po.append('item_qty', '2'); po.append('item_rate', '5.00'); po.append('item_job', ''); po.append('item_po', '');
  po.append('item_billable', ''); po.append('item_class', '');
  r = await app.post('/vtxns', po);
  assert.equal(r.status, 303, await r.clone().text());
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'orders@vendor.example');
  r = await app.post('/vtxns', vend('expense', { account_id: String(A.checking), then: 'close', back: '/expense-transactions' }));
  assert.equal(r.headers.get('location'), '/expense-transactions');
});

test('journal entry, transfer and deposit: save and new / save and close', async () => {
  const je = new URLSearchParams({ txn_date: TODAY, doc_number: '', memo: 'F1', then: 'new' });
  for (const [acct, d, c] of [[A.office, '10.00', ''], [A.checking, '', '10.00']]) {
    je.append('je_account', String(acct)); je.append('je_debit', d); je.append('je_credit', c); je.append('je_desc', ''); je.append('je_party', ''); je.append('je_class', '');
  }
  let r = await app.post('/journal', je);
  assert.equal(r.headers.get('location'), '/journal/new');
  r = await app.post('/transfers', new URLSearchParams({ from_account: String(A.checking), to_account: String(A.savings), amount: '5.00', txn_date: TODAY, memo: '', then: 'close' }));
  assert.match(r.headers.get('location'), /^\/ledger\/\d+$/);
  r = await app.post('/transfers', new URLSearchParams({ from_account: String(A.checking), to_account: String(A.savings), amount: '5.00', txn_date: TODAY, memo: '', then: 'new' }));
  assert.equal(r.headers.get('location'), '/transfers/new');
  const dep = new URLSearchParams({ account_id: String(A.checking), txn_date: TODAY, memo: '', then: 'new' });
  dep.append('other_account', String(A.interest_income)); dep.append('other_customer', ''); dep.append('other_desc', 'Interest'); dep.append('other_amount', '1.00');
  r = await app.post('/deposits', dep);
  assert.equal(r.headers.get('location'), '/deposits/new', await r.clone().text());
});
