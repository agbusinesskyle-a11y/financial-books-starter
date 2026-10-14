import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './app-harness.js';
import { tieout, TODAY } from './tieout.js';
import { runScheduledPayments } from '../lib/data/payables.js';
import { runRecurring } from '../lib/data/recurring.js';

// Deep tie-out for the purchases / vendor side. Every step is done over HTTP the way a person would, then the books are
// read every way the app shows them (tieout.js): they must agree with each other, and the change must be exactly what
// the accounting says it should be. Expected amounts below come from the debits and credits, never from the app.
// State carries forward from test to test; each test only checks the change it makes.

let app, t, A, V, I, C, sys;
before(async () => {
  app = await startApp();
  t = tieout(app);
  A = app.ids.accounts; V = app.ids.vendors; I = app.ids.items; C = app.ids.customers;
  t.checkTied(await t.snapshot(), 'sample');
  sys = t.sys();
});
after(async () => { await app.close(); });

const q = async (sql, params = []) => (await app.db.pool.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const money = c => `${c < 0 ? '-' : ''}$${Math.floor(Math.abs(c) / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${String(Math.abs(c) % 100).padStart(2, '0')}`;
const vtxnId = res => Number(/\/vtxns\/(\d+)/.exec(res.headers.get('location') ?? '')?.[1] ?? NaN);
const vendorId = res => Number(/\/vendors\/(\d+)/.exec(res.headers.get('location') ?? '')?.[1] ?? NaN);
const errorOf = async res => (/class="error[^"]*"[^>]*>([\s\S]*?)<\//.exec(await res.clone().text()) ?? [])[1] ?? '';
const ok303 = async (res, what) => assert.equal(res.status, 303, `${what}: ${res.status} ${res.status === 303 ? '' : await errorOf(res)}`);
// A redirect that carries an error flash (void / delete / convert use attempt(): failures still 303 back to the page).
const flashError = async res => {
  const loc = res.headers.get('location');
  if (!loc) return '';
  const page = await (await app.get(loc)).text();
  return (/class="flash error"[^>]*>([\s\S]*?)<\//.exec(page) ?? /role="alert"[^>]*>([\s\S]*?)<\//.exec(page) ?? [])[1] ?? '';
};

// A vendor document form the way the editor posts it.
function doc({ type = 'bill', vendor, date = TODAY, cats = [], items = [], ...rest }) {
  const p = new URLSearchParams({ type, vendor_id: vendor ? String(vendor) : '', txn_date: date, ...rest });
  for (const c of cats) {
    p.append('cat_account', String(c.account)); p.append('cat_desc', c.desc ?? ''); p.append('cat_amount', c.amount); p.append('cat_job', c.job ?? '');
    p.append('cat_po', c.po ?? ''); p.append('cat_billable', c.billable ? '1' : ''); p.append('cat_class', '');
  }
  for (const i of items) {
    p.append('item_item', String(i.item)); p.append('item_desc', i.desc ?? ''); p.append('item_qty', i.qty); p.append('item_rate', i.rate); p.append('item_job', i.job ?? '');
    p.append('item_po', i.po ?? ''); p.append('item_billable', i.billable ? '1' : ''); p.append('item_class', '');
  }
  return p;
}
const payForm = ({ account = A.checking, date = TODAY, method, checkNo = '', memo = '', bills, then = '' }) => {
  const p = new URLSearchParams({ account_id: String(account), txn_date: date, method, check_no: checkNo, memo, then });
  for (const b of bills) {
    p.append('bill', String(b.id));
    p.set(`pay_${b.id}`, b.pay ?? '');
    if (b.credit) p.set(`credit_${b.id}`, b.credit);
  }
  return p;
};
const parseCsv = text => text.trim().split(/\r\n/).map(line => {
  const cells = []; let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch; }
    else if (ch === '"') quoted = true; else if (ch === ',') { cells.push(cur); cur = ''; } else cur += ch;
  }
  cells.push(cur);
  return cells;
});
const latestPayment = async vendor => (await one(`SELECT txn_id FROM txn WHERE vendor_id = $1 AND type = 'bill_payment' ORDER BY txn_id DESC LIMIT 1`, [vendor])).txn_id;

// The vendor page (rendered HTML) shows the same open balance as every report.
async function pageBalance(vendor, snap) {
  const page = await (await app.get(`/vendors/${vendor}`)).text();
  const shown = /data-testid="open-balance">([^<]+)</.exec(page)?.[1];
  assert.equal(shown, money(Number(snap.vend.get(vendor).open_cents)), `vendor ${vendor} page balance`);
}

// One step: snapshot, act, snapshot; the books tie every way and moved exactly as expected.
// expected.cash: the change in cash-basis net income (only cash actually spent or received on income and expense moves it).
const netOf = (s, basis = 'accrual') => (basis === 'cash' ? s.plCash : s.pl).rows.find(row => /^Net Income$/.test(row.label ?? ''))?.values.at(-1) ?? 0;
async function step(label, action, expected = {}, { watch = [] } = {}) {
  const a = await t.snapshot();
  const out = await action();
  const b = await t.snapshot();
  t.checkTied(b, label);
  const { cash, ...want } = typeof expected === 'function' ? expected(out) : expected;
  t.expectChange(a, b, { label, ...want });
  if (cash !== undefined) assert.equal(netOf(b, 'cash') - netOf(a, 'cash'), cash, `${label}: cash-basis net income change`);
  for (const v of watch) if (b.vend.has(v)) await pageBalance(v, b);
  return { out, a, b };
}

// Average cost by hand: moves in order, in = { in: qty, value }, out = { out: qty }. Returns each move's cost (+ in, − out) and the end.
function avgCost(moves) {
  let qty = 0, value = 0;
  const costs = moves.map(m => {
    if (m.in !== undefined) { qty += m.in; value += m.value; return m.value; }
    const c = m.out === qty ? value : Math.round((m.out * value) / qty);
    qty -= m.out; value -= c;
    return -c;
  });
  return { costs, qty, value };
}

const st = {}; // ids carried between tests

// ---------------------------------------------------------------- 1. vendors
test('1. vendors: create, opening balance, edit, inactive/active, 1099 flag, merge with open bills', async () => {
  let r = await step('create vendor', async () => {
    const res = await app.post('/vendors', { displayName: 'Tieout Supply', email: 'ap@tieoutsupply.example' });
    await ok303(res, 'create vendor');
    return vendorId(res);
  }, {});
  st.supply = r.out;
  assert.equal(Number(r.b.vend.get(st.supply).open_cents), 0);
  assert.equal(r.b.counts.events - r.a.counts.events, 1, 'one history line: created');

  // Opening balance $1,250.00 as of 9/30: Dr Opening Balance Equity 125000, Cr A/P 125000; not income or expense.
  r = await step('create vendor with opening balance', async () => {
    const res = await app.post('/vendors', { displayName: 'Tieout Hauling', track1099: '1', openingBalance: '1,250.00', openingAsOf: '2026-09-30' });
    await ok303(res, 'opening balance vendor');
    return vendorId(res);
  }, out => ({ accounts: { opening_equity: 125000, ap: -125000 }, vendors: { [out]: 125000 }, net: 0 }), { watch: [] });
  st.hauling = r.out;
  await pageBalance(st.hauling, r.b);
  st.openingBill = (await one(`SELECT txn_id, approval_status FROM txn WHERE vendor_id = $1 AND type = 'bill'`, [st.hauling]));
  assert.equal(st.openingBill.approval_status, 'approved', 'an opening balance needs no approval');
  st.openingBill = st.openingBill.txn_id;
  await t.expectHistory(st.openingBill);
  assert.equal((await one('SELECT track_1099 FROM vendor WHERE vendor_id = $1', [st.hauling])).track_1099, true);

  // Edit: name, phone, 1099 tracking on. Nothing moves.
  await step('edit vendor', async () => {
    await ok303(await app.post(`/vendors/${st.supply}`, { displayName: 'Tieout Supply Co.', email: 'ap@tieoutsupply.example', phone: '(940) 555-0199',
      track1099: '1', active: '1' }), 'edit vendor');
  }, {}, { watch: [st.supply] });
  const sv = await one('SELECT display_name, phone, track_1099, active FROM vendor WHERE vendor_id = $1', [st.supply]);
  assert.deepEqual(sv, { display_name: 'Tieout Supply Co.', phone: '(940) 555-0199', track_1099: true, active: true });

  // Inactive and back, with a balance: the balance stays on the books and in every report.
  await step('make vendor with a balance inactive', async () => {
    await ok303(await app.post(`/vendors/${st.hauling}/inactive`), 'inactive');
  }, {}, { watch: [st.hauling] });
  assert.equal((await one('SELECT active FROM vendor WHERE vendor_id = $1', [st.hauling])).active, false);
  assert.doesNotMatch(await (await app.get('/vendors')).text(), /Tieout Hauling/, 'inactive vendors are hidden from the list');
  await step('make vendor active', async () => {
    await ok303(await app.post(`/vendors/${st.hauling}/active`), 'active');
  }, {});
  assert.equal((await one('SELECT active FROM vendor WHERE vendor_id = $1', [st.hauling])).active, true);

  // Merge: a duplicate vendor with an approved $300 fuel bill merges into Hauling. Only the vendor balance moves.
  r = await step('duplicate vendor', async () => vendorId(await app.post('/vendors', { displayName: 'Tieout Hauling (dup)' })), {});
  st.dup = r.out;
  r = await step('bill on the duplicate', async () => {
    const res = await app.post('/vtxns', doc({ vendor: st.dup, doc_number: 'DUP-1', cats: [{ account: A.fuel, amount: '300.00' }] }));
    await ok303(res, 'dup bill');
    return vtxnId(res);
  }, out => ({ accounts: { [A.fuel]: 30000, ap: -30000 }, vendors: { [st.dup]: 30000 }, net: -30000 }));
  st.dupBill = r.out;
  await step('approve dup bill', async () => ok303(await app.post(`/vtxns/${st.dupBill}/approve`), 'approve'), {});
  r = await step('merge vendors', async () => {
    await ok303(await app.post(`/vendors/${st.dup}/merge`, { into: String(st.hauling) }), 'merge');
  }, { vendors: { [st.hauling]: 30000 } }, { watch: [st.hauling] });
  assert.ok(!r.b.vend.has(st.dup), 'the merged vendor is gone');
  assert.equal(Number(r.b.vend.get(st.hauling).open_cents) - Number(r.a.vend.get(st.hauling).open_cents)
    + -Number(r.a.vend.get(st.dup).open_cents), 0, 'balances moved between vendors only');
  assert.equal((await one('SELECT vendor_id FROM txn WHERE txn_id = $1', [st.dupBill])).vendor_id, st.hauling);
  assert.equal((await one('SELECT count(*)::int AS n FROM posting WHERE txn_id = $1 AND vendor_id IS DISTINCT FROM $2', [st.dupBill, st.hauling])).n, 0,
    'the bill’s postings follow it to the kept vendor');
  await t.expectHistory(st.dupBill);
  assert.match(await (await app.get(`/vendors/${st.hauling}?tab=transactions`)).text(), new RegExp(`/vtxns/${st.dupBill}`));
});

