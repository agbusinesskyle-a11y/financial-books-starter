import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './app-harness.js';
import { tieout, TODAY } from './tieout.js';
import { runLateFees } from '../lib/data/latefees.js';
import { runRecurring } from '../lib/data/recurring.js';
import { computeStatement } from '../lib/data/statements.js';
import { getSummary } from '../lib/data/customers.js';
import { PROCESSORS, webhookSecret } from '../lib/payments/processors.js';
import { settingsKey } from '../lib/secrets.js';

// Deep tie-out of the SALES / CUSTOMER side. Every customer-side function is done the way a person would (HTTP through
// the app); after each one the books are read every way the app shows them (ledger, customer pages, A/R aging, customer
// balance summary, trial balance, balance sheet and P&L on both bases, Home, general ledger, history, audit) and
//   1. every view agrees with every other (checkTied), and
//   2. exactly the accounts, customers and net income that accounting says should move, moved (expectChange) — the
//      expected numbers are worked out here from first principles, never read back from the app.
// State carries forward from test to test, so they run in order.

const KEY = '12'.repeat(32);
const sent = [];
const mailer = { kind: 'smtp', from: 'books@sample.example', async send(m) { sent.push(m); return { status: 'sent' }; } };
let app, t, pool, sys, ITEM;

before(async () => {
  app = await startApp({ mailer, env: { SETTINGS_KEY: KEY } });
  t = tieout(app);
  pool = app.db.pool;
  sys = app.ids.accounts; // system keys and the sample's own accounts, by key -> account id
  const items = (await pool.query('SELECT item_id, name, kind, income_account_id, rate_cents FROM item WHERE org_id = $1', [app.ids.orgId])).rows;
  const by = name => {
    const i = items.find(x => x.name === name) ?? assert.fail(`no item ${name}`);
    return { id: Number(i.item_id), income: Number(i.income_account_id ?? sys.sales), rate: Number(i.rate_cents), kind: i.kind };
  };
  ITEM = { cubes: by('Range Cubes 20% (ton)'), hay: by('Coastal Hay Round Bale'), tub: by('Mineral Tub (250 lb)'), delivery: by('Delivery') };
  for (const i of Object.values(ITEM)) assert.notEqual(i.kind, 'inventory', 'these tests use non-inventory items');
});
after(async () => { await app.close(); });

// ---- helpers ----

const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const txnRow = id => one('SELECT *, txn_date::text AS d FROM txn WHERE txn_id = $1', [id]);
const newest = async (customerId, type) => Number((await one('SELECT txn_id FROM txn WHERE customer_id = $1 AND type = $2 ORDER BY txn_id DESC LIMIT 1', [customerId, type]))?.txn_id ?? 0);
const errorOf = html => (/class="error-banner"[^>]*>([^<]+)/.exec(html) ?? [])[1] ?? html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300);
async function ok(res, label, location = null) {
  if (res.status !== 303) assert.fail(`${label}: HTTP ${res.status}: ${errorOf(await res.text())}`);
  if (location) assert.equal(res.headers.get('location'), location, `${label}: redirected to ${res.headers.get('location')} (a flashed error?)`);
  return res;
}
const flash = async path => /class="flash (ok|error)" role="status">([^<]*)</.exec(await (await app.get(path)).text())?.slice(1) ?? [];
const idIn = (res, re) => Number(re.exec(res.headers.get('location'))[1]);
const net = report => report.rows.find(r => r.label === 'Net Income')?.values?.at(-1) ?? 0;
const rowBy = (report, accountId) => report.rows.find(r => Number(r.accountId) === Number(accountId))?.values?.at(-1) ?? 0;
// Sums debit-positive deltas by account (two keys can be the same account).
function acc(...pairs) {
  const out = {};
  for (const [k, v] of pairs) {
    const key = typeof k === 'number' ? String(k) : String(sys[k] ?? assert.fail(`no account ${k}`));
    out[key] = (out[key] ?? 0) + v;
  }
  for (const k of Object.keys(out)) if (out[k] === 0) delete out[k];
  return out;
}

function salesForm(type, customerId, lines, more = {}) {
  const p = new URLSearchParams({ type, customer_id: String(customerId), txn_date: TODAY, after_save: 'none', ...more });
  for (const l of lines) {
    p.append('line_item', l.item ? String(l.item) : ''); p.append('line_desc', l.desc ?? ''); p.append('line_qty', l.qty ?? '1');
    p.append('line_rate', l.rate ?? ''); p.append('line_est', l.est ?? '');
  }
  return p;
}
const payForm = (customerId, amount, apply, more = {}) => new URLSearchParams({ type: 'payment', customer_id: String(customerId), txn_date: TODAY, amount,
  payment_method: 'Check', ...Object.fromEntries(Object.entries(apply).map(([id, a]) => [`apply_${id}`, a])), ...more });

// One step: snapshot, act, snapshot; every view ties; exactly the expected things moved; the transaction shows everywhere.
// expect: { accounts, customers, net } (or a function of the action's result). cash: expected change in cash-basis net income.
async function step(label, action, expect = {}, { cash = null, history = true, activity = true } = {}) {
  const a = await t.snapshot();
  const r = (await action()) ?? {};
  const b = await t.snapshot();
  t.checkTied(b, label);
  const e = typeof expect === 'function' ? await expect(r) : expect;
  t.expectChange(a, b, { ...e, label });
  if (cash !== null) assert.equal(net(b.plCash) - net(a.plCash), typeof cash === 'function' ? cash(r) : cash, `${label}: cash-basis net income change`);
  if (history && r.txnId) await t.expectHistory(r.txnId, { activity });
  return { ...r, a, b };
}
const audited = async (table, id) => assert.ok((await one(`SELECT count(*)::int AS n FROM audit_log WHERE table_name = $1 AND row_id = $2`, [table, id])).n > 0,
  `${table} ${id} not in the audit log`);
const deletedAudited = async id => assert.ok((await one(`SELECT count(*)::int AS n FROM audit_log WHERE table_name = 'txn' AND row_id = $1 AND action = 'delete'`, [id])).n > 0,
  `deleted txn ${id} not in the audit log`);
const salesOn = () => app.post('/settings/sales', { customNumbers: '1', serviceDate: '1', discount: '1', shipping: '1', deposit: '1', defaultDelivery: 'none',
  statementKind: 'balance_forward', statementAging: '1' });

async function newCustomer(name, more = {}) {
  const res = await ok(await app.post('/customers', { displayName: name, email: `${name.toLowerCase().replace(/\W+/g, '.')}@example.com`, active: '1',
    lateFeesEnabled: '1', sendReminders: '1', ...more }), `create ${name}`);
  return idIn(res, /\/customers\/(\d+)/);
}

// The customers the test makes, and the documents it tracks between steps.
const C = {}, D = {};

// ---- 1. customers ----

