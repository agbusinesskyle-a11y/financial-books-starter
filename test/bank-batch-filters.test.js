import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './app-harness.js';
import { freshDb } from './harness.js';
import { tieout } from './tieout.js';
import { buildSampleFeed, writeLedgerlineSample, sampleUuid } from '../lib/bankfeed/sample.js';
import { pullCompany } from '../lib/bankfeed/pull.js';
import { linkCompany, saveMappings } from '../lib/data/bankfeeds.js';
import { addItem, listBankItems, countBankItems } from '../lib/data/banking.js';
import { writeVendorDoc } from '../lib/data/payables.js';
import { withTransaction } from '../lib/db.js';
import { hidden } from './bank-forms.js';

// Bank review v2, stage BR-6: batch Assign and Undo, "all N matching", and the lists' filters, order, page size,
// category column, inline Undo and CSV export.
let app, llDb, ll, feed, S, A, t, card;
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
  await saveMappings(pool(), { ...S, actor, choices: [{ id: llId('Operating Checking'), choice: String(A.checking) }, { id: llId('Business Card'), choice: String(A.card) }] });
  await pullCompany(pool(), ll, S);
  card = llId('Business Card');
  t = tieout(app);
});
after(async () => { await app.close(); await llDb.drop(); });

let seq = 0;
async function bankSays(rows) {
  const keys = [];
  for (const r of rows) {
    const key = `bf-${++seq}`;
    keys.push(key);
    await ll.query(`INSERT INTO core.transaction (org_id, transaction_id, account_id, amount, currency, posted_date, pending, description_raw, status, revision)
      VALUES ($1, $2, $3, $4, 'USD', $5, false, $6, 'active', 1)`, [feed.org, sampleUuid('bf', key), llId(r.account ?? 'Business Card'), r.amount, r.date ?? '2026-10-12', r.description]);
  }
  await pullCompany(pool(), ll, S);
  const ids = [];
  for (const k of keys) ids.push(Number((await pool().query('SELECT item_id FROM bank_feed_item WHERE ll_transaction_id = $1', [sampleUuid('bf', k)])).rows[0].item_id));
  return ids;
}
const state = async id => (await pool().query('SELECT review_state FROM bank_feed_item WHERE item_id = $1', [id])).rows[0].review_state;
const list = async (tab, extra = {}) => (await app.get(`/banking?${new URLSearchParams({ account: card, tab, ...extra })}`)).text();
const batch = (fields) => app.post('/banking/batch', new URLSearchParams([['account', card], ...fields]));

test('the Categorized list filters by text, dates, amount, category and how it was decided; sorts; pages; shows the category', async () => {
  const ids = await bankSays([{ amount: '-11.11', description: 'FILTER ALPHA', date: '2026-09-01' }, { amount: '-222.22', description: 'FILTER BETA', date: '2026-09-15' },
    { amount: '-33.33', description: 'FILTER GAMMA', date: '2026-10-01' }]);
  await addItem(pool(), { ...S, itemId: ids[0], lines: [{ accountId: A.office, amount: '' }], actor });
  await addItem(pool(), { ...S, itemId: ids[1], lines: [{ accountId: A.repairs, amount: '' }], actor });
  await addItem(pool(), { ...S, itemId: ids[2], lines: [{ accountId: A.office, amount: '' }], actor, source: 'batch' });
  const names = async f => (await listBankItems(pool(), { ...S, llAccountId: card, tab: 'categorized', filters: f })).map(i => i.description).filter(d => d.startsWith('FILTER'));
  assert.deepEqual(await names({ q: 'filter' }), ['FILTER GAMMA', 'FILTER BETA', 'FILTER ALPHA']);
  assert.deepEqual(await names({ q: 'filter', from: '2026-09-10', to: '2026-09-30' }), ['FILTER BETA']);
  assert.deepEqual(await names({ q: 'filter', min: 2000, max: 5000 }), ['FILTER GAMMA']);
  assert.deepEqual(await names({ q: 'filter', category: A.office }), ['FILTER GAMMA', 'FILTER ALPHA']);
  assert.deepEqual(await names({ q: 'filter', how: 'batch' }), ['FILTER GAMMA']);
  assert.equal(await countBankItems(pool(), { ...S, llAccountId: card, tab: 'categorized', filters: { q: 'filter', category: A.office } }), 2);
  assert.deepEqual((await listBankItems(pool(), { ...S, llAccountId: card, tab: 'categorized', filters: { q: 'filter' }, sort: 'big' })).map(i => i.description), ['FILTER BETA', 'FILTER GAMMA', 'FILTER ALPHA']);
  const page = await list('categorized', { q: 'FILTER', size: '100' });
  assert.match(page, /Filter · <strong>3 matching<\/strong>/);
  assert.match(page, /<td>Office Supplies<\/td>/, 'the category column');
  assert.match(page, /<option value="100" selected>100<\/option>/);
  assert.match(page, /href="\/banking\/export\.csv\?account=[^"]*q=FILTER/);
  // Every row can be undone in place, back to this list.
  assert.match(page, new RegExp(`action="/banking/item/${ids[0]}/undo"[\\s\\S]*?name="back" value="/banking\\?account=`));
});