test('1b. merging two vendors that both have an opening balance', async () => {
  const a = vendorId(await app.post('/vendors', { displayName: 'Merge Left', openingBalance: '100.00', openingAsOf: '2026-09-30' }));
  const b = vendorId(await app.post('/vendors', { displayName: 'Merge Right', openingBalance: '40.00', openingAsOf: '2026-09-30' }));
  // Both opening balances are bills numbered "Opening balance", and an opening-balance bill can't be opened for editing,
  // so the person can't renumber one to get past a duplicate-number rule (bill numbers may repeat since migration 016).
  const ob = (await one(`SELECT txn_id, doc_number FROM txn WHERE vendor_id = $1 AND type = 'bill'`, [a]));
  assert.equal(ob.doc_number, 'Opening balance');
  assert.equal((await app.get(`/vtxns/${ob.txn_id}/edit`)).status, 400);
  const r = await step('merge two opening-balance vendors', async () => {
    const res = await app.post(`/vendors/${a}/merge`, { into: String(b) });
    assert.equal(res.status, 303, `merge refused: ${await errorOf(res)}`);
  }, { vendors: { [b]: 10000 } });
  assert.ok(!r.b.vend.has(a));
});

// ---------------------------------------------------------------- 2. bills
test('2. bill with category and product lines; edit; duplicate number warning; void; delete', async () => {
  // Fuel 400.00 + Office 75.50 + 2 Mineral Tubs @ 60.00 (a product with no expense account → Cost of Goods Sold).
  let r = await step('bill with category and item lines', async () => {
    const res = await app.post('/vtxns', doc({ vendor: st.supply, doc_number: 'TS-100',
      cats: [{ account: A.fuel, amount: '400.00', desc: 'Diesel' }, { account: A.office, amount: '75.50' }], items: [{ item: I.tub, qty: '2', rate: '60.00' }] }));
    await ok303(res, 'bill');
    return vtxnId(res);
  }, { accounts: { [A.fuel]: 40000, [A.office]: 7550, cogs: 12000, ap: -59550 }, vendors: { [st.supply]: 59550 }, net: -59550, cash: 0 }, { watch: [st.supply] });
  st.b1 = r.out;
  await t.expectHistory(st.b1);
  assert.equal((await one('SELECT approval_status FROM txn WHERE txn_id = $1', [st.b1])).approval_status, 'awaiting');

  // Fuel 400 → 450: Dr Fuel 5000, Cr A/P 5000.
  await step('edit bill amount', async () => {
    await ok303(await app.post(`/vtxns/${st.b1}`, doc({ vendor: st.supply, doc_number: 'TS-100',
      cats: [{ account: A.fuel, amount: '450.00', desc: 'Diesel' }, { account: A.office, amount: '75.50' }], items: [{ item: I.tub, qty: '2', rate: '60.00' }] })), 'edit');
  }, { accounts: { [A.fuel]: 5000, ap: -5000 }, vendors: { [st.supply]: 5000 }, net: -5000 }, { watch: [st.supply] });
  await t.expectHistory(st.b1);

  // Same vendor, same bill number: a warning, nothing saved; "save anyway" saves it.
  await step('duplicate bill number warns', async () => {
    const res = await app.post('/vtxns', doc({ vendor: st.supply, doc_number: 'TS-100', cats: [{ account: A.office, amount: '12.00' }] }));
    assert.equal(res.status, 422);
    assert.match(await res.text(), /already has bill TS-100/);
  }, {});
  r = await step('duplicate bill saved anyway', async () => {
    const res = await app.post('/vtxns', doc({ vendor: st.supply, doc_number: 'TS-100', allow_duplicate: '1', cats: [{ account: A.office, amount: '12.00' }] }));
    await ok303(res, 'save anyway');
    return vtxnId(res);
  }, { accounts: { [A.office]: 1200, ap: -1200 }, vendors: { [st.supply]: 1200 }, net: -1200 });
  st.dupNumber = r.out;
  await step('delete bill', async () => {
    const res = await app.post(`/vtxns/${st.dupNumber}/delete`);
    assert.equal(res.headers.get('location'), `/vendors/${st.supply}`, await flashError(res));
  }, { accounts: { [A.office]: -1200, ap: 1200 }, vendors: { [st.supply]: -1200 }, net: 1200 }, { watch: [st.supply] });
  assert.equal((await q('SELECT 1 FROM txn WHERE txn_id = $1', [st.dupNumber])).length, 0);

  r = await step('bill to void', async () => vtxnId(await app.post('/vtxns', doc({ vendor: st.supply, doc_number: 'TS-101', cats: [{ account: A.repairs, amount: '200.00' }] }))),
    { accounts: { [A.repairs]: 20000, ap: -20000 }, vendors: { [st.supply]: 20000 }, net: -20000 });
  st.voidBill = r.out;
  await step('void bill', async () => {
    const res = await app.post(`/vtxns/${st.voidBill}/void`);
    assert.equal(await flashError(res), '');
  }, { accounts: { [A.repairs]: -20000, ap: 20000 }, vendors: { [st.supply]: -20000 }, net: 20000 }, { watch: [st.supply] });
  assert.ok((await one('SELECT voided_at FROM txn WHERE txn_id = $1', [st.voidBill])).voided_at);
  await t.expectHistory(st.voidBill);
});

// ---------------------------------------------------------------- 3. approval
test('3. approval: awaiting bills sit in A/P everywhere alike but can’t be paid; approve; reject', async () => {
  // The app's rule (vendors.js BALANCES, ledgerCheck): a bill posts to A/P when entered, approved or not.
  const awaiting = await one('SELECT approval_status, open_cents FROM txn WHERE txn_id = $1', [st.b1]);
  assert.equal(awaiting.approval_status, 'awaiting');
  const s = await t.snapshot();
  const aging = s.apAging.rows.find(x => Number(x.partyId) === st.supply)?.values.at(-1);
  assert.equal(aging, Number(s.vend.get(st.supply).open_cents), 'A/P aging counts the awaiting bill like the vendor page');
  const unpaid = await t.run('unpaid_bills', { period: 'today' });
  assert.ok(unpaid.rows.some(x => Number(x.txnId) === st.b1), 'Unpaid Bills lists the awaiting bill');
  assert.doesNotMatch(await (await app.get(`/pay-bills?vendor=${st.supply}`)).text(), new RegExp(`name="pay_${st.b1}"`), 'not offered in Pay bills');
  await step('paying an awaiting bill is refused', async () => {
    const res = await app.post('/pay-bills', payForm({ method: 'ACH', bills: [{ id: st.b1, pay: '645.50' }] }));
    assert.equal(res.status, 422);
  }, {});
  await step('schedule an awaiting bill is refused', async () => {
    const res = await app.post(`/vtxns/${st.b1}/schedule`, { pay_date: TODAY, account_id: String(A.checking), method: 'ACH' });
    assert.match(await flashError(res), /Approve the bill/);
  }, {});

  await step('approve bill', async () => ok303(await app.post(`/vtxns/${st.b1}/approve`), 'approve'), {});
  assert.equal((await one('SELECT approval_status FROM txn WHERE txn_id = $1', [st.b1])).approval_status, 'approved');
  assert.match(await (await app.get(`/pay-bills?vendor=${st.supply}`)).text(), new RegExp(`name="pay_${st.b1}"`));

  const r = await step('bill to reject', async () => vtxnId(await app.post('/vtxns', doc({ vendor: st.supply, doc_number: 'TS-R1', cats: [{ account: A.utilities, amount: '90.00' }] }))),
    { accounts: { [A.utilities]: 9000, ap: -9000 }, vendors: { [st.supply]: 9000 }, net: -9000 });
  st.rejected = r.out;
  await step('reject bill', async () => {
    const res = await app.post(`/vtxns/${st.rejected}/reject`, { reason: 'Not our meter' });
    assert.equal(await flashError(res), '');
  }, {});
  assert.equal((await one('SELECT approval_status FROM txn WHERE txn_id = $1', [st.rejected])).approval_status, 'rejected');
  await t.expectHistory(st.rejected);
  await step('void the rejected bill', async () => assert.equal(await flashError(await app.post(`/vtxns/${st.rejected}/void`)), ''),
    { accounts: { [A.utilities]: -9000, ap: 9000 }, vendors: { [st.supply]: -9000 }, net: 9000 });

  // From here on bills don't need approval (Settings → Bills).
  await step('turn bill approval off', async () => ok303(await app.post('/settings/bills', { nextCheckNumber: '1001' }), 'settings'), {});
});