test('1. customers: create, opening balance, edit, inactive/active, merge, sub-customer', async () => {
  await step('create a customer', async () => { C.a = await newCustomer('Tieout Ranch'); }, {});
  await audited('customer', C.a);
  assert.equal((await getSummary(pool, { orgId: app.ids.orgId, customerId: C.a, today: TODAY })).openCents, 0);

  // Opening balance $1,250.00 as of 9/30: an invoice that debits A/R and credits Opening Balance Equity; not income.
  const opening = await step('create a customer with an opening balance', async () => {
    const res = await ok(await app.post('/customers', { displayName: 'Tieout Opening Co', firstName: '', creditLimit: '', active: '1', openingBalance: '1,250.00', openingAsOf: '2026-09-30' }),
      'opening');
    C.opening = idIn(res, /\/customers\/(\d+)/);
    return { txnId: await newest(C.opening, 'invoice') };
  }, () => ({ accounts: acc(['ar', 125000], ['opening_equity', -125000]), customers: { [C.opening]: 125000 }, net: 0 }), { cash: 0 });
  assert.equal((await txnRow(opening.txnId)).d, '2026-09-30');

  await step('edit customer fields', async () => {
    await ok(await app.post(`/customers/${C.a}`, { displayName: 'Tieout Ranch', email: 'office@tieout.example', phone: '555-0100', active: '1', lateFeesEnabled: '1',
      sendReminders: '1', billingLine1: '1 Ledger Rd', billingCity: 'Denton', billingState: 'TX', billingPostal: '76201' }), 'edit');
  }, {});
  const c = await one('SELECT email, phone, late_fees_enabled FROM customer WHERE customer_id = $1', [C.a]);
  assert.deepEqual([c.email, c.phone, c.late_fees_enabled], ['office@tieout.example', '555-0100', true]);

  await step('make inactive', async () => { await ok(await app.post(`/customers/${C.opening}/active`, { active: '0' }), 'inactive'); }, {});
  assert.equal((await one('SELECT active FROM customer WHERE customer_id = $1', [C.opening])).active, false);
  await step('make active', async () => { await ok(await app.post(`/customers/${C.opening}/active`, { active: '1' }), 'active'); }, {});

  // Merge: two customers, each with an open invoice and a partial payment. Money moves between customers only.
  C.m1 = await newCustomer('Tieout Merge One');
  C.m2 = await newCustomer('Tieout Merge Two');
  for (const [cust, rate, paid] of [[C.m1, '300', '100'], [C.m2, '500', '200']]) {
    await step(`merge setup invoice ${rate}`, async () => {
      await ok(await app.post('/txns', salesForm('invoice', cust, [{ desc: 'Setup feed', qty: '1', rate }])), 'merge inv');
      return { txnId: await newest(cust, 'invoice') };
    }, { accounts: acc(['ar', Number(rate) * 100], ['sales', -Number(rate) * 100]), customers: { [cust]: Number(rate) * 100 }, net: Number(rate) * 100 }, { cash: 0 });
    const inv = await newest(cust, 'invoice');
    await step(`merge setup payment ${paid}`, async () => {
      await ok(await app.post('/txns', payForm(cust, paid, { [inv]: paid })), 'merge pay');
      return { txnId: await newest(cust, 'payment') };
    }, { accounts: acc(['undeposited', Number(paid) * 100], ['ar', -Number(paid) * 100]), customers: { [cust]: -Number(paid) * 100 }, net: 0 }, { cash: Number(paid) * 100 });
  }
  const m1Txns = (await q('SELECT txn_id FROM txn WHERE customer_id = $1 ORDER BY txn_id', [C.m1])).map(r => Number(r.txn_id));
  const merged = await step('merge two customers with open invoices and payments', async () => {
    await ok(await app.post(`/customers/${C.m1}/merge`, { into: String(C.m2) }), 'merge', `/customers/${C.m2}`);
  }, { customers: { [C.m2]: 20000 }, net: 0 }); // M1 owed 300-100 = 200.00; it all lands on M2.
  assert.ok(merged.a.cust.has(C.m1) && !merged.b.cust.has(C.m1), 'the merged customer is gone');
  assert.equal(merged.b.cust.get(C.m2).openCents, 20000 + 30000);
  assert.equal((await one('SELECT count(*)::int AS n FROM posting WHERE customer_id = $1', [C.m1])).n, 0, 'postings follow the merge');
  for (const id of m1Txns) {
    assert.equal(Number((await txnRow(id)).customer_id), C.m2);
    await t.expectHistory(id);
  }

  // Sub-customer under Tieout Ranch: its own balance; checkTied proves A/R = sum of every customer (no double count).
  await step('create a sub-customer', async () => {
    const res = await ok(await app.post('/customers', { displayName: 'Tieout Ranch: North Pasture', firstName: '', creditLimit: '', active: '1', isSub: '1',
      parentCustomerId: String(C.a) }), 'sub');
    C.sub = idIn(res, /\/customers\/(\d+)/);
  }, {});
  assert.equal(Number((await one('SELECT parent_customer_id FROM customer WHERE customer_id = $1', [C.sub])).parent_customer_id), C.a);
  await step('invoice the sub-customer', async () => {
    await ok(await app.post('/txns', salesForm('invoice', C.sub, [{ item: ITEM.tub.id, desc: 'Tub', qty: '1', rate: '139' }])), 'sub inv');
    return { txnId: await newest(C.sub, 'invoice') };
  }, { accounts: acc(['ar', 13900], [ITEM.tub.income, -13900]), customers: { [C.sub]: 13900 }, net: 13900 }, { cash: 0 });
});

// ---- 2. invoices ----

test('2. invoice: two lines with discount and shipping, edit up and down, duplicate, void, delete', async () => {
  await step('turn on discount and shipping', async () => { await ok(await salesOn(), 'sales settings'); }, {});
  // 2 tons of cubes at 485.00 (Feed Sales) + delivery 150.00 (Delivery Income) − 20.00 discount + 35.00 shipping = 1,135.00.
  const inv = (cubesQty) => salesForm('invoice', C.a, [{ item: ITEM.cubes.id, desc: 'Range cubes', qty: String(cubesQty), rate: '485' },
    { item: ITEM.delivery.id, desc: 'Delivery', qty: '1', rate: '150' }], { discount_kind: 'amount', discount_value: '20', shipping: '35' });
  const expectFor = (cubesQty, sign = 1) => {
    const cubes = cubesQty * 48500, total = cubes + 15000 - 2000 + 3500;
    return { accounts: acc(['ar', sign * total], [ITEM.cubes.income, -sign * cubes], [ITEM.delivery.income, -sign * 15000], ['discounts', sign * 2000], ['shipping_income', -sign * 3500]),
      customers: { [C.a]: sign * total }, net: sign * total };
  };
  const created = await step('create invoice', async () => {
    await ok(await app.post('/txns', inv(2)), 'invoice');
    return { txnId: await newest(C.a, 'invoice') };
  }, expectFor(2), { cash: 0 });
  D.inv1 = created.txnId;
  const r = await txnRow(D.inv1);
  assert.deepEqual([Number(r.total_cents), Number(r.discount_cents), Number(r.shipping_cents), Number(r.open_cents)], [113500, 2000, 3500, 113500]);
  // A/R aging and the customer balance summary show it under this customer (also proven by checkTied for every customer).
  const aging = await t.run('ar_aging_summary', { period: 'today' });
  assert.equal(aging.rows.find(x => Number(x.partyId) === C.a)?.values.at(-1), 113500);

  const edit = qty => { const p = inv(qty); p.set('doc_number', r.doc_number); return app.post(`/txns/${D.inv1}`, p); };
  await step('edit invoice up (2 → 3 tons)', async () => { await ok(await edit(3), 'edit up'); return { txnId: D.inv1 }; },
    { accounts: acc(['ar', 48500], [ITEM.cubes.income, -48500]), customers: { [C.a]: 48500 }, net: 48500 }, { cash: 0 });
  await step('edit invoice down (3 → 1 ton)', async () => { await ok(await edit(1), 'edit down'); return { txnId: D.inv1 }; },
    { accounts: acc(['ar', -97000], [ITEM.cubes.income, 97000]), customers: { [C.a]: -97000 }, net: -97000 }, { cash: 0 });
  assert.equal(Number((await txnRow(D.inv1)).total_cents), 65000);

  // Duplicate: the copy form comes pre-filled from the invoice; saving it books the same thing again.
  const copyPage = await (await app.get(`/txns/new?copy=${D.inv1}`)).text();
  assert.match(copyPage, /New invoice/);
  assert.match(copyPage, /value="Range cubes"/);
  assert.match(copyPage, new RegExp(`name="txn_date" value="${TODAY}"`));
  const dup = await step('duplicate invoice', async () => {
    await ok(await app.post('/txns', inv(1)), 'duplicate');
    return { txnId: await newest(C.a, 'invoice') };
  }, expectFor(1), { cash: 0 });
  assert.notEqual(dup.txnId, D.inv1);

  await step('void the duplicate', async () => {
    await ok(await app.post(`/txns/${dup.txnId}/void`), 'void', `/customers/${C.a}`);
    return { txnId: dup.txnId };
  }, expectFor(1, -1), { cash: 0 });
  const voided = await txnRow(dup.txnId);
  assert.ok(voided.voided_at);
  assert.equal(Number(voided.open_cents), 0, 'a voided invoice has nothing open');

  const small = await step('create a small invoice to delete', async () => {
    await ok(await app.post('/txns', salesForm('invoice', C.a, [{ desc: 'Odd job', qty: '1', rate: '40' }])), 'small');
    return { txnId: await newest(C.a, 'invoice') };
  }, { accounts: acc(['ar', 4000], ['sales', -4000]), customers: { [C.a]: 4000 }, net: 4000 }, { cash: 0 });
  await step('delete it', async () => { await ok(await app.post(`/txns/${small.txnId}/delete`), 'delete', `/customers/${C.a}`); },
    { accounts: acc(['ar', -4000], ['sales', 4000]), customers: { [C.a]: -4000 }, net: -4000 }, { cash: 0 });
  assert.equal(await txnRow(small.txnId), undefined);
  await deletedAudited(small.txnId);
  assert.equal((await one('SELECT count(*)::int AS n FROM posting WHERE txn_id = $1', [small.txnId])).n, 0);

  // The app doesn't let a saved invoice change customer (QBO does, when nothing is applied); the refusal must leave the books alone.
  C.other = await newCustomer('Tieout Other Ranch');
  await step('changing a saved invoice’s customer is refused', async () => {
    const res = await app.post(`/txns/${D.inv1}`, salesForm('invoice', C.other, [{ desc: 'Wrong customer', qty: '1', rate: '70' }], { doc_number: r.doc_number }));
    assert.equal(res.status, 422);
  }, {});

  // An invoice dated last year is last year's income: this year's P&L doesn't move, but A/R (and, through the year-end
  // roll, Retained Earnings on the TB/BS) does. Re-dating it into this year moves it into this year's income.
  const py = await step('invoice dated last year', async () => {
    await ok(await app.post('/txns', salesForm('invoice', C.other, [{ desc: 'Last year', qty: '1', rate: '90' }], { txn_date: '2025-12-15', due_date: '2026-01-14' })), 'py');
    return { txnId: await newest(C.other, 'invoice') };
  }, { accounts: acc(['ar', 9000], ['sales', -9000]), customers: { [C.other]: 9000 }, net: 0 }, { cash: 0 });
  const pyRow = await txnRow(py.txnId);
  const reOf = s => s.bs.rows.filter(r => /Retained Earnings/.test(r.label ?? "")).map(r => r.values?.at(-1) ?? 0);
  const bsBefore = reOf(py.b);
  const re = await step('re-date it into this year', async () => {
    await ok(await app.post(`/txns/${py.txnId}`, salesForm('invoice', C.other, [{ desc: 'Last year', qty: '1', rate: '90' }],
      { txn_date: '2026-01-05', due_date: '2026-02-04', doc_number: pyRow.doc_number })), 're-date');
    return { txnId: py.txnId };
  }, { net: 9000 }, { cash: 0 });
  const bsAfter = reOf(re.b);
  assert.deepEqual(bsAfter.map((v, i) => v - bsBefore[i]), [-9000], 'Retained Earnings on the balance sheet loses last year’s 90.00');
});

