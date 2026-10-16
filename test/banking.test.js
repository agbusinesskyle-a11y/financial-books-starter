import { test, before, after } from 'node:test';
import { itemForm, listFields, picks } from './bank-forms.js';

import assert from 'node:assert/strict';
import { startApp } from './app-harness.js';
import { freshDb } from './harness.js';
import { tieout } from './tieout.js';
import { buildSampleFeed, writeLedgerlineSample, sampleUuid } from '../lib/bankfeed/sample.js';
import { pullCompany } from '../lib/bankfeed/pull.js';
import { linkCompany, saveMappings } from '../lib/data/bankfeeds.js';
import { bankAccounts, listBankItems, matchCandidates, confidentMatch, matchItem, addItem, transferItem, excludeItems, undoItem,
  acceptConfident, getBankItem } from '../lib/data/banking.js';
import { listUndeposited } from '../lib/data/deposits.js';
import { deleteVendorTxn } from '../lib/data/payables.js';
import { finishReconciliation } from '../lib/data/ledger-tools.js';

// Stage B3: reviewing bank items — match, add, transfer, group payments into a deposit, exclude, undo — with the deep
// tie-out after every step: the books stay balanced, every view agrees, and each step moves exactly what it should.
let app, llDb, ll, feed, S, t, A, acct;
const actor = 'tester';
const llId = name => feed.accounts.find(a => a.name === name).id;

before(async () => {
  llDb = await freshDb({ migrate: false });
  ll = llDb.pool;
  app = await startApp({ ledgerline: ll });
  S = { orgId: app.ids.orgId, entityId: app.ids.entityId };
  A = app.ids.accounts;
  feed = await buildSampleFeed(app.db.pool, { ...S, asOf: '2026-10-12' });
  await writeLedgerlineSample(ll, feed);
  await app.db.pool.query('UPDATE org SET ledgerline_org_id = $1 WHERE org_id = $2', [feed.org, app.ids.orgId]);
  await linkCompany(app.db.pool, ll, { ...S, llEntityId: feed.entities[0].id, actor });
  await pullCompany(app.db.pool, ll, S);
  await saveMappings(app.db.pool, { ...S, actor, choices: [
    { id: llId('Operating Checking'), choice: String(A.checking) }, { id: llId('Business Savings'), choice: String(A.savings) },
    { id: llId('Business Card'), choice: String(A.card) }, { id: llId('Equipment Loan'), choice: String(A.equipment_loan) }] });
  await pullCompany(app.db.pool, ll, S);
  t = tieout(app);
  acct = (await bankAccounts(app.db.pool, S));
});
after(async () => { await app.close(); await llDb.drop(); });

const pool = () => app.db.pool;
const itemBy = async desc => (await pool().query(`SELECT item_id FROM bank_feed_item WHERE entity_id = $1 AND description = $2 ORDER BY posted_date DESC LIMIT 1`,
  [S.entityId, desc])).rows[0]?.item_id;
const state = async id => (await pool().query('SELECT review_state, (SELECT count(*)::int FROM bank_feed_link WHERE item_id = $1) AS links FROM bank_feed_item WHERE item_id = $1', [id])).rows[0];
// Do a step, then check the books tie out and moved exactly as expected.
async function step(label, fn, expected) {
  const a = await t.snapshot();
  const r = await fn();
  const b = await t.snapshot();
  t.checkTied(b, label);
  t.expectChange(a, b, { label, ...expected });
  return r;
}
// Put new items into the sample ledgerline and pull them.
async function bankSays(rows) {
  for (const r of rows) {
    await ll.query(`INSERT INTO core.transaction (org_id, transaction_id, account_id, amount, currency, posted_date, pending, description_raw, status, revision)
      VALUES ($1, $2, $3, $4, 'USD', $5, false, $6, 'active', 1)`, [feed.org, sampleUuid('test', r.key), llId(r.account), r.amount, r.date, r.description]);
  }
  await pullCompany(pool(), ll, S);
}

test('account cards: bank and books balances, items to review, verified month', async () => {
  assert.deepEqual(acct.map(a => a.books_name), ['Operating Checking', 'Savings', 'Business Card', 'Equipment Loan']);
  const checking = acct.find(a => a.books_name === 'Operating Checking');
  assert.ok(checking.to_review > 50);
  assert.ok(checking.verified_through);
  assert.equal(typeof checking.books_balance_cents, 'number');
  const card = acct.find(a => a.books_type === 'credit_card');
  assert.ok(card.bank_balance_cents >= 0, 'a card shows what is owed');
});

