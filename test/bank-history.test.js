import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { picks } from './bank-forms.js';
import { startApp } from './app-harness.js';
import { freshDb } from './harness.js';
import { buildSampleFeed, writeLedgerlineSample, sampleUuid } from '../lib/bankfeed/sample.js';
import { pullCompany } from '../lib/bankfeed/pull.js';
import { linkCompany, saveMappings } from '../lib/data/bankfeeds.js';
import { getBankItem } from '../lib/data/banking.js';
import { writeVendorDoc } from '../lib/data/payables.js';
import { saveVendor } from '../lib/data/vendors.js';
import { learnedHistory, suggestFor, listRules, vendorFor, categoryHistory } from '../lib/bankfeed/rules.js';
import { withTransaction } from '../lib/db.js';

// Bank review v2, stage BR-4: the books' own history teaches suggestions from day one, and the item page shows
// how the payee was categorized before, with Assign.
let app, llDb, ll, feed, S, A;
const actor = 'tester';
const llId = name => feed.accounts.find(a => a.name === name).id;
const pool = () => app.db.pool;
let vendorId;

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
  // A vendor with history only in the books (as if imported from QuickBooks): three repairs, one office purchase.
  vendorId = await saveVendor(pool(), { ...S, fields: { displayName: 'Zephyr Hardware Supply' }, actor });
  for (const [account, amount, date] of [[A.repairs, '40.00', '2026-03-02'], [A.repairs, '55.10', '2026-06-14'], [A.office, '12.00', '2026-08-01'], [A.repairs, '61.75', '2026-09-20'],
    [A.office, '99.00', '2023-01-05']]) {
    await withTransaction(pool(), tx => writeVendorDoc(tx, { ...S, actor, type: 'expense', vendorId, txnDate: date, accountId: A.card, memo: 'books history',
      categoryLines: [{ accountId: account, amount }], itemLines: [] }));
  }
});
after(async () => { await app.close(); await llDb.drop(); });

let seq = 0;
async function bankSays(rows) {
  const keys = [];
  for (const r of rows) {
    const key = `hist-${++seq}`;
    keys.push(key);
    await ll.query(`INSERT INTO core.transaction (org_id, transaction_id, account_id, amount, currency, posted_date, pending, description_raw, status, revision)
      VALUES ($1, $2, $3, $4, 'USD', $5, false, $6, 'active', 1)`, [feed.org, sampleUuid('hist', key), llId(r.account), r.amount, r.date ?? '2026-10-12', r.description]);
  }
  await pullCompany(pool(), ll, S);
  const ids = [];
  for (const k of keys) ids.push(Number((await pool().query('SELECT item_id FROM bank_feed_item WHERE ll_transaction_id = $1', [sampleUuid('hist', k)])).rows[0].item_id));
  return ids;
}

test('a bank line naming a vendor with books history is suggested like the books: 3 of 4, older than 24 months not counted', async () => {
  const [id] = await bankSays([{ account: 'Business Card', amount: '-48.20', description: 'POS ZEPHYR HARDWARE #0412' }]);
  const item = await getBankItem(pool(), { ...S, itemId: id });
  const history = await learnedHistory(pool(), S);
  const s = await suggestFor(pool(), { ...S, item, rules: await listRules(pool(), S), history });
  assert.deepEqual([s.source, s.basis, s.payee, s.accountId, s.count, s.of, s.confidence], ['history', 'books', `v:${vendorId}`, A.repairs, 3, 4, 'medium']);
  // The list says where it came from.
  const list = await (await app.get(`/banking?account=${llId('Business Card')}&tab=review`)).text();
  assert.match(list, /Like 3 of 4 of Zephyr Hardware Supply’s in the books/);
  // Money in never takes a vendor's purchase history.
  const [refund] = await bankSays([{ account: 'Business Card', amount: '18.00', description: 'ZEPHYR HARDWARE REFUND' }]);
  const r = await suggestFor(pool(), { ...S, item: await getBankItem(pool(), { ...S, itemId: refund }), rules: [], history });
  assert.ok(!r || r.basis !== 'books');
});

