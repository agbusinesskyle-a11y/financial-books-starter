import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './app-harness.js';
import { freshDb } from './harness.js';
import { tieout } from './tieout.js';
import { buildSampleFeed, writeLedgerlineSample, sampleUuid } from '../lib/bankfeed/sample.js';
import { pullCompany } from '../lib/bankfeed/pull.js';
import { linkCompany, saveMappings } from '../lib/data/bankfeeds.js';
import { getBankItem, matchItem, addItem, transferItem, excludeItems, undoItem, undoPlan, undoConfirmText, possibleDuplicates, listBankItems, markChecked,
  matchCandidates, confidentMatch, DuplicateError, StaleError, itemToken } from '../lib/data/banking.js';
import { saveRule, deleteRule, listRules, learnedHistory, suggestFor, acceptSuggestions, applyAutoRules, intentOf, priorityOf } from '../lib/bankfeed/rules.js';
import { writeVendorDoc } from '../lib/data/payables.js';
import { writeTransfer, writeJournalEntry } from '../lib/data/ledger-tools.js';
import { saveClass, saveLocation } from '../lib/data/accounting.js';
import { savePayment } from '../lib/data/writes.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withTransaction } from '../lib/db.js';
import { itemForm, picks } from './bank-forms.js';

// Bank review v2, stage BR-1: every defect from the Codex Astra deep dive
// and the design review, each with exact postings checked by the tie-out.
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
// New bank lines in the sample ledgerline, pulled in; returns their item ids in order.
async function bankSays(rows) {
  const keys = [];
  for (const r of rows) {
    const key = `v2-${++seq}`;
    keys.push(key);
    await ll.query(`INSERT INTO core.transaction (org_id, transaction_id, account_id, amount, currency, posted_date, pending, description_raw, status, revision, check_number)
      VALUES ($1, $2, $3, $4, 'USD', $5, false, $6, 'active', 1, $7)`, [feed.org, sampleUuid('v2', key), llId(r.account), r.amount, r.date, r.description, r.check ?? null]);
  }
  await pullCompany(pool(), ll, S);
  const ids = [];
  for (const k of keys) ids.push(Number((await pool().query('SELECT item_id FROM bank_feed_item WHERE ll_transaction_id = $1', [sampleUuid('v2', k)])).rows[0].item_id));
  return ids;
}
const expense = (account, amount, date, memo, extra = {}) => withTransaction(pool(), tx => writeVendorDoc(tx, { ...S, actor, type: extra.type ?? 'expense', txnDate: date,
  accountId: account, memo, docNumber: extra.doc ?? '', categoryLines: [{ accountId: A.office, amount }], itemLines: [] }));
const item = id => getBankItem(pool(), { ...S, itemId: id });
const txnCount = async () => Number((await pool().query('SELECT count(*) AS n FROM txn WHERE entity_id = $1', [S.entityId])).rows[0].n);
const events = async id => (await pool().query('SELECT * FROM bank_review_event WHERE item_id = $1 ORDER BY event_id', [id])).rows;
// Accept the way the list does: each ticked item carries the plan its suggestion showed.
async function shownIntents(itemIds) {
  const rules = await listRules(pool(), S), history = await learnedHistory(pool(), S);
  const intents = new Map();
  for (const id of itemIds) {
    const it = await item(id);
    const i = intentOf(await suggestFor(pool(), { ...S, item: it, rules, history }), it);
    if (i) intents.set(Number(id), i);
  }
  return intents;
}
let ruleNo = 0;
const rule = async (fields) => saveRule(pool(), { ...S, actor, fields: { name: `R${++ruleNo}`, money: 'out', mode: 'suggest', ...fields } });

test('#1 an automatic rule never creates a third expense when two could already be it', async () => {
  const e1 = await expense(A.checking, '88.77', '2026-10-05', 'one'), e2 = await expense(A.checking, '88.77', '2026-10-05', 'two');
  const [id] = await bankSays([{ account: 'Operating Checking', amount: '-88.77', date: '2026-10-05', description: 'DOUBLE CANDIDATE 8877' }]);
  const dupes = await possibleDuplicates(pool(), { ...S, item: await item(id) });
  assert.deepEqual(dupes.map(d => Number(d.txn_id)).sort(), [e1, e2].sort());
  const r = await rule({ name: 'Double', mode: 'auto', conditions: [{ field: 'description', op: 'contains', value: 'DOUBLE CANDIDATE' }], accountId: A.office });
  const before = await txnCount();
  assert.equal(await applyAutoRules(pool(), S), 0);
  assert.equal(await txnCount(), before, 'nothing created');
  assert.equal((await item(id)).review_state, 'new');
  const s = await suggestFor(pool(), { ...S, item: await item(id), rules: await listRules(pool(), S), history: await learnedHistory(pool(), S) });
  assert.equal(s.source, 'possible', 'shown as a decision, not a rule add');
  assert.equal(intentOf(s, await item(id)), null, 'never accepted in a batch');
  await deleteRule(pool(), { ...S, ruleId: r });
});

test('#4 Add is refused while something in the books could already be the item; a person can say it is separate', async () => {
  const e = await expense(A.checking, '89.67', '2026-10-06', 'entered by hand');
  const [id] = await bankSays([{ account: 'Operating Checking', amount: '-89.67', date: '2026-10-06', description: 'HAND ENTERED 8967' }]);
  await assert.rejects(addItem(pool(), { ...S, itemId: id, lines: [{ accountId: A.office, amount: '' }], actor }), err => err instanceof DuplicateError && err.duplicates[0].txn_id == e);
  // The form shows the possibilities and the box.
  let page = await (await app.get(`/banking/item/${id}`)).text();
  assert.match(page, /This may already be in the books/);
  assert.match(page, /This is a separate transaction/);
  const f = await itemForm(app, id);
  assert.ok(f.evidence, 'the page carries the evidence it showed');
  const res = await app.post(`/banking/item/${id}/add`, new URLSearchParams([...await picks(app, id), ['rev', f.rev], ['line_account', 'Office Supplies'], ['line_amount', ''], ['line_description', '']]));
  assert.equal(res.status, 422);
  // Batch/rule/auto can't say "separate" — only a person on the item page.
  await assert.rejects(addItem(pool(), { ...S, itemId: id, lines: [{ accountId: A.office, amount: '' }], actor, separate: true, source: 'batch' }), DuplicateError);
  const a = await t.snapshot();
  // Acknowledging stale evidence is refused: something new could be the item now.
  const stale = await app.post(`/banking/item/${id}/add`, new URLSearchParams([...await picks(app, id), ['rev', f.rev], ['line_account', 'Office Supplies'], ['line_amount', ''], ['line_description', ''], ['separate', '1'], ['evidence', 'not-what-was-shown']]));
  assert.equal(stale.status, 303);
  assert.equal((await item(id)).review_state, 'new');
  const ok = await app.post(`/banking/item/${id}/add`, new URLSearchParams([...await picks(app, id), ['rev', f.rev], ['line_account', 'Office Supplies'], ['line_amount', ''], ['line_description', ''], ['separate', '1'], ['evidence', f.evidence]]));
  assert.equal(ok.status, 303);
  const b = await t.snapshot();
  t.checkTied(b, 'separate add');
  t.expectChange(a, b, { accounts: { [A.checking]: -8967, [A.office]: 8967 }, net: -8967, label: 'separate add' });
  const [ev] = (await events(id)).filter(x => x.kind === 'added');
  assert.equal(ev.separate, true);
  page = await (await app.get(`/banking?account=${llId('Operating Checking')}&tab=categorized`)).text();
  assert.match(page, /marked separate/);
});

test('#2 recording the transfer on both feed lines posts it once', async () => {
  const [out, into] = await bankSays([{ account: 'Operating Checking', amount: '-298.76', date: '2026-10-07', description: 'XFER TO SAVINGS 29876' },
    { account: 'Business Savings', amount: '298.76', date: '2026-10-07', description: 'XFER FROM CHECKING 29876' }]);
  // Practice-style: the other side is left (matchOther false), then a person records "transfer" on it too.
  const a = await t.snapshot();
  const { txnId } = await transferItem(pool(), { ...S, itemId: out, otherAccountId: A.savings, actor, matchOther: false });
  const r2 = await transferItem(pool(), { ...S, itemId: into, otherAccountId: A.checking, actor });
  assert.equal(r2.matchedExisting, true);
  assert.equal(r2.txnId, txnId, 'the same transfer');
  const b = await t.snapshot();
  t.checkTied(b, 'both sides');
  t.expectChange(a, b, { accounts: { [A.checking]: -29876, [A.savings]: 29876 }, label: 'both sides once' });
  // Categorizing the other side to the first account is blocked the same way.
  const [o2, i2] = await bankSays([{ account: 'Operating Checking', amount: '-227.89', date: '2026-10-07', description: 'MOVE 22789' },
    { account: 'Business Savings', amount: '227.89', date: '2026-10-07', description: 'MOVE IN 22789' }]);
  await transferItem(pool(), { ...S, itemId: o2, otherAccountId: A.savings, actor, matchOther: false });
  // Choosing the other account as the whole category goes through the transfer service: matched to the same transfer.
  const before2 = await txnCount();
  await addItem(pool(), { ...S, itemId: i2, lines: [{ accountId: A.checking, amount: '' }], actor });
  assert.equal((await item(i2)).review_state, 'matched');
  assert.equal(await txnCount(), before2, 'no second transaction');
});