test('confident matches: books activity the bank shows is matched, and the books don’t move', async () => {
  const checking = llId('Operating Checking');
  const n = await step('accept confident', () => acceptConfident(pool(), { ...S, llAccountId: checking, actor }), {});
  assert.ok(n > 40, `matched ${n}`);
  // Checks matched by number even when they cleared a week later.
  const { rows: checks } = await pool().query(`SELECT i.check_number, t.doc_number FROM bank_feed_item i JOIN bank_feed_link k ON k.item_id = i.item_id JOIN txn t ON t.txn_id = k.txn_id
    WHERE i.entity_id = $1 AND i.check_number IS NOT NULL`, [S.entityId]);
  assert.ok(checks.length > 3 && checks.every(c => c.check_number === c.doc_number));
  // Bank-only items stay for review.
  const fee = await itemBy('MONTHLY SERVICE FEE');
  assert.equal((await state(fee)).review_state, 'new');
  for (const l of ['Business Savings', 'Business Card']) await acceptConfident(pool(), { ...S, llAccountId: llId(l), actor });
});

test('add: a bank fee becomes an expense on the account', async () => {
  const id = await itemBy('MONTHLY SERVICE FEE');
  const txnId = await step('add fee', () => addItem(pool(), { ...S, itemId: id, lines: [{ accountId: A.bank_fees, amount: '' }], actor }),
    { accounts: { [A.checking]: -1500, [A.bank_fees]: 1500 }, net: -1500 });
  assert.deepEqual(await state(id), { review_state: 'added', links: 1 });
  const { rows: [x] } = await pool().query('SELECT type, txn_date, account_id FROM txn WHERE txn_id = $1', [txnId]);
  assert.equal(x.type, 'expense');
  assert.equal(Number(x.account_id), A.checking);
  await t.expectHistory(txnId, { activity: false });
});

test('add: a card purchase with a vendor and a split', async () => {
  const id = await itemBy('TRACTOR SUPPLY #1234 LUBBOCK TX');
  const vendorId = Object.values(app.ids.vendors)[0];
  await step('add card purchase', () => addItem(pool(), { ...S, itemId: id, payee: `v:${vendorId}`, actor,
    lines: [{ accountId: A.repairs, amount: '60.00' }, { accountId: A.office, amount: '24.17' }] }),
  { accounts: { [A.card]: -8417, [A.repairs]: 6000, [A.office]: 2417 }, net: -8417 });
  // A split that doesn't add up is refused, and so is the account itself as a category.
  const other = await itemBy('SHELL OIL 57444 PLAINVIEW TX');
  await assert.rejects(addItem(pool(), { ...S, itemId: other, actor, lines: [{ accountId: A.fuel, amount: '60.00' }] }), /split adds up to \$60\.00; the bank shows \$61\.02/);
  await assert.rejects(addItem(pool(), { ...S, itemId: other, actor, lines: [{ accountId: A.card, amount: '' }] }), /can’t be Business Card itself/);
});

test('add: money into a bank account becomes a deposit', async () => {
  const id = await itemBy('INTEREST PAYMENT');
  const txnId = await step('add interest', () => addItem(pool(), { ...S, itemId: id, lines: [{ accountId: A.interest_income, amount: '' }], actor }),
    { accounts: { [A.savings]: 341, [A.interest_income]: -341 }, net: 341 });
  assert.equal((await pool().query('SELECT type FROM txn WHERE txn_id = $1', [txnId])).rows[0].type, 'deposit');
});