// ---- 3. receive payment ----

test('3. receive payment: full, partial, overpayment credit applied later, edit, void, delete; cash basis follows the money', async () => {
  // Two more invoices: delivery 150.00 (inv2) and one ton of cubes 485.00 (inv3).
  const inv2 = await step('invoice 2', async () => {
    await ok(await app.post('/txns', salesForm('invoice', C.a, [{ item: ITEM.delivery.id, desc: 'Delivery', qty: '1', rate: '150' }])), 'inv2');
    return { txnId: await newest(C.a, 'invoice') };
  }, { accounts: acc(['ar', 15000], [ITEM.delivery.income, -15000]), customers: { [C.a]: 15000 }, net: 15000 }, { cash: 0 });
  D.inv2 = inv2.txnId;
  const inv3 = await step('invoice 3', async () => {
    await ok(await app.post('/txns', salesForm('invoice', C.a, [{ item: ITEM.cubes.id, desc: 'Cubes', qty: '1', rate: '485' }])), 'inv3');
    return { txnId: await newest(C.a, 'invoice') };
  }, { accounts: acc(['ar', 48500], [ITEM.cubes.income, -48500]), customers: { [C.a]: 48500 }, net: 48500 }, { cash: 0 });
  D.inv3 = inv3.txnId;

  // Full payment of inv1 (650.00 = 485 cubes + 150 delivery − 20 discount + 35 shipping): cash basis now earns all of it.
  const pFull = await step('full payment', async () => {
    await ok(await app.post('/txns', payForm(C.a, '650.00', { [D.inv1]: '650.00' })), 'full');
    return { txnId: await newest(C.a, 'payment') };
  }, { accounts: acc(['undeposited', 65000], ['ar', -65000]), customers: { [C.a]: -65000 }, net: 0 }, { cash: 65000 });
  D.payFull = pFull.txnId;
  assert.equal(Number((await txnRow(D.inv1)).open_cents), 0);
  // Cash basis by account: the paid invoice's lines land in their own accounts.
  assert.equal(rowBy(pFull.b.plCash, ITEM.cubes.income) - rowBy(pFull.a.plCash, ITEM.cubes.income), 48500, 'cash basis: Feed Sales earned on payment');
  assert.equal(rowBy(pFull.b.plCash, ITEM.delivery.income) - rowBy(pFull.a.plCash, ITEM.delivery.income), 15000, 'cash basis: Delivery Income earned on payment');

  const pPart = await step('partial payment (50 of 150)', async () => {
    await ok(await app.post('/txns', payForm(C.a, '50.00', { [D.inv2]: '50.00' })), 'partial');
    return { txnId: await newest(C.a, 'payment') };
  }, { accounts: acc(['undeposited', 5000], ['ar', -5000]), customers: { [C.a]: -5000 }, net: 0 }, { cash: 5000 });
  D.payPart = pPart.txnId;
  assert.equal(Number((await txnRow(D.inv2)).open_cents), 10000);

  // Overpayment: 600.00 against inv3 (485.00) leaves a 115.00 credit; the customer's balance goes down by all 600.
  const pOver = await step('overpayment', async () => {
    await ok(await app.post('/txns', payForm(C.a, '600.00', { [D.inv3]: '485.00' })), 'over');
    return { txnId: await newest(C.a, 'payment') };
  }, { accounts: acc(['undeposited', 60000], ['ar', -60000]), customers: { [C.a]: -60000 }, net: 0 }, { cash: 48500 });
  D.payOver = pOver.txnId;
  assert.equal(Number((await txnRow(D.payOver)).open_cents), 11500, 'unapplied credit');

  // Apply 100.00 of the credit to inv2: nothing moves in the ledger or the balance; cash basis earns inv2's last 100.
  await step('apply the credit to another invoice', async () => {
    await ok(await app.post(`/txns/${D.payOver}/apply`, { [`apply_${D.inv2}`]: '100.00' }), 'apply', `/txns/${D.payOver}`);
    assert.match((await flash(`/txns/${D.payOver}`))[0] ?? 'ok', /ok/);
    return { txnId: D.payOver };
  }, {}, { cash: 10000 });
  assert.equal(Number((await txnRow(D.inv2)).open_cents), 0);
  assert.equal(Number((await txnRow(D.payOver)).open_cents), 1500);

  // Edit the partial payment 50 → 30: inv2 reopens by 20.
  const editPay = await (await app.get(`/txns/${D.payPart}/edit`)).text();
  assert.match(editPay, new RegExp(`name="apply_${D.inv2}" value="50.00"`));
  await step('edit a payment amount', async () => {
    await ok(await app.post(`/txns/${D.payPart}`, payForm(C.a, '30.00', { [D.inv2]: '30.00' })), 'edit pay', `/customers/${C.a}`);
    return { txnId: D.payPart };
  }, { accounts: acc(['undeposited', -2000], ['ar', 2000]), customers: { [C.a]: 2000 }, net: 0 }, { cash: -2000 });
  assert.equal(Number((await txnRow(D.inv2)).open_cents), 2000);

  await step('void the full payment', async () => {
    await ok(await app.post(`/txns/${D.payFull}/void`), 'void pay', `/customers/${C.a}`);
    return { txnId: D.payFull };
  }, { accounts: acc(['undeposited', -65000], ['ar', 65000]), customers: { [C.a]: 65000 }, net: 0 }, { cash: -65000 });
  assert.equal(Number((await txnRow(D.inv1)).open_cents), 65000, 'invoice reopens');

  // An unapplied 25.00 payment (a prepayment) deleted outright.
  const pre = await step('unapplied prepayment', async () => {
    await ok(await app.post('/txns', payForm(C.a, '25.00', {})), 'prepay');
    return { txnId: await newest(C.a, 'payment') };
  }, { accounts: acc(['undeposited', 2500], ['ar', -2500]), customers: { [C.a]: -2500 }, net: 0 }, { cash: 0 });
  await step('delete the unapplied payment', async () => {
    await ok(await app.post(`/txns/${pre.txnId}/delete`), 'delete prepay', `/customers/${C.a}`);
  }, { accounts: acc(['undeposited', -2500], ['ar', 2500]), customers: { [C.a]: 2500 }, net: 0 }, { cash: 0 });
  assert.equal(await txnRow(pre.txnId), undefined);
  await deletedAudited(pre.txnId);

  // An invoice can't be cut below what has been paid on it (inv3 is paid 485.00 in full).
  const r3 = await txnRow(D.inv3);
  await step('edit a paid invoice below its payments is refused', async () => {
    const res = await app.post(`/txns/${D.inv3}`, salesForm('invoice', C.a, [{ item: ITEM.cubes.id, desc: 'Cubes', qty: '1', rate: '400' }], { doc_number: r3.doc_number }));
    assert.equal(res.status, 422, 'refused');
  }, {});

  // Partial payment of a discounted invoice with shipping: cash basis earns each line, the discount and the shipping
  // in proportion to what was paid. 2 tons cubes 970.00 + delivery 150.00 = 1,120.00; 10% off = 112.00; shipping 30.00 → 1,038.00.
  const disc = await step('invoice with 10% discount and shipping', async () => {
    await ok(await app.post('/txns', salesForm('invoice', C.a, [{ item: ITEM.cubes.id, desc: 'Cubes', qty: '2', rate: '485' },
      { item: ITEM.delivery.id, desc: 'Delivery', qty: '1', rate: '150' }], { discount_kind: 'percent', discount_value: '10', shipping: '30' })), 'disc inv');
    return { txnId: await newest(C.a, 'invoice') };
  }, { accounts: acc(['ar', 103800], [ITEM.cubes.income, -97000], [ITEM.delivery.income, -15000], ['discounts', 11200], ['shipping_income', -3000]),
    customers: { [C.a]: 103800 }, net: 103800 }, { cash: 0 });
  D.disc = disc.txnId;
  const half = await step('pay half of the discounted invoice', async () => {
    await ok(await app.post('/txns', payForm(C.a, '519.00', { [D.disc]: '519.00' })), 'half');
    return { txnId: await newest(C.a, 'payment') };
  }, { accounts: acc(['undeposited', 51900], ['ar', -51900]), customers: { [C.a]: -51900 }, net: 0 }, { cash: 51900 });
  for (const [label, id, want] of [['Feed Sales', ITEM.cubes.income, 48500], ['Delivery Income', ITEM.delivery.income, 7500], ['Discounts Given', sys.discounts, -5600],
    ['Shipping Income', sys.shipping_income, 1500]]) {
    assert.equal(rowBy(half.b.plCash, id) - rowBy(half.a.plCash, id), want, `cash basis: half of ${label} earned`);
  }
});