// ---------------------------------------------------------------- 4. pay bills
test('4. pay bills: full by check, partial by ACH, several at once, print, edit, void, delete', async () => {
  // Bill TS-100 is 645.50 (450 + 75.50 + 120).
  let r = await step('pay a bill in full by check (to print)', async () => {
    const res = await app.post('/pay-bills', payForm({ method: 'Check', then: 'print', bills: [{ id: st.b1, pay: '645.50' }] }));
    await ok303(res, 'pay');
    assert.equal(res.headers.get('location'), '/checks');
    return latestPayment(st.supply);
  }, { accounts: { [A.checking]: -64550, ap: 64550 }, vendors: { [st.supply]: -64550 }, net: 0, cash: -64550 }, { watch: [st.supply] });
  st.p1 = r.out;
  await t.expectHistory(st.p1);
  assert.equal((await one('SELECT open_cents FROM txn WHERE txn_id = $1', [st.b1])).open_cents, 0);

  r = await step('partial payment by ACH', async () => {
    const res = await app.post('/pay-bills', payForm({ method: 'ACH', bills: [{ id: st.openingBill, pay: '500.00' }] }));
    await ok303(res, 'partial');
    return vtxnId(res);
  }, { accounts: { [A.checking]: -50000, ap: 50000 }, vendors: { [st.hauling]: -50000 }, net: 0, cash: 0 }, { watch: [st.hauling] });
  st.p2 = r.out;
  await t.expectHistory(st.p2);
  assert.equal((await one('SELECT open_cents FROM txn WHERE txn_id = $1', [st.openingBill])).open_cents, 75000);

  r = await step('another Supply bill', async () => vtxnId(await app.post('/vtxns', doc({ vendor: st.supply, doc_number: 'TS-102', cats: [{ account: A.office, amount: '210.00' }] }))),
    { accounts: { [A.office]: 21000, ap: -21000 }, vendors: { [st.supply]: 21000 }, net: -21000 });
  st.b3 = r.out;
  r = await step('another Hauling bill', async () => vtxnId(await app.post('/vtxns', doc({ vendor: st.hauling, doc_number: 'TH-7', cats: [{ account: A.freight_in, amount: '330.00' }] }))),
    { accounts: { [A.freight_in]: 33000, ap: -33000 }, vendors: { [st.hauling]: 33000 }, net: -33000 });
  st.h2 = r.out;
  assert.equal((await one('SELECT approval_status FROM txn WHERE txn_id = $1', [st.h2])).approval_status, 'approved', 'approval is off');

  // Three bills, two vendors, one go: two checks, 5001 and 5002. 210 + (250 + 330) = 790.
  await step('pay several bills at once by check', async () => {
    const res = await app.post('/pay-bills', payForm({ method: 'Check', checkNo: '5001', bills: [{ id: st.b3, pay: '210.00' }, { id: st.openingBill, pay: '250.00' }, { id: st.h2, pay: '330.00' }] }));
    await ok303(res, 'pay several');
  }, { accounts: { [A.checking]: -79000, ap: 79000 }, vendors: { [st.supply]: -21000, [st.hauling]: -58000 }, net: 0, cash: -54000 }, { watch: [st.supply, st.hauling] });
  const checks = await q(`SELECT txn_id, vendor_id, doc_number, total_cents FROM txn WHERE type = 'bill_payment' AND doc_number IN ('5001', '5002') ORDER BY doc_number`);
  assert.equal(checks.length, 2, 'one check per vendor');
  st.p3supply = checks.find(c => c.vendor_id === st.supply).txn_id;
  st.p3hauling = checks.find(c => c.vendor_id === st.hauling).txn_id;
  assert.deepEqual(checks.map(c => [c.vendor_id, c.total_cents]).sort((x, y) => x[1] - y[1]), [[st.supply, 21000], [st.hauling, 58000]]);
  for (const c of checks) await t.expectHistory(c.txn_id);

  // Printing moves no money.
  const toPrint = await (await app.get('/checks')).text();
  assert.match(toPrint, />5001</);
  await step('mark checks printed', async () => {
    const p = new URLSearchParams();
    for (const c of checks) p.append('ids', String(c.txn_id));
    p.append('ids', String(st.p1));
    await ok303(await app.post('/checks/printed', p), 'printed');
  }, {});
  const after = await (await app.get('/checks')).text();
  assert.doesNotMatch(after, />5001</);
  assert.equal((await one('SELECT count(*)::int AS n FROM txn WHERE txn_id = ANY($1) AND printed_at IS NOT NULL', [[...checks.map(c => c.txn_id), st.p1]])).n, 3);

  // Editing a payment's date and memo: nothing moves today; the ledger follows the new date.
  await step('edit bill payment date and memo', async () => {
    await ok303(await app.post(`/vtxns/${st.p2}`, { txn_date: '2026-10-10', doc_number: '', memo: 'ACH 7731' }), 'edit payment');
  }, {});
  assert.equal((await one('SELECT count(*)::int AS n FROM posting WHERE txn_id = $1 AND txn_date <> $2', [st.p2, '2026-10-10'])).n, 0);
  await t.expectHistory(st.p2);

  // Void the first check: the bill reopens, the bank gets the money back.
  await step('void bill payment', async () => assert.equal(await flashError(await app.post(`/vtxns/${st.p1}/void`)), ''),
    { accounts: { [A.checking]: 64550, ap: -64550 }, vendors: { [st.supply]: 64550 }, net: 0, cash: 64550 }, { watch: [st.supply] });
  assert.equal((await one('SELECT open_cents FROM txn WHERE txn_id = $1', [st.b1])).open_cents, 64550);
  await t.expectHistory(st.p1);

  await step('delete bill payment', async () => {
    const res = await app.post(`/vtxns/${st.p3supply}/delete`);
    assert.equal(res.headers.get('location'), `/vendors/${st.supply}`, await flashError(res));
  }, { accounts: { [A.checking]: 21000, ap: -21000 }, vendors: { [st.supply]: 21000 }, net: 0, cash: 21000 }, { watch: [st.supply] });
  assert.equal((await one('SELECT open_cents FROM txn WHERE txn_id = $1', [st.b3])).open_cents, 21000);
});

// ---------------------------------------------------------------- 5. scheduled payment
test('5. scheduled bill payment paid by the daily job', async () => {
  let r = await step('bill to schedule', async () => vtxnId(await app.post('/vtxns', doc({ vendor: st.supply, doc_number: 'TS-103', cats: [{ account: A.utilities, amount: '123.45' }] }))),
    { accounts: { [A.utilities]: 12345, ap: -12345 }, vendors: { [st.supply]: 12345 }, net: -12345 });
  st.s1 = r.out;
  await step('schedule payment', async () => {
    assert.equal(await flashError(await app.post(`/vtxns/${st.s1}/schedule`, { pay_date: TODAY, account_id: String(A.checking), method: 'ACH' })), '');
  }, {});
  assert.equal((await one('SELECT scheduled_pay_date FROM txn WHERE txn_id = $1', [st.s1])).scheduled_pay_date, TODAY);
  r = await step('daily job pays it', async () => {
    const out = await runScheduledPayments(app.db.pool, { orgId: app.ids.orgId, entityId: app.ids.entityId, today: TODAY });
    assert.deepEqual(out, { paid: 1, failed: 0 });
    return latestPayment(st.supply);
  }, { accounts: { [A.checking]: -12345, ap: 12345 }, vendors: { [st.supply]: -12345 }, net: 0, cash: -12345 }, { watch: [st.supply] });
  st.s1pay = r.out;
  assert.deepEqual(await one('SELECT open_cents, scheduled_pay_date FROM txn WHERE txn_id = $1', [st.s1]), { open_cents: 0, scheduled_pay_date: null });
  await t.expectHistory(st.s1pay);
});

// ---------------------------------------------------------------- 6. expenses and checks
test('6. expense (card) and check (bank) with category and product lines; void; delete', async () => {
  // Card: Fuel 82.40 + 1 tub @ 60.00 = 142.40. The card (a liability) is credited.
  let r = await step('expense on the credit card', async () => {
    const res = await app.post('/vtxns', doc({ type: 'expense', vendor: st.supply, account_id: String(A.card), payment_method: 'Credit card',
      cats: [{ account: A.fuel, amount: '82.40' }], items: [{ item: I.tub, qty: '1', rate: '60.00' }] }));
    await ok303(res, 'expense');
    return vtxnId(res);
  }, { accounts: { [A.card]: -14240, [A.fuel]: 8240, cogs: 6000 }, net: -14240, cash: -14240 });
  st.e1 = r.out;
  await t.expectHistory(st.e1);

  r = await step('check from checking', async () => {
    const res = await app.post('/vtxns', doc({ type: 'check', vendor: st.hauling, account_id: String(A.checking),
      cats: [{ account: A.rent, amount: '1000.00' }], items: [{ item: I.tub, qty: '3', rate: '50.00' }] }));
    await ok303(res, 'check');
    return vtxnId(res);
  }, { accounts: { [A.checking]: -115000, [A.rent]: 100000, cogs: 15000 }, net: -115000 });
  st.c1 = r.out;
  await t.expectHistory(st.c1);
  assert.match((await one('SELECT doc_number FROM txn WHERE txn_id = $1', [st.c1])).doc_number, /^\d+$/);

  await step('void expense', async () => assert.equal(await flashError(await app.post(`/vtxns/${st.e1}/void`)), ''),
    { accounts: { [A.card]: 14240, [A.fuel]: -8240, cogs: -6000 }, net: 14240 });
  await t.expectHistory(st.e1);
  await step('delete check', async () => {
    const res = await app.post(`/vtxns/${st.c1}/delete`);
    assert.equal(res.headers.get('location'), `/vendors/${st.hauling}`, await flashError(res));
  }, { accounts: { [A.checking]: 115000, [A.rent]: -100000, cogs: -15000 }, net: 115000 });
});

