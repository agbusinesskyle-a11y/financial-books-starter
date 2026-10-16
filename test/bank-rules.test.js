import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './app-harness.js';
import { freshDb } from './harness.js';
import { tieout } from './tieout.js';
import { buildSampleFeed, writeLedgerlineSample, sampleUuid } from '../lib/bankfeed/sample.js';
import { pullCompany } from '../lib/bankfeed/pull.js';
import { linkCompany, saveMappings } from '../lib/data/bankfeeds.js';
import { addItem, getBankItem } from '../lib/data/banking.js';
import { ruleFits, payeeKey, saveRule, getRule, listRules, learnedHistory, suggestFor, acceptSuggestions, intentOf } from '../lib/bankfeed/rules.js';
import { canAccess } from '../lib/domain/roles.js';

// Stage B4: bank rules (suggest or add automatically) and suggestions learned from how earlier items were added.
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
  // Four Shell fill-ups on the card, nobody entered them.
  for (const [n, d] of [[1, '2026-09-02'], [2, '2026-09-09'], [3, '2026-09-16'], [4, '2026-09-23']]) {
    feed.items.push({ id: sampleUuid('shell', n), account: llId('Business Card'), revision: 1, pending: false, status: 'active', posted_date: d,
      amount: `-${50 + n}.00`, description: `SHELL OIL 5744${n} PLAINVIEW TX`, merchant: 'Shell', channel: 'in store' });
  }
  await writeLedgerlineSample(ll, feed);
  await app.db.pool.query('UPDATE org SET ledgerline_org_id = $1 WHERE org_id = $2', [feed.org, app.ids.orgId]);
  await linkCompany(pool(), ll, { ...S, llEntityId: feed.entities[0].id, actor });
  await pullCompany(pool(), ll, S);
  await saveMappings(pool(), { ...S, actor, choices: [
    { id: llId('Operating Checking'), choice: String(A.checking) }, { id: llId('Business Savings'), choice: String(A.savings) },
    { id: llId('Business Card'), choice: String(A.card) }, { id: llId('Equipment Loan'), choice: 'skip' }] });
  await pullCompany(pool(), ll, S);
  t = tieout(app);
});
after(async () => { await app.close(); await llDb.drop(); });

// Accept the way the list does: each ticked item carries the plan its suggestion showed.
async function acceptShown(llAccountId, itemIds) {
  const rules = await listRules(pool(), S), history = await learnedHistory(pool(), S);
  const intents = new Map();
  for (const id of itemIds) {
    const item = await getBankItem(pool(), { ...S, itemId: id });
    const i = intentOf(await suggestFor(pool(), { ...S, item, rules, history }), item);
    if (i) intents.set(Number(id), i);
  }
  return (await acceptSuggestions(pool(), { ...S, llAccountId, itemIds, intents, actor })).accepted;
}

const itemsLike = async (pattern, state = 'new') => (await pool().query(`SELECT item_id FROM bank_feed_item WHERE entity_id = $1 AND description LIKE $2 AND review_state = $3
  ORDER BY posted_date, item_id`, [S.entityId, pattern, state])).rows.map(r => Number(r.item_id));

test('payee keys drop store numbers, references and banking words', () => {
  assert.equal(payeeKey('TRACTOR SUPPLY #1234 LUBBOCK TX'), 'TRACTOR SUPPLY LUBBOCK');
  assert.equal(payeeKey('SHELL OIL 57444 PLAINVIEW TX'), payeeKey('SHELL OIL 57441 PLAINVIEW TX'));
  assert.equal(payeeKey('ACH DEBIT XCEL ENERGY'), 'XCEL ENERGY');
  assert.equal(payeeKey('POS PURCHASE AMZN MKTP US*2K4LM9'), 'AMZN MKTP US');
  assert.equal(payeeKey('12345 #99'), '');
});