test('the item page shows the history with counts, last used and details; Assign fills in the Add form', async () => {
  const [id] = await bankSays([{ account: 'Business Card', amount: '-22.00', description: 'ZEPHYR HARDWARE 0413' }]);
  const page = await (await app.get(`/banking/item/${id}`)).text();
  assert.match(page, /<h2>History<\/h2>/);
  assert.match(page, /How <strong>Zephyr Hardware Supply<\/strong> was categorized before/);
  assert.match(page, /Repairs[\s\S]*?3 in the books[\s\S]*?9\/20\/26/);
  assert.match(page, new RegExp(`href="/banking/item/${id}\\?from=history&amp;category=${A.repairs}&amp;payee=v:${vendorId}#add"`));
  const filled = await (await app.get(`/banking/item/${id}?from=history&category=${A.office}&payee=v:${vendorId}`)).text();
  assert.match(filled, /Filled in from the history — check it, then Add/);
  assert.match(filled, /<input name="payee" list="item-payees" autocomplete="off" value="Zephyr Hardware Supply"/);
  assert.match(filled, /<input name="line_account" list="item-cats" autocomplete="off" value="Office Supplies"/);
  // A bank review adds to what the panel shows next time.
  const res = await app.post(`/banking/item/${id}/add`, new URLSearchParams([...await picks(app, id), ['rev', /name="rev" value="([^"]+)"/.exec(filled)[1]], ['evidence', /name="evidence" value="([^"]*)"/.exec(filled)?.[1] ?? ''],
    ['payee', 'Zephyr Hardware Supply'], ['line_account', 'Office Supplies'], ['line_amount', '']]));
  assert.equal(res.status, 303);
  const [next] = await bankSays([{ account: 'Business Card', amount: '-9.00', description: 'ZEPHYR HARDWARE 0414' }]);
  const h = await categoryHistory(pool(), { ...S, item: await getBankItem(pool(), { ...S, itemId: next }), history: await learnedHistory(pool(), S) });
  const office = h.rows.find(r => r.accountId === A.office);
  assert.deepEqual([office.bank, office.books], [1, 2], 'one bank review, plus the books (the bank-added expense counts there too)');
});

test('a description names a vendor only when exactly one fits', async () => {
  const books = { vendors: [{ id: 1, name: 'Lowes Home', key: 'LOWES HOME' }, { id: 2, name: 'Ace', key: 'ACE' }, { id: 3, name: 'Ace Hardware West', key: 'ACE HARDWARE WEST' },
    { id: 4, name: 'Ace Hardware East', key: 'ACE HARDWARE EAST' }], byVendor: new Map() };
  const it = d => ({ description: d, merchant_name: null });
  assert.equal(vendorFor(books, it('LOWES #2231'))?.id, 1);
  assert.equal(vendorFor(books, it('ACE'))?.id, 2);
  assert.equal(vendorFor(books, it('ACE HARDWARE 55')), null, 'two Ace Hardware vendors: neither');
  assert.equal(vendorFor(books, it('SQ *COFFEE')), null);
});

test('a vendor whose purchases were split across categories teaches no whole-item category', async () => {
  const v = await saveVendor(pool(), { ...S, fields: { displayName: 'Aster Mixed Purchases' }, actor });
  for (const amt of ['5000.00', '5001.00', '5002.00']) {
    await withTransaction(pool(), tx => writeVendorDoc(tx, { ...S, actor, type: 'expense', vendorId: v, txnDate: '2026-09-01', accountId: A.card, memo: 'split',
      categoryLines: [{ accountId: A.repairs, amount: '100.00' }, { accountId: A.office, amount: amt }], itemLines: [] }));
  }
  const [id] = await bankSays([{ account: 'Business Card', amount: '-5203.71', description: 'ASTER MIXED PURCHASES' }]);
  const s = await suggestFor(pool(), { ...S, item: await getBankItem(pool(), { ...S, itemId: id }), rules: [], history: await learnedHistory(pool(), S) });
  assert.ok(!s || s.basis !== 'books', 'no books-history suggestion from split purchases');
});

test('a card payment with a fee, or a purchase with a negative line, teaches no whole-item category', async () => {
  const card = await saveVendor(pool(), { ...S, fields: { displayName: 'Amber Card Finance' }, actor });
  const birch = await saveVendor(pool(), { ...S, fields: { displayName: 'Birch Equipment Exchange' }, actor });
  for (const n of ['1000.00', '1001.00', '1002.00']) {
    await withTransaction(pool(), tx => writeVendorDoc(tx, { ...S, actor, type: 'expense', vendorId: card, txnDate: '2026-09-01', accountId: A.checking, memo: 'card',
      categoryLines: [{ accountId: A.card, amount: n }, { accountId: A.bank_fees, amount: '10.00' }], itemLines: [] }));
    await withTransaction(pool(), tx => writeVendorDoc(tx, { ...S, actor, type: 'expense', vendorId: birch, txnDate: '2026-09-01', accountId: A.checking, memo: 'return',
      categoryLines: [{ accountId: A.repairs, amount: (Number(n) + 100).toFixed(2) }, { accountId: A.office, amount: '-1000.00' }], itemLines: [] }));
  }
  for (const d of ['AMBER CARD FINANCE', 'BIRCH EQUIPMENT EXCHANGE']) {
    const [id] = await bankSays([{ account: 'Business Card', amount: '-103.71', description: d }]);
    const s = await suggestFor(pool(), { ...S, item: await getBankItem(pool(), { ...S, itemId: id }), rules: [], history: await learnedHistory(pool(), S) });
    assert.ok(!s || s.basis !== 'books', d);
  }
});