// ---------------------------------------------------------------- 7. vendor credit
test('7. vendor credit applied in Pay bills; void the credit', async () => {
  const start = await t.snapshot();
  // Credit $100 office: Dr A/P 10000, Cr Office 10000.
  let r = await step('vendor credit', async () => {
    const res = await app.post('/vtxns', doc({ type: 'vendor_credit', vendor: st.supply, doc_number: 'TS-CR1', cats: [{ account: A.office, amount: '100.00' }] }));
    await ok303(res, 'credit');
    return vtxnId(res);
  }, { accounts: { ap: 10000, [A.office]: -10000 }, vendors: { [st.supply]: -10000 }, net: 10000 }, { watch: [st.supply] });
  st.vc = r.out;
  await t.expectHistory(st.vc);

  // TS-100 has 645.50 open: 100 from the credit, 545.50 by ACH.
  r = await step('pay bill with credit applied', async () => {
    const res = await app.post('/pay-bills', payForm({ method: 'ACH', bills: [{ id: st.b1, pay: '545.50', credit: '100.00' }] }));
    await ok303(res, 'pay with credit');
    return vtxnId(res);
  }, { accounts: { [A.checking]: -54550, ap: 54550 }, vendors: { [st.supply]: -54550 }, net: 0 }, { watch: [st.supply] });
  st.p4 = r.out;
  await t.expectHistory(st.p4);
  assert.deepEqual((await q('SELECT txn_id, open_cents FROM txn WHERE txn_id = ANY($1) ORDER BY txn_id', [[st.b1, st.vc]])).map(x => x.open_cents), [0, 0]);

  // Voiding the used credit: A/P back up, the office expense back, and the bill owes the 100 again.
  await step('void vendor credit', async () => assert.equal(await flashError(await app.post(`/vtxns/${st.vc}/void`)), ''),
    { accounts: { ap: -10000, [A.office]: 10000 }, vendors: { [st.supply]: 10000 }, net: -10000 }, { watch: [st.supply] });
  assert.equal((await one('SELECT open_cents FROM txn WHERE txn_id = $1', [st.b1])).open_cents, 10000);
  await t.expectHistory(st.vc);
  // Cash basis, over the whole test: the only money spent was the 545.50 ACH, all of it on the bill's expenses.
  assert.equal(netOf(await t.snapshot(), 'cash') - netOf(start, 'cash'), -54550, 'cash-basis net income after credit, payment and void');
});

// ---------------------------------------------------------------- 8. purchase orders and receipts
test('8. purchase order; partial item receipt; receipt → bill; close/reopen; bill the rest', async () => {
  const salt0 = await one('SELECT qty_on_hand::float AS qty, value_cents FROM item WHERE item_id = $1', [I.salt]);
  let r = await step('purchase order (no postings)', async () => {
    const res = await app.post('/vtxns', doc({ type: 'purchase_order', vendor: st.supply, due_date: '2026-10-20', items: [{ item: I.salt, qty: '50', rate: '6.00' }] }));
    await ok303(res, 'po');
    return vtxnId(res);
  }, {});
  st.po = r.out;
  assert.equal(r.b.counts.postings, r.a.counts.postings, 'a purchase order posts nothing');
  assert.equal((await one('SELECT open_cents FROM txn WHERE txn_id = $1', [st.po])).open_cents, 30000);
  await t.expectHistory(st.po);

  // 30 of 50 received at $6: Dr Inventory 18000, Cr A/P 18000.
  r = await step('item receipt from the PO (partial)', async () => {
    const form = await (await app.get(`/vtxns/new?type=item_receipt&from_po=${st.po}`)).text();
    assert.match(form, new RegExp(`name="item_po" value="${st.po}:1"`));
    const res = await app.post('/vtxns', doc({ type: 'item_receipt', vendor: st.supply, doc_number: 'TS-PL-1', items: [{ item: I.salt, qty: '30', rate: '6.00', po: `${st.po}:1` }] }));
    await ok303(res, 'receipt');
    return vtxnId(res);
  }, { accounts: { inventory: 18000, ap: -18000 }, vendors: { [st.supply]: 18000 }, net: 0, cash: 0 }, { watch: [st.supply] });
  st.receipt = r.out;
  await t.expectHistory(st.receipt);
  assert.equal((await one('SELECT open_cents FROM txn WHERE txn_id = $1', [st.po])).open_cents, 12000, '20 × $6 still to come');
  assert.deepEqual(await one('SELECT qty_on_hand::float AS qty, value_cents FROM item WHERE item_id = $1', [I.salt]), { qty: salt0.qty + 30, value_cents: salt0.value_cents + 18000 });

  await step('convert receipt to bill', async () => {
    assert.equal(await flashError(await app.post(`/vtxns/${st.receipt}/convert`, { txn_date: TODAY, doc_number: 'TS-104' })), '');
  }, {}, { watch: [st.supply] });
  assert.equal((await one('SELECT type FROM txn WHERE txn_id = $1', [st.receipt])).type, 'bill');
  await t.expectHistory(st.receipt);

  await step('close PO', async () => assert.equal(await flashError(await app.post(`/vtxns/${st.po}/close`)), ''), {});
  assert.equal((await one('SELECT open_cents FROM txn WHERE txn_id = $1', [st.po])).open_cents, 0);
  await step('reopen PO', async () => assert.equal(await flashError(await app.post(`/vtxns/${st.po}/reopen`)), ''), {});
  assert.equal((await one('SELECT open_cents FROM txn WHERE txn_id = $1', [st.po])).open_cents, 12000);

  r = await step('bill the rest of the PO', async () => {
    const res = await app.post('/vtxns', doc({ vendor: st.supply, doc_number: 'TS-105', items: [{ item: I.salt, qty: '20', rate: '6.00', po: `${st.po}:1` }] }));
    await ok303(res, 'rest');
    return vtxnId(res);
  }, { accounts: { inventory: 12000, ap: -12000 }, vendors: { [st.supply]: 12000 }, net: 0 }, { watch: [st.supply] });
  await t.expectHistory(r.out);
  assert.equal((await one('SELECT open_cents FROM txn WHERE txn_id = $1', [st.po])).open_cents, 0, 'fully received');
  assert.match(await (await app.get(`/vtxns/${st.po}`)).text(), /Closed/);
});

// ---------------------------------------------------------------- 9. inventory
test('9. inventory: buy, sell at average cost, adjust, back-dated purchase re-costs', async () => {
  const spray = I.flyspray;
  const item = async () => one('SELECT qty_on_hand::float AS qty, value_cents FROM item WHERE item_id = $1', [spray]);
  // Seeded: 40 opening @ $18.00 (7/14) and 24 received @ $18.50 (10/10).
  const opening = { in: 40, value: 72000 }, received = { in: 24, value: 44400 };
  assert.deepEqual(await item(), { qty: 64, value_cents: 116400 });
  const invAccount = s => s.accounts.get(sys.inventory) ?? 0;
  const valuation = s => s.inv.rows.find(x => x.kind === 'total').cells.value;

  const bought = { in: 10, value: 20000 };
  let r = await step('buy stock on a bill', async () => vtxnId(await app.post('/vtxns', doc({ vendor: st.supply, doc_number: 'TS-106', items: [{ item: spray, qty: '10', rate: '20.00' }] }))),
    { accounts: { inventory: 20000, ap: -20000 }, vendors: { [st.supply]: 20000 }, net: 0 });
  await t.expectHistory(r.out);
  assert.deepEqual(await item(), { qty: 74, value_cents: 136400 });

  // Sell 10 @ 34.99 to Hilltop: income at price, cost at the running average.
  const m1 = avgCost([opening, received, bought, { out: 10 }]);
  const sale1 = -m1.costs[3];
  r = await step('sell stock on an invoice', async () => {
    const p = new URLSearchParams({ type: 'invoice', customer_id: String(C.hilltop), txn_date: TODAY, after_save: 'none' });
    p.append('line_item', String(spray)); p.append('line_desc', ''); p.append('line_qty', '10'); p.append('line_rate', '34.99');
    p.append('line_service', ''); p.append('line_est', ''); p.append('line_bill', ''); p.append('line_class', '');
    await ok303(await app.post('/txns', p), 'invoice');
    return (await one(`SELECT txn_id FROM txn WHERE customer_id = $1 AND type = 'invoice' ORDER BY txn_id DESC LIMIT 1`, [C.hilltop])).txn_id;
  }, { accounts: { ar: 34990, [A.feed_sales]: -34990, cogs: sale1, inventory: -sale1 }, customers: { [C.hilltop]: 34990 }, net: 34990 - sale1 });
  st.sale = r.out;
  await t.expectHistory(st.sale);
  assert.deepEqual(await item(), { qty: m1.qty, value_cents: m1.value });

  // Count finds 60 (4 short). Same day, the adjustment counts before the sale (stock in, adjustments, then sales).
  const m2 = avgCost([opening, received, bought, { out: 4 }, { out: 10 }]);
  const shrink = -m2.costs[3], sale2 = -m2.costs[4];
  r = await step('quantity adjustment', async () => {
    await ok303(await app.post(`/settings/items/${spray}/adjust`, { txn_date: TODAY, newQty: '60', accountId: '', memo: 'Count' }), 'adjust');
    return (await one(`SELECT txn_id FROM txn WHERE type = 'inventory_adjustment' ORDER BY txn_id DESC LIMIT 1`)).txn_id;
  }, { accounts: { shrinkage: shrink, cogs: sale2 - sale1, inventory: -shrink - (sale2 - sale1) }, net: -shrink - (sale2 - sale1) });
  await t.expectHistory(r.out, { activity: false });
  assert.deepEqual(await item(), { qty: 60, value_cents: m2.value });

  // A purchase dated 10/1 (20 @ $15) lowers the average every later move used.
  const early = { in: 20, value: 30000 };
  const m3 = avgCost([opening, early, received, bought, { out: 4 }, { out: 10 }]);
  const shrink3 = -m3.costs[4], sale3 = -m3.costs[5];
  r = await step('back-dated purchase re-costs later moves', async () =>
    vtxnId(await app.post('/vtxns', doc({ vendor: st.supply, date: '2026-10-01', doc_number: 'TS-107', items: [{ item: spray, qty: '20', rate: '15.00' }] }))),
  { accounts: { ap: -30000, shrinkage: shrink3 - shrink, cogs: sale3 - sale2, inventory: 30000 - (shrink3 - shrink) - (sale3 - sale2) },
    vendors: { [st.supply]: 30000 }, net: -(shrink3 - shrink) - (sale3 - sale2) });
  await t.expectHistory(r.out);
  assert.deepEqual(await item(), { qty: m3.qty, value_cents: m3.value });
  assert.equal((await one('SELECT cost_cents FROM txn_line WHERE txn_id = $1', [st.sale])).cost_cents, -sale3, 'the sale is re-costed');
  // Inventory Valuation Summary = the Inventory Asset account.
  assert.equal(valuation(r.b), invAccount(r.b), 'inventory valuation = Inventory Asset account');
  const line = r.b.inv.rows.find(x => x.kind === 'line' && /Fly Spray/.test(JSON.stringify(x.cells)));
  assert.equal(line?.cells.value, m3.value, 'valuation line for Fly Spray');
});