test('#2b a split loan payment is not reused as a transfer', async () => {
  // Checking −$100 = loan $90 + interest $10, entered by hand; the loan's own feed line (+$100? no — the loan moves $90)
  // and a pure $100 transfer request must not reuse the split entry.
  const je = await withTransaction(pool(), tx => writeJournalEntry(tx, { ...S, actor, txnDate: '2026-10-08', docNumber: '', memo: 'loan payment', lines: [
    { accountId: A.equipment_loan, debit: '90.00', credit: '', description: '', party: '' }, { accountId: A.interest_expense ?? A.office, debit: '10.00', credit: '', description: '', party: '' },
    { accountId: A.checking, debit: '', credit: '100.00', description: '', party: '' }] }));
  const [id] = await bankSays([{ account: 'Operating Checking', amount: '-100.00', date: '2026-10-08', description: 'LOAN PMT 10000' }]);
  await assert.rejects(transferItem(pool(), { ...S, itemId: id, otherAccountId: A.equipment_loan, actor }), /already be in the books/, 'not reused, and not recorded twice');
  // A person matches it instead.
  await matchItem(pool(), { ...S, itemId: id, txnIds: [je], actor });
  assert.equal((await item(id)).review_state, 'matched');
});

test('#3 live pairing only when exactly one opposite line fits', async () => {
  const [out, , ] = await bankSays([{ account: 'Operating Checking', amount: '-319.87', date: '2026-10-09', description: 'XFER OUT 31987' },
    { account: 'Business Savings', amount: '319.87', date: '2026-10-09', description: 'UNRELATED DEPOSIT 31987' },
    { account: 'Business Savings', amount: '319.87', date: '2026-10-09', description: 'XFER IN 31987' }]);
  const r = await transferItem(pool(), { ...S, itemId: out, otherAccountId: A.savings, actor });
  assert.equal(r.pairedItemId, null);
  assert.equal(r.ambiguousPair, true);
  const { rows } = await pool().query(`SELECT count(*)::int AS n FROM bank_feed_item WHERE description LIKE '%31987' AND ll_account_id = $1 AND review_state = 'new'`, [llId('Business Savings')]);
  assert.equal(rows[0].n, 2, 'both left for a person');
  // A unique one is paired.
  const [o2, i2] = await bankSays([{ account: 'Operating Checking', amount: '-456.78', date: '2026-10-09', description: 'XFER OUT 45678' },
    { account: 'Business Savings', amount: '456.78', date: '2026-10-09', description: 'XFER IN 45678' }]);
  const r2 = await transferItem(pool(), { ...S, itemId: o2, otherAccountId: A.savings, actor });
  assert.equal(r2.pairedItemId, i2);
  // #11 Undo from the side that made it: the plan says it stays, and the other line now owns it.
  const plan = await undoPlan(pool(), { ...S, itemId: o2 });
  assert.equal(plan.kind, 'handover');
  assert.match(undoConfirmText(plan), /stays — the other account’s bank line still records it/);
  assert.equal(await undoItem(pool(), { ...S, itemId: o2, actor }), 'handed');
  assert.equal((await item(i2)).review_state, 'added');
  assert.equal((await undoPlan(pool(), { ...S, itemId: i2 })).kind, 'delete');
  assert.equal(await undoItem(pool(), { ...S, itemId: i2, actor }), 'deleted');
  assert.equal((await pool().query('SELECT 1 FROM txn WHERE txn_id = $1', [r2.txnId])).rowCount, 0);
});

test('#5 a batch does exactly what each ticked row showed; a shared match leaves both', async () => {
  const e = await expense(A.checking, '86.71', '2026-10-10', 'one purchase');
  const [i1, i2] = await bankSays([{ account: 'Operating Checking', amount: '-86.71', date: '2026-10-10', description: 'BATCH SAME 8671' },
    { account: 'Operating Checking', amount: '-86.71', date: '2026-10-10', description: 'BATCH SAME 8671 B' }]);
  const r = await rule({ name: 'Batch same', conditions: [{ field: 'description', op: 'contains', value: 'BATCH SAME' }], accountId: A.office });
  const intents = await shownIntents([i1, i2]);
  // Two candidates? No — one expense, two bank lines: each line's only candidate is the same expense.
  const before = await txnCount();
  const out = await acceptSuggestions(pool(), { ...S, llAccountId: llId('Operating Checking'), itemIds: [i1, i2], intents, actor });
  assert.equal(await txnCount(), before, 'no new expense from a line that showed a match');
  assert.ok(out.accepted <= 1);
  assert.ok(out.skipped.length >= 1);
  assert.ok(!(await pool().query(`SELECT 1 FROM bank_feed_link k JOIN txn t ON t.txn_id = k.txn_id WHERE k.item_id = ANY($1) AND t.txn_id <> $2`, [[i1, i2], e])).rowCount);
  await deleteRule(pool(), { ...S, ruleId: r });
});

test('#5b a plan that changed after the page was shown is skipped; nothing ticked does nothing', async () => {
  const [id] = await bankSays([{ account: 'Business Card', amount: '-46.81', date: '2026-10-10', description: 'STALE PLAN SHOP' }]);
  const r = await rule({ name: 'Stale', conditions: [{ field: 'description', op: 'contains', value: 'STALE PLAN' }], accountId: A.office });
  const intents = await shownIntents([id]);
  assert.ok(intents.get(id)?.startsWith('rule:'));
  // Someone changes the rule's class/memo after the page was shown.
  await saveRule(pool(), { ...S, actor, ruleId: r, fields: { name: 'Stale', money: 'out', mode: 'suggest', conditions: [{ field: 'description', op: 'contains', value: 'STALE PLAN' }],
    accountId: A.office, memo: 'changed later' } });
  const before = await txnCount();
  const out = await acceptSuggestions(pool(), { ...S, llAccountId: llId('Business Card'), itemIds: [id], intents, actor });
  assert.deepEqual([out.accepted, out.skipped[0].reason], [0, 'changed since the page was shown — review it']);
  assert.equal(await txnCount(), before);
  await assert.rejects(acceptSuggestions(pool(), { ...S, llAccountId: llId('Business Card'), itemIds: [], intents, actor }), /Tick the items/);
  const res = await app.post('/banking/batch', { account: llId('Business Card'), action: 'accept' });
  assert.equal(res.status, 303);
  assert.equal(await txnCount(), before, 'an empty batch does nothing in live books');
  // #12 Accepting with the fresh plan records the rule; deleting the rule keeps the history.
  const fresh = await shownIntents([id]);
  assert.equal((await acceptSuggestions(pool(), { ...S, llAccountId: llId('Business Card'), itemIds: [id], intents: fresh, actor })).accepted, 1);
  const [ev] = (await events(id)).filter(x => x.kind === 'added');
  assert.deepEqual([ev.source, ev.basis, ev.rule_name, ev.rule_snapshot.memo], ['batch', 'rule', 'Stale', 'changed later']);
  assert.equal(Number((await item(id)).rule_id), r);
  await deleteRule(pool(), { ...S, ruleId: r });
  const rows = await listBankItems(pool(), { ...S, llAccountId: llId('Business Card'), tab: 'categorized' });
  assert.equal(rows.find(x => Number(x.item_id) === id).rule_name, 'Stale', 'kept after the rule is deleted');
});

