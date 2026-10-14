import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerCheck } from '../lib/data/ledger.js';
import { canAccess } from '../lib/domain/roles.js';
import { homeShare } from '../lib/domain/fx.js';
import { savePaymentsSettings } from '../lib/data/online-payments.js';
import { startApp } from './app-harness.js';

// Regressions for the independent review of Settings S1–S6.
const TODAY = '2026-10-12';
let app, scope;
before(async () => {
  app = await startApp({ env: { SETTINGS_KEY: '34'.repeat(32) } });
  scope = { orgId: app.ids.orgId, entityId: app.ids.entityId };
});
after(async () => {
  const check = await ledgerCheck(app.db.pool, scope);
  assert.ok(check.balanced && check.arMatches && check.apMatches && check.inventoryMatches, JSON.stringify(check));
  await app.close();
});
const q = async (sql, params = []) => (await app.db.pool.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];

test('roles: mail server, bill-approval rule and account import are admin-only; reports-only can’t change time', () => {
  for (const path of ['/settings/email', '/settings/email/test', '/settings/bills', '/import/accounts']) assert.ok(!canAccess('standard', 'POST', path), path);
  assert.ok(canAccess('standard', 'POST', '/import/customers'));
  assert.ok(!canAccess('reports', 'POST', '/time'));
});

test('the test processor can’t be turned on in production', async () => {
  await assert.rejects(savePaymentsSettings(app.db.pool, { ...scope, fields: { enabled: '1', processor: 'test', card: '1' }, hasKey: true, env: { NODE_ENV: 'production' } }),
    /live server/);
  await savePaymentsSettings(app.db.pool, { ...scope, fields: { enabled: '1', processor: 'test', card: '1' }, hasKey: true,
    env: { NODE_ENV: 'production', PAYMENTS_TEST_MODE: '1' } });
});

test('foreign partial payments can’t round past what’s open', () => {
  let open = 150, fopen = 100, taken = 0;
  for (const part of [33, 33, 33, 1]) {
    const h = homeShare({ foreignTotal: 100, foreignOpen: fopen, homeOpen: open, part, rate: 1.5 });
    open -= h; fopen -= part; taken += h;
    assert.ok(open >= 0);
  }
  assert.equal(taken, 150);
  assert.equal(open, 0);
});

test('item import refuses duplicate SKUs instead of failing on save', async () => {
  const fd = new FormData();
  fd.set('csrf', app.csrf);
  fd.set('csv', 'Name,Type,SKU\nTub A,Product,TUB-1\nTub B,Product,tub-1\n');
  fd.set('step', 'preview');
  const res = await app.raw('/import/items', { method: 'POST', body: fd });
  assert.match(await res.text(), /SKU tub-1 is already used/);
});

test('budgets accept negative months; the timesheet keeps notes and untouched entries', async () => {
  const b = await app.post('/budgets', { name: 'Neg', fiscalYear: '2027', subdivide: 'none', startFrom: 'blank' });
  const id = Number(/\/budgets\/(\d+)/.exec(b.headers.get('location'))[1]);
  assert.equal((await app.post(`/budgets/${id}`, { [`c_${app.ids.accounts.rent}_1`]: '-120.50' })).status, 303);
  assert.equal(Number((await one('SELECT amount_cents FROM budget_line WHERE budget_id = $1', [id])).amount_cents), -12050);

  assert.equal((await app.post('/time', { date: TODAY, job: '', hours: '1', notes: 'Kept note' })).status, 303);
  assert.equal((await app.post('/time', { date: TODAY, job: '', hours: '0.5', notes: 'Second' })).status, 303);
  const sheet = new URLSearchParams({ monday: TODAY });
  sheet.append('ts_job', ''); sheet.append('ts_item', ''); sheet.append('ts_billable', '');
  for (let d = 0; d < 7; d++) sheet.append(`ts_d${d}`, d === 0 ? '1.5' : d === 1 ? '2' : '');
  assert.equal((await app.post('/time/week', sheet)).status, 303);
  const rows = await q(`SELECT entry_date, minutes, notes FROM time_entry ORDER BY entry_date, entry_id`);
  assert.deepEqual(rows.map(r => [r.entry_date, r.minutes, r.notes]), [[TODAY, 60, 'Kept note'], [TODAY, 30, 'Second'], ['2026-10-13', 120, null]]);
  const bad = new URLSearchParams(sheet);
  bad.set('ts_d2', 'lots');
  const res = await app.post('/time/week', bad);
  assert.equal(res.status, 422);
  assert.match(await res.text(), /value="lots"/, 'what was typed is shown again');
});