test('rule conditions: direction, account, text and amount, all or any', () => {
  const item = { amount_cents: -6102, description: 'SHELL OIL 57444 PLAINVIEW TX', merchant_name: 'Shell', ll_account: 'card-1' };
  const rule = (more) => ({ active: true, money: 'out', ll_account_id: null, match_all: true, conditions: [{ field: 'description', op: 'contains', value: 'shell' }], ...more });
  assert.equal(ruleFits(rule(), item), true, 'case-insensitive contains');
  assert.equal(ruleFits(rule({ money: 'in' }), item), false);
  assert.equal(ruleFits(rule({ ll_account_id: 'other' }), item), false);
  assert.equal(ruleFits(rule({ ll_account_id: 'card-1' }), item), true);
  assert.equal(ruleFits(rule({ active: false }), item), false);
  assert.equal(ruleFits(rule({ conditions: [{ field: 'description', op: 'starts', value: 'SHELL OIL' }] }), item), true);
  assert.equal(ruleFits(rule({ conditions: [{ field: 'description', op: 'is', value: 'SHELL' }] }), item), false);
  assert.equal(ruleFits(rule({ conditions: [{ field: 'description', op: 'not_contains', value: 'CHEVRON' }] }), item), true);
  const amt = (op, value, value2) => ruleFits(rule({ conditions: [{ field: 'amount', op, value, value2 }] }), item);
  assert.equal(amt('equals', 6102), true);
  assert.equal(amt('more', 6000), true);
  assert.equal(amt('less', 6000), false);
  assert.equal(amt('between', 6000, 7000), true);
  assert.equal(amt('between', 7000, 8000), false);
  // A $2,000 charge doesn't fit "less than $150", whichever sign the bank uses.
  assert.equal(ruleFits(rule({ conditions: [{ field: 'amount', op: 'less', value: 15000 }] }), { ...item, amount_cents: -200000 }), false);
  const both = { conditions: [{ field: 'description', op: 'contains', value: 'SHELL' }, { field: 'amount', op: 'more', value: 10000 }] };
  assert.equal(ruleFits(rule(both), item), false, 'all');
  assert.equal(ruleFits(rule({ ...both, match_all: false }), item), true, 'any');
  assert.equal(ruleFits(rule({ conditions: [] }), item), false, 'a rule needs a condition');
});

test('saving a rule checks what it says', async () => {
  const base = { name: 'Fees', money: 'out', conditions: [{ field: 'description', op: 'contains', value: 'FEE' }], accountId: A.bank_fees, mode: 'suggest' };
  await assert.rejects(saveRule(pool(), { ...S, actor, fields: { ...base, name: ' ' } }), /name/);
  await assert.rejects(saveRule(pool(), { ...S, actor, fields: { ...base, conditions: [] } }), /at least one condition/);
  await assert.rejects(saveRule(pool(), { ...S, actor, fields: { ...base, conditions: [{ field: 'amount', op: 'between', value: '20', value2: '10' }] } }), /second not smaller/);
  await assert.rejects(saveRule(pool(), { ...S, actor, fields: { ...base, accountId: '', payee: '' } }), /category or a payee/);
  await assert.rejects(saveRule(pool(), { ...S, actor, fields: { ...base, accountId: app.ids.accounts.checking + 99999 } }), /category the books can use/);
  await assert.rejects(saveRule(pool(), { ...S, actor, fields: { ...base, llAccount: '00000000-0000-0000-0000-000000000000' } }), /this company’s bank accounts/);
  const id = await saveRule(pool(), { ...S, actor, fields: base });
  await assert.rejects(saveRule(pool(), { ...S, actor, fields: base }), /already exists/);
  assert.equal((await getRule(pool(), { ...S, ruleId: id })).name, 'Fees');
  assert.equal(await getRule(pool(), { orgId: S.orgId, entityId: S.entityId + 999, ruleId: id }), null, 'another company can’t see it');
  await pool().query('DELETE FROM bank_rule WHERE rule_id = $1', [id]);
});

test('a suggest rule fills in the item and the batch accepts it', async () => {
  const res = await app.post('/banking/rules', new URLSearchParams([['name', 'Amazon'], ['priority', '50'], ['money', 'out'], ['llAccount', ''], ['matchAll', '1'],
    ['cond_field', 'description'], ['cond_op', 'contains'], ['cond_value', 'AMZN'], ['cond_value2', ''], ['payee', ''], ['accountId', String(A.office)],
    ['memo', 'Office order'], ['mode', 'suggest'], ['active', '1']]));
  assert.equal(res.status, 303, await res.clone().text());
  const [id] = await itemsLike('AMZN%');
  let page = await (await app.get(`/banking?account=${llId('Business Card')}`)).text();
  assert.match(page, /<span class="tag ok">Rule<\/span> Office Supplies/);
  page = await (await app.get(`/banking/item/${id}`)).text();
  assert.match(page, /Filled in by rule “Amazon”/);
  assert.match(page, /<input name="line_account" list="item-cats" autocomplete="off" value="Office Supplies"/);
  const a = await t.snapshot();
  assert.ok(await acceptShown(llId('Business Card'), [id]) === 1);
  const b = await t.snapshot();
  t.checkTied(b, 'rule accept');
  t.expectChange(a, b, { accounts: { [A.card]: -2399, [A.office]: 2399 }, net: -2399, label: 'rule accept' });
  const { rows: [x] } = await pool().query(`SELECT t.memo FROM bank_feed_link k JOIN txn t ON t.txn_id = k.txn_id WHERE k.item_id = $1`, [id]);
  assert.equal(x.memo, 'Office order');
});