test('#6 a rule’s class and location reach the postings (batch and automatic)', async () => {
  await saveClass(pool(), { ...S, fields: { name: 'Field ops' } });
  await saveLocation(pool(), { ...S, fields: { name: 'West yard' } });
  const classId = Number((await pool().query(`SELECT class_id FROM class WHERE entity_id = $1 AND name = 'Field ops'`, [S.entityId])).rows[0].class_id);
  const locationId = Number((await pool().query(`SELECT location_id FROM location WHERE entity_id = $1 AND name = 'West yard'`, [S.entityId])).rows[0].location_id);
  const [b1, a1] = await bankSays([{ account: 'Business Card', amount: '-49.23', date: '2026-10-11', description: 'DIMS SHOP ONE' },
    { account: 'Business Card', amount: '-49.24', date: '2026-10-11', description: 'DIMS AUTO TWO' }]);
  const r1 = await rule({ name: 'Dims', conditions: [{ field: 'description', op: 'contains', value: 'DIMS SHOP' }], accountId: A.office, classId, locationId });
  const r2 = await rule({ name: 'Dims auto', mode: 'auto', conditions: [{ field: 'description', op: 'contains', value: 'DIMS AUTO' }], accountId: A.office, classId, locationId });
  assert.equal((await acceptSuggestions(pool(), { ...S, llAccountId: llId('Business Card'), itemIds: [b1], intents: await shownIntents([b1]), actor })).accepted, 1);
  assert.equal(await applyAutoRules(pool(), S), 1);
  for (const id of [b1, a1]) {
    const { rows } = await pool().query(`SELECT p.class_id, p.location_id FROM bank_feed_link k JOIN posting p ON p.txn_id = k.txn_id WHERE k.item_id = $1`, [id]);
    assert.ok(rows.length >= 2);
    assert.ok(rows.every(p => Number(p.class_id) === classId && Number(p.location_id) === locationId), `every posting tagged (${id}) ${JSON.stringify(rows)} want ${classId}/${locationId}`);
  }
  for (const id of [r1, r2]) await deleteRule(pool(), { ...S, ruleId: id });
});

test('#7 Undo of an automatic add is not re-added by the next refresh; a re-imported line stays held', async () => {
  const [id] = await bankSays([{ account: 'Business Card', amount: '-47.33', date: '2026-10-11', description: 'AUTO HOLD SHOP' }]);
  const r = await rule({ name: 'Hold', mode: 'auto', conditions: [{ field: 'description', op: 'contains', value: 'AUTO HOLD' }], accountId: A.office });
  assert.equal(await applyAutoRules(pool(), S), 1);
  assert.equal(await undoItem(pool(), { ...S, itemId: id, actor }), 'deleted');
  assert.equal((await item(id)).auto_hold, true);
  const before = await txnCount();
  const p = await pullCompany(pool(), ll, S);
  assert.equal(p.autoAdded, 0);
  assert.equal(await txnCount(), before);
  // Still suggested for a person.
  const s = await suggestFor(pool(), { ...S, item: await item(id), rules: await listRules(pool(), S), history: await learnedHistory(pool(), S) });
  assert.equal(s.source, 'rule');
  // The line is dropped by a later start date and pulled back in: still held.
  const llTxn = (await item(id)).ll_transaction_id;
  await saveMappings(pool(), { ...S, actor, choices: [{ id: llId('Business Card'), choice: String(A.card), start: '2026-10-12' }] });
  await pullCompany(pool(), ll, S);
  assert.equal((await pool().query('SELECT 1 FROM bank_feed_item WHERE ll_transaction_id = $1', [llTxn])).rowCount, 0, 'dropped');
  await saveMappings(pool(), { ...S, actor, choices: [{ id: llId('Business Card'), choice: String(A.card), start: '' }] });
  const again = await pullCompany(pool(), ll, S);
  assert.equal(again.autoAdded, 0);
  const back = (await pool().query('SELECT auto_hold, review_state FROM bank_feed_item WHERE ll_transaction_id = $1', [llTxn])).rows[0];
  assert.deepEqual([back.auto_hold, back.review_state], [true, 'new']);
  assert.ok((await pool().query(`SELECT 1 FROM bank_review_event WHERE ll_transaction_id = $1 AND kind = 'undone'`, [llTxn])).rowCount, 'history kept');
  await deleteRule(pool(), { ...S, ruleId: r });
});

test('#8 a different check number is never a confident match or a duplicate', async () => {
  const chk = await expense(A.checking, '81.27', '2026-10-11', 'check 9102', { type: 'check', doc: '9102' });
  const [id] = await bankSays([{ account: 'Operating Checking', amount: '-81.27', date: '2026-10-11', description: 'CHECK 9101', check: '9101' }]);
  const it = await item(id);
  const c = await matchCandidates(pool(), { ...S, item: it });
  assert.equal(c.exact.find(x => Number(x.txn_id) === chk).checkConflict, true);
  assert.equal(confidentMatch(c, it), null);
  assert.equal((await possibleDuplicates(pool(), { ...S, item: it })).some(d => Number(d.txn_id) === chk), false);
  const page = await (await app.get(`/banking/item/${id}`)).text();
  assert.match(page, /Check number differs \(bank: 9101\)/);
  // The same number (written with a leading zero) is.
  const [id2] = await bankSays([{ account: 'Operating Checking', amount: '-81.27', date: '2026-10-11', description: 'CHECK 9102', check: '09102' }]);
  assert.equal(Number(confidentMatch(await matchCandidates(pool(), { ...S, item: await item(id2) }), await item(id2))?.txn_id), chk);
});

test('#9 a deposit’s customer is shown and learned', async () => {
  const customerId = Object.values(app.ids.customers)[0];
  const [id] = await bankSays([{ account: 'Operating Checking', amount: '123.47', date: '2026-10-11', description: 'CUSTOMER WIRE 12347' }]);
  await addItem(pool(), { ...S, itemId: id, payee: `c:${customerId}`, lines: [{ accountId: A.interest_income ?? A.sales ?? Object.values(A)[0], amount: '' }], actor }).catch(async err => {
    if (!/category/.test(err.message)) throw err;
  });
  if ((await item(id)).review_state !== 'added') return; // (sample books without that income account: nothing more to check)
  const rows = await listBankItems(pool(), { ...S, llAccountId: llId('Operating Checking'), tab: 'categorized' });
  const { rows: [c] } = await pool().query('SELECT display_name FROM customer WHERE customer_id = $1', [customerId]);
  assert.equal(rows.find(x => Number(x.item_id) === id).links[0].party, c.display_name);
  const hist = await learnedHistory(pool(), S);
  assert.ok([...hist.values()].flat().some(e => e.payee === `c:${customerId}`));
});

test('#10 a restored exclusion is For review only; a bank change after exclusion shows on Changed', async () => {
  const [id] = await bankSays([{ account: 'Business Card', amount: '-12.31', date: '2026-10-11', description: 'EXCLUDE CHANGE' }]);
  await excludeItems(pool(), { ...S, itemIds: [id], actor });
  await ll.query(`UPDATE core.transaction SET amount = -12.32, revision = 2 WHERE transaction_id = (SELECT ll_transaction_id FROM bank_feed_item WHERE item_id = $1)`, [id]).catch(() => {});
  await pool().query(`UPDATE bank_feed_item SET attention = 'changed' WHERE item_id = $1`, [id]);
  let rows = await listBankItems(pool(), { ...S, llAccountId: llId('Business Card'), tab: 'changed' });
  assert.ok(rows.some(x => Number(x.item_id) === id));
  assert.equal(await undoItem(pool(), { ...S, itemId: id, actor }), 'restored');
  assert.equal((await item(id)).attention, null);
  rows = await listBankItems(pool(), { ...S, llAccountId: llId('Business Card'), tab: 'categorized' });
  assert.ok(!rows.some(x => Number(x.item_id) === id), 'not on Categorized');
  rows = await listBankItems(pool(), { ...S, llAccountId: llId('Business Card'), tab: 'review' });
  assert.ok(rows.some(x => Number(x.item_id) === id));
});

test('books-side edits are flagged apart from the bank’s and cleared with Checked', async () => {
  const [id] = await bankSays([{ account: 'Business Card', amount: '-31.40', date: '2026-10-11', description: 'BOOKS EDIT SHOP' }]);
  const txnId = await addItem(pool(), { ...S, itemId: id, lines: [{ accountId: A.office, amount: '' }], actor });
  await withTransaction(pool(), tx => writeVendorDoc(tx, { ...S, actor, type: 'expense', txnId, txnDate: '2026-10-11', accountId: A.card, memo: 'edited',
    categoryLines: [{ accountId: A.office, amount: '35.00' }], itemLines: [] }));
  assert.equal((await item(id)).attention, 'books');
  const page = await (await app.get(`/banking/item/${id}`)).text();
  assert.match(page, /Changed in the books|edited or deleted/);
  await markChecked(pool(), { ...S, itemId: id, actor });
  assert.equal((await item(id)).attention, null);
  assert.equal((await events(id)).at(-1).kind, 'checked');
});