test('add: loan activity becomes a journal entry; transfer to the loan pairs with checking', async () => {
  const loanItem = await itemBy('LOAN PAYMENT RECEIVED');
  await step('loan via transfer', () => transferItem(pool(), { ...S, itemId: loanItem, otherAccountId: A.checking, actor }),
    { accounts: { [A.equipment_loan]: 85000, [A.checking]: -85000 } });
  assert.equal((await state(loanItem)).review_state, 'added');
  // A card refund (money into a card that isn't a payment) is added as a credit card credit against the category.
  await bankSays([{ key: 'refund', account: 'Business Card', amount: '12.00', date: '2026-10-10', description: 'TRACTOR SUPPLY REFUND' }]);
  const refund = await itemBy('TRACTOR SUPPLY REFUND');
  const txnId = await step('card refund', () => addItem(pool(), { ...S, itemId: refund, lines: [{ accountId: A.repairs, amount: '' }], actor }),
    { accounts: { [A.card]: 1200, [A.repairs]: -1200 }, net: 1200 });
  assert.equal((await pool().query('SELECT type FROM txn WHERE txn_id = $1', [txnId])).rows[0].type, 'cc_credit');
});

test('transfer between two fed accounts records both bank items with one transaction', async () => {
  await bankSays([{ key: 'tr-out', account: 'Operating Checking', amount: '-500.00', date: '2026-10-09', description: 'ONLINE TRANSFER TO SAV 8812' },
    { key: 'tr-in', account: 'Business Savings', amount: '500.00', date: '2026-10-10', description: 'ONLINE TRANSFER FROM CHK 4321' }]);
  const out = await itemBy('ONLINE TRANSFER TO SAV 8812'), into = await itemBy('ONLINE TRANSFER FROM CHK 4321');
  const r = await step('transfer', () => transferItem(pool(), { ...S, itemId: out, otherAccountId: A.savings, actor }),
    { accounts: { [A.checking]: -50000, [A.savings]: 50000 } });
  assert.equal(r.pairedItemId, Number(into));
  assert.deepEqual(await state(into), { review_state: 'matched', links: 1 });
  // Undo on the paired side only unlinks it; undo on the side that created it deletes the transfer.
  assert.equal(await undoItem(pool(), { ...S, itemId: into, actor }), 'unmatched');
  assert.equal(await step('undo transfer', () => undoItem(pool(), { ...S, itemId: out, actor }), { accounts: { [A.checking]: 50000, [A.savings]: -50000 } }), 'deleted');
  // A bank-to-card transfer is a credit card payment.
  const pay = await step('pay card', () => transferItem(pool(), { ...S, itemId: out, otherAccountId: A.card, actor }), { accounts: { [A.checking]: -50000, [A.card]: 50000 } });
  assert.equal((await pool().query('SELECT type FROM txn WHERE txn_id = $1', [pay.txnId])).rows[0].type, 'cc_payment');
  await undoItem(pool(), { ...S, itemId: out, actor });
});

test('one bank deposit of several payments waiting in Undeposited Funds', async () => {
  const waiting = await listUndeposited(pool(), S);
  assert.ok(waiting.length >= 2);
  const two = waiting.slice(0, 2);
  const sum = two.reduce((s, w) => s + Number(w.total_cents), 0);
  await bankSays([{ key: 'dep', account: 'Operating Checking', amount: (sum / 100).toFixed(2), date: '2026-10-12', description: 'BRANCH DEPOSIT 7781' }]);
  const id = await itemBy('BRANCH DEPOSIT 7781');
  const item = await getBankItem(pool(), { ...S, itemId: id });
  const c = await matchCandidates(pool(), { ...S, item });
  for (const w of two) assert.ok(c.undeposited.some(u => u.txn_id === w.txn_id));
  await assert.rejects(matchItem(pool(), { ...S, itemId: id, undepositedIds: [two[0].txn_id], actor }), /add up to/);
  const r = await step('group deposit', () => matchItem(pool(), { ...S, itemId: id, undepositedIds: two.map(w => w.txn_id), actor }),
    { accounts: { [A.checking]: sum, undeposited: -sum } });
  assert.ok(r.depositId);
  assert.equal((await state(id)).review_state, 'added');
  await step('undo grouped', () => undoItem(pool(), { ...S, itemId: id, actor }), { accounts: { [A.checking]: -sum, undeposited: sum } });
  assert.equal((await listUndeposited(pool(), S)).length, waiting.length, 'payments back in Undeposited Funds');
});

