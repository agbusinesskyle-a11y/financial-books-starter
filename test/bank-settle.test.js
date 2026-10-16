import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './app-harness.js';
import { freshDb } from './harness.js';
import { tieout } from './tieout.js';
import { buildSampleFeed, writeLedgerlineSample, sampleUuid } from '../lib/bankfeed/sample.js';
import { pullCompany } from '../lib/bankfeed/pull.js';
import { linkCompany, saveMappings } from '../lib/data/bankfeeds.js';
import { writeVendorDoc, approveBills } from '../lib/data/payables.js';
import { addItem, getBankItem } from '../lib/data/banking.js';
import { suggestFor, learnedHistory, categoryHistory } from '../lib/bankfeed/rules.js';
import { saveSalesDoc, savePayment } from '../lib/data/writes.js';
import { withTransaction } from '../lib/db.js';
import { hidden, itemForm, picks } from './bank-forms.js';

// Bank review v2, stage BR-3: a bank line pays open bills or invoices (part payments too), makes up a difference
// with adjustment lines, finds matches by search, and splits with negative lines — each exactly undoable.
let app, llDb, ll, feed, S, A, t;
const actor = 'tester';
const llId = name => feed.accounts.find(a => a.name === name).id;
const pool = () => app.db.pool;

before(async () => {
  llDb = await freshDb({ migrate: false });
  ll = llDb.pool;
  app = await startApp({ ledgerline: ll });
  S = { orgId: app.ids.orgId, entityId: app.ids.entityId };
  A = app.ids.accounts;
  feed = await buildSampleFeed(pool(), { ...S, asOf: '2026-10-12' });
  await writeLedgerlineSample(ll, feed);
  await pool().query('UPDATE org SET ledgerline_org_id = $1 WHERE org_id = $2', [feed.org, app.ids.orgId]);
  await linkCompany(pool(), ll, { ...S, llEntityId: feed.entities[0].id, actor });
  await pullCompany(pool(), ll, S);
  await saveMappings(pool(), { ...S, actor, choices: [
    { id: llId('Operating Checking'), choice: String(A.checking) }, { id: llId('Business Savings'), choice: String(A.savings) },
    { id: llId('Business Card'), choice: String(A.card) }, { id: llId('Equipment Loan'), choice: String(A.equipment_loan) }] });
  await pullCompany(pool(), ll, S);
  t = tieout(app);
});
after(async () => { await app.close(); await llDb.drop(); });

let seq = 0;
async function bankSays(rows) {
  const keys = [];
  for (const r of rows) {
    const key = `settle-${++seq}`;
    keys.push(key);
    await ll.query(`INSERT INTO core.transaction (org_id, transaction_id, account_id, amount, currency, posted_date, pending, description_raw, status, revision, check_number)
      VALUES ($1, $2, $3, $4, 'USD', $5, false, $6, 'active', 1, $7)`, [feed.org, sampleUuid('settle', key), llId(r.account), r.amount, r.date ?? '2026-10-12', r.description, r.check ?? null]);
  }
  await pullCompany(pool(), ll, S);
  const ids = [];
  for (const k of keys) ids.push(Number((await pool().query('SELECT item_id FROM bank_feed_item WHERE ll_transaction_id = $1', [sampleUuid('settle', k)])).rows[0].item_id));
  return ids;
}
const vendors = () => Object.values(app.ids.vendors);
// The sample company approves bills before they're paid.
const bill = async (vendorId, amount, memo) => {
  const id = await withTransaction(pool(), tx => writeVendorDoc(tx, { ...S, actor, type: 'bill', vendorId, txnDate: '2026-10-01', memo,
    categoryLines: [{ accountId: A.office, amount }], itemLines: [] }));
  await approveBills(pool(), { ...S, txnIds: [id], actor });
  return id;
};
const invoice = (customerId, rate) => saveSalesDoc(pool(), { ...S, customerId, type: 'invoice', actor, txnDate: '2026-10-01', dueDate: '2026-10-20',
  lines: [{ description: 'Feed', quantity: '1', rate }] });