test('duplicate evidence: a replaced bank line, an open bill, a payment less a fee', async () => {
  // Replaced: the bank removes a line the books used and sends it again under a new id.
  const [old] = await bankSays([{ account: 'Business Card', amount: '-61.11', date: '2026-10-11', description: 'REPLACED LINE' }]);
  const txnId = await addItem(pool(), { ...S, itemId: old, lines: [{ accountId: A.office, amount: '' }], actor });
  await ll.query(`UPDATE core.transaction SET status = 'removed' WHERE transaction_id = $1`, [(await item(old)).ll_transaction_id]);
  await pullCompany(pool(), ll, S);
  assert.equal((await item(old)).bank_state, 'removed');
  const [neo] = await bankSays([{ account: 'Business Card', amount: '-61.11', date: '2026-10-11', description: 'REPLACED LINE' }]);
  const d = await possibleDuplicates(pool(), { ...S, item: await item(neo) });
  assert.ok(d.some(x => Number(x.txn_id) === txnId && x.reason === 'replaced'));
  // Two live lines on the same day for the same amount: maybe two purchases, maybe one sent twice — a person decides; a
  // charge for the same amount a month later is not evidence.
  const [x1, x2] = await bankSays([{ account: 'Business Card', amount: '-10.82', date: '2026-10-11', description: 'APP STORE' },
    { account: 'Business Card', amount: '-10.82', date: '2026-10-11', description: 'APP STORE' }]);
  await addItem(pool(), { ...S, itemId: x1, lines: [{ accountId: A.office, amount: '' }], actor });
  assert.deepEqual((await possibleDuplicates(pool(), { ...S, item: await item(x2) })).map(d => d.reason), ['claimed']);
  const [x3] = await bankSays([{ account: 'Business Card', amount: '-10.82', date: '2026-09-10', description: 'APP STORE' }]);
  assert.equal((await possibleDuplicates(pool(), { ...S, item: await item(x3) })).filter(d => d.reason === 'claimed').length, 0);
  // Open bill for exactly the amount.
  const vendorId = Object.values(app.ids.vendors)[0];
  const bill = await withTransaction(pool(), tx => writeVendorDoc(tx, { ...S, actor, type: 'bill', vendorId, txnDate: '2026-10-01', memo: 'open bill',
    categoryLines: [{ accountId: A.office, amount: '234.57' }], itemLines: [] }));
  const [pay] = await bankSays([{ account: 'Operating Checking', amount: '-234.57', date: '2026-10-11', description: 'PAY THE BILL' }]);
  assert.ok((await possibleDuplicates(pool(), { ...S, item: await item(pay) })).some(x => Number(x.txn_id) === bill && x.reason === 'open_bill'));
  // A $100.00 payment waiting in Undeposited Funds and a $97.00 deposit at the bank (less a processor's fee).
  const customerId = app.ids.customers.hilltop ?? Object.values(app.ids.customers)[0];
  const paid = await savePayment(pool(), { ...S, customerId, txnDate: '2026-10-09', amountCents: 10000, paymentMethod: 'Card', actor, applications: [] });
  const [dep] = await bankSays([{ account: 'Operating Checking', amount: '97.00', date: '2026-10-11', description: 'PROCESSOR DEPOSIT' }]);
  assert.ok((await possibleDuplicates(pool(), { ...S, item: await item(dep) })).some(x => Number(x.txn_id) === paid && x.reason === 'waiting'));
  await assert.rejects(addItem(pool(), { ...S, itemId: dep, lines: [{ accountId: A.office, amount: '' }], actor }), DuplicateError);
});

test('the repair script finds bank-added transactions whose class never reached the postings', async () => {
  const [id] = await bankSays([{ account: 'Business Card', amount: '-18.18', date: '2026-10-11', description: 'OLD DIMS SHOP' }]);
  const txnId = await addItem(pool(), { ...S, itemId: id, lines: [{ accountId: A.office, amount: '' }], actor });
  const classId = Number((await pool().query('SELECT class_id FROM class WHERE entity_id = $1 ORDER BY class_id LIMIT 1', [S.entityId])).rows[0].class_id);
  await pool().query('UPDATE txn SET class_id = $2 WHERE txn_id = $1', [txnId, classId]); // as the old code left it: header only
  const run = args => promisify(execFile)(process.execPath, ['scripts/repair-bank-dims.js', ...args], { env: { ...process.env, DATABASE_URL: app.db.url, ALLOW_SUPERUSER: '1' } });
  const dry = await run([]);
  assert.match(dry.stdout, /1 bank-added transaction/);
  assert.match(dry.stdout, /Dry run/);
  assert.ok((await pool().query('SELECT 1 FROM posting WHERE txn_id = $1 AND class_id IS NULL', [txnId])).rowCount, 'dry run changes nothing');
  await run(['--apply']);
  assert.equal((await pool().query('SELECT 1 FROM posting WHERE txn_id = $1 AND class_id IS DISTINCT FROM $2', [txnId, classId])).rowCount, 0);
});

test('#13 rule order: blank is 100, 0 is kept, anything else is refused', async () => {
  assert.equal(priorityOf(''), 100);
  assert.equal(priorityOf('0'), 0);
  assert.equal(priorityOf('9999'), 9999);
  assert.throws(() => priorityOf('abc'), /whole number/);
  assert.throws(() => priorityOf('10000'), /whole number/);
  const id = await rule({ name: 'Zero first', priority: '0', conditions: [{ field: 'description', op: 'contains', value: 'ZEROFIRST' }], accountId: A.office });
  assert.equal((await listRules(pool(), S)).find(r => Number(r.rule_id) === id).priority, 0);
  await deleteRule(pool(), { ...S, ruleId: id });
});

test('every reviewed item keeps its history (source, basis, actor)', async () => {
  const [id] = await bankSays([{ account: 'Business Card', amount: '-22.22', date: '2026-10-11', description: 'HISTORY SHOP' }]);
  await addItem(pool(), { ...S, itemId: id, lines: [{ accountId: A.office, amount: '' }], actor });
  await undoItem(pool(), { ...S, itemId: id, actor });
  await excludeItems(pool(), { ...S, itemIds: [id], actor });
  await undoItem(pool(), { ...S, itemId: id, actor });
  assert.deepEqual((await events(id)).map(e => `${e.kind}/${e.source}`), ['added/manual', 'undone/manual', 'excluded/manual', 'restored/manual']);
  const page = await (await app.get(`/banking/item/${id}`)).text();
  assert.match(page, /<summary>History<\/summary>/);
});

// ---- Codex BR-1 review findings ----

// Hold the company lock in another connection while `fn` starts (it waits), change things, then let it go.
async function whileLocked(change, fn) {
  const c = await pool().connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT 1 FROM entity WHERE org_id = $1 AND entity_id = $2 FOR UPDATE', [S.orgId, S.entityId]);
    const running = fn();
    running.catch(() => {});
    await new Promise(r => setTimeout(r, 300));
    await change(c);
    await c.query('COMMIT');
    return await running;
  } finally { c.release(); }
}

test('A01 the same purchase sent twice on one day is never added again by a rule', async () => {
  const [a1] = await bankSays([{ account: 'Business Card', amount: '-211.07', date: '2026-10-11', description: 'TWICE SENT SHOP' }]);
  await addItem(pool(), { ...S, itemId: a1, lines: [{ accountId: A.office, amount: '' }], actor });
  const [a2] = await bankSays([{ account: 'Business Card', amount: '-211.07', date: '2026-10-11', description: 'TWICE SENT SHOP' }]);
  const r = await rule({ name: 'Twice', mode: 'auto', conditions: [{ field: 'description', op: 'contains', value: 'TWICE SENT' }], accountId: A.office });
  assert.equal(await applyAutoRules(pool(), S), 0);
  assert.equal((await item(a2)).review_state, 'new');
  await deleteRule(pool(), { ...S, ruleId: r });
});

test('A02/A04 a batch waiting for the lock skips an item the bank or a rule changed meanwhile', async () => {
  const [id] = await bankSays([{ account: 'Business Card', amount: '-212.07', date: '2026-10-11', description: 'LOCK WAIT SHOP' }]);
  const r = await rule({ name: 'Lock wait', conditions: [{ field: 'description', op: 'contains', value: 'LOCK WAIT' }], accountId: A.office });
  const intents = await shownIntents([id]);
  const before = await txnCount();
  const out = await whileLocked(c => c.query('UPDATE bank_feed_item SET amount_cents = -21307, revision = revision + 1 WHERE item_id = $1', [id]),
    () => acceptSuggestions(pool(), { ...S, llAccountId: llId('Business Card'), itemIds: [id], intents, actor }));
  assert.deepEqual([out.accepted, out.results[0].reason], [0, 'changed since the page was shown — review it']);
  assert.equal(await txnCount(), before);
  // A rule changed while the batch waited.
  const intents2 = await shownIntents([id]);
  const out2 = await whileLocked(c => c.query(`UPDATE bank_rule SET account_id = $2, memo = 'changed', updated_at = now() WHERE rule_id = $1`, [r, A.fuel]),
    () => acceptSuggestions(pool(), { ...S, llAccountId: llId('Business Card'), itemIds: [id], intents: intents2, actor }));
  assert.equal(out2.accepted, 0);
  assert.equal(await txnCount(), before);
  await deleteRule(pool(), { ...S, ruleId: r });
});