test('3a. void a paid invoice: its payment becomes an unapplied credit', async () => {
  const x = await step('invoice 200', async () => {
    await ok(await app.post('/txns', salesForm('invoice', C.a, [{ desc: 'To void after payment', qty: '1', rate: '200' }])), 'x');
    return { txnId: await newest(C.a, 'invoice') };
  }, { accounts: acc(['ar', 20000], ['sales', -20000]), customers: { [C.a]: 20000 }, net: 20000 }, { cash: 0 });
  const p = await step('pay it', async () => {
    await ok(await app.post('/txns', payForm(C.a, '200.00', { [x.txnId]: '200.00' })), 'x pay');
    return { txnId: await newest(C.a, 'payment') };
  }, { accounts: acc(['undeposited', 20000], ['ar', -20000]), customers: { [C.a]: -20000 }, net: 0 }, { cash: 20000 });
  // Voiding the invoice takes its income and A/R away; the 200.00 received stays, now as a credit the customer has.
  await step('void the paid invoice', async () => {
    const res = await app.post(`/txns/${x.txnId}/void`);
    if (res.headers.get('location') !== `/customers/${C.a}`) assert.fail(`void refused: ${(await flash(`/txns/${x.txnId}`))[1]}`);
    return { txnId: x.txnId };
  }, { accounts: acc(['ar', -20000], ['sales', 20000]), customers: { [C.a]: -20000 }, net: -20000 }, { cash: -20000 });
  assert.equal(Number((await txnRow(p.txnId)).open_cents), 20000, 'the payment is unapplied again');
});

test('3b. delete an applied payment (QBO deletes it and reopens the invoice)', async () => {
  // The partial payment (30.00 applied to invoice 2). Deleting it should take 30.00 out of Undeposited Funds and put it back on A/R.
  // BUG: lib/data/writes.js deleteTxn refuses any transaction with applications (appliedTotal counts credit_txn_id too), so a
  // received payment can only be voided, not deleted — QBO deletes it and reopens the invoices. The message also tells the
  // user to "remove the payment first" on the payment itself.
  await step('delete the applied partial payment', async () => {
    await ok(await app.post(`/txns/${D.payPart}/delete`), 'delete pay', `/customers/${C.a}`);
  }, { accounts: acc(['undeposited', -3000], ['ar', 3000]), customers: { [C.a]: 3000 }, net: 0 }, { cash: -3000 });
  assert.equal(await txnRow(D.payPart), undefined);
  await deletedAudited(D.payPart);
  assert.equal(Number((await txnRow(D.inv2)).open_cents), 5000);
});

// ---- 4. sales receipt and bank deposit ----

test('4. sales receipt into Undeposited Funds, bank deposit with an extra line, delete deposit', async () => {
  C.cash = await newCustomer('Tieout Cash Buyer');
  // 4 round bales at 85.00 = 340.00 to Hay Sales; the money sits in Undeposited Funds. Not A/R: no balance.
  const sr = await step('sales receipt', async () => {
    await ok(await app.post('/txns', salesForm('sales_receipt', C.cash, [{ item: ITEM.hay.id, desc: 'Round bales', qty: '4', rate: '85' }], { payment_method: 'Cash' })), 'sr');
    return { txnId: await newest(C.cash, 'sales_receipt') };
  }, { accounts: acc(['undeposited', 34000], [ITEM.hay.income, -34000]), net: 34000 }, { cash: 34000 });
  D.sr = sr.txnId;
  assert.equal(Number((await txnRow(D.sr)).account_id), sys.undeposited);

  // Deposit the receipt and the overpayment (600.00) to checking, plus 12.34 of interest (no customer).
  const dep = new URLSearchParams({ account_id: String(sys.checking), txn_date: TODAY, memo: 'Tieout deposit' });
  dep.append('source', String(D.sr)); dep.append('source', String(D.payOver));
  dep.append('other_account', String(sys.interest_income)); dep.append('other_customer', ''); dep.append('other_desc', 'Bank interest'); dep.append('other_amount', '12.34');
  const d1 = await step('bank deposit with an extra line', async () => {
    const res = await ok(await app.post('/deposits', dep), 'deposit');
    return { txnId: idIn(res, /\/deposits\/(\d+)/) };
  }, { accounts: acc(['checking', 34000 + 60000 + 1234], ['undeposited', -94000], ['interest_income', -1234]), net: 1234 }, { cash: 1234, activity: false });
  assert.equal(Number((await txnRow(d1.txnId)).total_cents), 95234);
  assert.equal((await app.get(`/deposits/${d1.txnId}`)).status, 200);

  await step('delete the deposit', async () => {
    await ok(await app.post(`/deposits/${d1.txnId}/delete`), 'delete deposit', '/deposits');
  }, { accounts: acc(['checking', -95234], ['undeposited', 94000], ['interest_income', 1234]), net: -1234 }, { cash: -1234 });
  assert.equal(await txnRow(d1.txnId), undefined);
  await deletedAudited(d1.txnId);
  assert.match(await (await app.get('/deposits/new')).text(), new RegExp(`name="source" value="${D.sr}"`), 'the receipt is waiting to be deposited again');

  const d2 = new URLSearchParams({ account_id: String(sys.checking), txn_date: TODAY, memo: 'Receipt only' });
  d2.append('source', String(D.sr));
  await step('deposit the sales receipt alone', async () => {
    const res = await ok(await app.post('/deposits', d2), 'deposit 2');
    return { txnId: idIn(res, /\/deposits\/(\d+)/) };
  }, { accounts: acc(['checking', 34000], ['undeposited', -34000]), net: 0 }, { cash: 0, activity: false });
  // A sales receipt deposited straight to the bank skips Undeposited Funds.
  await step('sales receipt straight to checking', async () => {
    await ok(await app.post('/txns', salesForm('sales_receipt', C.cash, [{ item: ITEM.tub.id, desc: 'Tub', qty: '1', rate: '139' }],
      { payment_method: 'Card', deposit_to: String(sys.checking) })), 'sr bank');
    return { txnId: await newest(C.cash, 'sales_receipt') };
  }, { accounts: acc(['checking', 13900], [ITEM.tub.income, -13900]), net: 13900 }, { cash: 13900 });
  // Once banked, the receipt can't be voided or deleted out from under the deposit (it would leave the bank holding money with no source).
  for (const action of ['void', 'delete']) {
    await step(`${action} a deposited sales receipt is refused`, async () => {
      const res = await app.post(`/txns/${D.sr}/${action}`);
      assert.equal(res.headers.get('location'), `/txns/${D.sr}`, `${action} was not refused`);
      assert.equal((await flash(`/txns/${D.sr}`))[0], 'error');
    }, {});
  }
});