test('an auto rule adds waiting items and new ones as they arrive — but never one the books already have', async () => {
  const fees = await itemsLike('MONTHLY SERVICE FEE');
  assert.ok(fees.length > 3);
  // One fee was already entered by hand in the books: the auto rule must leave that one to be matched.
  const handDate = (await getBankItem(pool(), { ...S, itemId: fees[0] })).posted_date;
  const { writeVendorDoc } = await import('../lib/data/payables.js');
  const { withTransaction } = await import('../lib/db.js');
  await withTransaction(pool(), tx => writeVendorDoc(tx, { ...S, actor, type: 'expense', txnDate: handDate, accountId: A.checking, memo: 'Fee entered by hand',
    categoryLines: [{ accountId: A.bank_fees, amount: '15.00' }], itemLines: [] }));
  // Fees the books already have (the sample books record some bank fees) are left to be matched, not added again.
  const { possibleDuplicates } = await import('../lib/data/banking.js');
  const unmatched = [];
  for (const id of fees) {
    const item = await getBankItem(pool(), { ...S, itemId: id });
    if (!(await possibleDuplicates(pool(), { ...S, item })).length) unmatched.push(id);
  }
  assert.ok(!unmatched.includes(fees[0]) && unmatched.length > 3);
  const a = await t.snapshot();
  const res = await app.post('/banking/rules', new URLSearchParams([['name', 'Bank fees'], ['priority', '10'], ['money', 'out'], ['llAccount', llId('Operating Checking')],
    ['matchAll', '1'], ['cond_field', 'description'], ['cond_op', 'is'], ['cond_value', 'MONTHLY SERVICE FEE'], ['cond_value2', ''], ['payee', ''],
    ['accountId', String(A.bank_fees)], ['memo', ''], ['mode', 'auto'], ['active', '1']]));
  assert.equal(res.status, 303);
  const added = unmatched.length;
  assert.match(decodeURIComponent(res.headers.get('set-cookie') ?? '') + (await (await app.get('/banking/rules')).text()), new RegExp(`added ${added} waiting bank item|${added} added`));
  const b = await t.snapshot();
  t.checkTied(b, 'auto rule');
  // (Net income isn't compared: the report covers this year and many of these fees are older.)
  t.expectChange(a, b, { accounts: { [A.checking]: -1500 * added, [A.bank_fees]: 1500 * added }, label: 'auto rule' });
  assert.deepEqual(await itemsLike('MONTHLY SERVICE FEE'), fees.filter(id => !unmatched.includes(id)), 'the ones already in the books wait to be matched');
  const { rows } = await pool().query(`SELECT count(*)::int AS n FROM bank_feed_item i JOIN bank_rule r ON r.rule_id = i.rule_id WHERE r.name = 'Bank fees'`);
  assert.equal(rows[0].n, added);
  const page = await (await app.get(`/banking?account=${llId('Operating Checking')}&tab=categorized`)).text();
  assert.match(page, /automatically from rule “Bank fees”/);
  // A new fee arrives from the bank: the pull adds it.
  await ll.query(`INSERT INTO core.transaction (org_id, transaction_id, account_id, amount, currency, posted_date, pending, description_raw, status, revision)
    VALUES ($1, $2, $3, -15.00, 'USD', '2026-10-12', false, 'MONTHLY SERVICE FEE', 'active', 1)`, [feed.org, sampleUuid('newfee'), llId('Operating Checking')]);
  const r = await pullCompany(pool(), ll, S);
  assert.equal(r.autoAdded, 1);
});