const open = async id => Number((await pool().query('SELECT open_cents FROM txn WHERE txn_id = $1', [id])).rows[0].open_cents);
const links = async id => (await pool().query(`SELECT k.how, t.type, t.txn_id FROM bank_feed_link k JOIN txn t ON t.txn_id = k.txn_id WHERE k.item_id = $1 ORDER BY t.txn_id`, [id])).rows;
const state = async id => (await pool().query('SELECT review_state FROM bank_feed_item WHERE item_id = $1', [id])).rows[0].review_state;
// The Match form as the page shows it, with what the person ticks and types.
async function settle(id, { txn = [], waiting = [], pay = {}, adj = [], memo = '' }) {
  const f = await itemForm(app, id);
  const body = new URLSearchParams({ rev: f.rev, memo, cats_v: hidden(f.page, 'cats_v') ?? '' });
  for (const x of txn) { body.append('txn', String(x)); body.set(`ver_${x}`, f.ver(x) ?? ''); }
  for (const x of waiting) { body.append('waiting', String(x)); body.set(`ver_${x}`, f.ver(x) ?? ''); }
  for (const [x, amount] of Object.entries(pay)) { body.append('pay', x); body.set(`ver_${x}`, f.ver(x) ?? ''); body.set(`pay_amt_${x}`, amount); }
  for (const a of adj) { body.append('adj_account', a.account); body.append('adj_amount', a.amount); body.append('adj_description', a.description ?? ''); }
  return { res: await app.post(`/banking/item/${id}/match`, body), form: f };
}
async function undo(id) {
  const f = await itemForm(app, id);
  return app.post(`/banking/item/${id}/undo`, new URLSearchParams({ plan: f.plan }));
}

test('a bank line pays part of an open bill; Undo deletes the payment and the bill is open again', async () => {
  const b = await bill(vendors()[0], '200.00', 'part pay');
  const [id] = await bankSays([{ account: 'Operating Checking', amount: '-150.00', description: 'ACH PART PAY' }]);
  const { form } = await settle(id, {});
  assert.match(form.page, new RegExp(`<input type="checkbox" name="pay" value="${b}"`), 'the open bill is offered');
  const before = await t.snapshot();
  const { res } = await settle(id, { pay: { [b]: '150.00' } });
  assert.equal(res.status, 303);
  assert.equal(await open(b), 5000);
  const after1 = await t.snapshot();
  t.checkTied(after1, 'part pay');
  t.expectChange(before, after1, { accounts: { [A.checking]: -15000, ap: 15000 }, vendors: { [vendors()[0]]: -15000 }, net: 0, label: 'bill payment from the bank line' });
  const l = await links(id);
  assert.deepEqual(l.map(x => [x.how, x.type]), [['added', 'bill_payment']]);
  assert.equal(await state(id), 'added');
  const { rows: [ev] } = await pool().query(`SELECT kind, detail->'plan'->'paid' AS paid FROM bank_review_event WHERE item_id = $1 ORDER BY event_id DESC LIMIT 1`, [id]);
  assert.equal(ev.kind, 'settled');
  assert.deepEqual(ev.paid, [{ txnId: b, cents: 15000 }]);
  // Undo says what happens, then does it.
  const f = await itemForm(app, id);
  assert.match(f.page, /what it paid is open again/);
  assert.equal((await undo(id)).status, 303);
  assert.equal(await open(b), 20000);
  assert.equal((await pool().query('SELECT 1 FROM txn WHERE txn_id = $1', [l[0].txn_id])).rowCount, 0);
  t.expectChange(before, await t.snapshot(), { label: 'undo puts everything back' });
  assert.equal(await state(id), 'new');
});