// ---- 5. credit memo ----

test('5. credit memo, applied to an invoice, then voided', async () => {
  // A 30.00 delivery credit: debits Delivery Income, credits A/R.
  const cm = await step('credit memo', async () => {
    await ok(await app.post('/txns', salesForm('credit_memo', C.a, [{ item: ITEM.delivery.id, desc: 'Late delivery credit', qty: '1', rate: '30' }])), 'cm');
    return { txnId: await newest(C.a, 'credit_memo') };
  }, { accounts: acc([ITEM.delivery.income, 3000], ['ar', -3000]), customers: { [C.a]: -3000 }, net: -3000 });
  D.cm = cm.txnId;
  await step('apply the credit memo to invoice 1', async () => {
    await ok(await app.post(`/txns/${D.cm}/apply`, { [`apply_${D.inv1}`]: '30.00' }), 'apply cm', `/txns/${D.cm}`);
    return { txnId: D.cm };
  }, {});
  assert.equal(Number((await txnRow(D.inv1)).open_cents), 62000);
  assert.equal(Number((await txnRow(D.cm)).open_cents), 0);
  await step('void the credit memo', async () => {
    await ok(await app.post(`/txns/${D.cm}/void`), 'void cm', `/customers/${C.a}`);
    return { txnId: D.cm };
  }, { accounts: acc([ITEM.delivery.income, -3000], ['ar', 3000]), customers: { [C.a]: 3000 }, net: 3000 });
  assert.equal(Number((await txnRow(D.inv1)).open_cents), 65000, 'the invoice it paid reopens');

  // A second credit (20.00 of Feed Sales) applied to the half-paid discounted invoice: no cash changes hands, so cash-basis
  // income doesn't move when it's created or applied.
  const cm2 = await step('credit memo 2', async () => {
    await ok(await app.post('/txns', salesForm('credit_memo', C.a, [{ item: ITEM.cubes.id, desc: 'Short weight', qty: '1', rate: '20' }])), 'cm2');
    return { txnId: await newest(C.a, 'credit_memo') };
  }, { accounts: acc([ITEM.cubes.income, 2000], ['ar', -2000]), customers: { [C.a]: -2000 }, net: -2000 }, { cash: 0 });
  await step('apply credit memo 2 to the discounted invoice', async () => {
    await ok(await app.post(`/txns/${cm2.txnId}/apply`, { [`apply_${D.disc}`]: '20.00' }), 'apply cm2', `/txns/${cm2.txnId}`);
    return { txnId: cm2.txnId };
  }, {}, { cash: 0 });
  assert.equal(Number((await txnRow(D.disc)).open_cents), 51900 - 2000);
});

// ---- 6. estimates ----

async function invoiceFromEstimate(estimateId, query) {
  const res = await app.get(`/txns/${estimateId}/invoice?${query}`);
  const html = (await res.text()).replace(/<template[\s\S]*?<\/template>/g, ''); // row templates aren't form values
  assert.equal(res.status, 200, errorOf(html));
  const vals = name => [...html.matchAll(new RegExp(`name="${name}" value="([^"]*)"`, 'g'))].map(m => m[1]);
  const items = [...html.matchAll(/<select name="line_item"[^>]*>([\s\S]*?)<\/select>/g)].map(m => (/<option value="(\d*)" selected/.exec(m[1]) ?? [])[1] ?? '');
  const descs = vals('line_desc'), rates = vals('line_rate'), ests = vals('line_est'), qtys = vals('line_qty');
  const cust = /name="customer_id" value="(\d+)"/.exec(html)?.[1] ?? /<select name="customer_id"[\s\S]*?<option value="(\d+)" selected/.exec(html)[1];
  const lines = descs.map((desc, i) => ({ item: items[i] ?? '', desc: desc.replace(/&amp;/g, '&'), qty: qtys[i], rate: rates[i], est: ests[i] })).filter(l => l.desc);
  return app.post('/txns', salesForm('invoice', cust, lines, { estimate_id: String(estimateId) }));
}

test('6. estimate: no ledger effect; statuses; converted to invoice by percent and then in full', async () => {
  // 2 tons of cubes (970.00) + delivery 150.00 = 1,120.00 estimated.
  const est = await step('create estimate', async () => {
    await ok(await app.post('/txns', salesForm('estimate', C.a, [{ item: ITEM.cubes.id, desc: 'Cubes', qty: '2', rate: '485' },
      { item: ITEM.delivery.id, desc: 'Delivery', qty: '1', rate: '150' }], { due_date: '2026-11-12' })), 'estimate');
    return { txnId: await newest(C.a, 'estimate') };
  }, {}, { cash: 0 });
  D.est = est.txnId;
  assert.equal((await one('SELECT count(*)::int AS n FROM posting WHERE txn_id = $1', [D.est])).n, 0);
  for (const status of ['accepted', 'rejected', 'pending', 'accepted']) {
    await step(`estimate ${status}`, async () => { await ok(await app.post(`/txns/${D.est}/status`, { status }), status, `/txns/${D.est}`); }, {});
    assert.equal((await txnRow(D.est)).estimate_status, status);
  }
  // 50%: half of each line — 485.00 cubes + 75.00 delivery = 560.00.
  const half = { accounts: acc(['ar', 56000], [ITEM.cubes.income, -48500], [ITEM.delivery.income, -7500]), customers: { [C.a]: 56000 }, net: 56000 };
  await step('convert 50% to an invoice', async () => {
    await ok(await invoiceFromEstimate(D.est, 'mode=percent&percent=50'), 'convert 50');
    return { txnId: await newest(C.a, 'invoice') };
  }, half, { cash: 0 });
  assert.equal(Number((await txnRow(D.est)).open_cents), 56000);
  await step('convert the rest', async () => {
    await ok(await invoiceFromEstimate(D.est, 'mode=full'), 'convert rest');
    return { txnId: await newest(C.a, 'invoice') };
  }, half, { cash: 0 });
  const e = await txnRow(D.est);
  assert.deepEqual([Number(e.open_cents), e.estimate_status], [0, 'closed']);
});

// ---- 7. late fees ----