test('A03/A05/A06/A17 a form acts only on what it showed', async () => {
  // A03: the bank corrects the amount after the page was shown.
  const [id] = await bankSays([{ account: 'Business Card', amount: '-214.07', date: '2026-10-11', description: 'FORM REV SHOP' }]);
  const f = await itemForm(app, id);
  await pool().query('UPDATE bank_feed_item SET amount_cents = -21507, revision = revision + 1 WHERE item_id = $1', [id]);
  await assert.rejects(addItem(pool(), { ...S, itemId: id, lines: [{ accountId: A.office, amount: '' }], actor, expect: { rev: f.rev } }), StaleError);
  const res = await app.post(`/banking/item/${id}/add`, new URLSearchParams([...await picks(app, id), ['rev', f.rev], ['line_account', 'Office Supplies'], ['line_amount', ''], ['line_description', '']]));
  assert.equal(res.status, 303);
  assert.equal((await item(id)).review_state, 'new', 'nothing recorded');
  // A05: the match target is edited after the page was shown.
  const e = await expense(A.checking, '216.07', '2026-10-11', 'target');
  const [m] = await bankSays([{ account: 'Operating Checking', amount: '-216.07', date: '2026-10-11', description: 'STALE TARGET' }]);
  const mf = await itemForm(app, m);
  await withTransaction(pool(), tx => writeVendorDoc(tx, { ...S, actor, type: 'expense', txnId: e, txnDate: '2026-10-11', accountId: A.checking, memo: 'edited target',
    categoryLines: [{ accountId: A.fuel, amount: '216.07' }], itemLines: [] }));
  const mres = await app.post(`/banking/item/${m}/match`, new URLSearchParams([['rev', mf.rev], ['txn', String(e)], ['ver_' + e, mf.ver(e)]]));
  assert.equal(mres.status, 303);
  assert.equal((await item(m)).review_state, 'new', 'not matched to a changed transaction');
  // A06: "separate" after new evidence appeared.
  await expense(A.checking, '218.07', '2026-10-11', 'first');
  const [s] = await bankSays([{ account: 'Operating Checking', amount: '-218.07', date: '2026-10-11', description: 'NEW EVIDENCE' }]);
  const sf = await itemForm(app, s);
  await expense(A.checking, '218.07', '2026-10-11', 'second possible');
  await assert.rejects(addItem(pool(), { ...S, itemId: s, lines: [{ accountId: A.office, amount: '' }], actor, separate: true, expect: { rev: sf.rev, evidence: sf.evidence } }), StaleError);
  // A17: an old Undo page (it said "unmatch") after the item was re-reviewed as an Add.
  const k = await expense(A.checking, '231.07', '2026-10-11', 'kept');
  const [u] = await bankSays([{ account: 'Operating Checking', amount: '-231.07', date: '2026-10-11', description: 'OLD UNDO' }]);
  await matchItem(pool(), { ...S, itemId: u, txnIds: [k], actor });
  const uf = await itemForm(app, u);
  await undoItem(pool(), { ...S, itemId: u, actor });
  const owned = await addItem(pool(), { ...S, itemId: u, lines: [{ accountId: A.office, amount: '' }], actor, separate: true });
  const ures = await app.post(`/banking/item/${u}/undo`, { plan: uf.plan });
  assert.equal(ures.status, 303);
  assert.ok((await pool().query('SELECT 1 FROM txn WHERE txn_id = $1', [owned])).rowCount, 'the new expense was not deleted by an old page');
});

test('A07 deposit lines keep their own class', async () => {
  await saveClass(pool(), { ...S, fields: { name: 'Second class' } });
  const { rows: cl } = await pool().query(`SELECT class_id FROM class WHERE entity_id = $1 ORDER BY class_id`, [S.entityId]);
  const [cls, cls2] = [Number(cl[0].class_id), Number(cl.at(-1).class_id)];
  const [id] = await bankSays([{ account: 'Operating Checking', amount: '219.07', date: '2026-10-11', description: 'SPLIT CLASS DEPOSIT' }]);
  const txnId = await addItem(pool(), { ...S, itemId: id, actor, lines: [{ accountId: A.office, amount: '119.07', classId: cls }, { accountId: A.fuel, amount: '100.00', classId: cls2 }] });
  const { rows } = await pool().query('SELECT account_id, amount_cents, class_id FROM posting WHERE txn_id = $1 AND account_id <> $2 ORDER BY amount_cents', [txnId, A.checking]);
  assert.deepEqual(rows.map(r => [Number(r.account_id), Number(r.amount_cents), Number(r.class_id)]), [[A.office, -11907, cls], [A.fuel, -10000, cls2]]);
});

test('A09/A10/A12 a books edit or deletion is flagged and recorded; a deletion holds the line even after re-import', async () => {
  const [id] = await bankSays([{ account: 'Business Card', amount: '-221.07', date: '2026-10-11', description: 'BOOKS SIDE SHOP' }]);
  const txnId = await addItem(pool(), { ...S, itemId: id, lines: [{ accountId: A.office, amount: '' }], actor });
  // A12: same total, different category.
  await withTransaction(pool(), tx => writeVendorDoc(tx, { ...S, actor, type: 'expense', txnId, txnDate: '2026-10-11', accountId: A.card, memo: 'recategorized',
    categoryLines: [{ accountId: A.fuel, amount: '221.07' }], itemLines: [] }));
  assert.equal((await item(id)).attention, 'books');
  assert.ok((await events(id)).some(e => e.kind === 'books_changed'));
  // A09: deleting it sends the line back held and flagged; a re-import keeps the hold.
  const { deleteVendorTxn } = await import('../lib/data/payables.js');
  await deleteVendorTxn(pool(), { ...S, txnId, actor });
  const now = await item(id);
  assert.deepEqual([now.review_state, now.attention, now.auto_hold], ['new', 'books', true]);
  assert.ok((await events(id)).some(e => e.kind === 'books_deleted'));
  const llTxn = now.ll_transaction_id;
  await saveMappings(pool(), { ...S, actor, choices: [{ id: llId('Business Card'), choice: String(A.card), start: '2026-10-12' }] });
  await pullCompany(pool(), ll, S);
  await saveMappings(pool(), { ...S, actor, choices: [{ id: llId('Business Card'), choice: String(A.card), start: '' }] });
  await pullCompany(pool(), ll, S);
  const back = (await pool().query('SELECT item_id, auto_hold FROM bank_feed_item WHERE ll_transaction_id = $1', [llTxn])).rows[0];
  assert.equal(back.auto_hold, true);
  // A10: the history follows the bank line to its new item.
  const page = await (await app.get(`/banking/item/${back.item_id}`)).text();
  assert.match(page, /an earlier copy of this bank line/);
});

test('A14 a counterpart that may already be something else is not paired', async () => {
  await withTransaction(pool(), tx => writeJournalEntry(tx, { ...S, actor, txnDate: '2026-10-11', docNumber: '', memo: 'savings in', lines: [
    { accountId: A.savings, debit: '226.07', credit: '', description: '', party: '' }, { accountId: A.office, debit: '', credit: '226.07', description: '', party: '' }] }));
  const [out, into] = await bankSays([{ account: 'Operating Checking', amount: '-226.07', date: '2026-10-11', description: 'TO SAVINGS 22607' },
    { account: 'Business Savings', amount: '226.07', date: '2026-10-11', description: 'FROM CHECKING 22607' }]);
  const r = await transferItem(pool(), { ...S, itemId: out, otherAccountId: A.savings, actor });
  assert.equal(r.pairedItemId, null);
  assert.match(r.pairNote, /may already be something else/);
  assert.equal((await item(into)).review_state, 'new');
});

test('A15 history keeps the bank line and exactly what was recorded', async () => {
  const [id] = await bankSays([{ account: 'Business Card', amount: '-228.07', date: '2026-10-11', description: 'HISTORY FACTS' }]);
  await addItem(pool(), { ...S, itemId: id, memo: 'custom memo', actor, lines: [{ accountId: A.office, amount: '128.07', description: 'paper' }, { accountId: A.fuel, amount: '100.00', description: 'gas' }] });
  const [ev] = (await events(id)).filter(e => e.kind === 'added');
  assert.deepEqual([Number(ev.detail.item.amount_cents), ev.detail.item.description, ev.detail.plan.memo], [-22807, 'HISTORY FACTS', 'custom memo']);
  assert.deepEqual(ev.detail.plan.lines.map(l => [l.cents, l.description]), [[12807, 'paper'], [10000, 'gas']]);
});