test('learning: after three Shell fill-ups go to Fuel, the fourth is suggested with confidence', async () => {
  const shells = await itemsLike('SHELL OIL 5744_ PLAINVIEW TX');
  assert.equal(shells.length, 5, 'four test fill-ups plus the sample one');
  const vendorId = Object.values(app.ids.vendors)[0];
  const history = () => learnedHistory(pool(), S);
  const suggest = async id => suggestFor(pool(), { ...S, item: await getBankItem(pool(), { ...S, itemId: id }), rules: await listRules(pool(), S), history: await history() });
  assert.equal(await suggest(shells[0]), null, 'nothing learned yet');
  await addItem(pool(), { ...S, itemId: shells[0], payee: `v:${vendorId}`, lines: [{ accountId: A.fuel, amount: '' }], actor });
  let s = await suggest(shells[1]);
  assert.deepEqual([s.source, s.confidence, s.accountId, s.count, s.of], ['history', 'low', A.fuel, 1, 1]);
  await addItem(pool(), { ...S, itemId: shells[1], payee: `v:${vendorId}`, lines: [{ accountId: A.fuel, amount: '' }], actor });
  // Not sure enough yet: the batch leaves it.
  assert.equal(await acceptShown(llId('Business Card'), [shells[2]]), 0);
  await addItem(pool(), { ...S, itemId: shells[2], payee: `v:${vendorId}`, lines: [{ accountId: A.fuel, amount: '' }], actor });
  s = await suggest(shells[3]);
  assert.deepEqual([s.source, s.confidence, s.payee, s.count, s.of], ['history', 'high', `v:${vendorId}`, 3, 3]);
  const page = await (await app.get(`/banking/item/${shells[3]}`)).text();
  assert.match(page, /Filled in like 3 of 3 earlier items/);
  const a = await t.snapshot();
  assert.equal(await acceptShown(llId('Business Card'), [shells[3]]), 1);
  const b = await t.snapshot();
  t.checkTied(b, 'history accept');
  t.expectChange(a, b, { accounts: { [A.card]: -5400, [A.fuel]: 5400 }, net: -5400, label: 'history accept' });
  // One different choice makes it less sure.
  await addItem(pool(), { ...S, itemId: shells[4], payee: '', lines: [{ accountId: A.repairs, amount: '' }], actor });
  const learned = (await history()).get(`out|${payeeKey('Shell')}`); // the merchant name, when the bank gives one
  assert.deepEqual(learned.map(e => [e.accountId, e.count]), [[A.fuel, 4], [A.repairs, 1]]);
});

test('rules belong to people who keep the books', async () => {
  assert.equal(canAccess('standard', 'POST', '/banking/rules'), true);
  assert.equal(canAccess('reports', 'POST', '/banking/rules'), false);
  assert.equal(canAccess('vendors', 'GET', '/banking/rules'), false);
  const page = await (await app.get('/banking/rules')).text();
  assert.match(page, /Amazon/);
  assert.match(page, /Adds automatically/);
  const { rows: [r] } = await pool().query(`SELECT rule_id FROM bank_rule WHERE name = 'Amazon'`);
  const form = await (await app.get(`/banking/rules/${r.rule_id}`)).text();
  assert.match(form, /value="AMZN"/);
  assert.equal((await app.post(`/banking/rules/${r.rule_id}/delete`, {})).status, 303);
  assert.equal((await app.get(`/banking/rules/${r.rule_id}`)).status, 404);
  const fromItem = await (await app.get(`/banking/rules/new?from=${(await itemsLike('TRACTOR SUPPLY%'))[0]}`)).text();
  assert.match(fromItem, /value="Tractor Supply"/);
  assert.match(fromItem, /name="cond_value" value="TRACTOR"/);
});

test('reports-only people don’t see Rules in the menu, and can’t open it (menu cleanup)', async () => {
  const { appNav } = await import('../lib/views/nav.js');
  const nav = role => { const n = appNav({ role, can: p => canAccess(role, 'GET', p), path: '/home', csrf: 'x', bookmarks: [], pins: ['accounting'] }); return [n.rail, n.panel].map(String).join(''); };
  assert.equal(canAccess('reports', 'GET', '/banking/rules'), false);
  assert.equal(canAccess('reports', 'GET', '/banking/rules/7'), false);
  assert.equal(canAccess('reports', 'GET', '/banking'), true);
  assert.doesNotMatch(nav('reports'), /href="\/banking\/rules"/);
  assert.match(nav('standard'), /href="\/banking\/rules"/);
});