test('a bill plus a bank fee: the difference goes to an adjustment journal entry; Undo removes both', async () => {
  const b = await bill(vendors()[0], '100.00', 'with fee');
  const [id] = await bankSays([{ account: 'Operating Checking', amount: '-102.50', description: 'WIRE OUT FEE' }]);
  const before = await t.snapshot();
  const { res } = await settle(id, { pay: { [b]: '100.00' }, adj: [{ account: 'Bank Fees', amount: '2.50', description: 'Wire fee' }] });
  assert.equal(res.status, 303);
  const after1 = await t.snapshot();
  t.checkTied(after1, 'bill + fee');
  t.expectChange(before, after1, { accounts: { [A.checking]: -10250, ap: 10000, [A.bank_fees]: 250 }, vendors: { [vendors()[0]]: -10000 }, net: -250, label: 'bill + fee' });
  assert.deepEqual((await links(id)).map(x => x.type).sort(), ['bill_payment', 'journal_entry']);
  await undo(id);
  t.expectChange(before, await t.snapshot(), { label: 'undo bill + fee' });
  assert.equal(await open(b), 10000);
});

test('money in pays an open invoice: a received payment into the bank account; Undo reopens it', async () => {
  const customerId = Object.values(app.ids.customers)[0];
  const inv = await invoice(customerId, '480');
  const [id] = await bankSays([{ account: 'Operating Checking', amount: '480.00', description: 'MOBILE DEPOSIT INV' }]);
  const before = await t.snapshot();
  const { res } = await settle(id, { pay: { [inv]: '480.00' } });
  assert.equal(res.status, 303);
  assert.equal(await open(inv), 0);
  const after1 = await t.snapshot();
  t.checkTied(after1, 'invoice paid');
  t.expectChange(before, after1, { accounts: { [A.checking]: 48000, ar: -48000 }, customers: { [customerId]: -48000 }, net: 0, label: 'invoice paid from the bank line' });
  const [l] = await links(id);
  assert.equal(l.type, 'payment');
  assert.equal(Number((await pool().query('SELECT account_id FROM txn WHERE txn_id = $1', [l.txn_id])).rows[0].account_id), A.checking);
  await undo(id);
  assert.equal(await open(inv), 48000);
  t.expectChange(before, await t.snapshot(), { label: 'undo invoice' });
});

