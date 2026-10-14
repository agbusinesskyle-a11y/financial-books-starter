import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { postingsFor, PostingError, SYSTEM_ACCOUNTS } from '../lib/domain/ledger.js';
import { ledgerCheck, listAccounts } from '../lib/data/ledger.js';
import { savePolicy, runLateFees } from '../lib/data/latefees.js';
import { startApp } from './app-harness.js';

const TODAY = '2026-10-12';
const SYS = { ar: 1, undeposited: 2, sales: 3, late_fee_income: 4 };
const sum = ps => ps.reduce((s, p) => s + p.amountCents, 0);
const by = ps => ps.reduce((m, p) => ({ ...m, [p.accountId]: (m[p.accountId] ?? 0) + p.amountCents }), {});

// ---- posting rules ----

test('posting rules: every type balances and hits the right accounts', () => {
  const lines = [{ line_no: 1, item_id: 10, amount_cents: 700 }, { line_no: 2, item_id: null, amount_cents: 300 }];
  const income = id => (id === 10 ? 50 : null);
  const t = (type, extra = {}) => ({ txn_id: 9, type, total_cents: 1000, customer_id: 7, ...extra });

  assert.deepEqual(by(postingsFor({ txn: t('invoice'), lines, sys: SYS, incomeAccount: income })), { 1: 1000, 50: -700, 3: -300 });
  assert.deepEqual(by(postingsFor({ txn: t('credit_memo'), lines, sys: SYS, incomeAccount: income })), { 1: -1000, 50: 700, 3: 300 });
  assert.deepEqual(by(postingsFor({ txn: t('sales_receipt'), lines, sys: SYS, incomeAccount: income })), { 2: 1000, 50: -700, 3: -300 });
  assert.deepEqual(by(postingsFor({ txn: t('sales_receipt', { account_id: 60 }), lines, sys: SYS, incomeAccount: income })), { 60: 1000, 50: -700, 3: -300 });
  assert.deepEqual(by(postingsFor({ txn: t('payment'), sys: SYS })), { 2: 1000, 1: -1000 });
  assert.deepEqual(by(postingsFor({ txn: t('late_fee'), lines, sys: SYS })), { 1: 1000, 4: -1000 });
  const dep = postingsFor({ txn: t('deposit', { account_id: 60, customer_id: null }), sys: SYS,
    depositLines: [{ line_no: 1, source_txn_id: 5, amount_cents: 800, customer_id: 7 }, { line_no: 2, account_id: 70, amount_cents: 200 }] });
  assert.deepEqual(by(dep), { 60: 1000, 2: -800, 70: -200 });
  for (const type of ['invoice', 'credit_memo', 'sales_receipt', 'payment', 'late_fee']) {
    assert.equal(sum(postingsFor({ txn: t(type), lines, sys: SYS, incomeAccount: income })), 0, type);
  }
  assert.deepEqual(postingsFor({ txn: t('invoice', { voided_at: new Date(), total_cents: 0 }), lines, sys: SYS }), []);
  assert.throws(() => postingsFor({ txn: t('invoice', { total_cents: 999 }), lines, sys: SYS }), PostingError);
  assert.throws(() => postingsFor({ txn: t('bogus'), sys: SYS }), PostingError);
});

// ---- through the app ----

let app, scope;
before(async () => {
  app = await startApp();
  scope = { orgId: app.ids.orgId, entityId: app.ids.entityId };
});
after(async () => {
  const check = await ledgerCheck(app.db.pool, scope);
  assert.ok(check.balanced, 'debits = credits after every test');
  assert.ok(check.arMatches, `A/R ${check.arLedger} = customer open balances ${check.arOpen}`);
  await app.close();
});

const balanceOf = async key => {
  const all = await listAccounts(app.db.pool, scope);
  return all.find(a => a.system_key === key || a.name === key).balance_cents;
};
const lines = (rows) => {
  const p = new URLSearchParams();
  for (const [item, desc, qty, rate] of rows) { p.append('line_item', item); p.append('line_desc', desc); p.append('line_qty', qty); p.append('line_rate', rate); }
  return p;
};