// ---------------------------------------------------------------- 10. billable expense
test('10. billable expense re-billed to the customer', async () => {
  await step('turn on billable expenses', async () => ok303(await app.post('/settings/accounting', { fiscalStartMonth: '1', method: 'accrual', dateFormat: 'mdy',
    showAccountNumbers: '1', classesOn: '', classMode: 'txn', locationsOn: '', locationLabel: 'Location', billableOn: '1', billableMarkup: '10',
    billableIncomeAccountId: String(A.delivery_income), autoApplyCustomer: '', autoApplyVendor: '', warnDuplicateBills: '1' }), 'settings'), {});
  const cust = C.redriver;
  let r = await step('billable expense', async () => {
    const res = await app.post('/vtxns', doc({ type: 'expense', vendor: st.supply, account_id: String(A.checking), payment_method: 'Debit card',
      cats: [{ account: A.repairs, amount: '200.00', desc: 'Gate hinge', billable: true, job: `c:${cust}` }] }));
    await ok303(res, 'billable expense');
    return vtxnId(res);
  }, { accounts: { [A.checking]: -20000, [A.repairs]: 20000 }, net: -20000, cash: -20000 });
  st.billable = r.out;
  await t.expectHistory(st.billable);
  const editor = await (await app.get(`/txns/new?type=invoice&customer=${cust}&billable=1`)).text();
  assert.match(editor, new RegExp(`name="line_bill" value="${st.billable}:1"`));
  assert.match(editor, /name="line_rate" value="220.00"/, '200 + 10% markup');

  // Re-billed: Dr A/R 22000, Cr the billable-expense income account 22000.
  r = await step('invoice the billable expense', async () => {
    const p = new URLSearchParams({ type: 'invoice', customer_id: String(cust), txn_date: TODAY, after_save: 'none' });
    p.append('line_item', ''); p.append('line_desc', 'Gate hinge'); p.append('line_qty', '1'); p.append('line_rate', '220.00');
    p.append('line_service', ''); p.append('line_est', ''); p.append('line_bill', `${st.billable}:1`); p.append('line_class', '');
    await ok303(await app.post('/txns', p), 'invoice');
    return (await one(`SELECT txn_id FROM txn WHERE customer_id = $1 AND type = 'invoice' ORDER BY txn_id DESC LIMIT 1`, [cust])).txn_id;
  }, { accounts: { ar: 22000, [A.delivery_income]: -22000 }, customers: { [cust]: 22000 }, net: 22000, cash: 0 });
  await t.expectHistory(r.out);
  const unbilled = await t.run('unbilled_charges', { period: 'today' });
  assert.ok(!JSON.stringify(unbilled.rows).includes('Gate hinge'), 'no longer unbilled');
});

// ---------------------------------------------------------------- 11. recurring bill
test('11. recurring bill template run by the daily job', async () => {
  const p = new URLSearchParams({ name: 'Monthly alarm', txnType: 'bill', mode: 'scheduled', unit: 'month', count: '1', startDate: TODAY, endDate: '', termsId: '', accountId: '', memo: '' });
  p.append('cat_account', String(A.utilities)); p.append('cat_desc', 'Alarm monitoring'); p.append('cat_amount', '55.00'); p.append('cat_job', ''); p.append('cat_po', '');
  p.append('cat_billable', ''); p.append('cat_class', '');
  await step('save recurring template', async () => ok303(await app.post(`/vendors/${st.supply}/recurring`, p), 'template'), {});
  const r = await step('daily job creates the bill', async () => {
    const runs = await runRecurring(app.db.pool, { orgId: app.ids.orgId, entityId: app.ids.entityId, today: TODAY });
    assert.equal(runs.filter(x => x.outcome === 'created').length, 1);
    return runs.find(x => x.outcome === 'created').txnId;
  }, { accounts: { [A.utilities]: 5500, ap: -5500 }, vendors: { [st.supply]: 5500 }, net: -5500, cash: 0 }, { watch: [st.supply] });
  await t.expectHistory(r.out);
  await step('running again makes nothing', async () => {
    const runs = await runRecurring(app.db.pool, { orgId: app.ids.orgId, entityId: app.ids.entityId, today: TODAY });
    assert.equal(runs.length, 0);
  }, {});
});

// ---------------------------------------------------------------- 12. 1099
test('12. 1099: page, CSV and report equal what was paid from bank accounts to 1099 vendors', async () => {
  // Supply (1099 on since the edit): scheduled ACH 123.45 + ACH 545.50 + billable expense 200 (debit card from checking).
  // The card expense was voided, check 5001 deleted, the first check voided.
  // Hauling: ACH 500 + check 5002 for 580; the rent check was deleted.
  const want = { [st.supply]: 12345 + 54550 + 20000, [st.hauling]: 50000 + 58000 };
  // Every tracked vendor, by a different road: credits to bank accounts from their payments, checks and expenses this year.
  const byLedger = new Map((await q(
    `SELECT t.vendor_id, -sum(p.amount_cents)::bigint AS paid FROM posting p JOIN account a ON a.account_id = p.account_id AND a.type = 'bank'
       JOIN txn t ON t.txn_id = p.txn_id JOIN vendor v ON v.vendor_id = t.vendor_id AND v.track_1099
      WHERE t.org_id = $1 AND t.type IN ('bill_payment', 'check', 'expense') AND p.txn_date BETWEEN '2026-01-01' AND '2026-12-31' GROUP BY t.vendor_id`,
    [app.ids.orgId])).map(x => [x.vendor_id, Number(x.paid)]));
  for (const [v, c] of Object.entries(want)) assert.equal(byLedger.get(Number(v)), c, `ledger 1099 for vendor ${v}`);

  const csv = await (await app.get('/vendors/1099.csv?year=2026')).text();
  const rows = parseCsv(csv).slice(1);
  const names = new Map((await q('SELECT vendor_id, display_name FROM vendor WHERE track_1099 AND org_id = $1', [app.ids.orgId])).map(x => [x.display_name, x.vendor_id]));
  const csvBy = new Map(rows.map(x => [names.get(x[0]), Math.round(Number(x[4]) * 100)]));
  for (const [v, c] of byLedger) assert.equal(csvBy.get(v), c, `1099 CSV for vendor ${v}`);
  assert.equal(csvBy.get(st.supply), want[st.supply]);
  const page = await (await app.get('/vendors/1099?year=2026')).text();
  assert.match(page, new RegExp(money(want[st.supply]).replace(/[$.]/g, '\\$&')));
  assert.match(page, new RegExp(money(want[st.hauling]).replace(/[$.]/g, '\\$&')));

  const rep = await t.run('contractor_1099_summary', { period: 'custom', from: '2026-01-01', to: '2026-12-31' });
  const repBy = new Map(rep.rows.filter(x => x.kind === 'line').map(x => [Number(x.partyId), x.cells.amount]));
  for (const [v, c] of byLedger) assert.equal(repBy.get(v), c, `1099 report for vendor ${v}`);
});

// ---------------------------------------------------------------- 13. multicurrency
test('13. foreign-currency bill paid at another rate: realized exchange gain', async () => {
  await step('turn on multicurrency, add EUR', async () => {
    await ok303(await app.post('/settings/currencies/on'), 'mc on');
    await ok303(await app.post('/settings/currencies', { code: 'EUR', rate: '1.10', date: '2026-10-01' }), 'eur');
  }, {});
  let r = await step('EUR vendor', async () => vendorId(await app.post('/vendors', { displayName: 'Rotterdam Seeds', currency: 'EUR' })), {});
  st.eur = r.out;
  // EUR 200 at 1.10 = $220: Dr Feed Purchases 22000, Cr A/P 22000.
  r = await step('EUR bill', async () => {
    const res = await app.post('/vtxns', doc({ vendor: st.eur, doc_number: 'RS-1', exchange_rate: '1.10', cats: [{ account: A.feed_purchases, amount: '200.00' }] }));
    await ok303(res, 'eur bill');
    return vtxnId(res);
  }, out => ({ accounts: { [A.feed_purchases]: 22000, ap: -22000 }, vendors: { [st.eur]: 22000 }, net: -22000 }), { watch: [] });
  st.eurBill = r.out;
  await t.expectHistory(st.eurBill);
  // Paid EUR 200 at 1.00 = $200 from the bank; A/P relieved at the bill's $220; $20 realized gain (a credit).
  r = await step('pay EUR bill at another rate', async () => {
    const p = payForm({ method: 'Other', bills: [{ id: st.eurBill, pay: '200.00' }] });
    p.set('rate_EUR', '1.00');
    const res = await app.post('/pay-bills', p);
    await ok303(res, 'eur pay');
    return vtxnId(res);
  }, { accounts: { ap: 22000, [A.checking]: -20000, fx_gain_loss: -2000 }, vendors: { [st.eur]: -22000 }, net: 2000, cash: -20000 });
  await t.expectHistory(r.out);
  const realized = await t.run('realized_gains_losses', { period: 'this_year_to_date' });
  assert.match(JSON.stringify(realized.rows), /20(00|\.00)/, 'realized gain shows on its report');
});