test('CSV export: every matching item, with what it became; a cell that looks like a formula is made text', async () => {
  const [id] = await bankSays([{ amount: '-44.44', description: '=HYPERLINK("x") CSV SHOP' }]);
  await addItem(pool(), { ...S, itemId: id, lines: [{ accountId: A.office, amount: '' }], actor });
  const res = await app.get(`/banking/export.csv?${new URLSearchParams({ account: card, tab: 'categorized', q: 'CSV SHOP' })}`);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const csv = await res.text();
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'Date,Description,Bank text,Spent,Received,Status,Recorded as,Payee,Category,Rule,How,By');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^2026-10-12,"'=HYPERLINK\(""x""\) CSV SHOP",,44\.44,,Added,expense,,Office Supplies,,manual,tester$/);
});

test('Assign to ticked: one category and payee for each, exactly as each row was shown; a possible duplicate is left', async () => {
  await withTransaction(pool(), tx => writeVendorDoc(tx, { ...S, actor, type: 'expense', txnDate: '2026-10-12', accountId: A.card, memo: 'already here',
    categoryLines: [{ accountId: A.office, amount: '58.58' }], itemLines: [] }));
  const [a, b, dup] = await bankSays([{ amount: '-55.01', description: 'ASSIGN ONE' }, { amount: '-55.02', description: 'ASSIGN TWO' }, { amount: '-58.58', description: 'ASSIGN DUP' }]);
  const page = await list('review');
  const before = await t.snapshot();
  const res = await batch([['tab', 'review'], ['action', 'assign'], ['assign_category', 'Office Supplies'], ['assign_payee', ''], ['cats_v', hidden(page, 'cats_v')], ['payees_v', hidden(page, 'payees_v')],
    ...[a, b, dup].flatMap(id => [['item', String(id)], [`rev_${id}`, hidden(page, `rev_${id}`)]])]);
  assert.equal(res.status, 200);
  const out = await res.text();
  assert.match(out, /Assign: 2 of 3 done/);
  assert.match(out, /may already be in the books — review it/);
  t.expectChange(before, await t.snapshot(), { accounts: { [A.card]: -11003, [A.office]: 11003 }, net: -11003, label: 'assign' });
  assert.deepEqual([await state(a), await state(b), await state(dup)], ['added', 'added', 'new']);
  const { rows } = await pool().query(`SELECT source, basis FROM bank_review_event WHERE item_id = ANY($1) AND kind = 'added'`, [[a, b]]);
  assert.deepEqual(rows.map(r => [r.source, r.basis]), [['batch', 'person'], ['batch', 'person']]);
});

test('Undo ticked on Categorized: each as its row showed it; one changed since is left', async () => {
  const [a, b] = await bankSays([{ amount: '-66.01', description: 'UNDO ONE' }, { amount: '-66.02', description: 'UNDO TWO' }]);
  await addItem(pool(), { ...S, itemId: a, lines: [{ accountId: A.office, amount: '' }], actor });
  await addItem(pool(), { ...S, itemId: b, lines: [{ accountId: A.office, amount: '' }], actor });
  const page = await list('categorized', { q: 'UNDO' });
  // b's transaction is edited in the books after the page was shown: its Undo plan is different now.
  const tb = Number((await pool().query('SELECT txn_id FROM bank_feed_link WHERE item_id = $1', [b])).rows[0].txn_id);
  await withTransaction(pool(), tx => writeVendorDoc(tx, { ...S, actor, type: 'expense', txnId: tb, txnDate: '2026-10-12', accountId: A.card, memo: 'edited',
    categoryLines: [{ accountId: A.office, amount: '66.02' }], itemLines: [] }));
  const res = await batch([['tab', 'categorized'], ['action', 'undo'], ...[a, b].flatMap(id => [['item', String(id)], [`plan_${id}`, hidden(page, `plan_${id}`)]])]);
  const out = await res.text();
  assert.match(out, /Undo: 1 of 2 done/);
  assert.deepEqual([await state(a), await state(b)], ['new', 'added']);
});