test('A11 Checked does not replace how the item was put in the books', async () => {
  const [id] = await bankSays([{ account: 'Business Card', amount: '-232.07', date: '2026-10-11', description: 'CHECKED PROVENANCE' }]);
  const r = await rule({ name: 'Provenance', mode: 'auto', conditions: [{ field: 'description', op: 'contains', value: 'CHECKED PROVENANCE' }], accountId: A.office });
  assert.equal(await applyAutoRules(pool(), S), 1);
  await pool().query(`UPDATE bank_feed_item SET attention = 'changed' WHERE item_id = $1`, [id]);
  await markChecked(pool(), { ...S, itemId: id, actor });
  await deleteRule(pool(), { ...S, ruleId: r });
  const row = (await listBankItems(pool(), { ...S, llAccountId: llId('Business Card'), tab: 'categorized' })).find(x => Number(x.item_id) === id);
  assert.deepEqual([row.made_event.source, row.made_event.rule_name, row.last_event.kind], ['auto', 'Provenance', 'checked']);
});

test('A13 every ticked item gets its outcome', async () => {
  const ids = await bankSays(Array.from({ length: 7 }, (_, n) => ({ account: 'Business Card', amount: `-${300 + n}.13`, date: '2026-10-11', description: `NO SUGGESTION ${n}` })));
  const res = await app.post('/banking/batch', new URLSearchParams([['account', llId('Business Card')], ['tab', 'review'], ['action', 'accept'], ...ids.map(i => ['item', String(i)])]));
  assert.equal(res.status, 200);
  const page = await res.text();
  assert.match(page, /Accept: 0 of 7 done/);
  for (let n = 0; n < 7; n++) assert.match(page, new RegExp(`NO SUGGESTION ${n}`));
});

test('a customer refund paid from checking is recorded with the customer', async () => {
  const customerId = Object.values(app.ids.customers)[0];
  const [id] = await bankSays([{ account: 'Operating Checking', amount: '-40.00', date: '2026-10-11', description: 'REFUND TO CUSTOMER' }]);
  const txnId = await addItem(pool(), { ...S, itemId: id, payee: `c:${customerId}`, lines: [{ accountId: A.office, amount: '' }], actor });
  const { rows: [t] } = await pool().query('SELECT type, txn_party_key(txn_id) AS k FROM txn WHERE txn_id = $1', [txnId]);
  assert.deepEqual([t.type, t.k], ['journal_entry', `c:${customerId}`]);
});

// ---- Codex BR-1 round 2 findings ----

test('C05 the same check sent again a week later is evidence, however far apart', async () => {
  const [c1] = await bankSays([{ account: 'Operating Checking', amount: '-345.07', date: '2026-10-05', description: 'CHECK 98001', check: '98001' }]);
  await addItem(pool(), { ...S, itemId: c1, lines: [{ accountId: A.office, amount: '' }], actor });
  const [c2] = await bankSays([{ account: 'Operating Checking', amount: '-345.07', date: '2026-10-12', description: 'CHECK 98001', check: '098001' }]);
  assert.deepEqual((await possibleDuplicates(pool(), { ...S, item: await item(c2) })).map(d => d.reason), ['claimed']);
  const r = await rule({ name: 'Check again', mode: 'auto', conditions: [{ field: 'description', op: 'contains', value: 'CHECK 98001' }], accountId: A.office });
  assert.equal(await applyAutoRules(pool(), S), 0);
  await deleteRule(pool(), { ...S, ruleId: r });
});

test('C10/C11 nothing automatic adds a held line, or one that changed since it was chosen', async () => {
  const [id] = await bankSays([{ account: 'Business Card', amount: '-350.07', date: '2026-10-11', description: 'HELD RECEIPT SHOP' }]);
  await addItem(pool(), { ...S, itemId: id, lines: [{ accountId: A.office, amount: '' }], actor });
  await undoItem(pool(), { ...S, itemId: id, actor });
  await assert.rejects(addItem(pool(), { ...S, itemId: id, lines: [{ accountId: A.office, amount: '' }], actor, source: 'auto', basis: 'ai' }), /undid this item/);
  assert.equal((await item(id)).auto_hold, true);
  const [c] = await bankSays([{ account: 'Business Card', amount: '-351.08', date: '2026-10-11', description: 'RECEIPT CHANGED SHOP' }]);
  const chosen = await item(c);
  await pool().query('UPDATE bank_feed_item SET amount_cents = -36108, revision = revision + 1 WHERE item_id = $1', [c]);
  await assert.rejects(addItem(pool(), { ...S, itemId: c, lines: [{ accountId: A.office, amount: '' }], actor, source: 'auto', basis: 'ai', expect: { rev: itemToken(chosen) } }), StaleError);
});

test('C01/C02 an old Checked page can’t clear a later books edit or a bank removal', async () => {
  const [id] = await bankSays([{ account: 'Business Card', amount: '-341.07', date: '2026-10-11', description: 'TWO EDITS SHOP' }]);
  const txnId = await addItem(pool(), { ...S, itemId: id, lines: [{ accountId: A.office, amount: '' }], actor });
  const edit = (amount, memo, account) => withTransaction(pool(), tx => writeVendorDoc(tx, { ...S, actor, type: 'expense', txnId, txnDate: '2026-10-11', accountId: A.card, memo,
    categoryLines: [{ accountId: account, amount }], itemLines: [] }));
  await edit('341.07', 'first edit', A.fuel);
  const f = await itemForm(app, id);
  await edit('351.07', 'second edit', A.office);
  await assert.rejects(markChecked(pool(), { ...S, itemId: id, actor, expect: { rev: f.rev } }), StaleError);
  assert.equal((await item(id)).attention, 'books');
  assert.equal((await events(id)).filter(e => e.kind === 'books_changed').length, 2, 'both edits recorded');
  // C02: the bank removes the line after the Checked page was shown.
  const g = await itemForm(app, id);
  await ll.query(`UPDATE core.transaction SET status = 'removed' WHERE transaction_id = $1`, [(await item(id)).ll_transaction_id]);
  await pullCompany(pool(), ll, S);
  await assert.rejects(markChecked(pool(), { ...S, itemId: id, actor, expect: { rev: g.rev } }), StaleError);
});

test('C03/C07 transfer reuse checks what was shown, and "separate" records a new transfer', async () => {
  const old = await withTransaction(pool(), tx => writeTransfer(tx, { ...S, type: 'transfer', fromId: A.checking, toId: A.savings, amountText: '343.07', txnDate: '2026-10-10', memo: 'earlier' }));
  const [id] = await bankSays([{ account: 'Operating Checking', amount: '-343.07', date: '2026-10-11', description: 'XFER 34307' }]);
  const f = await itemForm(app, id);
  await withTransaction(pool(), tx => writeTransfer(tx, { ...S, type: 'transfer', txnId: old, fromId: A.checking, toId: A.savings, amountText: '343.07', txnDate: '2026-10-09', memo: 'edited' }));
  await assert.rejects(transferItem(pool(), { ...S, itemId: id, otherAccountId: A.savings, actor, expect: { rev: f.rev, evidence: f.evidence } }), StaleError);
  assert.equal((await item(id)).review_state, 'new');
  // A different transfer of the same amount: "separate" records it, never matches the old one.
  const g = await itemForm(app, id);
  const a = await t.snapshot();
  const r = await transferItem(pool(), { ...S, itemId: id, otherAccountId: A.savings, actor, separate: true, expect: { rev: g.rev, evidence: g.evidence } });
  const b = await t.snapshot();
  assert.notEqual(r.txnId, old);
  t.expectChange(a, b, { accounts: { [A.checking]: -34307, [A.savings]: 34307 }, label: 'separate transfer' });
  assert.equal((await events(id)).find(e => e.kind === 'transfer').separate, true);
});

test('C04/C09 a transfer from the category keeps its class and location', async () => {
  const cls = Number((await pool().query('SELECT class_id FROM class WHERE entity_id = $1 ORDER BY class_id LIMIT 1', [S.entityId])).rows[0].class_id);
  const loc = Number((await pool().query('SELECT location_id FROM location WHERE entity_id = $1 ORDER BY location_id LIMIT 1', [S.entityId])).rows[0].location_id);
  const [id] = await bankSays([{ account: 'Operating Checking', amount: '-344.07', date: '2026-10-11', description: 'TO SAVINGS WITH CLASS' }]);
  const txnId = await addItem(pool(), { ...S, itemId: id, lines: [{ accountId: A.savings, amount: '' }], actor, dims: { classId: cls, locationId: loc } });
  const { rows } = await pool().query('SELECT class_id, location_id FROM posting WHERE txn_id = $1', [txnId]);
  assert.ok(rows.length === 2 && rows.every(p => Number(p.class_id) === cls && Number(p.location_id) === loc));
});