// ---------------------------------------------------------------- 14. batch actions
test('14. batch: make vendors inactive; delete vendor transactions', async () => {
  await step('batch make inactive', async () => {
    const p = new URLSearchParams({ action: 'inactive' });
    p.append('ids', String(st.supply)); p.append('ids', String(st.hauling));
    await ok303(await app.post('/vendors/batch', p), 'batch inactive');
  }, {}, { watch: [st.supply, st.hauling] });
  assert.equal((await one('SELECT count(*)::int AS n FROM vendor WHERE vendor_id = ANY($1) AND NOT active', [[st.supply, st.hauling]])).n, 2);
  await step('make them active again', async () => {
    for (const v of [st.supply, st.hauling]) await ok303(await app.post(`/vendors/${v}/active`), 'active');
  }, {});

  const x = (await step('bill x', async () => vtxnId(await app.post('/vtxns', doc({ vendor: st.supply, doc_number: 'TS-B1', cats: [{ account: A.office, amount: '10.00' }] }))),
    { accounts: { [A.office]: 1000, ap: -1000 }, vendors: { [st.supply]: 1000 }, net: -1000 })).out;
  const y = (await step('expense y', async () => vtxnId(await app.post('/vtxns', doc({ type: 'expense', vendor: st.supply, account_id: String(A.checking),
    cats: [{ account: A.office, amount: '20.00' }] }))), { accounts: { [A.office]: 2000, [A.checking]: -2000 }, net: -2000, cash: -2000 })).out;
  // TS-100 is paid, so the batch keeps it and says why.
  await step('batch delete (one refused)', async () => {
    const p = new URLSearchParams({ action: 'delete', back: `/vendors/${st.supply}?tab=transactions` });
    for (const id of [x, y, st.b1]) p.append('ids', String(id));
    const res = await app.post('/vtxns/batch', p);
    assert.equal(res.status, 303);
    assert.match(await flashError(res), /2 deleted\..*payments or credits applied/);
  }, { accounts: { [A.office]: -3000, ap: 1000, [A.checking]: 2000 }, vendors: { [st.supply]: -1000 }, net: 3000, cash: 2000 }, { watch: [st.supply] });
  assert.equal((await q('SELECT 1 FROM txn WHERE txn_id = ANY($1)', [[x, y]])).length, 0);
  assert.equal((await q('SELECT 1 FROM txn WHERE txn_id = $1', [st.b1])).length, 1);
});

// ---------------------------------------------------------------- 15. editing documents that others depend on
test('15. edit a partly paid bill, move a bill to another vendor, change and void a PO-linked bill', async () => {
  let r = await step('bill to part-pay', async () => vtxnId(await app.post('/vtxns', doc({ vendor: st.hauling, doc_number: 'TH-8', cats: [{ account: A.repairs, amount: '300.00' }] }))),
    { accounts: { [A.repairs]: 30000, ap: -30000 }, vendors: { [st.hauling]: 30000 }, net: -30000, cash: 0 });
  const part = r.out;
  await step('pay 100 of it', async () => ok303(await app.post('/pay-bills', payForm({ method: 'ACH', bills: [{ id: part, pay: '100.00' }] })), 'part pay'),
    { accounts: { [A.checking]: -10000, ap: 10000 }, vendors: { [st.hauling]: -10000 }, net: 0, cash: -10000 });
  // 300 → 350 with 100 paid: Dr Repairs 5000, Cr A/P 5000; 250 left to pay. Cash spent is still 100.
  await step('edit the part-paid bill up', async () => ok303(await app.post(`/vtxns/${part}`, doc({ vendor: st.hauling, doc_number: 'TH-8', cats: [{ account: A.repairs, amount: '350.00' }] })), 'edit'),
    { accounts: { [A.repairs]: 5000, ap: -5000 }, vendors: { [st.hauling]: 5000 }, net: -5000, cash: 0 }, { watch: [st.hauling] });
  assert.equal((await one('SELECT open_cents FROM txn WHERE txn_id = $1', [part])).open_cents, 25000);
  await t.expectHistory(part);

  // An unpaid bill moved to another vendor: only the two vendor balances move.
  r = await step('bill for the wrong vendor', async () => vtxnId(await app.post('/vtxns', doc({ vendor: st.supply, doc_number: 'X-1', cats: [{ account: A.office, amount: '40.00' }] }))),
    { accounts: { [A.office]: 4000, ap: -4000 }, vendors: { [st.supply]: 4000 }, net: -4000 });
  const moved = r.out;
  await step('change the bill’s vendor', async () => ok303(await app.post(`/vtxns/${moved}`, doc({ vendor: st.hauling, doc_number: 'X-1', cats: [{ account: A.office, amount: '40.00' }] })), 'move'),
    { vendors: { [st.supply]: -4000, [st.hauling]: 4000 } }, { watch: [st.supply, st.hauling] });
  assert.equal((await one('SELECT count(*)::int AS n FROM posting WHERE txn_id = $1 AND vendor_id IS DISTINCT FROM $2', [moved, st.hauling])).n, 0);
  await t.expectHistory(moved);

  // TS-105 received 20 salt from the PO; 15 instead: Cr Inventory 3000, Dr A/P 3000; 5 back on order.
  const ts105 = (await one(`SELECT txn_id FROM txn WHERE vendor_id = $1 AND doc_number = 'TS-105'`, [st.supply])).txn_id;
  await step('edit a PO-linked bill’s quantity', async () => ok303(await app.post(`/vtxns/${ts105}`, doc({ vendor: st.supply, doc_number: 'TS-105',
    items: [{ item: I.salt, qty: '15', rate: '6.00', po: `${st.po}:1` }] })), 'edit po bill'),
  { accounts: { inventory: -3000, ap: 3000 }, vendors: { [st.supply]: -3000 }, net: 0 });
  assert.equal((await one('SELECT open_cents FROM txn WHERE txn_id = $1', [st.po])).open_cents, 3000, '5 × $6 to come');
  await step('void the PO-linked bill', async () => assert.equal(await flashError(await app.post(`/vtxns/${ts105}/void`)), ''),
    { accounts: { inventory: -9000, ap: 9000 }, vendors: { [st.supply]: -9000 }, net: 0 });
  assert.equal((await one('SELECT open_cents FROM txn WHERE txn_id = $1', [st.po])).open_cents, 12000, 'all 20 back on order');
  await t.expectHistory(ts105);
});

// ---------------------------------------------------------------- 16. credit through a payment, then the payment undone
test('16. a payment that used a vendor credit is voided, then deleted: the credit comes back each time', async () => {
  let r = await step('vendor credit 50', async () => vtxnId(await app.post('/vtxns', doc({ type: 'vendor_credit', vendor: st.hauling, doc_number: 'TH-CR1', cats: [{ account: A.repairs, amount: '50.00' }] }))),
    { accounts: { ap: 5000, [A.repairs]: -5000 }, vendors: { [st.hauling]: -5000 }, net: 5000 });
  const vc = r.out;
  r = await step('bill 150', async () => vtxnId(await app.post('/vtxns', doc({ vendor: st.hauling, doc_number: 'TH-9', cats: [{ account: A.repairs, amount: '150.00' }] }))),
    { accounts: { [A.repairs]: 15000, ap: -15000 }, vendors: { [st.hauling]: 15000 }, net: -15000 });
  const bill = r.out;
  const opens = async () => (await q('SELECT txn_id, open_cents FROM txn WHERE txn_id = ANY($1)', [[bill, vc]])).reduce((m, x) => ({ ...m, [x.txn_id]: x.open_cents }), {});
  for (const [how, undo] of [['Check', 'void'], ['ACH', 'delete']]) {
    r = await step(`pay 100 + credit 50 by ${how}`, async () => {
      const res = await app.post('/pay-bills', payForm({ method: how, bills: [{ id: bill, pay: '100.00', credit: '50.00' }] }));
      await ok303(res, 'pay with credit');
      return latestPayment(st.hauling);
    }, { accounts: { [A.checking]: -10000, ap: 10000 }, vendors: { [st.hauling]: -10000 }, net: 0 }, { watch: [st.hauling] });
    assert.deepEqual(await opens(), { [bill]: 0, [vc]: 0 });
    await t.expectHistory(r.out);
    const pay = r.out;
    await step(`${undo} that payment`, async () => {
      const res = await app.post(`/vtxns/${pay}/${undo}`);
      assert.equal(await flashError(res), '');
    }, { accounts: { [A.checking]: 10000, ap: -10000 }, vendors: { [st.hauling]: 10000 }, net: 0 }, { watch: [st.hauling] });
    assert.deepEqual(await opens(), { [bill]: 15000, [vc]: 5000 }, `after ${undo}, the bill and the credit are open again`);
  }
  // Deleting the open credit: A/P and the expense come back.
  await step('delete the credit', async () => assert.equal(await flashError(await app.post(`/vtxns/${vc}/delete`)), ''),
    { accounts: { ap: -5000, [A.repairs]: 5000 }, vendors: { [st.hauling]: 5000 }, net: -5000 });
});

