import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './app-harness.js';
import { freshDb } from './harness.js';
import { buildSampleFeed, writeLedgerlineSample, sampleUuid } from '../lib/bankfeed/sample.js';
import { pullCompany } from '../lib/bankfeed/pull.js';
import { linkCompany, saveMappings } from '../lib/data/bankfeeds.js';
import { getBankItem, possibleDuplicates, addItem } from '../lib/data/banking.js';
import { writeVendorDoc } from '../lib/data/payables.js';
import { saveVendor } from '../lib/data/vendors.js';
import { learnedHistory, suggestFor, listRules, intentOf, acceptSuggestions } from '../lib/bankfeed/rules.js';
import { wordingTokens, sameWording, buildWording, wordingSuggestion } from '../lib/bankfeed/wording.js';
import { withTransaction } from '../lib/db.js';

// Bank review v3, stage S1: a bank line worded like earlier transactions in the books suggests their payee and
// category; last month's charge for the same amount, recorded from its own bank line, isn't taken for this one.
let app, llDb, ll, feed, S, A;
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
    { id: llId('Operating Checking'), choice: String(A.checking) }, { id: llId('Business Card'), choice: String(A.card) }] });
  await pullCompany(pool(), ll, S);
});
after(async () => { await app.close(); await llDb.drop(); });

let seq = 0;
async function bankSays(rows) {
  const keys = [];
  for (const r of rows) {
    const key = `word-${++seq}`;
    keys.push(key);
    await ll.query(`INSERT INTO core.transaction (org_id, transaction_id, account_id, amount, currency, posted_date, pending, description_raw, status, revision, check_number)
      VALUES ($1, $2, $3, $4, 'USD', $5, false, $6, 'active', 1, $7)`, [feed.org, sampleUuid('word', key), llId(r.account), r.amount, r.date ?? '2026-10-12', r.description, r.check ?? null]);
  }
  await pullCompany(pool(), ll, S);
  const ids = [];
  for (const k of keys) ids.push(Number((await pool().query('SELECT item_id FROM bank_feed_item WHERE ll_transaction_id = $1', [sampleUuid('word', k)])).rows[0].item_id));
  return ids;
}
const item = id => getBankItem(pool(), { ...S, itemId: id });
const suggest = async id => suggestFor(pool(), { ...S, item: await item(id), rules: await listRules(pool(), S), history: await learnedHistory(pool(), S) });
// What QuickBooks left in the books: expenses recorded from its own bank feed, the bank's text as the memo.
const expense = (vendorId, accountId, amount, date, memo, from = A.checking) => withTransaction(pool(), tx => writeVendorDoc(tx, { ...S, actor, type: 'expense', vendorId,
  txnDate: date, accountId: from, memo, categoryLines: [{ accountId, amount }], itemLines: [] }));

test('the words of a bank text: boilerplate, masks, dates and one-off codes out; ids and last fours in', () => {
  assert.deepEqual(wordingTokens('ORIG CO NAME:QUILLBACK MU CO ENTRY DESCR:ISA PYMENT SEC:PPD ORIG ID:9000123456'), ['QUILLBACK', 'MU', 'ISA', 'PYMENT', '9000123456']);
  assert.deepEqual(wordingTokens('QUILLBACK MU  ISA PAYMNT PPD ID: 9000123456'), ['QUILLBACK', 'MU', 'ISA', 'PAYMNT', '9000123456']);
  assert.deepEqual(wordingTokens('AMAZON MKTPL*5943K7DE2'), ['AMAZON', 'MKTPL']);
  assert.deepEqual(wordingTokens('WEB TFR TO *8150 MANAGEMENT FEES 101426'), ['TFR', '8150', 'MANAGEMENT', 'FEES', '101426']);
  assert.deepEqual(wordingTokens('TALLGRASS XXX-XXX-4729 IL 10/07 · Paid to Tallgrass Trading'), ['TALLGRASS', '4729', 'IL']);
  assert.ok(sameWording('ORIG CO NAME:QUILLBACK MU CO ENTRY DESCR:ISA PYMENT SEC:PPD ORIG ID:9000123456', 'QUILLBACK MU  ISA PAYMNT PPD ID: 9000123456'));
  assert.ok(!sameWording('WEB TFR FR *6150 FUNDS TRANSFER VIA ONLINE 101426', 'Insurance for October'));
  assert.ok(!sameWording('', 'anything'));
});

test('the latest close ones decide: three alike is sure, a change of mind is only likely, one is nothing', () => {
  const row = (id, date, memo, category, party = 'v:1') => ({ txn_id: id, txn_date: date, memo, party, category, cents: -1000 });
  const line = { description: 'SPROCKET CLOUD HOSTING', amount_cents: -1500 };
  const sure = buildWording([row(1, '2026-01-01', 'SPROCKET CLOUD HOSTING', 7), row(2, '2026-02-01', 'SPROCKET CLOUD HOSTING', 7), row(3, '2026-03-01', 'SPROCKET CLOUD HOSTING', 7),
    row(4, '2026-03-01', 'SOMETHING ELSE ENTIRELY', 9)]);
  assert.deepEqual((({ confidence, accountId, payee, count, of }) => ({ confidence, accountId, payee, count, of }))(wordingSuggestion(sure, line)),
    { confidence: 'high', accountId: 7, payee: 'v:1', count: 3, of: 3 });
  // Money in never learns from money out.
  assert.equal(wordingSuggestion(sure, { ...line, amount_cents: 1500 }), null);
  // The books changed their mind last month: the newest five decide, and they don't all agree.
  const changed = buildWording([row(1, '2026-01-01', 'SPROCKET CLOUD HOSTING', 7), row(2, '2026-02-01', 'SPROCKET CLOUD HOSTING', 7), row(3, '2026-03-01', 'SPROCKET CLOUD HOSTING', 7),
    row(5, '2026-04-01', 'SPROCKET CLOUD HOSTING', 8)]);
  assert.equal(wordingSuggestion(changed, line).confidence, 'medium');
  assert.equal(wordingSuggestion(changed, line).accountId, 7);
  // Two different payees for the same words: never sure.
  const twoPayees = buildWording([row(1, '2026-01-01', 'SPROCKET CLOUD HOSTING', 7), row(2, '2026-02-01', 'SPROCKET CLOUD HOSTING', 7, 'v:2'), row(3, '2026-03-01', 'SPROCKET CLOUD HOSTING', 7)]);
  assert.equal(wordingSuggestion(twoPayees, line).confidence, 'medium');
  assert.equal(wordingSuggestion(buildWording([row(1, '2026-01-01', 'SPROCKET CLOUD HOSTING', 7)]), line), null);
  // A record that isn't active any more is never suggested.
  assert.equal(wordingSuggestion(sure, line, { usable: id => id !== 7 }), null);
});