test('a payment waiting in Undeposited Funds less a processor fee: deposit plus adjustment', async () => {
  const customerId = Object.values(app.ids.customers)[0];
  const paid = await savePayment(pool(), { ...S, customerId, txnDate: '2026-10-10', amountCents: 20000, paymentMethod: 'Card', actor, applications: [] });
  const [id] = await bankSays([{ account: 'Operating Checking', amount: '194.20', description: 'CARD SETTLEMENT' }]);
  const before = await t.snapshot();
  const { res, form } = await settle(id, { waiting: [paid], adj: [{ account: 'Bank Fees', amount: '-5.80', description: 'Processor fee' }] });
  assert.match(form.page, new RegExp(`name="waiting" value="${paid}"`), 'the waiting payment is offered');
  assert.equal(res.status, 303);
  assert.doesNotMatch(await (await app.get(`/banking/item/${id}`)).text(), /class="flash error|changed since/);
  const after1 = await t.snapshot();
  t.checkTied(after1, 'deposit less fee');
  t.expectChange(before, after1, { accounts: { [A.checking]: 19420, undeposited: -20000, [A.bank_fees]: 580 }, net: -580, label: 'deposit less fee' });
  assert.equal(await state(id), 'added', 'as Match does for waiting payments alone: the deposit is new');
  await undo(id);
  t.expectChange(before, await t.snapshot(), { label: 'undo deposit less fee' });
});

test('nothing is written when the parts don’t come to the bank amount, a bill changed, or a check would pay two vendors', async () => {
  const [v1, v2] = vendors();
  const b1 = await bill(v1, '60.00', 'mismatch');
  const [id] = await bankSays([{ account: 'Operating Checking', amount: '-75.00', description: 'SHORT' }]);
  const before = await t.snapshot();
  const { res } = await settle(id, { pay: { [b1]: '60.00' } });
  assert.equal(res.status, 422);
  const page = await res.text();
  assert.match(page, /Add an adjustment for the difference of \$15\.00/);
  assert.match(page, new RegExp(`<input type="checkbox" name="pay" value="${b1}" checked>`), 'what was ticked is shown again');
  assert.match(page, new RegExp(`name="pay_amt_${b1}"[^>]*value="60.00"`));
  // More than is open on the bill.
  assert.equal((await settle(id, { pay: { [b1]: '75.00' } })).res.status, 422);
  // The bill changed after the page was shown.
  const f = await itemForm(app, id);
  await withTransaction(pool(), tx => writeVendorDoc(tx, { ...S, actor, type: 'bill', txnId: b1, vendorId: v1, txnDate: '2026-10-01', memo: 'edited',
    categoryLines: [{ accountId: A.office, amount: '75.00' }], itemLines: [] }));
  const body = new URLSearchParams({ rev: f.rev, pay: String(b1), [`ver_${b1}`]: f.ver(b1), [`pay_amt_${b1}`]: '75.00' });
  const stale = await app.post(`/banking/item/${id}/match`, body);
  assert.equal(stale.status, 303);
  assert.match(await (await app.get(`/banking/item/${id}`)).text(), /changed since the page was shown/);
  // Check 5501 paying bills from two vendors.
  const b2 = await bill(v2, '25.00', 'two vendors');
  const [chk] = await bankSays([{ account: 'Operating Checking', amount: '-100.00', description: 'CHECK 5501', check: '5501' }]);
  const two = await settle(chk, { pay: { [b1]: '75.00', [b2]: '25.00' } });
  assert.equal(two.res.status, 422);
  assert.match(await two.res.text(), /Check 5501 pays one vendor/);
  t.expectChange(before, await t.snapshot(), { accounts: { [A.office]: 1500 + 2500, ap: -(1500 + 2500) }, vendors: { [v1]: 1500, [v2]: 2500 }, net: -4000,
    label: 'only the bill edit and the new bill moved anything' });
  assert.equal(await state(id), 'new');
  assert.equal(await state(chk), 'new');
});

test('a check pays one vendor’s bill with the bank’s check number', async () => {
  const b = await bill(vendors()[1], '42.00', 'by check');
  const [id] = await bankSays([{ account: 'Operating Checking', amount: '-42.00', description: 'CHECK 5502', check: '5502' }]);
  assert.equal((await settle(id, { pay: { [b]: '42.00' } })).res.status, 303);
  const [l] = await links(id);
  const { rows: [p] } = await pool().query('SELECT doc_number, payment_method FROM txn WHERE txn_id = $1', [l.txn_id]);
  assert.deepEqual([p.doc_number, p.payment_method], ['5502', 'Check']);
});

test('Find match: search by payee, date range and amount; what another bank line already records is shown, not offered', async () => {
  const vendorId = vendors()[2] ?? vendors()[0];
  const { rows: [v] } = await pool().query('SELECT display_name FROM vendor WHERE vendor_id = $1', [vendorId]);
  const exp = await withTransaction(pool(), tx => writeVendorDoc(tx, { ...S, actor, type: 'expense', vendorId, txnDate: '2026-09-20', accountId: A.card, memo: 'find me',
    categoryLines: [{ accountId: A.office, amount: '61.23' }], itemLines: [] }));
  const [id] = await bankSays([{ account: 'Business Card', amount: '-61.23', description: 'SOMETHING ELSE ENTIRELY', date: '2026-10-12' }]);
  const q = encodeURIComponent(v.display_name.split(' ')[0]);
  const page = await (await app.get(`/banking/item/${id}?find=1&q=${q}&from=2026-09-01&to=2026-10-31&amount=61.23`)).text();
  assert.match(page, new RegExp(`<input type="checkbox" name="txn" value="${exp}"`));
  assert.match(page, /22 days before/);
  // Another bank line takes it; the search still shows it, marked and not selectable.
  const [other] = await bankSays([{ account: 'Business Card', amount: '-61.23', description: 'THE REAL ONE', date: '2026-09-21' }]);
  const f = await itemForm(app, other);
  await app.post(`/banking/item/${other}/match`, new URLSearchParams({ rev: f.rev, txn: String(exp), [`ver_${exp}`]: f.ver(exp) ?? hidden(f.page, `ver_${exp}`) }));
  assert.equal(await state(other), 'matched');
  const again = await (await app.get(`/banking/item/${id}?find=1&q=${q}&from=2026-09-01&to=2026-10-31`)).text();
  assert.match(again, new RegExp(`<input type="checkbox" name="txn" value="${exp}"[^>]* disabled>`));
  assert.match(again, /Already matched to <a href="\/banking\/item\/\d+">another bank line<\/a>/);
  // A search that finds nothing says so.
  assert.match(await (await app.get(`/banking/item/${id}?find=1&q=zzzz-nobody`)).text(), /Nothing in the books on this account fits that search/);
});

test('Add with a negative split line: an expense less a discount, a deposit less a fee kept back', async () => {
  const [buy, dep] = await bankSays([{ account: 'Business Card', amount: '-90.00', description: 'SUPPLY SHOP DISCOUNT' },
    { account: 'Operating Checking', amount: '970.00', description: 'MARKET DEPOSIT' }]);
  const before = await t.snapshot();
  let f = await itemForm(app, buy);
  let res = await app.post(`/banking/item/${buy}/add`, new URLSearchParams([...await picks(app, buy), ['rev', f.rev], ['evidence', f.evidence ?? ''],
    ['line_account', 'Office Supplies'], ['line_amount', '100.00'], ['line_account', 'Bank Fees'], ['line_amount', '-10.00']]));
  assert.equal(res.status, 303);
  f = await itemForm(app, dep);
  res = await app.post(`/banking/item/${dep}/add`, new URLSearchParams([...await picks(app, dep), ['rev', f.rev], ['evidence', f.evidence ?? ''],
    ['line_account', 'Interest Income'], ['line_amount', '1000.00'], ['line_account', 'Bank Fees'], ['line_amount', '-30.00']]));
  assert.equal(res.status, 303);
  const after1 = await t.snapshot();
  t.checkTied(after1, 'negative lines');
  t.expectChange(before, after1, { accounts: { [A.card]: -9000, [A.office]: 10000, [A.bank_fees]: -1000 + 3000, [A.checking]: 97000, [A.interest_income]: -100000 },
    net: 100000 - 10000 - 2000, label: 'negative split lines' });
  const [d] = await links(dep);
  assert.equal(d.type, 'deposit');
  assert.equal(Number((await pool().query('SELECT cash_back_cents FROM txn WHERE txn_id = $1', [d.txn_id])).rows[0].cash_back_cents), 3000);
  // A single negative line, or a split that doesn't add up, is refused.
  const [bad] = await bankSays([{ account: 'Business Card', amount: '-20.00', description: 'BAD SPLIT' }]);
  f = await itemForm(app, bad);
  assert.equal((await app.post(`/banking/item/${bad}/add`, new URLSearchParams([...await picks(app, bad), ['rev', f.rev], ['line_account', 'Office Supplies'], ['line_amount', '-20.00']]))).status, 422);
  assert.equal((await app.post(`/banking/item/${bad}/add`, new URLSearchParams([...await picks(app, bad), ['rev', f.rev], ['line_account', 'Office Supplies'], ['line_amount', '25.00'],
    ['line_account', 'Bank Fees'], ['line_amount', '-1.00']]))).status, 422);
});

test('a match and a bill payment together: Undo deletes only the payment, the matched expense stays', async () => {
  const b = await bill(vendors()[0], '30.00', 'combined');
  const exp = await withTransaction(pool(), tx => writeVendorDoc(tx, { ...S, actor, type: 'expense', vendorId: vendors()[0], txnDate: '2026-10-11', accountId: A.checking,
    memo: 'combined part', categoryLines: [{ accountId: A.office, amount: '12.00' }], itemLines: [] }));
  const [id] = await bankSays([{ account: 'Operating Checking', amount: '-42.00', description: 'COMBINED' }]);
  const before = await t.snapshot();
  const { res } = await settle(id, { txn: [exp], pay: { [b]: '30.00' } });
  assert.equal(res.status, 303);
  assert.equal(await state(id), 'matched');
  assert.deepEqual((await links(id)).map(x => [x.how, x.type]).sort(), [['added', 'bill_payment'], ['matched', 'expense']]);
  t.expectChange(before, await t.snapshot(), { accounts: { [A.checking]: -3000, ap: 3000 }, vendors: { [vendors()[0]]: -3000 }, net: 0, label: 'match + pay' });
  await undo(id);
  t.expectChange(before, await t.snapshot(), { label: 'undo match + pay' });
  assert.equal((await pool().query('SELECT 1 FROM txn WHERE txn_id = $1', [exp])).rowCount, 1);
  assert.equal(await open(b), 3000);
});

test('a negative deposit line with a class keeps it (recorded as a journal entry, not cash back)', async () => {
  await pool().query(`UPDATE accounting_settings SET classes_on = true, class_mode = 'line' WHERE org_id = $1 AND entity_id = $2`, [S.orgId, S.entityId]).catch(() => null);
  const settings = (await pool().query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'accounting_settings' AND column_name = 'class_mode'`)).rowCount;
  const cls = Number((await pool().query(`INSERT INTO class (org_id, entity_id, name) VALUES ($1, $2, 'Fee class') RETURNING class_id`, [S.orgId, S.entityId])).rows[0].class_id);
  const [dep] = await bankSays([{ account: 'Operating Checking', amount: '951.23', description: 'CLASSED DEPOSIT' }]);
  await addItem(pool(), { ...S, itemId: dep, actor, lines: [{ accountId: A.interest_income, amount: '1001.23', classId: cls }, { accountId: A.bank_fees, amount: '-50.00', classId: cls }] });
  const { rows } = await pool().query(`SELECT t.type, p.account_id, p.amount_cents, p.class_id FROM bank_feed_link k JOIN txn t ON t.txn_id = k.txn_id
    JOIN posting p ON p.txn_id = t.txn_id WHERE k.item_id = $1 AND p.account_id = $2`, [dep, A.bank_fees]);
  assert.equal(rows[0].type, 'journal_entry');
  assert.deepEqual([Number(rows[0].amount_cents), Number(rows[0].class_id)], [5000, cls]);
  assert.ok(settings >= 0);
});

test('a ten-digit bank check number settles a bill as a payment with no check number (the reference stays in the memo)', async () => {
  const b = await bill(vendors()[0], '32.84', 'ten digits');
  const [id] = await bankSays([{ account: 'Operating Checking', amount: '-32.84', description: 'LONG REF PAYMENT', check: '1234567890' }]);
  assert.equal((await settle(id, { pay: { [b]: '32.84' } })).res.status, 303);
  const [l] = await links(id);
  const { rows: [p] } = await pool().query('SELECT doc_number, payment_method, memo FROM txn WHERE txn_id = $1', [l.txn_id]);
  assert.deepEqual([p.doc_number, p.payment_method], [null, 'Other']);
  assert.match(p.memo, /1234567890/);
});

test('settlement fee adjustments never teach history for whole deposits', async () => {
  const customerId = Object.values(app.ids.customers)[0];
  for (const [n, rate] of [[0, '500'], [1, '501'], [2, '502']]) {
    const inv = await invoice(customerId, rate);
    const net = (Number(rate) - 2.39).toFixed(2);
    const [id] = await bankSays([{ account: 'Operating Checking', amount: net, description: 'PROCESSOR HISTORY RECEIPT', date: `2026-10-0${n + 1}` }]);
    assert.equal((await settle(id, { pay: { [inv]: `${rate}.00` }, adj: [{ account: 'Bank Fees', amount: '-2.39' }] })).res.status, 303);
  }
  const [next] = await bankSays([{ account: 'Operating Checking', amount: '503.71', description: 'PROCESSOR HISTORY RECEIPT' }]);
  const it = await getBankItem(pool(), { ...S, itemId: next });
  const s = await suggestFor(pool(), { ...S, item: it, rules: [], history: await learnedHistory(pool(), S) });
  assert.ok(!s || s.source !== 'history', 'no history learned from fee adjustments');
  const h = await categoryHistory(pool(), { ...S, item: it, history: await learnedHistory(pool(), S) });
  assert.deepEqual(h.rows, []);
});

test('an unsupported bank reference survives a full-length memo and a grouped deposit', async () => {
  const [a] = await bankSays([{ account: 'Business Card', amount: '-87.37', description: 'LONG MEMO', check: 'ABC1234567890' }]);
  await addItem(pool(), { ...S, itemId: a, actor, memo: 'x'.repeat(1000), lines: [{ accountId: A.office, amount: '' }] });
  const memo = async id => (await pool().query('SELECT t.memo FROM bank_feed_link k JOIN txn t ON t.txn_id = k.txn_id WHERE k.item_id = $1 ORDER BY t.txn_id', [id])).rows.map(r => r.memo);
  const [m] = await memo(a);
  assert.equal(m.length, 1000);
  assert.match(m, /\(bank ref ABC1234567890\)$/);
  const customerId = Object.values(app.ids.customers)[0];
  const paid = await savePayment(pool(), { ...S, customerId, txnDate: '2026-10-10', amountCents: 88231, paymentMethod: 'Card', actor, applications: [] });
  const [g] = await bankSays([{ account: 'Operating Checking', amount: '880.00', description: 'GROUPED REFERENCE', check: 'ABC1234567890' }]);
  assert.equal((await settle(g, { waiting: [paid], adj: [{ account: 'Bank Fees', amount: '-2.31' }] })).res.status, 303);
  for (const x of await memo(g)) assert.match(x, /ABC1234567890/);
});

test('a reference crossing the 1,000-character cut, and an adjustment journal’s memo, keep the whole reference', async () => {
  const [a] = await bankSays([{ account: 'Business Card', amount: '-92.17', description: 'ACROSS CUT', check: 'ABC1234567890' }]);
  await addItem(pool(), { ...S, itemId: a, actor, memo: `${'x'.repeat(990)}ABC1234567890`, lines: [{ accountId: A.office, amount: '' }] });
  const memos = async id => (await pool().query('SELECT t.memo FROM bank_feed_link k JOIN txn t ON t.txn_id = k.txn_id WHERE k.item_id = $1 ORDER BY t.txn_id', [id])).rows.map(r => r.memo);
  assert.match((await memos(a))[0], /ABC1234567890\)?$/);
  const customerId = Object.values(app.ids.customers)[0];
  const inv = await invoice(customerId, '197.63');
  const [g] = await bankSays([{ account: 'Operating Checking', amount: '195.32', description: 'ADJ CUT', check: 'ABC1234567890' }]);
  const it = await getBankItem(pool(), { ...S, itemId: g });
  const { settleItem, itemToken } = await import('../lib/data/banking.js');
  await settleItem(pool(), { ...S, itemId: g, actor, memo: 'y'.repeat(1000), settle: [{ txnId: inv, amountCents: 19763 }],
    adjustments: [{ accountId: A.bank_fees, cents: -231, description: 'fee' }], expect: { rev: itemToken(it) } });
  for (const m of await memos(g)) { assert.ok(m.length <= 1000); assert.match(m, /ABC1234567890/); }
});