// ---------------------------------------------------------------- 17. inventory returns and re-costing on edit / delete
test('17. inventory: return to vendor, edit a purchase’s cost, delete the back-dated purchase', async () => {
  const spray = I.flyspray;
  const item = async () => one('SELECT qty_on_hand::float AS qty, value_cents FROM item WHERE item_id = $1', [spray]);
  const saleCost = async () => -(await one('SELECT cost_cents FROM txn_line WHERE txn_id = $1', [st.sale])).cost_cents;
  const shrinkCost = async () => -(await one(`SELECT cost_cents FROM txn_line l JOIN txn t ON t.txn_id = l.txn_id WHERE t.type = 'inventory_adjustment' AND l.item_id = $1
    ORDER BY t.txn_id DESC LIMIT 1`, [spray])).cost_cents;
  // Where test 9 left Fly Spray (moves in the app's same-day order: in, adjustments, returns to vendor, sales).
  const opening = { in: 40, value: 72000 }, early = { in: 20, value: 30000 }, received = { in: 24, value: 44400 };
  const avg2 = moves => {
    let qty = 0, value = 0;
    const costs = moves.map(m => {
      if (m.in !== undefined) { qty += m.in; value += m.value; return m.value; }
      if (m.outAt !== undefined) { qty -= m.outAt; value -= m.value; return -m.value; }
      const c = m.out === qty ? value : Math.round((m.out * value) / qty);
      qty -= m.out; value -= c;
      return -c;
    });
    return { costs, qty, value };
  };
  const m0 = avg2([opening, early, received, { in: 10, value: 20000 }, { out: 4 }, { out: 10 }]);
  assert.deepEqual(await item(), { qty: m0.qty, value_cents: m0.value });
  assert.equal(await saleCost(), -m0.costs[5]);

  // Return 2 @ $15.00 to Supply on a vendor credit: Dr A/P 3000, Cr Inventory at the credit amount; the sale re-costs.
  const ret = { outAt: 2, value: 3000 };
  const m1 = avg2([opening, early, received, { in: 10, value: 20000 }, { out: 4 }, ret, { out: 10 }]);
  const dSale1 = -m1.costs[6] - -m0.costs[5], dShrink1 = -m1.costs[4] - -m0.costs[4];
  const r = await step('return stock to the vendor', async () => vtxnId(await app.post('/vtxns', doc({ type: 'vendor_credit', vendor: st.supply, doc_number: 'TS-RET1',
    items: [{ item: spray, qty: '2', rate: '15.00' }] }))),
  { accounts: { ap: 3000, inventory: -3000 - dSale1 - dShrink1, cogs: dSale1, shrinkage: dShrink1 }, vendors: { [st.supply]: -3000 }, net: -dSale1 - dShrink1 });
  await t.expectHistory(r.out);
  assert.deepEqual(await item(), { qty: m1.qty, value_cents: m1.value });
  assert.equal(await saleCost(), -m1.costs[6]);

  // TS-106 was 10 @ $20.00; the real cost was $22.00.
  const ts106 = (await one(`SELECT txn_id FROM txn WHERE vendor_id = $1 AND doc_number = 'TS-106'`, [st.supply])).txn_id;
  const m2 = avg2([opening, early, received, { in: 10, value: 22000 }, { out: 4 }, ret, { out: 10 }]);
  const dSale2 = -m2.costs[6] - -m1.costs[6], dShrink2 = -m2.costs[4] - -m1.costs[4];
  await step('edit a purchase’s cost', async () => ok303(await app.post(`/vtxns/${ts106}`, doc({ vendor: st.supply, doc_number: 'TS-106', items: [{ item: spray, qty: '10', rate: '22.00' }] })), 'edit cost'),
    { accounts: { ap: -2000, inventory: 2000 - dSale2 - dShrink2, cogs: dSale2, shrinkage: dShrink2 }, vendors: { [st.supply]: 2000 }, net: -dSale2 - dShrink2 });
  assert.deepEqual(await item(), { qty: m2.qty, value_cents: m2.value });
  assert.equal(await shrinkCost(), -m2.costs[4]);

  // Delete the back-dated 10/1 purchase (20 @ $15).
  const ts107 = (await one(`SELECT txn_id FROM txn WHERE vendor_id = $1 AND doc_number = 'TS-107'`, [st.supply])).txn_id;
  const m3 = avg2([opening, received, { in: 10, value: 22000 }, { out: 4 }, ret, { out: 10 }]);
  const dSale3 = -m3.costs[5] - -m2.costs[6], dShrink3 = -m3.costs[3] - -m2.costs[4];
  await step('delete the back-dated purchase', async () => {
    const res = await app.post(`/vtxns/${ts107}/delete`);
    assert.equal(res.headers.get('location'), `/vendors/${st.supply}`, await flashError(res));
  }, { accounts: { ap: 30000, inventory: -30000 - dSale3 - dShrink3, cogs: dSale3, shrinkage: dShrink3 }, vendors: { [st.supply]: -30000 }, net: -dSale3 - dShrink3 });
  assert.deepEqual(await item(), { qty: m3.qty, value_cents: m3.value });
  assert.equal(await saleCost(), -m3.costs[5]);
  const s = await t.snapshot();
  assert.equal(s.inv.rows.find(x => x.kind === 'total').cells.value, s.accounts.get(sys.inventory) ?? 0, 'inventory valuation = Inventory Asset account');
});

// ---------------------------------------------------------------- 18. foreign currency: partial payment, void, vendor credit
test('18. EUR: partial payment at another rate, void it, pay at a third rate; EUR credit applied with a payment', async () => {
  let r = await step('EUR bill 100 @ 1.10', async () => vtxnId(await app.post('/vtxns', doc({ vendor: st.eur, doc_number: 'RS-2', exchange_rate: '1.10',
    cats: [{ account: A.feed_purchases, amount: '100.00' }] }))), { accounts: { [A.feed_purchases]: 11000, ap: -11000 }, vendors: { [st.eur]: 11000 }, net: -11000 });
  const bill = r.out;
  const pay = async (eur, rate) => {
    const p = payForm({ method: 'Other', bills: [{ id: bill, pay: eur }] });
    p.set('rate_EUR', rate);
    await ok303(await app.post('/pay-bills', p), 'eur pay');
    return latestPayment(st.eur);
  };
  // EUR 50 at 1.20 = $60 out; A/P relieved at the bill's 1.10 = $55; $5 realized loss (a debit).
  r = await step('pay EUR 50 at 1.20', () => pay('50.00', '1.20'), { accounts: { ap: 5500, [A.checking]: -6000, fx_gain_loss: 500 }, vendors: { [st.eur]: -5500 }, net: -500 });
  const p1 = r.out;
  await t.expectHistory(p1);
  await step('void the EUR payment', async () => assert.equal(await flashError(await app.post(`/vtxns/${p1}/void`)), ''),
    { accounts: { ap: -5500, [A.checking]: 6000, fx_gain_loss: -500 }, vendors: { [st.eur]: 5500 }, net: 500 });
  assert.deepEqual(await one('SELECT open_cents, foreign_open_cents FROM txn WHERE txn_id = $1', [bill]), { open_cents: 11000, foreign_open_cents: 10000 });
  // EUR 100 at 1.05 = $105 out; A/P $110; $5 gain.
  await step('pay EUR 100 at 1.05', () => pay('100.00', '1.05'), { accounts: { ap: 11000, [A.checking]: -10500, fx_gain_loss: -500 }, vendors: { [st.eur]: -11000 }, net: 500 });

  // EUR credit 20 @ 1.10 ($22) and a bill of EUR 60 @ 1.10 ($66): pay EUR 40 at 1.00 plus the credit.
  r = await step('EUR vendor credit 20 @ 1.10', async () => vtxnId(await app.post('/vtxns', doc({ type: 'vendor_credit', vendor: st.eur, doc_number: 'RS-CR1', exchange_rate: '1.10',
    cats: [{ account: A.feed_purchases, amount: '20.00' }] }))), { accounts: { ap: 2200, [A.feed_purchases]: -2200 }, vendors: { [st.eur]: -2200 }, net: 2200 });
  const vc = r.out;
  r = await step('EUR bill 60 @ 1.10', async () => vtxnId(await app.post('/vtxns', doc({ vendor: st.eur, doc_number: 'RS-3', exchange_rate: '1.10',
    cats: [{ account: A.feed_purchases, amount: '60.00' }] }))), { accounts: { [A.feed_purchases]: 6600, ap: -6600 }, vendors: { [st.eur]: 6600 }, net: -6600 });
  const bill3 = r.out;
  // Cash out EUR 40 × 1.00 = $40. The payment's part of the bill is EUR 40 × 1.10 = $44 off A/P: $4 gain. The credit and the bill
  // were both carried at 1.10, so applying the credit moves nothing more. Vendor: −$66 bill + $22 credit used = −$44.
  r = await step('pay EUR 40 at 1.00 plus EUR 20 credit', async () => {
    const p = payForm({ method: 'Other', bills: [{ id: bill3, pay: '40.00', credit: '20.00' }] });
    p.set('rate_EUR', '1.00');
    await ok303(await app.post('/pay-bills', p), 'eur pay with credit');
    return latestPayment(st.eur);
  }, { accounts: { ap: 4400, [A.checking]: -4000, fx_gain_loss: -400 }, vendors: { [st.eur]: -4400 }, net: 400 }, { watch: [st.eur] });
  await t.expectHistory(r.out);
  assert.deepEqual((await q('SELECT open_cents, foreign_open_cents FROM txn WHERE txn_id = ANY($1) ORDER BY txn_id', [[vc, bill3]])).map(x => [x.open_cents, x.foreign_open_cents]),
    [[0, 0], [0, 0]]);
  // Voiding that payment gives back the credit and reopens the whole bill.
  const p3 = r.out;
  await step('void the EUR payment that used the credit', async () => assert.equal(await flashError(await app.post(`/vtxns/${p3}/void`)), ''),
    { accounts: { ap: -4400, [A.checking]: 4000, fx_gain_loss: 400 }, vendors: { [st.eur]: 4400 }, net: -400 }, { watch: [st.eur] });
  assert.deepEqual((await q('SELECT open_cents, foreign_open_cents FROM txn WHERE txn_id = ANY($1) ORDER BY txn_id', [[vc, bill3]])).map(x => [x.open_cents, x.foreign_open_cents]),
    [[2200, 2000], [6600, 6000]]);
});