test('the seeded books balance, every system account exists, deposits cleared older payments', async () => {
  const check = await ledgerCheck(app.db.pool, scope);
  assert.ok(check.balanced);
  assert.ok(check.arMatches);
  assert.ok(check.debits > 0);
  const accounts = await listAccounts(app.db.pool, scope);
  for (const s of SYSTEM_ACCOUNTS) assert.ok(accounts.some(a => a.system_key === s.key), s.key);
  assert.ok(await balanceOf('Operating Checking') > 0);
  assert.ok(await balanceOf('Feed Sales') > 0, 'income shows as a positive (credit-normal) balance');
  const waiting = (await app.db.pool.query(
    `SELECT coalesce(sum(t.total_cents), 0)::bigint AS n FROM txn t WHERE t.org_id = $1 AND t.type IN ('payment', 'sales_receipt') AND t.voided_at IS NULL
        AND (t.type = 'payment' OR coalesce(t.account_id, 0) IN (0, (SELECT account_id FROM account WHERE org_id = $1 AND system_key = 'undeposited')))
        AND NOT EXISTS (SELECT 1 FROM deposit_line d WHERE d.source_txn_id = t.txn_id)`, [scope.orgId])).rows[0].n;
  assert.equal(await balanceOf('undeposited'), waiting, 'Undeposited Funds = payments not yet deposited');
});

