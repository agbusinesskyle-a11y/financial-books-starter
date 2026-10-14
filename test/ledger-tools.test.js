import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerCheck } from '../lib/data/ledger.js';
import { canAccess } from '../lib/domain/roles.js';
import { startApp } from './app-harness.js';

const TODAY = '2026-10-12';
let app, scope;
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
const idFrom = res => Number(/\/ledger\/(\d+)/.exec(res.headers.get('location'))[1]);

function je(lines, more = {}) {
  const p = new URLSearchParams({ txn_date: TODAY, memo: 'Test entry', ...more });
  for (const l of lines) {
    p.append('je_account', String(l.account)); p.append('je_debit', l.debit ?? ''); p.append('je_credit', l.credit ?? '');
    p.append('je_desc', l.desc ?? ''); p.append('je_party', l.party ?? ''); p.append('je_class', '');
  }
  return app.post('/journal', p);
}

test('tools belong to standard and admin roles; reports can look', () => {
  assert.ok(canAccess('standard', 'POST', '/journal'));
  assert.ok(!canAccess('customers', 'GET', '/tools'));
  assert.ok(!canAccess('vendors', 'GET', '/reconcile'));
  assert.ok(canAccess('reports', 'GET', '/ledger/5'));
  assert.ok(!canAccess('reports', 'POST', '/transfers'));
});

test('journal entries must balance, can’t touch A/R, and can reverse themselves', async () => {
  const a = app.ids.accounts;
  const unbalanced = await je([{ account: a.rent, debit: '100' }, { account: a.checking, credit: '90' }]);
  assert.equal(unbalanced.status, 422);
  assert.match(await unbalanced.text(), /difference is \$10\.00/);
  const ar = (await one(`SELECT account_id FROM account WHERE system_key = 'ar' AND entity_id = $1`, [app.ids.entityId])).account_id;
  const blocked = await je([{ account: ar, debit: '100' }, { account: a.checking, credit: '100' }]);
  assert.equal(blocked.status, 422);
  assert.match(await blocked.text(), /kept by its own transactions/);
  const both = await je([{ account: a.rent, debit: '5', credit: '5' }, { account: a.checking, credit: '5' }]);
  assert.equal(both.status, 422);

  const res = await je([{ account: a.rent, debit: '1200', party: `v:${app.ids.vendors.office}` }, { account: a.checking, credit: '1200' }],
    { reverse_on: '2026-11-01' });
  assert.equal(res.status, 303, await res.clone().text());
  const id = idFrom(res);
  const t = await one('SELECT * FROM txn WHERE txn_id = $1', [id]);
  assert.match(t.doc_number, /^JE-\d{4}$/);
  assert.equal(Number(t.total_cents), 120000);
  const posts = await q('SELECT account_id, amount_cents, vendor_id FROM posting WHERE txn_id = $1 ORDER BY amount_cents', [id]);
  assert.deepEqual(posts.map(p => Number(p.amount_cents)), [-120000, 120000]);
  assert.equal(posts[1].vendor_id, app.ids.vendors.office);
  const rev = await one('SELECT * FROM txn WHERE reverses_txn_id = $1', [id]);
  assert.equal(rev.txn_date, '2026-11-01');
  const revPosts = await q('SELECT amount_cents FROM posting WHERE txn_id = $1 AND account_id = $2', [rev.txn_id, a.rent]);
  assert.equal(Number(revPosts[0].amount_cents), -120000);
  const page = await (await app.get(`/ledger/${id}`)).text();
  assert.match(page, /Reversed by/);
  assert.match(await (await app.get(`/settings/accounts/${a.rent}`)).text(), new RegExp(`/ledger/${id}`), 'the register links to it');
  assert.equal((await app.get(`/journal/${id}/edit`)).status, 200);
});

test('transfers and credit card payments move money between the right accounts', async () => {
  const a = app.ids.accounts;
  const t = await app.post('/transfers', { from_account: String(a.checking), to_account: String(a.savings), amount: '250', txn_date: TODAY, memo: 'To savings' });
  assert.equal(t.status, 303);
  const tp = await q('SELECT account_id, amount_cents FROM posting WHERE txn_id = $1', [idFrom(t)]);
  assert.equal(Number(tp.find(p => p.account_id === a.savings).amount_cents), 25000);
  assert.equal(Number(tp.find(p => p.account_id === a.checking).amount_cents), -25000);
  assert.equal((await app.post('/transfers', { from_account: String(a.rent), to_account: String(a.savings), amount: '5', txn_date: TODAY })).status, 422);
  assert.equal((await app.post('/card-payments', { from_account: String(a.savings), to_account: String(a.checking), amount: '5', txn_date: TODAY })).status, 422,
    'a card payment goes to a credit card');
  const c = await app.post('/card-payments', { from_account: String(a.checking), to_account: String(a.card), amount: '300', txn_date: TODAY });
  assert.equal(c.status, 303);
  const cp = await q('SELECT account_id, amount_cents FROM posting WHERE txn_id = $1', [idFrom(c)]);
  assert.equal(Number(cp.find(p => p.account_id === a.card).amount_cents), 30000, 'the card balance goes down');
});