test('match rules: same account, exact amounts, not used twice, nothing pending or removed', async () => {
  const { rows: [m] } = await pool().query(`SELECT i.item_id, k.txn_id FROM bank_feed_item i JOIN bank_feed_link k ON k.item_id = i.item_id
    WHERE i.entity_id = $1 AND i.review_state = 'matched' AND k.how = 'matched' AND i.ll_account_id = $2 LIMIT 1`, [S.entityId, llId('Operating Checking')]);
  await bankSays([{ key: 'dupe', account: 'Operating Checking', amount: '-15.00', date: '2026-10-11', description: 'DUPLICATE TEST' }]);
  const dupe = await itemBy('DUPLICATE TEST');
  await assert.rejects(matchItem(pool(), { ...S, itemId: dupe, txnIds: [m.txn_id], actor }), /already matched to another bank item|isn’t on this account/);
  const pending = (await pool().query(`SELECT item_id FROM bank_feed_item WHERE entity_id = $1 AND pending`, [S.entityId])).rows[0].item_id;
  await assert.rejects(addItem(pool(), { ...S, itemId: pending, lines: [{ accountId: A.fuel, amount: '' }], actor }), /still pending/);
  await assert.rejects(excludeItems(pool(), { ...S, itemIds: [], actor }), /Choose/);
  // Excluding and restoring.
  assert.equal(await excludeItems(pool(), { ...S, itemIds: [dupe], actor }), 1);
  assert.equal((await state(dupe)).review_state, 'excluded');
  await assert.rejects(addItem(pool(), { ...S, itemId: dupe, lines: [{ accountId: A.fuel, amount: '' }], actor }), /already been reviewed/);
  assert.equal(await undoItem(pool(), { ...S, itemId: dupe, actor }), 'restored');
  assert.equal((await state(dupe)).review_state, 'new');
  const excluded = await listBankItems(pool(), { ...S, llAccountId: llId('Operating Checking'), tab: 'excluded' });
  assert.equal(excluded.length, 0);
});

test('deleting a books transaction sends its bank item back for review', async () => {
  const id = await itemBy('SHELL OIL 57444 PLAINVIEW TX');
  const txnId = await addItem(pool(), { ...S, itemId: id, lines: [{ accountId: A.fuel, amount: '' }], actor });
  assert.equal((await state(id)).review_state, 'added');
  await deleteVendorTxn(pool(), { ...S, txnId, actor });
  assert.deepEqual(await state(id), { review_state: 'new', links: 0 });
});

test('undo is refused once the transaction is reconciled', async () => {
  const id = await itemBy('AMZN MKTP US*2K4LM9 AMZN.COM/BILL WA');
  const txnId = await addItem(pool(), { ...S, itemId: id, lines: [{ accountId: A.office, amount: '' }], actor });
  // Reconcile the card with just this charge cleared.
  const { rows: [b] } = await pool().query(`SELECT coalesce(-sum(i.amount_cents), 0)::bigint AS n FROM reconciled_item i JOIN reconciliation r ON r.rec_id = i.rec_id
    WHERE i.account_id = $1`, [A.card]);
  await finishReconciliation(pool(), { ...S, accountId: A.card, statementDate: '2026-10-12', endingText: ((Number(b.n) + 2399) / 100).toFixed(2), txnIds: [txnId], actor });
  await assert.rejects(undoItem(pool(), { ...S, itemId: id, actor }), /reconciled/);
});

test('another company can’t touch these bank items', async () => {
  const id = await itemBy('MONTHLY SERVICE FEE');
  const other = { orgId: S.orgId, entityId: S.entityId + 999 };
  assert.equal(await getBankItem(pool(), { ...other, itemId: id }), null);
  await assert.rejects(addItem(pool(), { ...other, itemId: id, lines: [{ accountId: A.fuel, amount: '' }], actor }), /not found/);
  await assert.rejects(excludeItems(pool(), { ...other, itemIds: [id], actor }), /not found/);
});

test('confidentMatch needs one clear candidate', () => {
  const item = { check_number: null };
  assert.equal(confidentMatch({ exact: [{ txn_id: 1, days: 1 }] }, item).txn_id, 1);
  assert.equal(confidentMatch({ exact: [{ txn_id: 1, days: 1 }, { txn_id: 2, days: 2 }] }, item), null);
  assert.equal(confidentMatch({ exact: [{ txn_id: 1, days: 20 }] }, item), null);
  assert.equal(confidentMatch({ exact: [{ txn_id: 1, days: 20, doc_number: '1042' }] }, { check_number: '1042' }).txn_id, 1);
});