test('an unbalanced posting can never commit', async () => {
  const c = await app.db.pool.connect();
  try {
    const { rows: [t] } = await c.query(`SELECT txn_id FROM txn WHERE org_id = $1 AND type = 'invoice' AND voided_at IS NULL LIMIT 1`, [scope.orgId]);
    const { rows: [a] } = await c.query(`SELECT account_id FROM account WHERE org_id = $1 AND system_key = 'sales'`, [scope.orgId]);
    await c.query('BEGIN');
    await c.query(`INSERT INTO posting (org_id, entity_id, txn_id, account_id, amount_cents, txn_date) VALUES ($1, $2, $3, $4, 1, '2026-10-01')`,
      [scope.orgId, scope.entityId, t.txn_id, a.account_id]);
    await assert.rejects(c.query('COMMIT'), /out of balance/);
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
});

test('invoice: income goes to each item’s account; edit, void and delete rewrite the ledger', async () => {
  const cust = app.ids.customers.hilltop;
  const feedBefore = await balanceOf('Feed Sales'), salesBefore = await balanceOf('sales'), arBefore = await balanceOf('ar');
  const body = lines([[String(app.ids.items.cubes), 'Cubes', '2', '485'], ['', 'Misc', '1', '20']]);
  for (const [k, v] of Object.entries({ type: 'invoice', customer_id: String(cust), txn_date: TODAY })) body.set(k, v);
  assert.equal((await app.post('/txns', body)).status, 303);
  const inv = (await app.db.pool.query(`SELECT txn_id FROM txn WHERE customer_id = $1 AND type = 'invoice' ORDER BY txn_id DESC LIMIT 1`, [cust])).rows[0].txn_id;
  assert.equal(await balanceOf('Feed Sales') - feedBefore, 97000);
  assert.equal(await balanceOf('sales') - salesBefore, 2000, 'a line with no product goes to Sales');
  assert.equal(await balanceOf('ar') - arBefore, 99000);

  body.set('line_qty', '1'); // first line now 1 ton
  const edit = lines([[String(app.ids.items.cubes), 'Cubes', '1', '485'], ['', 'Misc', '1', '20']]);
  for (const [k, v] of Object.entries({ type: 'invoice', customer_id: String(cust), txn_date: TODAY })) edit.set(k, v);
  assert.equal((await app.post(`/txns/${inv}`, edit)).status, 303);
  assert.equal(await balanceOf('Feed Sales') - feedBefore, 48500);
  assert.equal(await balanceOf('ar') - arBefore, 50500);

  assert.equal((await app.post(`/txns/${inv}/void`)).status, 303);
  assert.equal(await balanceOf('ar'), arBefore);
  assert.equal((await app.db.pool.query('SELECT count(*)::int AS n FROM posting WHERE txn_id = $1', [inv])).rows[0].n, 0);
});

test('sales receipts can go straight to a bank account; payments wait in Undeposited Funds', async () => {
  const cust = app.ids.customers.hilltop;
  const checking = app.ids.accounts.checking;
  const form = await (await app.get(`/txns/new?type=sales_receipt&customer=${cust}`)).text();
  assert.match(form, /name="deposit_to"/);
  assert.match(form, /<option value="\d+" selected>Undeposited Funds<\/option>/);
  const before = await balanceOf('Operating Checking');
  const body = lines([[String(app.ids.items.hay), 'Hay', '10', '85']]);
  for (const [k, v] of Object.entries({ type: 'sales_receipt', customer_id: String(cust), txn_date: TODAY, deposit_to: String(checking) })) body.set(k, v);
  assert.equal((await app.post('/txns', body)).status, 303);
  assert.equal(await balanceOf('Operating Checking') - before, 85000);
});

test('make deposit: bank payments, add other funds, guard banked payments, delete puts them back', async () => {
  const cust = app.ids.customers.hilltop;
  for (const amount of ['300.00', '450.00']) {
    assert.equal((await app.post('/txns', { type: 'payment', customer_id: String(cust), txn_date: TODAY, amount, payment_ref: `Check ${amount}` })).status, 303);
  }
  const pays = (await app.db.pool.query(
    `SELECT txn_id FROM txn WHERE customer_id = $1 AND type = 'payment' AND payment_ref LIKE 'Check %.00' ORDER BY txn_id`, [cust])).rows.map(r => r.txn_id);
  const page = await (await app.get('/deposits/new')).text();
  for (const id of pays) assert.match(page, new RegExp(`name="source" value="${id}"`));
  const ufBefore = await balanceOf('undeposited'), bankBefore = await balanceOf('Savings');

  const body = new URLSearchParams({ account_id: String(app.ids.accounts.savings), txn_date: TODAY, memo: 'Friday deposit' });
  for (const id of pays) body.append('source', String(id));
  for (const [a, amt] of [[String(app.ids.accounts.interest_income), '1.25'], ['', ''], ['', '']]) {
    body.append('other_customer', ''); body.append('other_account', a); body.append('other_desc', a ? 'Interest' : ''); body.append('other_amount', amt);
  }
  const res = await app.post('/deposits', body);
  assert.equal(res.status, 303);
  const depId = Number(/\/deposits\/(\d+)/.exec(res.headers.get('location'))[1]);
  assert.equal(await balanceOf('Savings') - bankBefore, 75125);
  assert.equal(ufBefore - await balanceOf('undeposited'), 75000);
  assert.match(await (await app.get(`/deposits/${depId}`)).text(), /Interest/);
  assert.match(await (await app.get('/deposits')).text(), /\$751\.25/);
  assert.match(await (await app.get(`/customers/${cust}?tab=activity`)).text(), /deposited to Savings/);

  // Banked payments can't be voided, deleted, or have their amount changed.
  const voided = await app.post(`/txns/${pays[0]}/void`);
  assert.equal(voided.status, 303);
  assert.match(await (await app.get(voided.headers.get('location'))).text(), /deposit to Savings/);
  const edit = await app.post(`/txns/${pays[0]}`, { type: 'payment', customer_id: String(cust), txn_date: TODAY, amount: '310.00' });
  assert.equal(edit.status, 422);
  assert.match(await edit.text(), /Remove it from that deposit first/);
  // Nothing selected is an error; a payment that's already banked can't be deposited twice.
  assert.equal((await app.post('/deposits', { account_id: String(app.ids.accounts.savings), txn_date: TODAY })).status, 422);
  const twice = new URLSearchParams({ account_id: String(app.ids.accounts.savings), txn_date: TODAY, source: String(pays[0]) });
  assert.equal((await app.post('/deposits', twice)).status, 422);

  assert.equal((await app.post(`/deposits/${depId}/delete`)).status, 303);
  assert.equal(await balanceOf('undeposited'), ufBefore);
  assert.equal(await balanceOf('Savings'), bankBefore);
  assert.equal((await app.post(`/txns/${pays[1]}/delete`)).status, 303, 'once out of the deposit it can be deleted');
});

test('late fees post to Late Fee Income', async () => {
  const before = await balanceOf('late_fee_income');
  await savePolicy(app.db.pool, { ...scope, today: '2026-01-01', fields: { enabled: '1', feeKind: 'flat', flat: '25', graceDays: '0' } });
  await app.db.pool.query(`UPDATE late_fee_policy SET effective_from = '2020-01-01' WHERE org_id = $1`, [scope.orgId]);
  const n = await runLateFees(app.db.pool, { ...scope, today: TODAY });
  assert.ok(n > 0);
  assert.equal(await balanceOf('late_fee_income') - before, n * 2500);
});

test('chart of accounts: add, sub-account, rules, rename built-in, register, delete', async () => {
  const page = await (await app.get('/settings/accounts')).text();
  assert.match(page, /Books balance/);
  assert.match(page, /Undeposited Funds/);
  assert.match(page, /Built in/);

  const add = await app.post('/settings/accounts', { name: 'Truck Fuel', number: '6110', type: 'expense', active: '1' });
  assert.equal(add.status, 303);
  const fuel = Number(/accounts\/(\d+)/.exec(add.headers.get('location'))[1]);
  assert.equal((await app.post('/settings/accounts', { name: 'Truck Fuel', type: 'expense', active: '1' })).status, 422, 'names are unique');
  assert.equal((await app.post('/settings/accounts', { name: 'Other', number: '6110', type: 'expense', active: '1' })).status, 422, 'numbers are unique');
  const ar = await app.post('/settings/accounts', { name: 'Second A/R', type: 'accounts_receivable', active: '1' });
  assert.equal(ar.status, 422);
  assert.match(await ar.text(), /Only the built-in/);

  const parent = (await listAccounts(app.db.pool, scope)).find(a => a.name === 'Fuel').account_id;
  assert.equal((await app.post(`/settings/accounts/${fuel}/edit`, { name: 'Truck Fuel', number: '6110', type: 'expense', parentId: String(parent), active: '1' })).status, 303);
  const wrongType = await app.post(`/settings/accounts/${fuel}/edit`, { name: 'Truck Fuel', type: 'expense', parentId: String(app.ids.accounts.checking), active: '1' });
  assert.equal(wrongType.status, 422);
  assert.match(await (await app.get('/settings/accounts')).text(), /class="sub-account"><a href="\/settings\/accounts\/\d+">Truck Fuel/);

  const uf = (await listAccounts(app.db.pool, scope)).find(a => a.system_key === 'undeposited');
  assert.equal((await app.post(`/settings/accounts/${uf.account_id}/edit`, { name: 'Payments to Deposit', number: '1250', type: 'bank' })).status, 303);
  const renamed = (await listAccounts(app.db.pool, scope)).find(a => a.system_key === 'undeposited');
  assert.equal(renamed.name, 'Payments to Deposit');
  assert.equal(renamed.type, 'other_current_asset', 'built-in type never changes');

  const register = await (await app.get(`/settings/accounts/${app.ids.accounts.checking}`)).text();
  assert.match(register, /Deposit/);
  assert.match(register, /href="\/deposits\/\d+"/);

  assert.equal((await app.post(`/settings/accounts/${fuel}/delete`)).headers.get('location'), '/settings/accounts');
  const used = await app.post(`/settings/accounts/${app.ids.accounts.feed_sales}/delete`);
  assert.equal(used.headers.get('location'), `/settings/accounts/${app.ids.accounts.feed_sales}/edit`);
  assert.match(await (await app.get(used.headers.get('location'))).text(), /still has a balance|has been used/);
  const retire = await app.post(`/settings/accounts/${app.ids.accounts.feed_sales}/edit`, { name: 'Feed Sales', number: '4010', type: 'income' });
  assert.equal(retire.status, 422, 'an account with a balance can’t be made inactive');
});

test('products pick an income account', async () => {
  const form = await (await app.get(`/settings/items/${app.ids.items.hay}`)).text();
  assert.match(form, new RegExp(`<option value="${app.ids.accounts.hay_sales}" selected>4020 · Hay Sales</option>`));
  assert.equal((await app.post(`/settings/items/${app.ids.items.hay}`, { name: 'Coastal Hay Round Bale', kind: 'product', rate: '85', active: '1',
    incomeAccountId: String(app.ids.accounts.checking) })).status, 422, 'must be an income account');
  assert.match(await (await app.get('/settings/items')).text(), /Hay Sales/);
});

test('installable app: manifest, icons, service worker, phone viewport on every page', async () => {
  const manifest = await app.get('/public/manifest.webmanifest');
  assert.equal(manifest.headers.get('content-type'), 'application/manifest+json');
  const m = JSON.parse(await manifest.text());
  assert.equal(m.display, 'standalone');
  for (const icon of m.icons) {
    const res = await app.get(icon.src);
    assert.equal(res.status, 200, icon.src);
    const png = Buffer.from(await res.arrayBuffer());
    assert.equal(png.readUInt32BE(16), Number(icon.sizes.split('x')[0]), `${icon.src} is ${icon.sizes}`);
  }
  const sw = await app.get('/sw.js');
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get('content-type'), /javascript/);
  for (const path of ['/customers', `/customers/${app.ids.customers.redriver}`, '/deposits', '/deposits/new', '/settings/accounts', '/login']) {
    const html = await (await app.get(path)).text();
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/, path);
    assert.match(html, /<link rel="manifest" href="\/public\/manifest.webmanifest">/, path);
  }
});