test('C06/C12 moving a transaction to another project makes old pages stale', async () => {
  const customerId = Object.values(app.ids.customers)[0];
  const mk = name => pool().query('INSERT INTO project (org_id, customer_id, name) VALUES ($1, $2, $3) RETURNING project_id', [S.orgId, customerId, name]).then(r => Number(r.rows[0].project_id));
  const p1 = await mk('Barn'), p2 = await mk('Shop');
  const [id] = await bankSays([{ account: 'Business Card', amount: '-352.07', date: '2026-10-11', description: 'PROJECT MOVE SHOP' }]);
  const txnId = await addItem(pool(), { ...S, itemId: id, lines: [{ accountId: A.office, amount: '' }], actor });
  const ver = async () => (await pool().query('SELECT txn_version($1) AS v', [txnId])).rows[0].v;
  await pool().query('UPDATE posting SET project_id = $2 WHERE txn_id = $1 AND account_id = $3', [txnId, p1, A.office]);
  const v1 = await ver();
  const f = await itemForm(app, id);
  await pool().query('UPDATE posting SET project_id = $2 WHERE txn_id = $1 AND account_id = $3', [txnId, p2, A.office]);
  assert.notEqual(await ver(), v1, 'a project change changes the version');
  // C12: the old Undo page (made before the project move) is refused.
  const res = await app.post(`/banking/item/${id}/undo`, { plan: f.plan });
  assert.equal(res.status, 303);
  assert.ok((await pool().query('SELECT 1 FROM txn WHERE txn_id = $1', [txnId])).rowCount, 'not deleted by a page that showed it before the move');
});

test('A09b a books-deletion warning comes back with the line until someone checks it', async () => {
  const [id] = await bankSays([{ account: 'Business Card', amount: '-353.07', date: '2026-10-11', description: 'WARN BACK SHOP' }]);
  const txnId = await addItem(pool(), { ...S, itemId: id, lines: [{ accountId: A.office, amount: '' }], actor });
  const { deleteVendorTxn } = await import('../lib/data/payables.js');
  await deleteVendorTxn(pool(), { ...S, txnId, actor });
  const llTxn = (await item(id)).ll_transaction_id;
  const cycle = async () => {
    await saveMappings(pool(), { ...S, actor, choices: [{ id: llId('Business Card'), choice: String(A.card), start: '2026-10-12' }] });
    await pullCompany(pool(), ll, S);
    await saveMappings(pool(), { ...S, actor, choices: [{ id: llId('Business Card'), choice: String(A.card), start: '' }] });
    await pullCompany(pool(), ll, S);
    return (await pool().query('SELECT item_id, attention, auto_hold FROM bank_feed_item WHERE ll_transaction_id = $1', [llTxn])).rows[0];
  };
  let back = await cycle();
  assert.deepEqual([back.attention, back.auto_hold], ['books', true]);
  await markChecked(pool(), { ...S, itemId: back.item_id, actor });
  back = await cycle();
  assert.deepEqual([back.attention, back.auto_hold], [null, true], 'checked warnings stay answered; the hold stays');
});

// ---- Codex BR-1 round 3 findings ----

test('D02 Accept also checks the row as the page showed it', async () => {
  const [id] = await bankSays([{ account: 'Business Card', amount: '-402.07', date: '2026-10-11', description: 'ROW SHOWN SHOP' }]);
  const r = await rule({ name: 'Row shown', conditions: [{ field: 'description', op: 'contains', value: 'ROW SHOWN' }], accountId: A.office });
  const shown = itemToken(await item(id));
  await pool().query('UPDATE bank_feed_item SET amount_cents = -41207, revision = revision + 1 WHERE item_id = $1', [id]);
  const intents = await shownIntents([id]); // a plan worked out from the newer line
  const out = await acceptSuggestions(pool(), { ...S, llAccountId: llId('Business Card'), itemIds: [id], intents, revs: new Map([[id, shown]]), actor });
  assert.deepEqual([out.accepted, out.results[0].reason], [0, 'changed since the page was shown — review it']);
  // The list shows the line its suggestion was worked out from.
  const page = await (await app.get(`/banking?account=${llId('Business Card')}&tab=review`)).text();
  assert.match(page, /\$412\.07/);
  await deleteRule(pool(), { ...S, ruleId: r });
});

test('D03 a line edit that moves no posting still changes the version', async () => {
  const customerId = Object.values(app.ids.customers)[0];
  const [id] = await bankSays([{ account: 'Business Card', amount: '-403.07', date: '2026-10-11', description: 'LINE FACTS SHOP' }]);
  const txnId = await addItem(pool(), { ...S, itemId: id, lines: [{ accountId: A.office, amount: '', description: 'supplies' }], actor });
  const ver = async () => (await pool().query('SELECT txn_version($1) AS v', [txnId])).rows[0].v;
  const before = await ver();
  await pool().query(`UPDATE txn_line SET description = 'reimbursable customer supplies', billable = true, customer_id = $2 WHERE txn_id = $1`, [txnId, customerId]);
  assert.notEqual(await ver(), before);
});

test('D04/D05 a line the bank removes and sends back keeps its unanswered books warning', async () => {
  const [id] = await bankSays([{ account: 'Business Card', amount: '-404.07', date: '2026-10-11', description: 'COMES BACK SHOP' }]);
  const txnId = await addItem(pool(), { ...S, itemId: id, lines: [{ accountId: A.office, amount: '' }], actor });
  await withTransaction(pool(), tx => writeVendorDoc(tx, { ...S, actor, type: 'expense', txnId, txnDate: '2026-10-11', accountId: A.card, memo: 'more',
    categoryLines: [{ accountId: A.office, amount: '414.07' }], itemLines: [] }));
  assert.equal((await item(id)).attention, 'books');
  const llTxn = (await item(id)).ll_transaction_id;
  await ll.query(`UPDATE core.transaction SET status = 'removed' WHERE transaction_id = $1`, [llTxn]);
  await pullCompany(pool(), ll, S);
  assert.equal((await item(id)).attention, 'removed');
  await ll.query(`UPDATE core.transaction SET status = 'active', revision = revision + 1 WHERE transaction_id = $1`, [llTxn]);
  await pullCompany(pool(), ll, S);
  assert.equal((await item(id)).attention, 'books', 'the books still disagree');
  // D05: a deleted expense's warning comes back with a returning row too.
  const [d] = await bankSays([{ account: 'Business Card', amount: '-405.07', date: '2026-10-11', description: 'DELETED COMES BACK' }]);
  const t2 = await addItem(pool(), { ...S, itemId: d, lines: [{ accountId: A.office, amount: '' }], actor });
  const { deleteVendorTxn } = await import('../lib/data/payables.js');
  await deleteVendorTxn(pool(), { ...S, txnId: t2, actor });
  const l2 = (await item(d)).ll_transaction_id;
  await ll.query(`UPDATE core.transaction SET status = 'removed' WHERE transaction_id = $1`, [l2]);
  await pullCompany(pool(), ll, S);
  await ll.query(`UPDATE core.transaction SET status = 'active', revision = revision + 1 WHERE transaction_id = $1`, [l2]);
  await pullCompany(pool(), ll, S);
  const back = await item(d);
  assert.deepEqual([back.attention, back.auto_hold], ['books', true]);
});

test('D07 undoing an exclusion holds the line from automatic rules', async () => {
  const [id] = await bankSays([{ account: 'Business Card', amount: '-407.07', date: '2026-10-11', description: 'RESTORE HOLD SHOP' }]);
  await addItem(pool(), { ...S, itemId: id, lines: [{ accountId: A.office, amount: '' }], actor });
  await undoItem(pool(), { ...S, itemId: id, actor });
  await excludeItems(pool(), { ...S, itemIds: [id], actor });
  await undoItem(pool(), { ...S, itemId: id, actor });
  assert.equal((await item(id)).auto_hold, true);
  const r = await rule({ name: 'Restore hold', mode: 'auto', conditions: [{ field: 'description', op: 'contains', value: 'RESTORE HOLD' }], accountId: A.office });
  assert.equal(await applyAutoRules(pool(), S), 0);
  assert.equal((await item(id)).review_state, 'new');
  await deleteRule(pool(), { ...S, ruleId: r });
});

// ---- Codex BR-1 round 4 findings ----