// The row's own form, as a browser sends it: its hidden fields plus what's in the row.
async function rowPost(id, { account = 'Operating Checking', drop = [], set = {} } = {}) {
  const page = await (await app.get(`/banking?account=${llId(account)}&tab=review`)).text();
  const form = new RegExp(`<form id="row-${id}"[^>]*>([\\s\\S]*?)</form>`).exec(page)?.[1];
  assert.ok(form, `row ${id} has its own form`);
  const body = new URLSearchParams();
  for (const m of form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) body.set(m[1], m[2].replace(/&amp;/g, '&'));
  for (const m of page.matchAll(new RegExp(`<input name="(payee|category|memo)" form="row-${id}"[^>]*? value="([^"]*)"`, 'g'))) body.set(m[1], m[2].replace(/&amp;/g, '&'));
  for (const k of drop) body.delete(k);
  for (const [k, v] of Object.entries(set)) body.set(k, v);
  return app.raw(`/banking/item/${id}/row`, { method: 'POST', body: body.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' } });
}

test('Quillback: last month’s payment is shown, the row is filled in as the earlier ones were, and Post as new records it', async () => {
  const nwm = await saveVendor(pool(), { ...S, fields: { displayName: 'Quillback Mutual Life' }, actor });
  for (const d of ['2026-07-14', '2026-08-12', '2026-09-12']) await expense(nwm, A.office, '34.52', d, 'QUILLBACK MU  ISA PAYMNT PPD ID: 9000123456');
  const [id] = await bankSays([{ account: 'Operating Checking', amount: '-34.52', date: '2026-10-14', description: 'ORIG CO NAME:QUILLBACK MU CO ENTRY DESCR:ISA PYMENT SEC:PPD ORIG ID:9000123456' }]);
  // September's payment is still evidence (the memo alone doesn't prove which bank line it came from)…
  assert.equal((await possibleDuplicates(pool(), { ...S, item: await item(id) })).length, 1);
  const s = await suggest(id);
  assert.equal(s.source, 'possible');
  assert.equal(intentOf(s, await item(id)), null, 'never batch');
  // …and the row is filled in with what it would be as a new one.
  assert.deepEqual([s.fill.source, s.fill.basis, s.fill.confidence, s.fill.payee, s.fill.accountId, s.fill.count, s.fill.of], ['history', 'wording', 'high', `v:${nwm}`, A.office, 3, 3]);
  const page = await (await app.get(`/banking?account=${llId('Operating Checking')}&tab=review`)).text();
  assert.match(page, /Same amount in the books: Expense · Quillback Mutual Life · 9\/12\/26\. Post as new only if this is a separate one/);
  assert.match(page, /Same bank wording as 3 earlier \(last 9\/12\/26\)/);
  assert.match(page, new RegExp(`<input name="payee" form="row-${id}" list="bank-payees" value="Quillback Mutual Life"`));
  assert.match(page, />Post as new</);
  // Without the evidence it showed, the row can't say it's separate.
  const refused = await rowPost(id, { drop: ['evidence'] });
  assert.equal(refused.status, 422);
  assert.match((await refused.json()).error, /may already be in the books/);
  const ok = await rowPost(id);
  assert.equal(ok.status, 200, await ok.clone().text());
  const { rows } = await pool().query(`SELECT t.vendor_id, p.account_id, p.amount_cents FROM bank_feed_link k JOIN txn t ON t.txn_id = k.txn_id JOIN posting p ON p.txn_id = t.txn_id
    WHERE k.item_id = $1`, [id]);
  assert.deepEqual(rows.map(r => [Number(r.vendor_id), Number(r.account_id), Number(r.amount_cents)]).sort(), [[nwm, A.checking, -3452], [nwm, A.office, 3452]].sort());
  const { rows: [ev] } = await pool().query(`SELECT source, separate FROM bank_review_event WHERE item_id = $1 AND kind = 'added'`, [id]);
  assert.deepEqual([ev.source, ev.separate], ['row', true]);
});


test('still evidence: the same wording within a few days, an earlier entry in other words, or a check', async () => {
  const v = await saveVendor(pool(), { ...S, fields: { displayName: 'Larkspur Gas Utility' }, actor });
  await expense(v, A.utilities ?? A.office, '61.18', '2026-10-09', 'LARKSPUR GAS UTIL AUTOPAY 4471829');
  const [near] = await bankSays([{ account: 'Operating Checking', amount: '-61.18', date: '2026-10-12', description: 'LARKSPUR GAS UTIL AUTOPAY 4471829' }]);
  assert.equal((await possibleDuplicates(pool(), { ...S, item: await item(near) })).length, 1, 'three days apart: maybe this very payment');
  assert.equal((await suggest(near)).source, 'match', 'offered as the match, not a new expense');
  // Entered by hand weeks before it cleared, in its own words: could be this one.
  await expense(v, A.office, '72.40', '2026-09-20', 'October gas bill (paid early)');
  const [early] = await bankSays([{ account: 'Operating Checking', amount: '-72.40', date: '2026-10-12', description: 'LARKSPUR GAS UTIL AUTOPAY 4471829' }]);
  assert.equal((await suggest(early)).source, 'possible');
  // The bank says it's a check: the check rule decides, not the wording.
  await expense(v, A.office, '15.25', '2026-09-01', 'CHECK 3001 LARKSPUR');
  const [chk] = await bankSays([{ account: 'Operating Checking', amount: '-15.25', date: '2026-10-12', description: 'CHECK 3001 LARKSPUR', check: '3001' }]);
  assert.equal((await suggest(chk)).source, 'possible');
  // Adding it as new is still refused while the evidence stands.
  await assert.rejects(addItem(pool(), { ...S, itemId: early, actor, payee: `v:${v}`, lines: [{ accountId: A.office, amount: '' }] }), /may already be in the books/);
});

test('batch Accept leaves a wording suggestion for a person; posted as shown it is exact; an inactive category is never suggested', async () => {
  const v = await saveVendor(pool(), { ...S, fields: { displayName: 'Halyard Software Co' }, actor });
  for (const d of ['2026-04-03', '2026-05-03', '2026-06-03', '2026-07-03']) await expense(v, A.office, '19.99', d, 'HALYARD SOFTWARE SUBSCR 8448', A.card);
  const [id] = await bankSays([{ account: 'Business Card', amount: '-19.99', date: '2026-10-03', description: 'HALYARD SOFTWARE SUBSCR 8448' }]);
  const it = await item(id), s = await suggest(id);
  assert.equal(s.confidence, 'high');
  assert.equal(intentOf(s, it), null);
  // Even with a made-up intent, batch Accept doesn't take it.
  const out = await acceptSuggestions(pool(), { ...S, llAccountId: llId('Business Card'), itemIds: [id], intents: new Map([[id, 'history:0123456789abcdef01234567']]), actor });
  assert.deepEqual([out.accepted, out.skipped[0]?.reason], [0, 'nothing sure enough to accept']);
  // A person posts it as shown.
  await addItem(pool(), { ...S, itemId: id, actor, payee: s.payee, lines: [{ accountId: s.accountId, amount: '' }], basis: 'history', expect: { rev: (await import('../lib/data/banking.js')).itemToken(it) } });
  const { rows } = await pool().query(`SELECT t.vendor_id, p.account_id, p.amount_cents FROM bank_feed_link k JOIN txn t ON t.txn_id = k.txn_id JOIN posting p ON p.txn_id = t.txn_id
    WHERE k.item_id = $1 ORDER BY p.account_id`, [id]);
  assert.deepEqual(rows.map(r => [Number(r.vendor_id), Number(r.account_id), Number(r.amount_cents)]).sort(),
    [[v, A.card, -1999], [v, A.office, 1999]].sort());
  // The category is made inactive: the next line worded the same isn't suggested to it.
  const cat = await pool().query(`INSERT INTO account (org_id, entity_id, name, type, active) SELECT org_id, entity_id, 'Retired Software', type, true FROM account WHERE account_id = $1 RETURNING account_id`, [A.office]);
  const retired = Number(cat.rows[0].account_id);
  for (const d of ['2026-06-05', '2026-07-05', '2026-08-05']) await expense(v, retired, '8.88', d, 'HALYARD BACKUP ADDON 5521', A.card);
  await pool().query('UPDATE account SET active = false WHERE account_id = $1', [retired]);
  const [next] = await bankSays([{ account: 'Business Card', amount: '-8.88', date: '2026-10-05', description: 'HALYARD BACKUP ADDON 5521' }]);
  const s2 = await suggest(next);
  assert.ok(!s2 || s2.accountId !== retired);
});

test('a processor prefix alone, or a store name the books have never seen, is no likeness (Codex S1 #2)', () => {
  const row = (id, date, memo, category) => ({ txn_id: id, txn_date: date, memo, party: 'v:9', category, cents: -1000 });
  const w = buildWording([row(1, '2026-01-01', 'SP KESTRELWELLNESS', 5), row(2, '2026-02-01', 'SP KESTRELWELLNESS', 5), row(3, '2026-03-01', 'SP KESTRELWELLNESS', 5),
    row(4, '2026-03-02', 'SP KESTRELWELLNESS', 5)]);
  assert.equal(wordingSuggestion(w, { description: 'SP MARLOWE-FIGBOUTIQ', amount_cents: -2500 }), null);
  const v = buildWording([row(1, '2026-01-01', 'SQ *WILLET CHAPEL', 6), row(2, '2026-02-01', 'SQ *WILLET CHAPEL', 6), row(3, '2026-03-01', 'SQ *WILLET CHAPEL', 6)]);
  assert.equal(wordingSuggestion(v, { description: 'SQ *CORNER BAKERY', amount_cents: -900 }), null);
  assert.equal(wordingSuggestion(v, { description: 'SQ *WILLET CHAPEL', amount_cents: -900 }).confidence, 'high');
});

test('one exact-amount transaction is a sure match only if nothing else could be the line and its payee agrees (Codex S1 #6)', async () => {
  const pelican = await saveVendor(pool(), { ...S, fields: { displayName: 'Pelican Bay Water' }, actor });
  const other = await saveVendor(pool(), { ...S, fields: { displayName: 'Osprey Landscaping' }, actor });
  for (const d of ['2026-07-01', '2026-08-01', '2026-09-01']) await expense(pelican, A.office, '47.00', d, 'PELICAN BAY WATER 77810');
  // Entered by hand two days before, for another vendor, the same amount.
  await expense(other, A.office, '63.29', '2026-10-10', 'hedges');
  const [id] = await bankSays([{ account: 'Operating Checking', amount: '-63.29', date: '2026-10-12', description: 'PELICAN BAY WATER 77810' }]);
  const s = await suggest(id);
  assert.equal(s.source, 'possible', 'the bank says Pelican Bay; the only candidate is Osprey');
  // Same wording, same payee: the match stays sure.
  await expense(pelican, A.office, '51.00', '2026-10-11', 'PELICAN BAY WATER 77810');
  const [id2] = await bankSays([{ account: 'Operating Checking', amount: '-51.00', date: '2026-10-12', description: 'PELICAN BAY WATER 77810' }]);
  assert.deepEqual([(await suggest(id2)).source, (await suggest(id2)).confidence], ['match', 'high']);
});

test('different accounts named by their last four are different counterparties; the feed’s merchant name only adds support (Codex S1 #2, #5)', () => {
  const row = (id, date, memo, category, party) => ({ txn_id: id, txn_date: date, memo, party, category, cents: -80000 });
  const w = buildWording([row(1, '2026-07-01', 'WEB TFR TO *8150 MANAGEMENT FEES 070126', 5, 'v:1'), row(2, '2026-08-01', 'WEB TFR TO *8150 MANAGEMENT FEES 080126', 5, 'v:1'),
    row(3, '2026-09-01', 'WEB TFR TO *8150 MANAGEMENT FEES 090126', 5, 'v:1'), row(4, '2026-09-02', 'QUILLBACK MU ISA PAYMNT 9000123456', 6, 'v:2'),
    row(5, '2026-08-02', 'QUILLBACK MU ISA PAYMNT 9000123456', 6, 'v:2'), row(6, '2026-07-02', 'QUILLBACK MU ISA PAYMNT 9000123456', 6, 'v:2'),
    row(7, '2026-07-03', 'MUTUAL OF OMAHA PREMIUM', 9, 'v:3')]);
  assert.equal(wordingSuggestion(w, { description: 'WEB TFR TO *8150 MANAGEMENT FEES 101426', amount_cents: -80000 }).confidence, 'high');
  assert.equal(wordingSuggestion(w, { description: 'WEB TFR TO *9999 MANAGEMENT FEES 101426', amount_cents: -80000 }), null);
  // "MUTUAL" is known (another insurer) but isn't in Quillback's bank text: the merchant name can't lower the score.
  const nw = { description: 'ORIG CO NAME:QUILLBACK MU CO ENTRY DESCR:ISA PYMENT SEC:PPD ORIG ID:9000123456', amount_cents: -3452 };
  assert.deepEqual([wordingSuggestion(w, nw).payee, wordingSuggestion(w, { ...nw, merchant_name: 'Quillback Mutual Life' }).payee], ['v:2', 'v:2']);
});

test('an inactive payee is refused by the writer itself; deactivating a customer waits for the company lock (Codex S1 #3)', async () => {
  const v = await saveVendor(pool(), { ...S, fields: { displayName: 'Tern Retired Supplies' }, actor });
  const [id] = await bankSays([{ account: 'Business Card', amount: '-13.13', date: '2026-10-12', description: 'TERN RETIRED SUPPLIES' }]);
  await pool().query('UPDATE vendor SET active = false WHERE vendor_id = $1', [v]);
  await assert.rejects(addItem(pool(), { ...S, itemId: id, actor, payee: `v:${v}`, lines: [{ accountId: A.office, amount: '' }] }), /payee is inactive/);
  const { setCustomersActive, lockEntity } = await import('../lib/data/writes.js');
  const customerId = Object.values(app.ids.customers)[0];
  const holder = await pool().connect();
  try {
    await holder.query('BEGIN');
    await lockEntity(holder, S.orgId, S.entityId);
    let done = false;
    const change = setCustomersActive(pool(), { ...S, ids: [customerId], active: false, actor }).then(() => { done = true; });
    await new Promise(r => setTimeout(r, 300));
    assert.equal(done, false, 'waits while a posting holds the lock');
    await holder.query('COMMIT');
    await change;
    assert.equal(done, true);
  } finally { holder.release(); }
  await setCustomersActive(pool(), { ...S, ids: [customerId], active: true, actor });
});

test('Post as new on a transfer records a new transfer, never last month’s (Codex S1 round 2 #1)', async () => {
  const { writeTransfer } = await import('../lib/data/ledger-tools.js');
  const sept = await withTransaction(pool(), tx => writeTransfer(tx, { ...S, type: 'transfer', fromId: A.checking, toId: A.savings, amountText: '88.92', txnDate: '2026-09-28', memo: 'ONLINE TRANSFER TO SAV 4412' }));
  const [id] = await bankSays([{ account: 'Operating Checking', amount: '-88.92', date: '2026-10-12', description: 'ONLINE TRANSFER TO SAV 4412' }]);
  assert.equal((await suggest(id)).source, 'possible');
  const { rows: [sav] } = await pool().query('SELECT name FROM account WHERE account_id = $1', [A.savings]);
  const res = await rowPost(id, { set: { category: sav.name, payee: '' } });
  assert.equal(res.status, 200, await res.clone().text());
  const { rows } = await pool().query('SELECT txn_id FROM bank_feed_link WHERE item_id = $1', [id]);
  assert.equal(rows.length, 1);
  assert.notEqual(Number(rows[0].txn_id), Number(sept), 'a new transfer, not September’s');
  const { rows: [ev] } = await pool().query(`SELECT kind, separate FROM bank_review_event WHERE item_id = $1 ORDER BY event_id DESC LIMIT 1`, [id]);
  assert.deepEqual([ev.kind, ev.separate], ['transfer', true]);
});

test('a match turned down for another payee: its row posts as new with the evidence it showed (Codex S1 round 2 #3)', async () => {
  const heron = await saveVendor(pool(), { ...S, fields: { displayName: 'Heron Pool Service' }, actor });
  const other = await saveVendor(pool(), { ...S, fields: { displayName: 'Egret Window Cleaning' }, actor });
  for (const d of ['2026-06-02', '2026-07-02', '2026-08-02']) await expense(heron, A.office, '75.00', d, 'HERON POOL SERVICE 30219');
  await expense(other, A.office, '41.70', '2026-10-10', 'windows');
  const [id] = await bankSays([{ account: 'Operating Checking', amount: '-41.70', date: '2026-10-12', description: 'HERON POOL SERVICE 30219' }]);
  const s = await suggest(id);
  assert.equal(s.source, 'possible');
  assert.ok(s.dupes.every(d => d.reason), 'the evidence as the guard sees it');
  const res = await rowPost(id);
  assert.equal(res.status, 200, await res.clone().text());
  const { rows: [t] } = await pool().query('SELECT t.vendor_id FROM bank_feed_link k JOIN txn t ON t.txn_id = k.txn_id WHERE k.item_id = $1', [id]);
  assert.equal(Number(t.vendor_id), heron);
});

test('batch Accept works a match out again with the books as they are now (Codex S1 round 2 #2)', async () => {
  const kite = await saveVendor(pool(), { ...S, fields: { displayName: 'Kite Courier Co' }, actor });
  const wren = await saveVendor(pool(), { ...S, fields: { displayName: 'Wren Paper Goods' }, actor });
  await expense(wren, A.office, '29.15', '2026-10-11', 'paper');
  const [id] = await bankSays([{ account: 'Operating Checking', amount: '-29.15', date: '2026-10-12', description: 'KITE COURIER DELIVERY 55120' }]);
  // As the page showed it (and as the batch first read the books): one candidate, a sure match.
  const stale = await learnedHistory(pool(), S);
  const it = await item(id);
  const shown = await suggestFor(pool(), { ...S, item: it, rules: await listRules(pool(), S), history: stale });
  assert.equal(shown.source, 'match');
  // Then Kite's history arrives: the bank says Kite, the only candidate is Wren's.
  for (const d of ['2026-07-12', '2026-08-12', '2026-09-12']) await expense(kite, A.office, '18.00', d, 'KITE COURIER DELIVERY 55120');
  const out = await acceptSuggestions(pool(), { ...S, llAccountId: llId('Operating Checking'), itemIds: [id], intents: new Map([[id, intentOf(shown, it)]]), actor, preloaded: stale });
  assert.equal(out.accepted, 0);
  assert.equal((await item(id)).review_state, 'new');
});

test('a pending line shows what it will be suggested as — nothing to choose or post until it posts', async () => {
  const osprey = await saveVendor(pool(), { ...S, fields: { displayName: 'Osprey Term Life' }, actor });
  for (const d of ['2026-06-20', '2026-07-20', '2026-08-20']) await expense(osprey, A.office, '22.10', d, 'OSPREY TERM LIFE PREM 7731990');
  // Also an exact-amount transaction two days before: a pending line is never matched or checked for duplicates yet.
  await expense(osprey, A.office, '64.00', '2026-10-10', 'OSPREY TERM LIFE PREM 7731990');
  const key = `word-${++seq}`;
  await ll.query(`INSERT INTO core.transaction (org_id, transaction_id, account_id, amount, currency, posted_date, pending, description_raw, status, revision)
    VALUES ($1, $2, $3, '-64.00', 'USD', '2026-10-12', true, 'OSPREY TERM LIFE PREM 7731990', 'active', 1)`, [feed.org, sampleUuid('word', key), llId('Operating Checking')]);
  await pullCompany(pool(), ll, S);
  const id = Number((await pool().query('SELECT item_id FROM bank_feed_item WHERE ll_transaction_id = $1', [sampleUuid('word', key)])).rows[0].item_id);
  assert.equal((await item(id)).pending, true);
  const { previewFor } = await import('../lib/bankfeed/rules.js');
  const p = await previewFor(pool(), { ...S, item: await item(id), rules: await listRules(pool(), S), history: await learnedHistory(pool(), S) });
  assert.deepEqual([p.source, p.basis, p.accountId, p.payee], ['history', 'wording', A.office, `v:${osprey}`]);
  const page = await (await app.get(`/banking?account=${llId('Operating Checking')}&tab=review`)).text();
  const row = new RegExp(`<tr id="item-${id}"[^>]*>([\\s\\S]*?)</tr>`).exec(page)[1];
  assert.match(row, /Osprey Term Life/);
  assert.match(row, /Will suggest:/);
  assert.match(row, /Can be reviewed once the bank posts it/);
  assert.doesNotMatch(row, /<input|<button/);
  assert.doesNotMatch(page, new RegExp(`id="row-${id}"|form="row-${id}"`));
  const head = page.slice(page.indexOf('<table class="grid bank-items in-row">'), page.indexOf('</thead>'));
  assert.equal([...row.matchAll(/<td[^>]*>/g)].length, (head.match(/<th[ >]/g) ?? []).length, 'one cell per column');
  const ip = await (await app.get(`/banking/item/${id}`)).text();
  assert.match(ip, /Pending at the bank — it can be added once it posts\.<br><span class="muted">Will suggest:<\/span>/);
  assert.match(ip, /· Osprey Term Life/);
  // Someone who can only look (reports role: no review) sees the same preview, without controls (Codex S2 #1).
  const { bankingPage } = await import('../lib/views/banking.js');
  const it = await item(id);
  const current = { id: llId('Operating Checking'), books_name: 'Operating Checking', books_type: 'bank', books_balance_cents: 0, bank_balance_cents: null };
  const ro = String(bankingPage({ entityName: 'Test', csrf: 'x', flash: null, timeZone: 'UTC', accounts: [current], current, tab: 'review', items: [{ ...it, links: [] }],
    counts: { review: 1 }, suggestions: new Map(), previews: new Map([[id, { s: p, payee: 'Osprey Term Life' }]]), accountNames: new Map([[A.office, 'Office']]),
    canRefresh: false, canReview: false, page: 1, more: false }));
  const roRow = new RegExp(`<tr id="item-${id}"[^>]*>([\\s\\S]*?)</tr>`).exec(ro)[1];
  assert.doesNotMatch(ro, /Accept ticked/);
  assert.match(roRow, /Will suggest:/);
  assert.match(roRow, /Office/);
  assert.match(roRow, /Osprey Term Life/);
  assert.doesNotMatch(roRow, /<input|<button/);
  // Posting from the row is still refused while it's pending.
  await assert.rejects(addItem(pool(), { ...S, itemId: id, actor, payee: `v:${osprey}`, lines: [{ accountId: A.office, amount: '' }] }));
});

// ---- stage S4: open bills and invoices on the bank line ----
const s4 = async () => ({ ...(await import('../lib/data/payables.js')), ...(await import('../lib/data/writes.js')), ...(await import('../lib/data/banking.js')) });
const newInvoice = async (customerId, rate, date = '2026-10-01') => (await s4()).saveSalesDoc(pool(), { ...S, customerId, type: 'invoice', actor, txnDate: date, dueDate: '2026-10-30',
  lines: [{ description: 'Feed', quantity: '1', rate }] });
const newBill = async (vendorId, amount, { approve = true, date = '2026-10-01' } = {}) => {
  const m = await s4();
  const id = await withTransaction(pool(), tx => m.writeVendorDoc(tx, { ...S, actor, type: 'bill', vendorId, txnDate: date, memo: 'bill', categoryLines: [{ accountId: A.office, amount }], itemLines: [] }));
  if (approve) await m.approveBills(pool(), { ...S, txnIds: [id], actor });
  return id;
};
// The hidden fields of one row's own form (only that form).
const rowForm = (page, id) => new RegExp(`<form id="row-${id}"[^>]*>([\\s\\S]*?)</form>`).exec(page)?.[1] ?? '';
const openOf = async id => Number((await pool().query('SELECT open_cents FROM txn WHERE txn_id = $1', [id])).rows[0].open_cents);

test('one open invoice for exactly the deposit, from the customer the bank names: Match settles it; Undo reopens it', async () => {
  const { saveCustomer } = await s4();
  const cust = await saveCustomer(pool(), { ...S, fields: { displayName: 'Gannet Feed Co-op', active: true }, actor });
  const inv = await newInvoice(cust, '1234.56');
  const [id] = await bankSays([{ account: 'Operating Checking', amount: '1234.56', date: '2026-10-12', description: 'GANNET FEED COOP ACH PMT 99120' }]);
  const s = await suggest(id);
  assert.deepEqual([s.source, s.confidence, s.doc.txn_id, s.named], ['settle', 'high', Number(inv), true]);
  assert.equal(intentOf(s, await item(id)), null, 'never batch');
  const page = await (await app.get(`/banking?account=${llId('Operating Checking')}&tab=review`)).text();
  const row = new RegExp(`<tr id="item-${id}"[^>]*>([\\s\\S]*?)</tr>`).exec(page)[1];
  assert.match(row, /Payment for invoice/);
  assert.match(row, />Match</);
  assert.match(rowForm(page, id), /name="mode" value="settle"/);
  const res = await rowPost(id);
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(await openOf(inv), 0);
  const { rows: ls } = await pool().query('SELECT k.how, t.type FROM bank_feed_link k JOIN txn t ON t.txn_id = k.txn_id WHERE k.item_id = $1', [id]);
  assert.deepEqual(ls.map(l => [l.how, l.type]), [['added', 'payment']], 'a received payment, owned by the bank line');
  const { undoItem, undoPlan } = await s4();
  await undoItem(pool(), { ...S, itemId: id, actor, expect: { plan: (await undoPlan(pool(), { ...S, itemId: id })).token } });
  assert.equal(await openOf(inv), 123456, 'Undo reopens the invoice');
});

test('a bill: medium when the bank doesn’t name the vendor; not suggested if it needs approval or two fit; always still evidence', async () => {
  const v = await saveVendor(pool(), { ...S, fields: { displayName: 'Plover Hauling' }, actor });
  const b1 = await newBill(v, '412.30');
  const [id] = await bankSays([{ account: 'Operating Checking', amount: '-412.30', date: '2026-10-12', description: 'ONLINE PMT 77231' }]);
  const s = await suggest(id);
  assert.deepEqual([s.source, s.confidence, s.doc.txn_id], ['settle', 'medium', Number(b1)]);
  const page = await (await app.get(`/banking?account=${llId('Operating Checking')}&tab=review`)).text();
  assert.match(new RegExp(`<tr id="item-${id}"[^>]*>([\\s\\S]*?)</tr>`).exec(page)[1], /the bank doesn’t name them: check it/);
  // Needs approval: still evidence (Add is refused), but not offered to pay.
  const b2 = await newBill(v, '518.40', { approve: false });
  const [id2] = await bankSays([{ account: 'Operating Checking', amount: '-518.40', date: '2026-10-12', description: 'PLOVER HAULING' }]);
  const s2 = await suggest(id2);
  assert.equal(s2.source, 'possible');
  assert.ok(s2.dupes.some(d => Number(d.txn_id) === Number(b2) && d.reason === 'open_bill'));
  await assert.rejects(addItem(pool(), { ...S, itemId: id2, actor, payee: `v:${v}`, lines: [{ accountId: A.office, amount: '' }] }), /may already be in the books/);
  // Two open bills for the same amount: no guess.
  await newBill(v, '77.77'); await newBill(v, '77.77');
  const [id3] = await bankSays([{ account: 'Operating Checking', amount: '-77.77', date: '2026-10-12', description: 'PLOVER HAULING' }]);
  assert.equal((await suggest(id3)).source, 'possible');
  // An open bill more than a year old is still evidence.
  const old = await newBill(v, '61.06', { date: '2025-01-15' });
  const [id4] = await bankSays([{ account: 'Operating Checking', amount: '-61.06', date: '2026-10-12', description: 'PLOVER HAULING' }]);
  assert.ok((await possibleDuplicates(pool(), { ...S, item: await item(id4) })).some(d => Number(d.txn_id) === Number(old)));
});

test('the row’s Match is refused if the books changed after the page was shown (Codex design #12)', async () => {
  const { saveCustomer } = await s4();
  const cust = await saveCustomer(pool(), { ...S, fields: { displayName: 'Shearwater Ranch', active: true }, actor });
  const inv = await newInvoice(cust, '845.00');
  const [id] = await bankSays([{ account: 'Operating Checking', amount: '845.00', date: '2026-10-12', description: 'SHEARWATER RANCH PAYMENT' }]);
  assert.equal((await suggest(id)).source, 'settle');
  const page = await (await app.get(`/banking?account=${llId('Operating Checking')}&tab=review`)).text();
  // Meanwhile someone records a deposit for the same amount on the account.
  const { writeDeposit } = await import('../lib/data/deposits.js');
  await withTransaction(pool(), tx => writeDeposit(tx, { ...S, actor, accountId: A.checking, txnDate: '2026-10-11', memo: 'counter deposit', sourceTxnIds: [],
    otherLines: [{ accountId: A.office, customerId: cust, description: 'x', amount: '845.00' }] }));
  const form = new RegExp(`<form id="row-${id}"[^>]*>([\\s\\S]*?)</form>`).exec(page)[1];
  const body = new URLSearchParams();
  for (const m of form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) body.set(m[1], m[2].replace(/&amp;/g, '&'));
  const res = await app.raw(`/banking/item/${id}/row`, { method: 'POST', body: body.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' } });
  assert.equal(res.status, 422);
  assert.equal(await openOf(inv), 84500, 'nothing paid');
  assert.equal((await item(id)).review_state, 'new');
});

test('a customer with several open invoices the bank names: a pointer to Find match, never a guess at which (Q&Z)', async () => {
  const { saveCustomer } = await s4();
  const dl = await saveCustomer(pool(), { ...S, fields: { displayName: 'Q&Z Grain & Seed', active: true }, actor });
  const denton = await saveCustomer(pool(), { ...S, fields: { displayName: 'Q&Z Grain & Seed - Denton', active: true }, actor });
  for (const r of ['1045.99', '1045.99', '994.59', '1105.10']) await newInvoice(dl, r);
  await newInvoice(denton, '975.80');
  const [id] = await bankSays([{ account: 'Operating Checking', amount: '2091.98', date: '2026-10-12', description: 'Q&Z GRAIN SEED PAYMENTS Remit System' }]);
  const s = await suggest(id);
  assert.ok(s.source !== 'settle');
  assert.deepEqual([s.openDocs.key, s.openDocs.n], [`c:${dl}`, 4], 'the customer the bank names (not the Denton one)');
  const page = await (await app.get(`/banking?account=${llId('Operating Checking')}&tab=review`)).text();
  const row = new RegExp(`<tr id="item-${id}"[^>]*>([\\s\\S]*?)</tr>`).exec(page)[1];
  assert.match(row, /4 open invoices from Q&amp;Z Grain &amp; Seed/);
  assert.match(row, new RegExp(`href="/banking/item/${id}\\?find=1&amp;q=Q%26Z\\+Grain\\+%26\\+Seed#match"`));
  const ip = await (await app.get(`/banking/item/${id}?find=1&q=${encodeURIComponent('Q&Z Grain & Seed')}`)).text();
  assert.match(ip, /Q&amp;Z Grain &amp; Seed/);
});

test('a settle suggestion only for the party the bank names, or when it names nobody — never someone else’s invoice (Codex S4 #1)', async () => {
  const { saveCustomer } = await s4();
  const kestrel = await saveCustomer(pool(), { ...S, fields: { displayName: 'Kestrel Mill', active: true }, actor });
  const denton = await saveCustomer(pool(), { ...S, fields: { displayName: 'Kestrel Mill - Denton', active: true }, actor });
  const tern = await saveCustomer(pool(), { ...S, fields: { displayName: 'Tern Distribution', active: true }, actor });
  const kInv = await newInvoice(kestrel, '3141.59');
  await newInvoice(denton, '500.00'); await newInvoice(denton, '600.00');
  const tInv = await newInvoice(tern, '2718.28');
  await newInvoice(kestrel, '100.00');
  // "KESTREL MILL DENTON" names the Denton customer, not Kestrel Mill: Kestrel's exact invoice isn't offered.
  const [a] = await bankSays([{ account: 'Operating Checking', amount: '3141.59', date: '2026-10-12', description: 'KESTREL MILL DENTON PAYMENT' }]);
  const sa = await suggest(a);
  assert.notEqual(sa.source, 'settle');
  assert.equal(sa.openDocs?.key, `c:${denton}`, 'Denton’s open invoices are pointed to');
  // The bank names Kestrel; the only exact invoice is Tern's: not offered, Kestrel's invoices pointed to.
  const [b] = await bankSays([{ account: 'Operating Checking', amount: '2718.28', date: '2026-10-12', description: 'KESTREL MILL PAYMENT' }]);
  const sb = await suggest(b);
  assert.equal(sb.source, 'possible');
  assert.equal(sb.openDocs?.key, `c:${kestrel}`);
  const page = await (await app.get(`/banking?account=${llId('Operating Checking')}&tab=review`)).text();
  assert.doesNotMatch(rowForm(page, b), /name="mode" value="settle"/);
  assert.equal(await openOf(tInv), 271828);
  // Named exactly: sure.
  const [c] = await bankSays([{ account: 'Operating Checking', amount: '3141.59', date: '2026-10-12', description: 'KESTREL MILL PAYMENT' }]);
  const sc = await suggest(c);
  assert.deepEqual([sc.source, sc.confidence, sc.doc.txn_id], ['settle', 'high', Number(kInv)]);
});

test('a demoted match still points to the named customer’s open invoices (Codex S4 #2)', async () => {
  const { saveCustomer } = await s4();
  const heron = await saveCustomer(pool(), { ...S, fields: { displayName: 'Heronwood Stables', active: true }, actor });
  await newInvoice(heron, '777.70');
  const { writeDeposit } = await import('../lib/data/deposits.js');
  await withTransaction(pool(), tx => writeDeposit(tx, { ...S, actor, accountId: A.checking, txnDate: '2026-10-11', memo: 'counter', sourceTxnIds: [],
    otherLines: [{ accountId: A.office, customerId: heron, description: 'x', amount: '777.70' }] }));
  const [id] = await bankSays([{ account: 'Operating Checking', amount: '777.70', date: '2026-10-12', description: 'HERONWOOD STABLES ACH' }]);
  const s = await suggest(id);
  assert.equal(s.source, 'possible');
  assert.equal(s.openDocs?.key, `c:${heron}`);
});

// ---- stage S3: texted receipts on the bank line ----
let rseq = 0;
// A receipt as processReceipt leaves it in a practice copy: read, matched to this bank line, waiting for a person.
async function receiptFor(itemId, { vendorId = null, accountId = null, vendor = 'Puffin Hardware', total = 0, photo = 'photo-bytes' } = {}) {
  const sid = `MM${String(++rseq).padStart(32, '0')}`;
  const { rows: [r] } = await pool().query(`INSERT INTO receipt (org_id, entity_id, from_phone, message_sid, body, filename, content_type, content, size_bytes, status, extracted, vendor_id, account_id, item_id)
    VALUES ($1, $2, '+15555550100', $3, 'hardware', 'receipt.jpg', 'image/jpeg', $4, $5, 'review', $6, $7, $8, $9) RETURNING receipt_id`,
  [S.orgId, S.entityId, sid, Buffer.from(photo), Buffer.from(photo).length, JSON.stringify({ vendor, total_cents: total, date: '2026-10-11', confidence: 'high' }), vendorId, accountId, itemId]);
  return Number(r.receipt_id);
}
const receiptState = async id => (await pool().query('SELECT status, txn_id FROM receipt WHERE receipt_id = $1', [id])).rows[0];

test('a texted receipt matched to a line: shown on the row, fills it in, goes with it when posted, and comes back on Undo', async () => {
  const puffin = await saveVendor(pool(), { ...S, fields: { displayName: 'Puffin Hardware' }, actor });
  const [id] = await bankSays([{ account: 'Business Card', amount: '-58.21', date: '2026-10-12', description: 'PUFFIN HDWE 0041 SEASIDE OR' }]);
  const rid = await receiptFor(id, { vendorId: puffin, accountId: A.office, total: 5821 });
  const page = await (await app.get(`/banking?account=${llId('Business Card')}&tab=review`)).text();
  const row = new RegExp(`<tr id="item-${id}"[^>]*>([\\s\\S]*?)</tr>`).exec(page)[1];
  assert.match(row, /Receipt from Puffin Hardware · \$58\.21, texted/);
  assert.match(row, new RegExp(`href="/receipts/${rid}/image"`));
  assert.match(row, /value="Puffin Hardware"/, 'the receipt’s vendor fills the empty payee');
  const res = await rowPost(id, { account: 'Business Card' });
  assert.equal(res.status, 200, await res.clone().text());
  const { rows: [link] } = await pool().query('SELECT txn_id FROM bank_feed_link WHERE item_id = $1', [id]);
  assert.deepEqual(await receiptState(rid), { status: 'added', txn_id: link.txn_id });
  const { rows: docs } = await pool().query('SELECT filename FROM document WHERE txn_id = $1', [link.txn_id]);
  assert.deepEqual(docs.map(d => d.filename), ['receipt.jpg'], 'the photo is filed on the transaction');
  const { undoItem, undoPlan } = await s4();
  await undoItem(pool(), { ...S, itemId: id, actor, expect: { plan: (await undoPlan(pool(), { ...S, itemId: id })).token } });
  assert.deepEqual(await receiptState(rid), { status: 'review', txn_id: null });
  // Posted again: the photo is filed once more, not copied twice onto the line.
  const res2 = await rowPost(id, { account: 'Business Card' });
  assert.equal(res2.status, 200, await res2.clone().text());
  const { rows: files } = await pool().query(`SELECT count(*)::int AS n FROM bank_item_attachment a JOIN bank_feed_item i ON i.ll_transaction_id = a.ll_transaction_id AND i.entity_id = a.entity_id
    WHERE i.item_id = $1`, [id]);
  assert.equal(files[0].n, 1);
  assert.equal((await receiptState(rid)).status, 'added');
});

test('a receipt matched after the page was shown makes the page out of date — row and batch (Codex design #11)', async () => {
  const v = await saveVendor(pool(), { ...S, fields: { displayName: 'Guillemot Office Supply' }, actor });
  const [id] = await bankSays([{ account: 'Business Card', amount: '-33.10', date: '2026-10-12', description: 'GUILLEMOT OFFICE 2231' }]);
  const page = await (await app.get(`/banking?account=${llId('Business Card')}&tab=review`)).text();
  const form = rowForm(page, id);
  await receiptFor(id, { vendorId: v, accountId: A.office, vendor: 'Guillemot', total: 3310 });
  const body = new URLSearchParams();
  for (const m of form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) body.set(m[1], m[2].replace(/&amp;/g, '&'));
  body.set('payee', 'Guillemot Office Supply');
  const { rows: [cat] } = await pool().query('SELECT name FROM account WHERE account_id = $1', [A.office]);
  body.set('category', cat.name);
  const res = await app.raw(`/banking/item/${id}/row`, { method: 'POST', body: body.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' } });
  assert.equal(res.status, 422);
  assert.equal((await item(id)).review_state, 'new');
  // The batch's row token from before the receipt is stale too.
  const stale = new Map([[id, /name="rev_\d+" value="([^"]+)"/.exec(new RegExp(`<input type="hidden" name="rev_${id}" value="[^"]+"`).exec(page)[0])[1]]]);
  const out = await acceptSuggestions(pool(), { ...S, llAccountId: llId('Business Card'), itemIds: [id], revs: stale, intents: new Map([[id, 'history:0123456789abcdef01234567']]), actor });
  assert.equal(out.accepted, 0);
});

test('a receipt for another bank line, or rejected, never goes with this one', async () => {
  const v = await saveVendor(pool(), { ...S, fields: { displayName: 'Murre Tools' }, actor });
  const [a, b] = await bankSays([{ account: 'Business Card', amount: '-12.40', date: '2026-10-12', description: 'MURRE TOOLS 1' },
    { account: 'Business Card', amount: '-12.40', date: '2026-10-12', description: 'MURRE TOOLS 2' }]);
  const rb = await receiptFor(b, { vendorId: v, accountId: A.office, total: 1240 });
  const ra = await receiptFor(a, { vendorId: v, accountId: A.office, total: 1240 });
  await pool().query(`UPDATE receipt SET status = 'rejected' WHERE receipt_id = $1`, [ra]);
  const { rows: [cat] } = await pool().query('SELECT name FROM account WHERE account_id = $1', [A.office]);
  const res = await rowPost(a, { account: 'Business Card', set: { payee: 'Murre Tools', category: cat.name } });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await receiptState(ra)).status, 'rejected');
  assert.equal((await receiptState(rb)).status, 'review', 'the other line’s receipt waits for that line');
});

test('a receipt never changes what a rule fills in or a batch posts; it fills only an empty row (Codex S3 #1, #2)', async () => {
  const v = await saveVendor(pool(), { ...S, fields: { displayName: 'Razorbill Paints' }, actor });
  const { saveRule } = await import('../lib/bankfeed/rules.js');
  await saveRule(pool(), { ...S, actor, fields: { name: 'Razorbill', money: 'out', mode: 'suggest', conditions: [{ field: 'description', op: 'contains', value: 'RAZORBILL' }], accountId: A.office } });
  const [id] = await bankSays([{ account: 'Business Card', amount: '-41.25', date: '2026-10-12', description: 'RAZORBILL PAINTS 33' }]);
  await receiptFor(id, { vendorId: v, accountId: A.repairs, vendor: 'Razorbill', total: 4125 });
  const page = await (await app.get(`/banking?account=${llId('Business Card')}&tab=review`)).text();
  const row = new RegExp(`<tr id="item-${id}"[^>]*>([\\s\\S]*?)</tr>`).exec(page)[1];
  assert.match(row, /Receipt from Razorbill/);
  assert.match(row, /<input name="payee"[^>]*value=""/, 'the rule says no payee; the receipt doesn’t add one');
  const { rows: [office] } = await pool().query('SELECT name FROM account WHERE account_id = $1', [A.office]);
  assert.ok(row.includes(`value="${office.name.replace(/&/g, '&amp;')}"`), 'the rule’s category, not the receipt’s');
});

test('Post, Undo, reject the receipt: its photo isn’t filed on what the line becomes next (Codex S3 #3)', async () => {
  const v = await saveVendor(pool(), { ...S, fields: { displayName: 'Auklet Lumber' }, actor });
  const [id] = await bankSays([{ account: 'Business Card', amount: '-66.60', date: '2026-10-12', description: 'AUKLET LUMBER YARD' }]);
  const rid = await receiptFor(id, { vendorId: v, accountId: A.office, vendor: 'Auklet Lumber', total: 6660, photo: 'auklet-photo' });
  assert.equal((await rowPost(id, { account: 'Business Card' })).status, 200);
  const { undoItem, undoPlan } = await s4();
  await undoItem(pool(), { ...S, itemId: id, actor, expect: { plan: (await undoPlan(pool(), { ...S, itemId: id })).token } });
  const { rejectReceipt } = await import('../lib/sms/receipts.js');
  await rejectReceipt(pool(), { ...S, receiptId: rid, actor });
  const { rows: [cat] } = await pool().query('SELECT name FROM account WHERE account_id = $1', [A.office]);
  assert.equal((await rowPost(id, { account: 'Business Card', set: { payee: 'Auklet Lumber', category: cat.name } })).status, 200);
  const { rows: [link] } = await pool().query('SELECT txn_id FROM bank_feed_link WHERE item_id = $1', [id]);
  assert.equal((await pool().query('SELECT 1 FROM document WHERE txn_id = $1', [link.txn_id])).rowCount, 0);
  assert.equal((await pool().query('SELECT 1 FROM bank_item_attachment WHERE receipt_id = $1', [rid])).rowCount, 0);
  assert.ok((await pool().query('SELECT content FROM receipt WHERE receipt_id = $1', [rid])).rows[0].content, 'the receipt keeps its photo');
});

test('a bill plus a fee: the receipt points at the transaction its photo is filed on (Codex S3 #4)', async () => {
  const v = await saveVendor(pool(), { ...S, fields: { displayName: 'Petrel Feed Supply' }, actor });
  const b = await newBill(v, '97.63');
  const [id] = await bankSays([{ account: 'Operating Checking', amount: '-99.63', date: '2026-10-12', description: 'PETREL FEED WIRE' }]);
  const rid = await receiptFor(id, { vendorId: v, accountId: A.office, vendor: 'Petrel Feed Supply', total: 9963 });
  const { settleItem, itemToken: tok } = await s4();
  await settleItem(pool(), { ...S, itemId: id, actor, settle: [{ txnId: b, amountCents: 9763 }], adjustments: [{ accountId: A.bank_fees, cents: 200, description: 'wire fee' }],
    expect: { rev: tok(await item(id)) } });
  const r = await receiptState(rid);
  assert.equal(r.status, 'added');
  const { rows: [doc] } = await pool().query(`SELECT d.txn_id FROM bank_item_attachment a JOIN document d ON d.document_id = a.document_id WHERE a.receipt_id = $1`, [rid]);
  assert.equal(Number(r.txn_id), Number(doc.txn_id), 'the same transaction');
});

test('a receipt rejected after the page was shown: the row is refused (Codex S3 #5)', async () => {
  const v = await saveVendor(pool(), { ...S, fields: { displayName: 'Skua Glassworks' }, actor });
  const [id] = await bankSays([{ account: 'Business Card', amount: '-22.22', date: '2026-10-12', description: 'SKUA GLASSWORKS' }]);
  const rid = await receiptFor(id, { vendorId: v, accountId: A.office, vendor: 'Skua Glassworks', total: 2222 });
  const page = await (await app.get(`/banking?account=${llId('Business Card')}&tab=review`)).text();
  const { rejectReceipt } = await import('../lib/sms/receipts.js');
  await rejectReceipt(pool(), { ...S, receiptId: rid, actor });
  const body = new URLSearchParams();
  for (const m of rowForm(page, id).matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) body.set(m[1], m[2].replace(/&amp;/g, '&'));
  for (const m of page.matchAll(new RegExp(`<input name="(payee|category|memo)" form="row-${id}"[^>]*? value="([^"]*)"`, 'g'))) body.set(m[1], m[2].replace(/&amp;/g, '&'));
  const res = await app.raw(`/banking/item/${id}/row`, { method: 'POST', body: body.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' } });
  assert.equal(res.status, 422);
  assert.equal((await item(id)).review_state, 'new');
});

test('a receipt with two charges of its amount near its date is left for a person, however far apart (Codex S3 #6)', async () => {
  await saveVendor(pool(), { ...S, fields: { displayName: 'Fulmar Electric' }, actor });
  const [a, b] = await bankSays([{ account: 'Business Card', amount: '-45.45', date: '2026-10-11', description: 'FULMAR ELECTRIC' },
    { account: 'Business Card', amount: '-45.45', date: '2026-10-14', description: 'FULMAR ELECTRIC' }]);
  const rid = await receiptFor(null, { vendor: 'Fulmar Electric', total: 4545 });
  await pool().query(`UPDATE receipt SET status = 'received' WHERE receipt_id = $1`, [rid]);
  const { processReceipt } = await import('../lib/sms/receipts.js');
  const out = await processReceipt(pool(), { orgId: S.orgId, receiptId: rid, hold: true });
  assert.equal(out.status, 'review');
  const { rows: [r] } = await pool().query('SELECT item_id, note FROM receipt WHERE receipt_id = $1', [rid]);
  assert.equal(r.item_id, null);
  assert.match(r.note, /More than one charge fits/);
  assert.ok(a && b);
});

// ---- S3 round 2: one locked lifecycle for receipts ----
const asReceived = async (rid, extracted) => pool().query(`UPDATE receipt SET status = 'received', item_id = NULL, extracted = $2 WHERE receipt_id = $1`, [rid, JSON.stringify(extracted)]);
const processIt = async rid => (await import('../lib/sms/receipts.js')).processReceipt(pool(), { orgId: S.orgId, receiptId: rid, hold: true });

test('a rejected receipt is never matched again; an ambiguous retry lets go of its line (Codex S3 r2 #1, #2)', async () => {
  const [a] = await bankSays([{ account: 'Business Card', amount: '-71.07', date: '2026-10-11', description: 'SANDPIPER SURF SHOP' }]);
  const rid = await receiptFor(null, { vendor: 'Sandpiper Surf', total: 7107 });
  await asReceived(rid, { vendor: 'Sandpiper Surf', total_cents: 7107, date: '2026-10-11', confidence: 'high' });
  assert.equal((await processIt(rid)).status, 'review');
  assert.equal(Number((await pool().query('SELECT item_id FROM receipt WHERE receipt_id = $1', [rid])).rows[0].item_id), a);
  // A second charge for the amount arrives: the retry can't tell which, and lets go of the first.
  await bankSays([{ account: 'Business Card', amount: '-71.07', date: '2026-10-13', description: 'SANDPIPER SURF SHOP' }]);
  await processIt(rid);
  const { rows: [r] } = await pool().query('SELECT status, item_id, note FROM receipt WHERE receipt_id = $1', [rid]);
  assert.deepEqual([r.status, r.item_id], ['review', null]);
  assert.match(r.note, /More than one charge fits/);
  const { rejectReceipt } = await import('../lib/sms/receipts.js');
  await rejectReceipt(pool(), { ...S, receiptId: rid, actor });
  await processIt(rid);
  assert.equal((await receiptState(rid)).status, 'rejected');
});

test('a receipt paid with another card is never matched to this card’s charge (Codex S3 r2 #3)', async () => {
  const { rows: [card] } = await pool().query(`SELECT mask FROM ledgerline_account WHERE ll_account_id = $1::uuid`, [llId('Business Card')]);
  await bankSays([{ account: 'Business Card', amount: '-19.19', date: '2026-10-11', description: 'TURNSTONE CAFE' }]);
  const rid = await receiptFor(null, { vendor: 'Turnstone Cafe', total: 1919 });
  await asReceived(rid, { vendor: 'Turnstone Cafe', total_cents: 1919, date: '2026-10-11', card_last4: card.mask === '9999' ? '8888' : '9999', confidence: 'high' });
  assert.equal((await processIt(rid)).status, 'waiting');
  assert.equal((await pool().query('SELECT item_id FROM receipt WHERE receipt_id = $1', [rid])).rows[0].item_id, null);
});

test('a match plus a fee takes the receipt once, and files it (Codex S3 r2 #4)', async () => {
  const v = await saveVendor(pool(), { ...S, fields: { displayName: 'Wigeon Welding' }, actor });
  const e = await expense(v, A.office, '150.00', '2026-10-10', 'welding');
  const [id] = await bankSays([{ account: 'Operating Checking', amount: '-152.00', date: '2026-10-12', description: 'WIGEON WELDING' }]);
  const rid = await receiptFor(id, { vendorId: v, accountId: A.office, vendor: 'Wigeon Welding', total: 15200 });
  const { settleItem, itemToken: tok, txnVersions } = await s4();
  await settleItem(pool(), { ...S, itemId: id, actor, txnIds: [e], adjustments: [{ accountId: A.bank_fees, cents: 200, description: 'fee' }],
    expect: { rev: tok(await item(id)), versions: await txnVersions(pool(), [e]) } });
  const r = await receiptState(rid);
  assert.equal(r.status, 'added');
  assert.equal(Number(r.txn_id), Number(e), 'filed on the matched expense (it has the vendor)');
});

test('the clean-up after a review never takes a receipt for a line that was undone (Codex S3 r2 #5)', async () => {
  const v = await saveVendor(pool(), { ...S, fields: { displayName: 'Brant Brick Co' }, actor });
  const [id] = await bankSays([{ account: 'Business Card', amount: '-88.08', date: '2026-10-12', description: 'BRANT BRICK' }]);
  const rid = await receiptFor(id, { vendorId: v, accountId: A.office, vendor: 'Brant Brick', total: 8808 });
  assert.equal((await rowPost(id, { account: 'Business Card' })).status, 200);
  const { undoItem, undoPlan } = await s4();
  await undoItem(pool(), { ...S, itemId: id, actor, expect: { plan: (await undoPlan(pool(), { ...S, itemId: id })).token } });
  const { settleReviewed } = await import('../lib/sms/receipts.js');
  await settleReviewed(pool(), S);
  assert.deepEqual(await receiptState(rid), { status: 'review', txn_id: null });
});

test('a receipt texted after its line was matched is filed the tracked way: Undo then Reject takes it off (Codex S3 r2 #6)', async () => {
  const v = await saveVendor(pool(), { ...S, fields: { displayName: 'Scoter Signs' }, actor });
  const e = await expense(v, A.office, '64.64', '2026-10-11', 'sign', A.card);
  const [id] = await bankSays([{ account: 'Business Card', amount: '-64.64', date: '2026-10-12', description: 'SCOTER SIGNS' }]);
  const { matchItem, txnVersions, undoItem, undoPlan, itemToken: tok } = await s4();
  await matchItem(pool(), { ...S, itemId: id, txnIds: [e], actor, expect: { rev: tok(await item(id)), versions: await txnVersions(pool(), [e]) } });
  const rid = await receiptFor(null, { vendor: 'Scoter Signs', total: 6464 });
  await asReceived(rid, { vendor: 'Scoter Signs', total_cents: 6464, date: '2026-10-12', confidence: 'high' });
  assert.equal((await processIt(rid)).status, 'added');
  assert.equal((await pool().query('SELECT 1 FROM document WHERE txn_id = $1', [e])).rowCount, 1, 'filed on the matched expense');
  await undoItem(pool(), { ...S, itemId: id, actor, expect: { plan: (await undoPlan(pool(), { ...S, itemId: id })).token } });
  const { rejectReceipt } = await import('../lib/sms/receipts.js');
  await rejectReceipt(pool(), { ...S, receiptId: rid, actor });
  assert.equal((await pool().query('SELECT 1 FROM document WHERE txn_id = $1', [e])).rowCount, 0, 'no longer on the expense');
});

// ---- S3 round 3 ----
test('Try again never revives a rejected receipt (Codex S3 r3 #2)', async () => {
  const rid = await receiptFor(null, { vendor: 'Eider Books', total: 1313 });
  await asReceived(rid, { vendor: 'Eider Books', total_cents: 1313, date: '2026-10-11', confidence: 'high' });
  const { rejectReceipt, assignAndRetry } = await import('../lib/sms/receipts.js');
  await rejectReceipt(pool(), { ...S, receiptId: rid, actor });
  await assert.rejects(assignAndRetry(pool(), { ...S, receiptId: rid, actor }), /changed meanwhile/);
  assert.equal((await receiptState(rid)).status, 'rejected');
});

test('a receipt that lets go of its line takes its photo copies with it (Codex S3 r3 #3)', async () => {
  const v = await saveVendor(pool(), { ...S, fields: { displayName: 'Gadwall Garden' }, actor });
  const [id] = await bankSays([{ account: 'Business Card', amount: '-36.36', date: '2026-10-11', description: 'GADWALL GARDEN' }]);
  const rid = await receiptFor(id, { vendorId: v, accountId: A.office, vendor: 'Gadwall Garden', total: 3636 });
  assert.equal((await rowPost(id, { account: 'Business Card' })).status, 200);
  const { undoItem, undoPlan } = await s4();
  await undoItem(pool(), { ...S, itemId: id, actor, expect: { plan: (await undoPlan(pool(), { ...S, itemId: id })).token } });
  // A second charge for the amount: the retry can't tell which and lets go of this line.
  await bankSays([{ account: 'Business Card', amount: '-36.36', date: '2026-10-13', description: 'GADWALL GARDEN' }]);
  await asReceived(rid, { vendor: 'Gadwall Garden', total_cents: 3636, date: '2026-10-11', confidence: 'high' });
  await pool().query('UPDATE receipt SET item_id = $2 WHERE receipt_id = $1', [rid, id]);
  await processIt(rid);
  assert.equal((await pool().query('SELECT item_id FROM receipt WHERE receipt_id = $1', [rid])).rows[0].item_id, null);
  assert.equal((await pool().query('SELECT 1 FROM bank_item_attachment WHERE receipt_id = $1', [rid])).rowCount, 0);
  const { rows: [cat] } = await pool().query('SELECT name FROM account WHERE account_id = $1', [A.office]);
  assert.equal((await rowPost(id, { account: 'Business Card', set: { payee: 'Gadwall Garden', category: cat.name } })).status, 200);
  const { rows: [link] } = await pool().query('SELECT txn_id FROM bank_feed_link WHERE item_id = $1', [id]);
  assert.equal((await pool().query('SELECT 1 FROM document WHERE txn_id = $1', [link.txn_id])).rowCount, 0, 'the photo didn’t come along');
});

test('a receipt from a business the books don’t know never takes a charge naming one of the company’s vendors (Codex S3 r3 #4)', async () => {
  await saveVendor(pool(), { ...S, fields: { displayName: 'Tern Probe Supply' }, actor });
  await bankSays([{ account: 'Business Card', amount: '-27.27', date: '2026-10-11', description: 'TERN PROBE SUPPLY' }]);
  const rid = await receiptFor(null, { vendor: 'Albatross Bakery', total: 2727 });
  await asReceived(rid, { vendor: 'Albatross Bakery', total_cents: 2727, date: '2026-10-11', confidence: 'high' });
  assert.equal((await processIt(rid)).status, 'waiting');
  assert.equal((await pool().query('SELECT item_id FROM receipt WHERE receipt_id = $1', [rid])).rows[0].item_id, null);
});

test('a receipt whose transaction was deleted directly can be rejected, its photo gone (Codex S3 r3 #6)', async () => {
  const v = await saveVendor(pool(), { ...S, fields: { displayName: 'Smew Stationery' }, actor });
  const [id] = await bankSays([{ account: 'Business Card', amount: '-17.71', date: '2026-10-11', description: 'SMEW STATIONERY' }]);
  const rid = await receiptFor(id, { vendorId: v, accountId: A.office, vendor: 'Smew Stationery', total: 1771 });
  assert.equal((await rowPost(id, { account: 'Business Card' })).status, 200);
  const { rows: [link] } = await pool().query('SELECT txn_id FROM bank_feed_link WHERE item_id = $1', [id]);
  const { deleteVendorTxn } = await import('../lib/data/payables.js');
  if (deleteVendorTxn) await deleteVendorTxn(pool(), { ...S, txnId: link.txn_id, actor });
  else await withTransaction(pool(), async tx => (await import('../lib/data/payables.js')).deleteVendorTxnTx(tx, { ...S, txnId: link.txn_id, actor }));
  const { rejectReceipt } = await import('../lib/sms/receipts.js');
  await rejectReceipt(pool(), { ...S, receiptId: rid, actor });
  assert.equal((await receiptState(rid)).status, 'rejected');
  assert.equal((await pool().query('SELECT 1 FROM bank_item_attachment WHERE receipt_id = $1', [rid])).rowCount, 0);
});

// ---- S3 round 4 ----
test('a bank correction to another amount or vendor: the old receipt no longer goes with the line (Codex S3 r4 #1)', async () => {
  const robin = await saveVendor(pool(), { ...S, fields: { displayName: 'Robin Machinery' }, actor });
  await saveVendor(pool(), { ...S, fields: { displayName: 'Raven Groceries' }, actor });
  const key = `word-${++seq}`;
  await ll.query(`INSERT INTO core.transaction (org_id, transaction_id, account_id, amount, currency, posted_date, pending, description_raw, status, revision)
    VALUES ($1, $2, $3, '-38.38', 'USD', '2026-10-12', false, 'ROBIN MACHINERY', 'active', 1)`, [feed.org, sampleUuid('word', key), llId('Business Card')]);
  await pullCompany(pool(), ll, S);
  const id = Number((await pool().query('SELECT item_id FROM bank_feed_item WHERE ll_transaction_id = $1', [sampleUuid('word', key)])).rows[0].item_id);
  const rid = await receiptFor(id, { vendorId: robin, accountId: A.office, vendor: 'Robin Machinery', total: 3838 });
  assert.equal((await item(id)).receipt_ids, String(rid));
  // The bank corrects it: another amount and another business.
  await ll.query(`UPDATE core.transaction SET amount = '-47.47', description_raw = 'RAVEN GROCERIES', revision = 2 WHERE transaction_id = $1`, [sampleUuid('word', key)]);
  await pullCompany(pool(), ll, S);
  assert.equal((await item(id)).receipt_ids ?? null, null);
  const page = await (await app.get(`/banking?account=${llId('Business Card')}&tab=review`)).text();
  assert.doesNotMatch(new RegExp(`<tr id="item-${id}"[^>]*>([\\s\\S]*?)</tr>`).exec(page)[1], /Receipt from Robin/);
  // Only the vendor changed (same amount): still not the receipt's.
  await ll.query(`UPDATE core.transaction SET amount = '-38.38', revision = 3 WHERE transaction_id = $1`, [sampleUuid('word', key)]);
  await pullCompany(pool(), ll, S);
  assert.equal((await item(id)).receipt_ids ?? null, null, 'the bank names Raven, not Robin');
});

test('a charge naming two vendors takes neither’s receipt (Codex S3 r4 #2)', async () => {
  await saveVendor(pool(), { ...S, fields: { displayName: 'Finch Pharmacy' }, actor });
  await saveVendor(pool(), { ...S, fields: { displayName: 'Rook Hardware' }, actor });
  await bankSays([{ account: 'Business Card', amount: '-55.05', date: '2026-10-11', description: 'FINCH PHARMACY ROOK HARDWARE' }]);
  const rid = await receiptFor(null, { vendor: 'Rook Hardware', total: 5505 });
  await asReceived(rid, { vendor: 'Rook Hardware', total_cents: 5505, date: '2026-10-11', confidence: 'high' });
  assert.equal((await processIt(rid)).status, 'waiting');
});

test('a transaction deleted directly gives its receipt back to the line’s review (Codex S3 r4 #3)', async () => {
  const v = await saveVendor(pool(), { ...S, fields: { displayName: 'Shrike Saddlery' }, actor });
  const [id] = await bankSays([{ account: 'Business Card', amount: '-91.19', date: '2026-10-12', description: 'SHRIKE SADDLERY' }]);
  const rid = await receiptFor(id, { vendorId: v, accountId: A.office, vendor: 'Shrike Saddlery', total: 9119 });
  assert.equal((await rowPost(id, { account: 'Business Card' })).status, 200);
  const { rows: [link] } = await pool().query('SELECT txn_id FROM bank_feed_link WHERE item_id = $1', [id]);
  const { deleteVendorTxn } = await import('../lib/data/payables.js');
  await deleteVendorTxn(pool(), { ...S, txnId: link.txn_id, actor });
  assert.deepEqual(await receiptState(rid), { status: 'review', txn_id: null });
  assert.equal((await item(id)).receipt_ids, String(rid), 'shown on the line again, and taken by its next review');
  assert.equal((await rowPost(id, { account: 'Business Card' })).status, 200);
  assert.equal((await receiptState(rid)).status, 'added');
});

// ---- S3 round 5 ----
test('the Receipts page clean-up never files a receipt that no longer fits its corrected line (Codex S3 r5 #1)', async () => {
  const robin = await saveVendor(pool(), { ...S, fields: { displayName: 'Robinet Valves' }, actor });
  await saveVendor(pool(), { ...S, fields: { displayName: 'Ravenna Market' }, actor });
  const key = `word-${++seq}`;
  await ll.query(`INSERT INTO core.transaction (org_id, transaction_id, account_id, amount, currency, posted_date, pending, description_raw, status, revision)
    VALUES ($1, $2, $3, '-38.83', 'USD', '2026-10-12', false, 'ROBINET VALVES', 'active', 1)`, [feed.org, sampleUuid('word', key), llId('Business Card')]);
  await pullCompany(pool(), ll, S);
  const id = Number((await pool().query('SELECT item_id FROM bank_feed_item WHERE ll_transaction_id = $1', [sampleUuid('word', key)])).rows[0].item_id);
  const rid = await receiptFor(id, { vendorId: robin, accountId: A.office, vendor: 'Robinet Valves', total: 3883 });
  await ll.query(`UPDATE core.transaction SET amount = '-47.74', description_raw = 'RAVENNA MARKET', revision = 2 WHERE transaction_id = $1`, [sampleUuid('word', key)]);
  await pullCompany(pool(), ll, S);
  const { rows: [cat] } = await pool().query('SELECT name FROM account WHERE account_id = $1', [A.office]);
  assert.equal((await rowPost(id, { account: 'Business Card', set: { payee: 'Ravenna Market', category: cat.name } })).status, 200);
  const { settleReviewed } = await import('../lib/sms/receipts.js');
  await settleReviewed(pool(), S);
  assert.equal((await receiptState(rid)).status, 'review');
  const { rows: [link] } = await pool().query('SELECT txn_id FROM bank_feed_link WHERE item_id = $1', [id]);
  assert.equal((await pool().query('SELECT 1 FROM document WHERE txn_id = $1', [link.txn_id])).rowCount, 0);
});

test('a receipt’s photo can’t be taken off the bank line except by rejecting the receipt (Codex S3 r5 #2)', async () => {
  const v = await saveVendor(pool(), { ...S, fields: { displayName: 'Lapwing Lamps' }, actor });
  const [id] = await bankSays([{ account: 'Business Card', amount: '-29.92', date: '2026-10-12', description: 'LAPWING LAMPS' }]);
  const rid = await receiptFor(id, { vendorId: v, accountId: A.office, vendor: 'Lapwing Lamps', total: 2992 });
  assert.equal((await rowPost(id, { account: 'Business Card' })).status, 200);
  const { rows: [f] } = await pool().query('SELECT attachment_id FROM bank_item_attachment WHERE receipt_id = $1', [rid]);
  const { deleteBankAttachment } = await import('../lib/data/bank-extras.js');
  await assert.rejects(deleteBankAttachment(pool(), { ...S, itemId: id, attachmentId: f.attachment_id }), /reject the receipt/);
});

test('the item page shows the receipts its review will take (Codex S3 r5 #3)', async () => {
  const v = await saveVendor(pool(), { ...S, fields: { displayName: 'Dunlin Drapery' }, actor });
  const [id] = await bankSays([{ account: 'Business Card', amount: '-73.37', date: '2026-10-12', description: 'DUNLIN DRAPERY' }]);
  const rid = await receiptFor(id, { vendorId: v, accountId: A.office, vendor: 'Dunlin Drapery', total: 7337 });
  const ip = await (await app.get(`/banking/item/${id}`)).text();
  assert.match(ip, /Receipt from Dunlin Drapery · \$73\.37/);
  assert.match(ip, new RegExp(`href="/receipts/${rid}/image"`));
});

// ---- S3 round 6 ----
test('two receipts that fit one charge: both are left for a person, and the line shows neither (Codex S3 r6 #1)', async () => {
  const [id] = await bankSays([{ account: 'Business Card', amount: '-24.31', date: '2026-10-12', description: 'POS PURCHASE 4471' }]);
  const r1 = await receiptFor(null, { vendor: 'Pipit Pastry', total: 2431 });
  await asReceived(r1, { vendor: 'Pipit Pastry', total_cents: 2431, date: '2026-10-11', confidence: 'high' });
  await processIt(r1);
  assert.equal(Number((await pool().query('SELECT item_id FROM receipt WHERE receipt_id = $1', [r1])).rows[0].item_id), id);
  const before = (await item(id)).receipt_ids;
  const r2 = await receiptFor(null, { vendor: 'Wagtail Wines', total: 2431 });
  await asReceived(r2, { vendor: 'Wagtail Wines', total_cents: 2431, date: '2026-10-11', confidence: 'high' });
  await processIt(r2);
  const { rows } = await pool().query('SELECT receipt_id, status, item_id, note FROM receipt WHERE receipt_id = ANY($1) ORDER BY receipt_id', [[r1, r2]]);
  assert.deepEqual(rows.map(r => [r.status, r.item_id]), [['review', null], ['review', null]]);
  assert.ok(rows.every(r => /Another receipt fits the same charge/.test(r.note)));
  assert.notEqual((await item(id)).receipt_ids ?? null, before, 'a page that showed the first is out of date');
});

test('rejecting a receipt with the same photo as another never touches the other’s document (Codex S3 r7 #2)', async () => {
  const v = await saveVendor(pool(), { ...S, fields: { displayName: 'Bunting Books' }, actor });
  const [id] = await bankSays([{ account: 'Business Card', amount: '-15.51', date: '2026-10-12', description: 'BUNTING BOOKS' }]);
  const ra = await receiptFor(id, { vendorId: v, accountId: A.office, vendor: 'Bunting Books', total: 1551, photo: 'same-photo' });
  assert.equal((await rowPost(id, { account: 'Business Card' })).status, 200);
  const { rows: [link] } = await pool().query('SELECT txn_id FROM bank_feed_link WHERE item_id = $1', [id]);
  const rb = await receiptFor(null, { vendor: 'Bunting Books', total: 1551, photo: 'same-photo' });
  const { rejectReceipt } = await import('../lib/sms/receipts.js');
  await rejectReceipt(pool(), { ...S, receiptId: rb, actor });
  assert.equal((await pool().query('SELECT 1 FROM document WHERE txn_id = $1', [link.txn_id])).rowCount, 1, 'A’s photo stays on A’s transaction');
  assert.equal((await receiptState(ra)).status, 'added');
});

test('two receipts for one charge stay a person’s choice on Retry and when a third arrives (Codex S3 r7 #1)', async () => {
  const [id] = await bankSays([{ account: 'Business Card', amount: '-42.24', date: '2026-10-12', description: 'POS PURCHASE 9921' }]);
  const mk = async name => { const rid = await receiptFor(null, { vendor: name, total: 4224 }); await asReceived(rid, { vendor: name, total_cents: 4224, date: '2026-10-11', confidence: 'high' }); return rid; };
  const r1 = await mk('Pipit Pies'), r2 = await mk('Wagtail Wares');
  await processIt(r1); await processIt(r2);
  // Retry the first: still two receipts for the charge.
  await pool().query(`UPDATE receipt SET status = 'received' WHERE receipt_id = $1`, [r1]);
  await processIt(r1);
  const r3 = await mk('Linnet Linens');
  await processIt(r3);
  const { rows } = await pool().query('SELECT status, item_id FROM receipt WHERE receipt_id = ANY($1)', [[r1, r2, r3]]);
  assert.ok(rows.every(r => r.status === 'review' && r.item_id === null), JSON.stringify(rows));
  assert.equal((await item(id)).review_state, 'new', 'nothing posted on its own');
});

test('the review’s history keeps the receipts it took (Codex S3 r6 #3)', async () => {
  const v = await saveVendor(pool(), { ...S, fields: { displayName: 'Bittern Boots' }, actor });
  const [id] = await bankSays([{ account: 'Business Card', amount: '-81.18', date: '2026-10-12', description: 'BITTERN BOOTS' }]);
  const rid = await receiptFor(id, { vendorId: v, accountId: A.office, vendor: 'Bittern Boots', total: 8118 });
  assert.equal((await rowPost(id, { account: 'Business Card' })).status, 200);
  const { rows: [ev] } = await pool().query(`SELECT detail FROM bank_review_event WHERE item_id = $1 AND kind = 'added' ORDER BY event_id DESC LIMIT 1`, [id]);
  assert.equal(ev.detail.receipts?.[0]?.receipt_id, rid);
  assert.equal(Number(ev.detail.receipts[0].vendor_id), v);
  assert.equal(ev.detail.receipts[0].read.vendor, 'Bittern Boots');
});

// ---- card payments (the owner's ask: "if it recognizes that it's a credit card payment from a bank account that's in the
// same company, it will automatically match it and route it to that credit card in the chart of accounts") ----
test('a card payment out of a bank account goes to the company’s card: by its last four, else the card company, else the only card', async () => {
  const { rows: [cardLine] } = await pool().query(`SELECT mask FROM ledgerline_account WHERE ll_account_id = $1::uuid`, [llId('Business Card')]);
  // By the last four the bank text names.
  const [a] = await bankSays([{ account: 'Operating Checking', amount: '-536.40', date: '2026-10-12', description: `PAYMENT TO CREDIT CARD ENDING IN ${cardLine.mask}` }]);
  const sa = await suggest(a);
  assert.deepEqual([sa.basis, sa.accountId, sa.confidence], ['card', A.card, 'high']);
  // The only card, when the text says outright it's a card payment.
  const [b] = await bankSays([{ account: 'Operating Checking', amount: '-212.12', date: '2026-10-12', description: 'ONLINE CRD EPAY 0042' }]);
  assert.deepEqual([(await suggest(b)).accountId, (await suggest(b)).confidence], [A.card, 'medium']);
  // A card company's name with a payment word picks the card named for it.
  const { rows: [chase] } = await pool().query(`INSERT INTO account (org_id, entity_id, name, type, active) VALUES ($1, $2, 'Chase Ink 7781', 'credit_card', true) RETURNING account_id`, [S.orgId, S.entityId]);
  const [c] = await bankSays([{ account: 'Operating Checking', amount: '-99.99', date: '2026-10-12', description: 'CHASE CREDIT CRD EPAY PAT SAMPLE' }]);
  assert.deepEqual([(await suggest(c)).basis, (await suggest(c)).accountId], ['card', Number(chase.account_id)]);
  // Not a card payment: an insurance ACH payment.
  const [d] = await bankSays([{ account: 'Operating Checking', amount: '-110.00', date: '2026-10-12', description: 'PROG PREFERRED INS PREM ACH PMT' }]);
  assert.notEqual((await suggest(d))?.basis, 'card');
  // Money in, or on the card itself: never.
  const [e] = await bankSays([{ account: 'Business Card', amount: '536.40', date: '2026-10-12', description: 'PAYMENT THANK YOU CRD EPAY' }]);
  assert.notEqual((await suggest(e))?.basis, 'card');
  // The list says why; posting it records the payment to the card (both accounts move, nothing to an expense).
  const page = await (await app.get(`/banking?account=${llId('Operating Checking')}&tab=review`)).text();
  assert.match(page, /Card payment — to this card by its last four/);
  assert.equal((await rowPost(a)).status, 200);
  const { rows } = await pool().query(`SELECT p.account_id, p.amount_cents FROM bank_feed_link k JOIN posting p ON p.txn_id = k.txn_id WHERE k.item_id = $1 ORDER BY p.amount_cents`, [a]);
  assert.deepEqual(rows.map(r => [Number(r.account_id), Number(r.amount_cents)]), [[A.checking, -53640], [A.card, 53640]]);
  await pool().query('UPDATE account SET active = false WHERE account_id = $1', [chase.account_id]);
});

test('a card payment is never sent to another card, nor a loan payment to a card (Codex card review #1, #2)', async () => {
  const { rows: [chase] } = await pool().query(`INSERT INTO account (org_id, entity_id, name, type, active) VALUES ($1, $2, 'Chase Freedom 7781', 'credit_card', true) RETURNING account_id`, [S.orgId, S.entityId]);
  try {
    const lines = await bankSays([{ account: 'Operating Checking', amount: '-61.35', date: '2026-10-12', description: 'CHASE CREDIT CRD EPAY CARD ENDING IN 6150' },
      { account: 'Operating Checking', amount: '-450.00', date: '2026-10-12', description: 'CHASE AUTO LOAN PAYMENT' },
      { account: 'Operating Checking', amount: '-1890.00', date: '2026-10-12', description: 'CHASE MORTGAGE PAYMENT' },
      { account: 'Operating Checking', amount: '-75.00', date: '2026-10-12', description: 'CITI CHASE CARD PMT' },
      { account: 'Operating Checking', amount: '-40.00', date: '2026-10-12', description: 'CHASE ONLINE PAYMENT' }]);
    for (const id of lines) assert.notEqual((await suggest(id))?.basis, 'card', (await item(id)).description);
    const [ok] = await bankSays([{ account: 'Operating Checking', amount: '-77.81', date: '2026-10-12', description: 'CHASE CREDIT CRD EPAY CARD ENDING IN 7781' }]);
    assert.equal((await suggest(ok)).accountId, Number(chase.account_id));
    const [amex] = await bankSays([{ account: 'Operating Checking', amount: '-12.34', date: '2026-10-12', description: 'AMERICAN EXPRESS ACH PMT M0510' }]);
    assert.notEqual((await suggest(amex))?.accountId, Number(chase.account_id), 'an AmEx payment never goes to a Chase card');
  } finally { await pool().query('UPDATE account SET active = false WHERE account_id = $1', [chase.account_id]); }
});

test('every number named points at the same card, and the card is never named for another card company (Codex card r2)', async () => {
  const { rows: [chase] } = await pool().query(`INSERT INTO account (org_id, entity_id, name, type, active) VALUES ($1, $2, 'Chase Sapphire 7781', 'credit_card', true) RETURNING account_id`, [S.orgId, S.entityId]);
  try {
    const lines = await bankSays([{ account: 'Operating Checking', amount: '-61.36', date: '2026-10-12', description: 'CHASE CREDIT CRD EPAY FROM *7781 TO CARD ENDING IN 6150' },
      { account: 'Operating Checking', amount: '-61.37', date: '2026-10-12', description: 'CITI CARD PMT CARD ENDING IN 7781' },
      { account: 'Operating Checking', amount: '-61.38', date: '2026-10-12', description: 'AMERICAN EXPRESS CARD PAYMENT' }]);
    for (const id of lines) assert.notEqual((await suggest(id))?.accountId, Number(chase.account_id), (await item(id)).description);
  } finally { await pool().query('UPDATE account SET active = false WHERE account_id = $1', [chase.account_id]); }
});

test('card companies only as whole words; a card by company name is only likely (not batch); research leaves card payments alone (Codex card review)', async () => {
  const { saysCardPayment } = await import('../lib/bankfeed/rules.js');
  assert.equal(saysCardPayment('CITIZENS INSURANCE ACH PMT'), false);
  assert.equal(saysCardPayment('POS PURCHASE PAYMENT 4471'), false);
  assert.equal(saysCardPayment('WELLS FARGO AUTO LOAN PAYMENT CARD PMT'), false);
  assert.equal(saysCardPayment('ONLINE CARD PAYMENT'), true);
  const { looksLikeTransfer } = await import('../lib/ai/auto-research.js');
  for (const t of ['CARD PAYMENT', 'CRD PMT 0042', 'CC PMT', 'CARDMEMBER SERV WEB PYMT']) assert.ok(looksLikeTransfer({ description: t }), t);
  const { rows: [chase] } = await pool().query(`INSERT INTO account (org_id, entity_id, name, type, active) VALUES ($1, $2, 'Chase Slate 17781', 'credit_card', true) RETURNING account_id`, [S.orgId, S.entityId]);
  try {
    const [byName, partial] = await bankSays([{ account: 'Operating Checking', amount: '-33.33', date: '2026-10-12', description: 'CHASE CREDIT CRD EPAY PAT SAMPLE' },
      { account: 'Operating Checking', amount: '-33.34', date: '2026-10-12', description: 'CHASE CREDIT CRD EPAY ENDING IN 7781' }]);
    const s = await suggest(byName);
    assert.deepEqual([s.accountId, s.confidence], [Number(chase.account_id), 'medium']);
    assert.equal(intentOf(s, await item(byName)), null, 'by card company only: a person posts it');
    assert.notEqual((await suggest(partial))?.accountId, Number(chase.account_id), '7781 is not 17781');
  } finally { await pool().query('UPDATE account SET active = false WHERE account_id = $1', [chase.account_id]); }
});

test('a longer card number is matched whole, never cut to another card’s (Codex card r4 #1)', async () => {
  const { rows: [a] } = await pool().query(`INSERT INTO account (org_id, entity_id, name, type, active) VALUES ($1, $2, 'Amex 1000', 'credit_card', true) RETURNING account_id`, [S.orgId, S.entityId]);
  const { rows: [b] } = await pool().query(`INSERT INTO account (org_id, entity_id, name, type, active) VALUES ($1, $2, 'Amex 10001', 'credit_card', true) RETURNING account_id`, [S.orgId, S.entityId]);
  try {
    const [x, y] = await bankSays([{ account: 'Operating Checking', amount: '-137.19', date: '2026-10-12', description: 'AMEX CARD PAYMENT ENDING IN 10001' },
      { account: 'Operating Checking', amount: '-137.20', date: '2026-10-12', description: 'AMEX CARD PAYMENT ENDING IN 1000' }]);
    assert.equal((await suggest(x))?.accountId, Number(b.account_id));
    assert.equal((await suggest(y))?.accountId, Number(a.account_id));
  } finally { await pool().query('UPDATE account SET active = false WHERE account_id = ANY($1)', [[a.account_id, b.account_id]]); }
});