test('the screen: cards, tabs, item page, add and undo through the forms', async () => {
  let page = await (await app.get('/banking')).text();
  assert.match(page, /Bank transactions/);
  for (const n of ['Operating Checking', 'Savings', 'Business Card', 'Equipment Loan']) assert.match(page, new RegExp(n));
  assert.match(page, /For review \(\d+\)/);
  const checking = llId('Operating Checking');
  page = await (await app.get(`/banking?account=${checking}&tab=categorized`)).text();
  assert.match(page, /Matched to /);
  // An item page: facts, the four actions, and adding through the form.
  await bankSays([{ key: 'screen', account: 'Operating Checking', amount: '-42.00', date: '2026-10-11', description: 'SCREEN TEST CHARGE' }]);
  const id = await itemBy('SCREEN TEST CHARGE');
  page = await (await app.get(`/banking/item/${id}`)).text();
  for (const h of ['Match', 'Add', 'Transfer', 'Exclude']) assert.match(page, new RegExp(`<h2>${h}</h2>`));
  let rev = (await itemForm(app, id)).rev;
  let res = await app.post(`/banking/item/${id}/add`, new URLSearchParams([...await picks(app, id), ['rev', rev], ['payee', ''], ['line_account', 'Fuel'], ['line_amount', '40.00'], ['line_description', ''],
    ['line_account', ''], ['line_amount', ''], ['line_description', ''], ['memo', '']]));
  assert.equal(res.status, 422);
  assert.match(await res.text(), /split adds up to \$40\.00/);
  res = await app.post(`/banking/item/${id}/add`, new URLSearchParams([...await picks(app, id), ['rev', rev], ['payee', ''], ['line_account', 'Fuel'], ['line_amount', ''], ['line_description', 'Diesel'], ['memo', '']]));
  assert.equal(res.status, 303);
  assert.equal((await state(id)).review_state, 'added');
  page = await (await app.get(`/banking/item/${id}`)).text();
  assert.match(page, /Added as <a href="\/vtxns\/\d+">Expense/);
  res = await app.post(`/banking/item/${id}/undo`, { plan: (await itemForm(app, id)).plan });
  assert.equal(res.status, 303);
  assert.equal((await state(id)).review_state, 'new');
  // Batch: exclude ticked, then accept matches with nothing ticked.
  res = await app.post('/banking/batch', new URLSearchParams([['account', checking], ['tab', 'review'], ['action', 'exclude'], ['item', String(id)], ...(await listFields(app, checking, [id]))]));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Exclude: 1 of 1 done/);
  assert.equal((await state(id)).review_state, 'excluded');
  res = await app.post('/banking/batch', new URLSearchParams([['account', checking], ['tab', 'review'], ['action', 'accept']]));
  assert.equal(res.status, 303);
  // Refresh comes back to the banking page.
  res = await app.post('/bank-feeds/refresh', { back: `/banking?account=${checking}&tab=review` });
  assert.equal(res.headers.get('location'), `/banking?account=${checking}&tab=review`);
  res = await app.post('/bank-feeds/refresh', { back: 'https://elsewhere.example/' });
  assert.equal(res.headers.get('location'), '/settings/bank-feeds');
  assert.equal((await app.get('/banking/item/999999999')).status, 404);
});

test('Reconcile starts with what the bank feed cleared already ticked', async () => {
  const res = await app.get(`/reconcile/start?account=${A.checking}&date=2026-10-12&ending=1000.00`);
  const page = await res.text();
  assert.equal(res.status, 200);
  const { rows } = await pool().query(`SELECT DISTINCT k.txn_id FROM bank_feed_link k JOIN bank_feed_item i ON i.item_id = k.item_id
    WHERE i.ll_account_id = $1 AND NOT EXISTS (SELECT 1 FROM reconciled_item r WHERE r.txn_id = k.txn_id AND r.account_id = $2)`, [llId('Operating Checking'), A.checking]);
  assert.ok(rows.length > 10);
  for (const r of rows.slice(0, 10)) assert.match(page, new RegExp(`name="ids" value="${r.txn_id}"[^>]* checked`));
  const ticked = (page.match(/name="ids" value="\d+"[^>]* checked/g) ?? []).length;
  assert.equal(ticked, rows.length, 'only bank-cleared items are ticked');
});