test('7. late fees: policy on, daily job charges an overdue invoice, fee deleted', async () => {
  await step('turn on late fees ($25 flat, no grace)', async () => {
    await ok(await app.post('/settings/late-fees', { enabled: '1', feeKind: 'flat', flat: '25', graceDays: '0' }), 'policy');
  }, {});
  // An invoice due yesterday (10/11). With no grace, a fee is due 10/12 — the day the policy starts.
  const late = await step('overdue invoice', async () => {
    await ok(await app.post('/txns', salesForm('invoice', C.a, [{ desc: 'Old feed bill', qty: '1', rate: '100' }], { txn_date: '2026-09-11', due_date: '2026-10-11' })), 'late inv');
    return { txnId: await newest(C.a, 'invoice') };
  }, { accounts: acc(['ar', 10000], ['sales', -10000]), customers: { [C.a]: 10000 }, net: 10000 }, { cash: 0 });
  D.late = late.txnId;
  // Which invoices are due a fee today, from the rule itself: open, unvoided, home-currency invoices due 10/11 of customers with late fees on.
  const eligible = await q(`SELECT t.customer_id FROM txn t JOIN customer c ON c.customer_id = t.customer_id
    WHERE t.org_id = $1 AND t.entity_id = $2 AND t.type = 'invoice' AND t.voided_at IS NULL AND t.open_cents > 0 AND t.due_date = '2026-10-11'
      AND t.currency IS NULL AND c.late_fees_enabled`, [app.ids.orgId, app.ids.entityId]);
  assert.ok(eligible.some(r => Number(r.customer_id) === C.a));
  const perCustomer = {};
  for (const r of eligible) perCustomer[r.customer_id] = (perCustomer[r.customer_id] ?? 0) + 2500;
  const fees = 2500 * eligible.length;
  await step('run the daily late-fee job', async () => {
    assert.equal(await runLateFees(pool, { orgId: app.ids.orgId, entityId: app.ids.entityId, today: TODAY }), eligible.length);
    D.fee = Number((await one(`SELECT txn_id FROM txn WHERE type = 'late_fee' AND source_txn_id = $1`, [D.late])).txn_id);
    return { txnId: D.fee };
  }, { accounts: acc(['ar', fees], ['late_fee_income', -fees]), customers: perCustomer, net: fees }, { cash: 0 });
  assert.equal((await txnRow(D.fee)).d, TODAY);
  await step('run it again: nothing more', async () => {
    assert.equal(await runLateFees(pool, { orgId: app.ids.orgId, entityId: app.ids.entityId, today: TODAY }), 0);
  }, {});
  await step('delete the late fee', async () => {
    await ok(await app.post(`/txns/${D.fee}/delete`), 'delete fee', `/customers/${C.a}`);
  }, { accounts: acc(['ar', -2500], ['late_fee_income', 2500]), customers: { [C.a]: -2500 }, net: -2500 });
  assert.equal(await txnRow(D.fee), undefined);
  await deletedAudited(D.fee);
  // Turn fees off again so later steps don't pick any up.
  await step('turn late fees off', async () => { await ok(await app.post('/settings/late-fees', { feeKind: 'flat', flat: '25', graceDays: '0' }), 'off'); }, {});
});

// ---- 8. recurring ----

test('8. recurring template creates an invoice when the job runs', async () => {
  const form = new URLSearchParams({ name: 'Tieout monthly tub', txnType: 'invoice', mode: 'scheduled', unit: 'month', count: '1', startDate: TODAY, endDate: '', termsId: '', memo: 'Monthly' });
  form.append('line_item', String(ITEM.tub.id)); form.append('line_desc', 'Mineral tub'); form.append('line_qty', '2'); form.append('line_rate', '139');
  await step('create recurring template', async () => { await ok(await app.post(`/customers/${C.a}/recurring`, form), 'template'); }, {});
  const tpl = await one('SELECT template_id FROM recurring_template WHERE customer_id = $1', [C.a]);
  await step('run recurring', async () => {
    const runs = await runRecurring(pool, { orgId: app.ids.orgId, entityId: app.ids.entityId, today: TODAY });
    assert.deepEqual(runs.map(r => [r.templateId, r.outcome]), [[tpl.template_id, 'created']]);
    return { txnId: Number((await one('SELECT txn_id FROM txn WHERE recurring_template_id = $1', [tpl.template_id])).txn_id) };
  }, { accounts: acc(['ar', 27800], [ITEM.tub.income, -27800]), customers: { [C.a]: 27800 }, net: 27800 }, { cash: 0 });
  await step('run recurring again the same day', async () => {
    assert.deepEqual(await runRecurring(pool, { orgId: app.ids.orgId, entityId: app.ids.entityId, today: TODAY }), []);
  }, {});
});

// ---- 9. statements ----

test('9. statements: no ledger effect; total due = the customer balance on the statement date', async () => {
  for (const [cust, kind] of [[C.a, 'open_item'], [C.a, 'balance_forward'], [C.m2, 'transaction'], [app.ids.customers.redriver, 'balance_forward']]) {
    const s = await step(`statement ${kind} for ${cust}`, async () => {
      await ok(await app.post(`/customers/${cust}/statements`, { kind, statementDate: TODAY, startDate: '2022-01-01', endDate: TODAY, action: 'save' }), 'statement');
    }, {});
    const st = await one('SELECT statement_id, content FROM statement WHERE customer_id = $1 ORDER BY statement_id DESC LIMIT 1', [cust]);
    assert.equal(st.content.total_due_cents, s.b.cust.get(cust).openCents, `${kind} statement total ≠ customer balance`);
    assert.equal((await app.get(`/statements/${st.statement_id}.pdf`)).status, 200);
  }
  // A statement dated in the past: its total due = the customer's A/R on that date, straight from the ledger.
  for (const cust of [app.ids.customers.redriver, app.ids.customers.loneoak, C.m2]) {
    for (const kind of ['balance_forward', 'open_item']) {
      const date = '2026-09-30';
      const st = await computeStatement(pool, { orgId: app.ids.orgId, entityId: app.ids.entityId, customerId: cust,
        request: { kind, statementDate: date, startDate: '2026-07-01', endDate: date } });
      const ledger = Number((await one(`SELECT coalesce(sum(amount_cents), 0)::bigint AS n FROM posting WHERE account_id = $1 AND customer_id = $2 AND txn_date <= $3`,
        [sys.ar, cust, date])).n);
      const aging = await t.run('ar_aging_summary', { period: 'custom', to: date, from: date });
      assert.equal(aging.rows.find(x => Number(x.partyId) === cust)?.values.at(-1) ?? 0, ledger, `A/R aging for customer ${cust} on ${date} ≠ ledger`);
      // BUG (open_item only): lib/data/statements.js computeStatement lists today's open_cents for items dated on/before the
      // statement date, so invoices paid after that date drop off and the total due understates the balance on that date.
      assert.equal(st.total_due_cents, ledger, `${kind} statement for customer ${cust} on ${date} ≠ A/R on that date`);
    }
  }
  const open = await computeStatement(pool, { orgId: app.ids.orgId, entityId: app.ids.entityId, customerId: C.a, request: { kind: 'open_item', statementDate: TODAY } });
  assert.equal(open.aging.current + open.aging.d1_30 + open.aging.d31_60 + open.aging.d61_90 + open.aging.over_90,
    open.rows.filter(r => r.open_cents > 0).reduce((s, r) => s + r.open_cents, 0));
});

// ---- 10. online payments ----

async function payOnline(invoiceId, method) {
  const share = await app.post(`/txns/${invoiceId}/share`);
  assert.equal(share.status, 200, `share link: ${share.headers.get('location')}`);
  const link = /value="https?:\/\/[^/"]+(\/pay\/[A-Za-z0-9_-]+)"/.exec(await share.text())[1];
  const open = await fetch(app.base + link, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `method=${method}` });
  assert.equal(open.status, 303);
  const checkoutPath = new URL(open.headers.get('location'), app.base).pathname;
  const checkoutId = /co_[A-Za-z0-9_-]{24}/.exec(checkoutPath)[0];
  const pay = await fetch(app.base + checkoutPath, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'action=pay' });
  assert.equal(pay.status, 303);
  const co = await one('SELECT status, payment_txn_id FROM online_checkout WHERE checkout_id = $1', [checkoutId]);
  assert.equal(co.status, 'paid');
  return { txnId: Number(co.payment_txn_id), checkoutId, link };
}