// ---------------------------------------------------------------- 19. the detail reports agree with the summaries
test('19. A/P detail reports agree with the vendor pages and the A/P account', async () => {
  const s = await t.snapshot();
  t.checkTied(s, 'final');
  const ap = -(s.accounts.get(sys.ap) ?? 0);
  const detail = await t.run('ap_aging_detail', { period: 'today' });
  assert.equal(detail.rows.find(x => x.kind === 'total' && x.grand).cells.open, ap, 'A/P Aging Detail total = A/P account');
  const vbd = await t.run('vendor_balance_detail', { period: 'today' });
  let party = null;
  const totals = new Map();
  for (const x of vbd.rows) {
    if (x.kind === 'section') party = Number(x.partyId);
    if (x.kind === 'total' && !x.grand) totals.set(party, x.cells.open);
  }
  for (const [id, v] of s.vend) assert.equal(totals.get(id) ?? 0, Number(v.open_cents), `Vendor Balance Detail for vendor ${id}`);
  const unpaid = await t.run('unpaid_bills', { period: 'today' });
  const listed = new Map(unpaid.rows.filter(x => x.kind === 'line' && x.txnType === 'bill').map(x => [Number(x.txnId), x.cells.open]));
  const open = await q(`SELECT txn_id, open_cents FROM txn WHERE org_id = $1 AND type = 'bill' AND voided_at IS NULL AND open_cents <> 0`, [app.ids.orgId]);
  for (const b of open) assert.equal(listed.get(b.txn_id), b.open_cents, `Unpaid Bills shows bill ${b.txn_id} with its open amount`);
  assert.equal(listed.size, open.length, 'Unpaid Bills lists only open bills');
  // The vendor list's balances = the vendor pages.
  const list = await (await app.get('/vendors.csv?inactive=1')).text();
  const byName = new Map([...s.vend.values()].map(v => [v.display_name, Number(v.open_cents)]));
  let seen = 0;
  for (const cells of parseCsv(list).slice(1)) {
    // A leading ' is the export's guard against spreadsheet formulas ("-150.00" → "'-150.00").
    const bal = Math.round(Number(cells.at(-3).replace(/^'/, '')) * 100);
    if (byName.has(cells[0])) { assert.equal(bal, byName.get(cells[0]), `vendor list balance for ${cells[0]}`); seen++; }
  }
  assert.equal(seen, s.vend.size, 'every vendor is on the list');
});

// ---------------------------------------------------------------- 20. the books on earlier dates
test('20. on earlier dates too: A/P aging = vendor balances = balance sheet A/P; inventory valuation = Inventory Asset', async () => {
  // A payment dated before the bill it pays (allowed): between the two dates it's money paid ahead.
  let r = await step('bill dated 10/9', async () => vtxnId(await app.post('/vtxns', doc({ vendor: st.supply, date: '2026-10-09', doc_number: 'TS-PB', cats: [{ account: A.office, amount: '70.00' }] }))),
    { accounts: { [A.office]: 7000, ap: -7000 }, vendors: { [st.supply]: 7000 }, net: -7000 });
  const bill = r.out;
  await step('paid with a payment dated 10/6', async () => ok303(await app.post('/pay-bills', payForm({ method: 'ACH', date: '2026-10-06', bills: [{ id: bill, pay: '70.00' }] })), 'early pay'),
    { accounts: { ap: 7000, [A.checking]: -7000 }, vendors: { [st.supply]: -7000 }, net: 0 });
  // A voided bill with a payment scheduled: the job must not pay it.
  r = await step('bill to schedule then void', async () => vtxnId(await app.post('/vtxns', doc({ vendor: st.supply, doc_number: 'TS-SV', cats: [{ account: A.office, amount: '33.00' }] }))),
    { accounts: { [A.office]: 3300, ap: -3300 }, vendors: { [st.supply]: 3300 }, net: -3300 });
  const sv = r.out;
  assert.equal(await flashError(await app.post(`/vtxns/${sv}/schedule`, { pay_date: TODAY, account_id: String(A.checking), method: 'ACH' })), '');
  await step('void the scheduled bill', async () => assert.equal(await flashError(await app.post(`/vtxns/${sv}/void`)), ''),
    { accounts: { [A.office]: -3300, ap: 3300 }, vendors: { [st.supply]: -3300 }, net: 3300 });
  await step('daily job skips the voided bill', async () => {
    const out = await runScheduledPayments(app.db.pool, { orgId: app.ids.orgId, entityId: app.ids.entityId, today: TODAY });
    assert.equal(out.paid, 0);
  }, {});

  const sumParties = rep => rep.rows.filter(x => x.partyId).reduce((s, x) => s + x.values.at(-1), 0);
  const bsLine = (bs, id) => bs.rows.find(x => Number(x.accountId) === id)?.values.at(-1) ?? 0;
  for (const date of ['2026-07-31', '2026-09-30', '2026-10-01', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-09', '2026-10-10', '2026-10-11', TODAY]) {
    const at = { period: 'custom', from: date, to: date };
    const [aging, vbs, bs, inv] = await Promise.all([t.run('ap_aging_summary', at), t.run('vendor_balance_summary', at), t.run('balance_sheet', at),
      t.run('inventory_valuation_summary', at)]);
    // The ledger on that date, straight from the postings.
    const { rows: [l] } = await app.db.pool.query(
      `SELECT coalesce(-sum(amount_cents) FILTER (WHERE account_id = $3), 0)::bigint AS ap, coalesce(sum(amount_cents) FILTER (WHERE account_id = $4), 0)::bigint AS inv
         FROM posting WHERE org_id = $1 AND txn_date <= $2`, [app.ids.orgId, date, sys.ap, sys.inventory]);
    assert.equal(sumParties(aging), Number(l.ap), `${date}: A/P aging = A/P ledger`);
    assert.equal(sumParties(vbs), Number(l.ap), `${date}: vendor balance summary = A/P ledger`);
    assert.equal(bsLine(bs, sys.ap), Number(l.ap), `${date}: balance sheet A/P = A/P ledger`);
    assert.equal(bsLine(bs, sys.inventory), Number(l.inv), `${date}: balance sheet inventory = ledger`);
    assert.equal(inv.rows.find(x => x.kind === 'total')?.cells.value ?? 0, Number(l.inv), `${date}: inventory valuation = Inventory Asset`);
  }
});

// ---------------------------------------------------------------- 21. cash basis and card payments
test('21. cash basis: paying for stock is not an expense; part payments; card payments; unapplied credits', async () => {
  const ts106 = (await one(`SELECT txn_id, open_cents FROM txn WHERE vendor_id = $1 AND doc_number = 'TS-106'`, [st.supply]));
  assert.equal(ts106.open_cents, 22000);
  // Paying a bill for inventory moves cash into stock, not into the P&L (cost comes when the stock is sold).
  await step('pay the stock bill', async () => ok303(await app.post('/pay-bills', payForm({ method: 'ACH', bills: [{ id: ts106.txn_id, pay: '220.00' }] })), 'pay stock'),
    { accounts: { [A.checking]: -22000, ap: 22000 }, vendors: { [st.supply]: -22000 }, net: 0, cash: 0 });
  // TS-100 has 100.00 left (fuel, office and tubs — all P&L): paying it is 100 of expense on the cash basis.
  assert.equal((await one('SELECT open_cents FROM txn WHERE txn_id = $1', [st.b1])).open_cents, 10000);
  await step('pay the rest of a mixed bill', async () => ok303(await app.post('/pay-bills', payForm({ method: 'ACH', bills: [{ id: st.b1, pay: '100.00' }] })), 'pay rest'),
    { accounts: { [A.checking]: -10000, ap: 10000 }, vendors: { [st.supply]: -10000 }, net: 0, cash: -10000 });
  // Paid from the credit card: the card's balance goes up; not a 1099 payment (the card company reports it).
  const ten99 = async () => Number((await one(
    `SELECT coalesce(-sum(p.amount_cents), 0)::bigint AS n FROM posting p JOIN account a ON a.account_id = p.account_id AND a.type = 'bank' JOIN txn t ON t.txn_id = p.txn_id
      WHERE t.vendor_id = $1 AND t.type IN ('bill_payment', 'check', 'expense')`, [st.supply])).n);
  const before1099 = await ten99();
  const rep = async () => (await t.run('contractor_1099_summary', { period: 'custom', from: '2026-01-01', to: '2026-12-31' })).rows.find(x => Number(x.partyId) === st.supply)?.cells.amount;
  const repBefore = await rep();
  assert.equal(repBefore, before1099);
  await step('pay a bill from the credit card', async () => ok303(await app.post('/pay-bills', payForm({ account: A.card, method: 'Credit card', bills: [{ id: st.b3, pay: '210.00' }] })), 'card pay'),
    { accounts: { [A.card]: -21000, ap: 21000 }, vendors: { [st.supply]: -21000 }, net: 0, cash: -21000 });
  assert.equal(await rep(), repBefore, 'a card payment is not on the 1099');
  // A vendor credit nobody has used yet: on the cash basis nothing has happened.
  await step('unapplied vendor credit', async () => ok303(await app.post('/vtxns', doc({ type: 'vendor_credit', vendor: st.hauling, doc_number: 'TH-CR2',
    cats: [{ account: A.repairs, amount: '25.00' }] })), 'credit'),
  { accounts: { ap: 2500, [A.repairs]: -2500 }, vendors: { [st.hauling]: -2500 }, net: 2500, cash: 0 });
});