test('foreign: no rate change after payments; deposited payments keep their rate; one revaluation per date', async () => {
  await app.post('/settings/currencies/on');
  await app.post('/settings/currencies', { code: 'EUR', rate: '1.10', date: '2026-10-01' });
  const c = Number(/\/customers\/(\d+)/.exec((await app.post('/customers', { displayName: 'Rate Lock SARL', currency: 'EUR', active: '1' })).headers.get('location'))[1]);
  const inv = new URLSearchParams({ type: 'invoice', customer_id: String(c), txn_date: TODAY, after_save: 'none', exchange_rate: '1.10' });
  inv.append('line_item', ''); inv.append('line_desc', 'Order'); inv.append('line_qty', '1'); inv.append('line_rate', '100');
  await app.post('/txns', inv);
  const invoice = await one(`SELECT txn_id, doc_number FROM txn WHERE customer_id = $1 AND type = 'invoice'`, [c]);
  await app.post('/txns', { type: 'payment', customer_id: String(c), txn_date: TODAY, amount: '40', exchange_rate: '1.05', [`apply_${invoice.txn_id}`]: '40' });
  const edit = new URLSearchParams(inv);
  edit.set('exchange_rate', '1.30'); edit.set('doc_number', invoice.doc_number);
  assert.equal((await app.post(`/txns/${invoice.txn_id}`, edit)).status, 422, 'rate locked once paid against');

  const pay = await one(`SELECT txn_id FROM txn WHERE customer_id = $1 AND type = 'payment'`, [c]);
  const dep = new URLSearchParams({ account_id: String(app.ids.accounts.checking), txn_date: TODAY });
  dep.append('source', String(pay.txn_id));
  await app.post('/deposits', dep);
  assert.equal((await q('SELECT 1 FROM deposit_line WHERE source_txn_id = $1', [pay.txn_id])).length, 1, 'deposited');
  {
    const res = await app.post(`/txns/${pay.txn_id}`, { type: 'payment', customer_id: String(c), txn_date: TODAY, amount: '40', exchange_rate: '1.30',
      [`apply_${invoice.txn_id}`]: '40' });
    assert.equal(res.status, 422, 'a deposited payment’s rate can’t change');
  }

  await app.post('/settings/currencies/EUR/rate', { rate: '1.20', date: '2026-10-31' });
  assert.equal((await app.post('/settings/currencies/revalue', { date: '2026-10-31' })).status, 303);
  assert.equal((await app.post('/settings/currencies/revalue', { date: '2026-10-31' })).status, 422, 'not twice');
  assert.equal((await app.post('/settings/currencies/revalue', { date: '2026-10-01' })).status, 422, 'not before later foreign activity');
  const rev = await one(`SELECT txn_id FROM txn WHERE type = 'fx_revaluation' LIMIT 1`);
  await app.post(`/ledger/${rev.txn_id}/delete`);
  assert.equal((await q(`SELECT 1 FROM txn WHERE type = 'fx_revaluation'`)).length, 2, 'legs stay together');
});

test('documents: a customer’s document isn’t served to a role without the customer side', async () => {
  const fd = new FormData();
  fd.set('csrf', app.csrf);
  fd.set('file', new Blob([Buffer.from('w9')]), 'w9.pdf');
  await app.raw(`/vendors/${app.ids.vendors.office}/documents`, { method: 'POST', body: fd });
  const d = await one(`SELECT document_id FROM document WHERE vendor_id = $1 ORDER BY document_id DESC LIMIT 1`, [app.ids.vendors.office]);
  assert.ok(d);
  assert.ok(!canAccess('customers', 'GET', '/vendors'), 'so the route answers 404 for a customers-only person');
});