test('reconcile: the difference must be zero; cleared transactions are locked until an admin overrides; undo frees them', async () => {
  const a = app.ids.accounts;
  const start = await (await app.get(`/reconcile/start?account=${a.savings}&date=${TODAY}&ending=0`)).text();
  const boxes = [...start.matchAll(/name="ids" value="(\d+)" data-amount="(-?\d+)"/g)].map(m => ({ id: m[1], amount: Number(m[2]) }));
  assert.ok(boxes.length >= 1);
  const beginning = Number(/data-beginning="(-?\d+)"/.exec(start)[1]);
  const body = ending => {
    const p = new URLSearchParams({ statement_date: TODAY, ending });
    for (const b of boxes) p.append('ids', b.id);
    return p;
  };
  const wrong = await app.post(`/reconcile/${a.savings}`, body('1.00'));
  assert.equal(wrong.status, 422);
  assert.match(await wrong.text(), /The difference is/);
  const ending = beginning + boxes.reduce((s, b) => s + b.amount, 0);
  const done = await app.post(`/reconcile/${a.savings}`, body((ending / 100).toFixed(2)));
  assert.equal(done.status, 303, await done.clone().text());
  const rec = await one('SELECT * FROM reconciliation WHERE account_id = $1', [a.savings]);
  assert.equal(Number(rec.ending_cents), ending);
  assert.equal((await app.get(`/reconcile/report/${rec.rec_id}.pdf`)).headers.get('content-type'), 'application/pdf');

  // The transfer into savings is now locked.
  const transfer = (await one(`SELECT txn_id FROM txn WHERE type = 'transfer' AND to_account_id = $1 LIMIT 1`, [a.savings])).txn_id;
  const blocked = await app.post(`/ledger/${transfer}/void`);
  assert.equal(blocked.status, 303);
  assert.equal((await one('SELECT voided_at FROM txn WHERE txn_id = $1', [transfer])).voided_at, null, 'not voided without the override');
  const edit = await app.post(`/transfers/${transfer}`, { from_account: String(a.checking), to_account: String(a.savings), amount: '260', txn_date: TODAY });
  assert.equal(edit.status, 422);
  const editPage = await edit.text();
  assert.match(editPage, /was reconciled/);
  assert.match(editPage, /name="edit_reconciled"/, 'admins are offered the override');
  assert.equal((await app.post(`/transfers/${transfer}`, { from_account: String(a.checking), to_account: String(a.savings), amount: '250', txn_date: TODAY, edit_reconciled: '1' })).status, 303);
  assert.match(await (await app.get(`/ledger/${transfer}`)).text(), /name="edit_reconciled" value="1"/, 'void/delete carry the override for admins');

  // Later statement dates only; then undo.
  const again = await app.post(`/reconcile/${a.savings}`, new URLSearchParams({ statement_date: TODAY, ending: '0' }));
  assert.equal(again.status, 422);
  assert.match(await again.text(), /already reconciled through/);
  assert.equal((await app.post(`/reconcile/${a.savings}/undo`)).status, 303);
  assert.equal((await one('SELECT count(*)::int AS n FROM reconciled_item WHERE txn_id = $1', [transfer])).n, 0);
  assert.equal((await app.post(`/ledger/${transfer}/void`)).status, 303);
  assert.ok((await one('SELECT voided_at FROM txn WHERE txn_id = $1', [transfer])).voided_at, 'unlocked after undo');
});

test('a reconciled customer transaction is locked on its own editor too', async () => {
  const a = app.ids.accounts;
  const p = new URLSearchParams({ type: 'sales_receipt', customer_id: String(app.ids.customers.hilltop), txn_date: TODAY, deposit_to: String(a.savings), after_save: 'none' });
  p.append('line_item', ''); p.append('line_desc', 'Cash sale'); p.append('line_qty', '1'); p.append('line_rate', '40'); p.append('line_service', ''); p.append('line_est', ''); p.append('line_bill', '');
  assert.equal((await app.post('/txns', p)).status, 303);
  const sr = (await one(`SELECT txn_id FROM txn WHERE type = 'sales_receipt' AND account_id = $1 ORDER BY txn_id DESC LIMIT 1`, [a.savings])).txn_id;
  const start = await (await app.get(`/reconcile/start?account=${a.savings}&date=2026-10-13`)).text();
  const boxes = [...start.matchAll(/name="ids" value="(\d+)" data-amount="(-?\d+)"/g)].map(m => ({ id: m[1], amount: Number(m[2]) }));
  const beginning = Number(/data-beginning="(-?\d+)"/.exec(start)[1]);
  const body = new URLSearchParams({ statement_date: '2026-10-13', ending: ((beginning + boxes.reduce((s, b) => s + b.amount, 0)) / 100).toFixed(2) });
  for (const b of boxes) body.append('ids', b.id);
  assert.equal((await app.post(`/reconcile/${a.savings}`, body)).status, 303);
  const edit = new URLSearchParams(p);
  edit.set('line_rate', '45');
  const res = await app.post(`/txns/${sr}`, edit);
  assert.equal(res.status, 422);
  assert.match(await res.text(), /name="edit_reconciled"/);
  edit.set('edit_reconciled', '1');
  assert.equal((await app.post(`/txns/${sr}`, edit)).status, 303);
});