test('all N matching: a recorded list to confirm, carried out item by item as shown', async () => {
  const ids = await bankSays([{ amount: '-7.01', description: 'ALLMATCH ONE' }, { amount: '-7.02', description: 'ALLMATCH TWO' }, { amount: '-7.03', description: 'ALLMATCH THREE' }]);
  const page = await list('review', { q: 'ALLMATCH' });
  assert.match(page, /name="all" value="exclude:3"/);
  // A fourth arrives before the person clicks: refused, nothing excluded.
  const [late] = await bankSays([{ amount: '-7.04', description: 'ALLMATCH FOUR' }]);
  let res = await batch([['tab', 'review'], ['list', 'q=ALLMATCH'], ['all', 'exclude:3']]);
  assert.equal(res.status, 303);
  // Four now: step one lists exactly those four and changes nothing.
  res = await batch([['tab', 'review'], ['list', 'q=ALLMATCH'], ['all', 'exclude:4']]);
  assert.equal(res.status, 200);
  const confirm = await res.text();
  assert.match(confirm, /Exclude these 4 items\?/);
  assert.deepEqual(await Promise.all([...ids, late].map(state)), ['new', 'new', 'new', 'new']);
  const selection = /name="selection" value="([0-9a-f-]{36})"/.exec(confirm)[1];
  // Before confirming, one of them changes at the bank and another matching line arrives: only the unchanged three listed are done.
  await pool().query('UPDATE bank_feed_item SET amount_cents = -70400, revision = revision + 1 WHERE item_id = $1', [late]);
  const [extra] = await bankSays([{ amount: '-7.05', description: 'ALLMATCH FIVE' }]);
  res = await app.post('/banking/batch/confirm', new URLSearchParams({ selection }));
  const done = await res.text();
  assert.match(done, /Exclude: 3 of 4 done/);
  assert.match(done, /changed since the page was shown/);
  assert.deepEqual(await Promise.all([...ids, late, extra].map(state)), ['excluded', 'excluded', 'excluded', 'new', 'new']);
  // Used once.
  assert.equal((await app.post('/banking/batch/confirm', new URLSearchParams({ selection }))).status, 303);
  // Restore the three from Excluded the same way; an Undo plan that changed since is left.
  res = await batch([['tab', 'excluded'], ['list', 'q=ALLMATCH'], ['all', 'undo:3']]);
  const sel2 = /name="selection" value="([0-9a-f-]{36})"/.exec(await res.text())[1];
  res = await app.post('/banking/batch/confirm', new URLSearchParams({ selection: sel2 }));
  assert.match(await res.text(), /Undo: 3 of 3 done/);
  assert.deepEqual(await Promise.all(ids.map(state)), ['new', 'new', 'new']);
  // Accept never works on "all matching".
  res = await batch([['tab', 'review'], ['list', 'q=ALLMATCH'], ['all', 'accept:4']]);
  assert.equal(res.status, 303);
});

test('Undo all matching: a books transaction edited after the list was shown is left', async () => {
  const [a] = await bankSays([{ amount: '-31.83', description: 'UNDOALL EDIT' }]);
  await addItem(pool(), { ...S, itemId: a, lines: [{ accountId: A.office, amount: '' }], actor });
  const res = await batch([['tab', 'categorized'], ['list', 'q=UNDOALL'], ['all', 'undo:1']]);
  const selection = /name="selection" value="([0-9a-f-]{36})"/.exec(await res.text())[1];
  const t1 = Number((await pool().query('SELECT txn_id FROM bank_feed_link WHERE item_id = $1', [a])).rows[0].txn_id);
  await withTransaction(pool(), tx => writeVendorDoc(tx, { ...S, actor, type: 'expense', txnId: t1, txnDate: '2026-10-12', accountId: A.card, memo: 'edited',
    categoryLines: [{ accountId: A.repairs, amount: '31.83' }], itemLines: [] }));
  const out = await (await app.post('/banking/batch/confirm', new URLSearchParams({ selection }))).text();
  assert.match(out, /Undo: 0 of 1 done/);
  assert.equal(await state(a), 'added');
  assert.equal((await pool().query('SELECT 1 FROM txn WHERE txn_id = $1', [t1])).rowCount, 1);
});

test('CSV export makes text of a formula behind a tab or spaces', async () => {
  await ll.query(`INSERT INTO core.transaction (org_id, transaction_id, account_id, amount, currency, posted_date, pending, description_raw, original_description, status, revision)
    VALUES ($1, $2, $3, -10.73, 'USD', '2026-10-12', false, 'CSV TAB SHOP', $4, 'active', 1)`, [feed.org, sampleUuid('bf', 'csv-tab'), card, '\t=1+2']);
  await pullCompany(pool(), ll, S);
  const csv = await (await app.get(`/banking/export.csv?${new URLSearchParams({ account: card, tab: 'review', q: 'CSV TAB SHOP' })}`)).text();
  assert.match(csv, /CSV TAB SHOP,"'\t=1\+2",10\.73/);
});