test('10. online payment through the test processor and its signed webhook; fees post correctly', async () => {
  await step('turn on online payments (company pays the fee)', async () => {
    await ok(await app.post('/settings/payments', { enabled: '1', processor: 'test', card: '1', ach: '1', feePayer: 'company' }), 'payments');
  }, {});
  const inv = await step('invoice to pay online', async () => {
    await ok(await app.post('/txns', salesForm('invoice', C.a, [{ desc: 'Online feed order', qty: '1', rate: '200' }])), 'online inv');
    return { txnId: await newest(C.a, 'invoice') };
  }, { accounts: acc(['ar', 20000], ['sales', -20000]), customers: { [C.a]: 20000 }, net: 20000 }, { cash: 0 });
  // Card: 2.9% + 30¢ = 610 kept by the processor, an expense; 193.90 reaches Undeposited Funds; A/R relieved by all 200.
  const fee = Math.round(20000 * 0.029) + 30;
  const paid = await step('pay by card online', async () => payOnline(inv.txnId, 'card'),
    { accounts: acc(['undeposited', 20000 - fee], ['merchant_fees', fee], ['ar', -20000]), customers: { [C.a]: -20000 }, net: -fee }, { cash: 20000 - fee });
  assert.equal(Number((await txnRow(inv.txnId)).open_cents), 0);
  // A replayed, correctly signed webhook records nothing more.
  await step('replayed signed webhook', async () => {
    const body = JSON.stringify({ type: 'checkout.paid', checkout_id: paid.checkoutId });
    const sig = PROCESSORS.test.sign(body, webhookSecret(settingsKey({ SETTINGS_KEY: KEY })));
    assert.equal((await fetch(`${app.base}/webhooks/payments/test`, { method: 'POST', body, headers: { 'x-fb-signature': sig, 'content-type': 'application/json' } })).status, 200);
    const forged = await fetch(`${app.base}/webhooks/payments/test`, { method: 'POST', body, headers: { 'x-fb-signature': 'deadbeef', 'content-type': 'application/json' } });
    assert.equal(forged.status, 400);
  }, {});
  // Banking it: only what the processor sent (200.00 − 6.10) moves from Undeposited Funds to checking.
  const dep = new URLSearchParams({ account_id: String(sys.checking), txn_date: TODAY, memo: 'Processor payout' });
  dep.append('source', String(paid.txnId));
  await step('deposit the online payment', async () => {
    const res = await ok(await app.post('/deposits', dep), 'payout');
    return { txnId: idIn(res, /\/deposits\/(\d+)/) };
  }, { accounts: acc(['checking', 20000 - fee], ['undeposited', -(20000 - fee)]), net: 0 }, { cash: 0, activity: false });

  // Customer pays the fee: ACH 1,000.00 with a 5.00 fee on top. The 5.00 surcharge is income; the processor's 5.00 is an expense.
  await step('customer pays the fee', async () => {
    await ok(await app.post('/settings/payments', { enabled: '1', processor: 'test', card: '1', ach: '1', feePayer: 'customer' }), 'payments 2');
  }, {});
  const inv2 = await step('invoice 1,000.00', async () => {
    await ok(await app.post('/txns', salesForm('invoice', C.a, [{ desc: 'Big feed order', qty: '1', rate: '1000' }])), 'online inv 2');
    return { txnId: await newest(C.a, 'invoice') };
  }, { accounts: acc(['ar', 100000], ['sales', -100000]), customers: { [C.a]: 100000 }, net: 100000 }, { cash: 0 });
  await step('pay by ACH online with the surcharge', async () => payOnline(inv2.txnId, 'ach'),
    { accounts: acc(['undeposited', 100000 - 500 + 500], ['merchant_fees', 500], ['convenience_fees', -500], ['ar', -100000]), customers: { [C.a]: -100000 }, net: 0 },
    { cash: 100000 });
  await step('back to company pays, online payments off', async () => {
    await ok(await app.post('/settings/payments', { processor: 'test', feePayer: 'company' }), 'payments off');
  }, {});
});

// ---- 11. batch actions ----

test('11. batch actions on the customer page: send, reminder, delete', async () => {
  const ids = [];
  for (const rate of ['10', '20']) {
    const r = await step(`batch invoice ${rate}`, async () => {
      await ok(await app.post('/txns', salesForm('invoice', C.a, [{ desc: 'Batch item', qty: '1', rate }])), 'batch inv');
      return { txnId: await newest(C.a, 'invoice') };
    }, { accounts: acc(['ar', Number(rate) * 100], ['sales', -Number(rate) * 100]), customers: { [C.a]: Number(rate) * 100 }, net: Number(rate) * 100 });
    ids.push(r.txnId);
  }
  const batch = action => { const p = new URLSearchParams({ action }); for (const i of ids) p.append('ids', String(i)); if (action === 'delete') p.set('confirmed', '1'); return app.post(`/customers/${C.a}/batch`, p); };
  for (const action of ['send', 'reminder']) {
    await step(`batch ${action}`, async () => { await ok(await batch(action), action, `/customers/${C.a}`); }, {});
    const [kind, text] = await flash(`/customers/${C.a}`);
    assert.equal(kind, 'ok', text);
    assert.match(text, /2 of 2/);
  }
  await step('batch delete', async () => { await ok(await batch('delete'), 'batch delete', `/customers/${C.a}`); },
    { accounts: acc(['ar', -3000], ['sales', 3000]), customers: { [C.a]: -3000 }, net: -3000 });
  for (const id of ids) { assert.equal(await txnRow(id), undefined); await deletedAudited(id); }
});

// ---- 12. price rules and credit limit ----

test('12. price rules and the credit-limit warning post nothing wrong', async () => {
  C.rule = await newCustomer('Tieout Rule Ranch');
  const body = new URLSearchParams({ name: 'Tieout wholesale', kind: 'percent_off', percentOff: '20', startDate: '2026-10-01', endDate: '2026-12-31', active: '1' });
  body.append('customerIds', String(C.rule));
  await step('create price rule', async () => { await ok(await app.post('/settings/price-rules', body), 'rule'); }, {});
  // 10 round bales at the list 85.00 less 20% = 68.00 each = 680.00, all to Hay Sales.
  await step('invoice with a blank rate takes the rule price', async () => {
    await ok(await app.post('/txns', salesForm('invoice', C.rule, [{ item: ITEM.hay.id, desc: 'Round bales', qty: '10', rate: '' }])), 'rule inv');
    return { txnId: await newest(C.rule, 'invoice') };
  }, { accounts: acc(['ar', Math.round(ITEM.hay.rate * 0.8) * 10], [ITEM.hay.income, -Math.round(ITEM.hay.rate * 0.8) * 10]),
    customers: { [C.rule]: Math.round(ITEM.hay.rate * 0.8) * 10 }, net: Math.round(ITEM.hay.rate * 0.8) * 10 });
  await step('set a 100.00 credit limit', async () => {
    await ok(await app.post(`/customers/${C.rule}`, { displayName: 'Tieout Rule Ranch', firstName: '', creditLimit: '100.00', active: '1', lateFeesEnabled: '1' }), 'limit');
  }, {});
  await step('invoice over the credit limit warns but books normally', async () => {
    await ok(await app.post('/txns', salesForm('invoice', C.rule, [{ desc: 'Extra', qty: '1', rate: '500' }])), 'over limit');
    const [kind, text] = await flash(`/customers/${C.rule}`);
    assert.equal(kind, 'ok');
    assert.match(text, /over their \$100\.00 credit limit/);
    return { txnId: await newest(C.rule, 'invoice') };
  }, { accounts: acc(['ar', 50000], ['sales', -50000]), customers: { [C.rule]: 50000 }, net: 50000 });
});

// ---- 13. multicurrency ----