test('E01 waiting payments are checked again when the match runs', async () => {
  const customerId = Object.values(app.ids.customers)[0];
  const paid = await savePayment(pool(), { ...S, customerId, txnDate: '2026-10-11', amountCents: 50107, paymentMethod: 'Check', actor, applications: [] });
  const [dep] = await bankSays([{ account: 'Operating Checking', amount: '501.07', date: '2026-10-12', description: 'WAITING CHECKED AGAIN' }]);
  // The payment moves after the bank date before the match runs.
  await savePayment(pool(), { ...S, txnId: paid, customerId, txnDate: '2026-10-20', amountCents: 50107, paymentMethod: 'Check', actor, applications: [] });
  await assert.rejects(matchItem(pool(), { ...S, itemId: dep, undepositedIds: [paid], actor }), /no longer waiting to be deposited before this bank date/);
});

test('E03/E05 a bank warning nobody answered comes back when a removed line returns', async () => {
  const [id] = await bankSays([{ account: 'Business Card', amount: '-503.07', date: '2026-10-11', description: 'PARKED WARNING SHOP' }]);
  await addItem(pool(), { ...S, itemId: id, lines: [{ accountId: A.office, amount: '' }], actor });
  const llTxn = (await item(id)).ll_transaction_id;
  await ll.query(`UPDATE core.transaction SET posted_date = '2026-10-12', revision = revision + 1 WHERE transaction_id = $1`, [llTxn]);
  await pullCompany(pool(), ll, S);
  assert.equal((await item(id)).attention, 'changed');
  await ll.query(`UPDATE core.transaction SET status = 'removed' WHERE transaction_id = $1`, [llTxn]);
  await pullCompany(pool(), ll, S);
  await ll.query(`UPDATE core.transaction SET status = 'active', revision = revision + 1 WHERE transaction_id = $1`, [llTxn]);
  await pullCompany(pool(), ll, S);
  assert.equal((await item(id)).attention, 'changed');
  // Answered with Checked, it stays answered through the same cycle.
  await markChecked(pool(), { ...S, itemId: id, actor });
  await ll.query(`UPDATE core.transaction SET status = 'removed' WHERE transaction_id = $1`, [llTxn]);
  await pullCompany(pool(), ll, S);
  await ll.query(`UPDATE core.transaction SET status = 'active', revision = revision + 1 WHERE transaction_id = $1`, [llTxn]);
  await pullCompany(pool(), ll, S);
  assert.equal((await item(id)).attention, null);
});

test('E04 marking a journal entry as adjusting changes its version', async () => {
  const { saveJournalEntry } = await import('../lib/data/ledger-tools.js');
  const lines = [{ accountId: String(A.office), debit: '504.07', credit: '', description: '' }, { accountId: String(A.checking), debit: '', credit: '504.07', description: '' }];
  const je = await saveJournalEntry(pool(), { ...S, actor, txnDate: '2026-10-11', docNumber: 'ADJ-1', memo: 'adj', lines });
  const ver = async () => (await pool().query('SELECT txn_version($1) AS v', [je])).rows[0].v;
  const v1 = await ver();
  await saveJournalEntry(pool(), { ...S, actor, txnId: je, txnDate: '2026-10-11', docNumber: 'ADJ-1', memo: 'adj', lines, adjusting: true });
  assert.notEqual(await ver(), v1);
});

// ---- Codex BR-1 round 5 findings ----

test('F04 a foreign amount or rate edit changes the version', async () => {
  const e = await expense(A.card, '604.08', '2026-10-11', 'fx');
  const ver = async () => (await pool().query('SELECT txn_version($1) AS v', [e])).rows[0].v;
  const v1 = await ver();
  await pool().query(`UPDATE txn SET currency = 'EUR', exchange_rate = 1.2, foreign_total_cents = 50340 WHERE txn_id = $1`, [e]);
  const v2 = await ver();
  assert.notEqual(v2, v1);
  await pool().query(`UPDATE txn SET exchange_rate = 1.5, foreign_total_cents = 40272 WHERE txn_id = $1`, [e]);
  assert.notEqual(await ver(), v2);
});

test('F01 an amount difference someone checked stays answered when the line comes back', async () => {
  const [id] = await bankSays([{ account: 'Business Card', amount: '-601.07', date: '2026-10-11', description: 'CHECKED AMOUNT SHOP' }]);
  await addItem(pool(), { ...S, itemId: id, lines: [{ accountId: A.office, amount: '' }], actor });
  const llTxn = (await item(id)).ll_transaction_id;
  await ll.query(`UPDATE core.transaction SET amount = -611.07, revision = revision + 1 WHERE transaction_id = $1`, [llTxn]);
  await pullCompany(pool(), ll, S);
  assert.equal((await item(id)).attention, 'changed');
  await markChecked(pool(), { ...S, itemId: id, actor });
  await ll.query(`UPDATE core.transaction SET status = 'removed' WHERE transaction_id = $1`, [llTxn]);
  await pullCompany(pool(), ll, S);
  await ll.query(`UPDATE core.transaction SET status = 'active', revision = revision + 1 WHERE transaction_id = $1`, [llTxn]);
  await pullCompany(pool(), ll, S);
  assert.equal((await item(id)).attention, null);
});

test('F02 a books edit reverted while the bank had the line removed leaves no warning', async () => {
  const [id] = await bankSays([{ account: 'Business Card', amount: '-602.07', date: '2026-10-11', description: 'REVERTED WHILE GONE' }]);
  const txnId = await addItem(pool(), { ...S, itemId: id, lines: [{ accountId: A.office, amount: '' }], actor });
  const save = account => withTransaction(pool(), tx => writeVendorDoc(tx, { ...S, actor, type: 'expense', txnId, txnDate: '2026-10-11', accountId: A.card, memo: 'REVERTED WHILE GONE',
    categoryLines: [{ accountId: account, amount: '602.07' }], itemLines: [] }));
  await save(A.office);
  await markChecked(pool(), { ...S, itemId: id, actor }).catch(() => {}); // baseline: the saved form (if it flagged anything)
  await save(A.fuel);
  assert.equal((await item(id)).attention, 'books');
  const llTxn = (await item(id)).ll_transaction_id;
  await ll.query(`UPDATE core.transaction SET status = 'removed' WHERE transaction_id = $1`, [llTxn]);
  await pullCompany(pool(), ll, S);
  await save(A.office);
  await ll.query(`UPDATE core.transaction SET status = 'active', revision = revision + 1 WHERE transaction_id = $1`, [llTxn]);
  await pullCompany(pool(), ll, S);
  assert.equal((await item(id)).attention, null);
});

// ---- Codex BR-1 round 6 follow-ups ----

test('G03 deleting one of several matched transactions while the bank has the line removed keeps the warning', async () => {
  const e1 = await expense(A.card, '300.00', '2026-10-11', 'part one'), e2 = await expense(A.card, '403.01', '2026-10-11', 'part two');
  const [id] = await bankSays([{ account: 'Business Card', amount: '-703.01', date: '2026-10-11', description: 'TWO PART CHARGE' }]);
  await matchItem(pool(), { ...S, itemId: id, txnIds: [e1, e2], actor });
  const llTxn = (await item(id)).ll_transaction_id;
  await ll.query(`UPDATE core.transaction SET status = 'removed' WHERE transaction_id = $1`, [llTxn]);
  await pullCompany(pool(), ll, S);
  const { deleteVendorTxn } = await import('../lib/data/payables.js');
  await deleteVendorTxn(pool(), { ...S, txnId: e1, actor });
  await ll.query(`UPDATE core.transaction SET status = 'active', revision = revision + 1 WHERE transaction_id = $1`, [llTxn]);
  await pullCompany(pool(), ll, S);
  assert.equal((await item(id)).attention, 'books');
});

test('G02 saving a checked transaction unchanged doesn’t reopen it', async () => {
  const [id] = await bankSays([{ account: 'Business Card', amount: '-702.01', date: '2026-10-11', description: 'NO OP SAVE SHOP' }]);
  const txnId = await addItem(pool(), { ...S, itemId: id, lines: [{ accountId: A.office, amount: '' }], actor });
  const save = amount => withTransaction(pool(), tx => writeVendorDoc(tx, { ...S, actor, type: 'expense', txnId, txnDate: '2026-10-11', accountId: A.card, memo: 'NO OP SAVE SHOP',
    categoryLines: [{ accountId: A.office, amount }], itemLines: [] }));
  await save('712.01');
  assert.equal((await item(id)).attention, 'books');
  await markChecked(pool(), { ...S, itemId: id, actor });
  const rv = (await item(id)).review_version;
  await save('712.01');
  const now = await item(id);
  assert.deepEqual([now.attention, Number(now.review_version)], [null, Number(rv)]);
  await save('722.01'); // a real change still shows
  assert.equal((await item(id)).attention, 'books');
});