test('13. multicurrency: EUR invoice and a payment at another rate post the realized exchange gain or loss', async () => {
  await step('turn on multicurrency, add EUR', async () => {
    await ok(await app.post('/settings/currencies/on'), 'mc on');
    await ok(await app.post('/settings/currencies', { code: 'EUR', rate: '1.10', date: '2026-10-01' }), 'eur');
    await ok(await app.post('/settings/currencies/EUR/rate', { rate: '1.05', date: '2026-10-11' }), 'eur rate');
    const res = await ok(await app.post('/customers', { displayName: 'Tieout Lyon', currency: 'EUR', active: '1' }), 'eur cust');
    C.eur = idIn(res, /\/customers\/(\d+)/);
  }, {});
  // EUR 100 at 1.10 = 110.00 of A/R and income.
  const inv = await step('EUR invoice', async () => {
    await ok(await app.post('/txns', salesForm('invoice', C.eur, [{ desc: 'Export order', qty: '1', rate: '100' }], { exchange_rate: '1.10' })), 'eur inv');
    return { txnId: await newest(C.eur, 'invoice') };
  }, { accounts: acc(['ar', 11000], ['sales', -11000]), customers: { [C.eur]: 11000 }, net: 11000 }, { cash: 0 });
  // Paid EUR 100 at 1.05: 105.00 arrives, A/R relieved at the invoice's 110.00, the 5.00 difference is a realized loss.
  await step('EUR payment at 1.05', async () => {
    await ok(await app.post('/txns', payForm(C.eur, '100', { [inv.txnId]: '100' }, { exchange_rate: '1.05', payment_method: 'Wire' })), 'eur pay');
    return { txnId: await newest(C.eur, 'payment') };
  }, { accounts: acc(['undeposited', 10500], ['fx_gain_loss', 500], ['ar', -11000]), customers: { [C.eur]: -11000 }, net: -500 }, { cash: 11000 - 500 });
  const i = await txnRow(inv.txnId);
  assert.deepEqual([Number(i.open_cents), Number(i.foreign_open_cents)], [0, 0]);
});

// ---- 14. projects ----

test('14. projects: invoices assigned to a project; profitability income = its invoices', async () => {
  const p = await step('create project', async () => {
    const res = await ok(await app.post(`/customers/${C.a}/projects`, { name: 'Tieout barn', status: 'in_progress', startDate: '2026-10-01', endDate: '', description: '' }), 'project');
    return { projectId: idIn(res, /\/projects\/(\d+)/) };
  }, {});
  D.project = p.projectId;
  await step('invoice on the project', async () => {
    await ok(await app.post('/txns', salesForm('invoice', C.a, [{ item: ITEM.cubes.id, desc: 'Cubes for the crew', qty: '1', rate: '485' }], { project_id: String(D.project) })), 'proj inv');
    return { txnId: await newest(C.a, 'invoice') };
  }, { accounts: acc(['ar', 48500], [ITEM.cubes.income, -48500]), customers: { [C.a]: 48500 }, net: 48500 });
  // Assign an existing invoice (invoice 2, 150.00 delivery, paid) to the project by editing it: no money moves.
  const r2 = await txnRow(D.inv2);
  await step('assign an existing invoice to the project', async () => {
    await ok(await app.post(`/txns/${D.inv2}`, salesForm('invoice', C.a, [{ item: ITEM.delivery.id, desc: 'Delivery', qty: '1', rate: '150' }],
      { project_id: String(D.project), doc_number: r2.doc_number })), 'assign', `/customers/${C.a}`);
    return { txnId: D.inv2 };
  }, {});
  assert.equal(Number((await txnRow(D.inv2)).project_id), D.project);
  const report = await t.run('project_profitability_summary', { period: 'this_year_to_date' });
  const row = report.rows.find(x => Number(x.projectId) === D.project) ?? assert.fail('project missing from profitability');
  assert.deepEqual(row.values, [48500 + 15000, 0, 0, 48500 + 15000], 'project income = its invoices');
  const page = await (await app.get(`/projects/${D.project}`)).text();
  assert.match(page, /<dt>Invoiced<\/dt><dd>\$635\.00<\/dd>/);
});

// ---- final cross-checks ----

test('every customer’s Transaction List by Customer ties to the customer page; P&L accrual vs cash for the year', async () => {
  const s = await t.snapshot();
  t.checkTied(s, 'final');
  const sign = { invoice: 1, late_fee: 1, payment: -1, credit_memo: -1 };
  for (const [id, sum] of s.cust) {
    const r = await t.run('transaction_list_by_customer', { period: 'all', customer: String(id) });
    const ids = new Set(r.rows.filter(x => x.kind === 'line').map(x => Number(x.txnId)));
    const open = await q(`SELECT txn_id, type, open_cents FROM txn WHERE customer_id = $1 AND voided_at IS NULL AND open_cents <> 0 AND type <> 'estimate'`, [id]);
    let total = 0;
    for (const o of open) {
      assert.ok(ids.has(Number(o.txn_id)), `customer ${id}: open ${o.type} ${o.txn_id} missing from Transaction List by Customer`);
      total += (sign[o.type] ?? 0) * Number(o.open_cents);
    }
    assert.equal(total, sum.openCents, `customer ${id}: open items on the transaction list ≠ customer page`);
    // Each listed amount is the transaction's own total.
    for (const x of r.rows.filter(y => y.kind === 'line')) {
      const tx = await txnRow(Number(x.txnId));
      if (tx && !tx.voided_at && !tx.currency) assert.equal(Math.abs(x.cells.amount), Number(tx.total_cents), `customer ${id}: txn ${x.txnId} amount`);
    }
  }
  // Accrual minus cash income for the year = the year's sales still unpaid — A/R that arose this year (from first principles,
  // per income account: what's invoiced vs what's been collected).
  const plA = await t.run('profit_and_loss', { period: 'this_year_to_date' });
  const plC = await t.run('profit_and_loss', { period: 'this_year_to_date' }, 'cash');
  assert.equal(net(plA), net(s.pl));
  assert.equal(net(plC), net(s.plCash));
  // Fees taken or charged at the moment of payment are the same on both bases.
  for (const key of ['merchant_fees', 'convenience_fees', 'fx_gain_loss']) assert.equal(rowBy(plA, sys[key]), rowBy(plC, sys[key]), `${key}: same on both bases`);
  // Income by Customer adds up to the P&L on both bases.
  const ibcA = await t.run('income_by_customer_summary', { period: 'this_year_to_date' });
  const ibcC = await t.run('income_by_customer_summary', { period: 'this_year_to_date' }, 'cash');
  assert.equal(ibcA.rows.at(-1).values[2], net(plA), 'accrual: income by customer ≠ P&L');
  assert.equal(ibcC.rows.at(-1).values[2], net(plC), 'cash: income by customer ≠ P&L');
  // For each customer this test made (all dated this year), income from first principles: accrual = what was sold (invoices,
  // late fees, sales receipts, less credit memos, plus fees the customer paid on top); cash = the part of it actually paid.
  const incomeOf = (rep, id) => rep.rows.find(r => Number(r.groupId ?? r.partyId) === id)?.values?.[0] ?? 0;
  for (const id of [C.a, C.cash, C.rule, C.m2, C.sub, C.eur, C.other, C.opening]) {
    const docs = await q(`SELECT type, total_cents, open_cents, surcharge_cents, system_kind FROM txn WHERE customer_id = $1 AND voided_at IS NULL AND txn_date >= '2026-01-01'
      AND type IN ('invoice', 'late_fee', 'sales_receipt', 'credit_memo', 'payment') AND coalesce(system_kind, '') <> 'opening_balance'`, [id]);
    let accrual = 0, cash = 0;
    for (const d of docs) {
      const total = Number(d.total_cents), open = Number(d.open_cents);
      if (['invoice', 'late_fee'].includes(d.type)) { accrual += total; cash += total - open; }
      if (d.type === 'sales_receipt') { accrual += total; cash += total; }
      if (d.type === 'credit_memo') { accrual -= total; cash -= total - open; }
      if (d.type === 'payment') { accrual += Number(d.surcharge_cents ?? 0); cash += Number(d.surcharge_cents ?? 0); }
    }
    assert.equal(incomeOf(ibcA, id), accrual, `customer ${id}: accrual income`);
    assert.equal(incomeOf(ibcC, id), cash, `customer ${id}: cash income`);
  }
});
