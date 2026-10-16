import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './app-harness.js';
import { freshDb } from './harness.js';
import { tieout } from './tieout.js';
import { buildSampleFeed, writeLedgerlineSample, sampleUuid } from '../lib/bankfeed/sample.js';
import { pullCompany } from '../lib/bankfeed/pull.js';
import { linkCompany, saveMappings } from '../lib/data/bankfeeds.js';
import { backdatedBill } from '../lib/data/banking.js';
import { writeVendorDoc } from '../lib/data/payables.js';
import { withTransaction } from '../lib/db.js';
import { itemForm, picks } from './bank-forms.js';

// Bank review v2, stage BR-7: files and notes on a bank line, and a backdated bill paid by it.
let app, llDb, ll, feed, S, A, t;
const actor = 'tester';
const llId = name => feed.accounts.find(a => a.name === name).id;
const pool = () => app.db.pool;
const PDF = Buffer.from('%PDF-1.4\n% receipt\n');

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
  t = tieout(app);
});
after(async () => { await app.close(); await llDb.drop(); });

let seq = 0;
async function bankSays(rows) {
  const keys = [];
  for (const r of rows) {
    const key = `fn-${++seq}`;
    keys.push(key);
    await ll.query(`INSERT INTO core.transaction (org_id, transaction_id, account_id, amount, currency, posted_date, pending, description_raw, status, revision)
      VALUES ($1, $2, $3, $4, 'USD', $5, false, $6, 'active', 1)`, [feed.org, sampleUuid('fn', key), llId(r.account ?? 'Business Card'), r.amount, r.date ?? '2026-10-12', r.description]);
  }
  await pullCompany(pool(), ll, S);
  const ids = [];
  for (const k of keys) ids.push(Number((await pool().query('SELECT item_id FROM bank_feed_item WHERE ll_transaction_id = $1', [sampleUuid('fn', k)])).rows[0].item_id));
  return ids;
}
const attach = (id, data = PDF, name = 'receipt.pdf') => {
  const fd = new FormData();
  fd.set('csrf', app.csrf);
  fd.set('file', new Blob([data]), name);
  return app.raw(`/banking/item/${id}/attach`, { method: 'POST', body: fd });
};
const vendorName = async id => (await pool().query('SELECT display_name FROM vendor WHERE vendor_id = $1', [id])).rows[0].display_name;
const docs = async id => (await pool().query(`SELECT d.document_id, d.txn_id, d.vendor_id FROM document d JOIN bank_item_attachment a ON a.document_id = d.document_id
  JOIN bank_feed_item i ON i.entity_id = a.entity_id AND i.ll_transaction_id = a.ll_transaction_id WHERE i.item_id = $1`, [id])).rows;

test('a file added on a bank item goes onto the transaction it becomes; Undo leaves it on the bank item; adding again moves it', async () => {
  const [id] = await bankSays([{ amount: '-31.40', description: 'RECEIPT SHOP' }]);
  assert.equal((await attach(id)).status, 303);
  let page = (await itemForm(app, id)).page;
  assert.match(page, /receipt\.pdf<\/a> · 1 KB · operator/);
  const file = /href="(\/banking\/item\/\d+\/attachment\/\d+)"/.exec(page)[1];
  const dl = await app.get(file);
  assert.equal(dl.headers.get('content-type'), 'application/pdf');
  assert.ok(Buffer.from(await dl.arrayBuffer()).equals(PDF));
  assert.deepEqual(await docs(id), [], 'not filed while waiting');
  // Added with a vendor: filed on the expense.
  const vendorId = Object.values(app.ids.vendors)[0];
  let f = await itemForm(app, id);
  await app.post(`/banking/item/${id}/add`, new URLSearchParams([...await picks(app, id), ['rev', f.rev], ['evidence', f.evidence ?? ''], ['payee', await vendorName(vendorId)], ['line_account', 'Office Supplies'], ['line_amount', '']]));
  const txnId = Number((await pool().query('SELECT txn_id FROM bank_feed_link WHERE item_id = $1', [id])).rows[0].txn_id);
  let d = await docs(id);
  assert.deepEqual(d.map(x => [Number(x.txn_id), Number(x.vendor_id)]), [[txnId, vendorId]]);
  assert.match((await itemForm(app, id)).page, /On the transaction/);
  // Undo: the expense is deleted, the file stays on the bank item.
  f = await itemForm(app, id);
  await app.post(`/banking/item/${id}/undo`, new URLSearchParams({ plan: f.plan }));
  d = await docs(id);
  assert.equal(d.length, 1);
  assert.equal(d[0].txn_id, null);
  // Added again: the same document is moved onto the new expense, not copied.
  f = await itemForm(app, id);
  await app.post(`/banking/item/${id}/add`, new URLSearchParams([...await picks(app, id), ['rev', f.rev], ['evidence', f.evidence ?? ''], ['payee', await vendorName(vendorId)], ['line_account', 'Office Supplies'], ['line_amount', '']]));
  const again = await docs(id);
  assert.equal(again.length, 1);
  assert.equal(again[0].document_id, d[0].document_id);
  assert.equal(Number(again[0].txn_id), Number((await pool().query('SELECT txn_id FROM bank_feed_link WHERE item_id = $1', [id])).rows[0].txn_id));
  // Removing it from the bank item keeps the filed copy.
  page = (await itemForm(app, id)).page;
  const del = /action="(\/banking\/item\/\d+\/attachment\/\d+\/delete)"/.exec(page)[1];
  assert.equal((await app.post(del, new URLSearchParams())).status, 303);
  assert.equal((await pool().query('SELECT 1 FROM document WHERE document_id = $1', [d[0].document_id])).rowCount, 1);
});

test('notes: on the item page and the list', async () => {
  const [id] = await bankSays([{ amount: '-12.00', description: 'NOTE SHOP' }]);
  assert.equal((await app.post(`/banking/item/${id}/note`, new URLSearchParams({ note: 'Ask Sarah what this was' }))).status, 303);
  assert.match((await itemForm(app, id)).page, /Ask Sarah what this was <small class="muted">— operator,/);
  assert.match(await (await app.get(`/banking?account=${llId('Business Card')}&tab=review`)).text(), /Note: Ask Sarah what this was/);
  assert.equal((await app.post(`/banking/item/${id}/note`, new URLSearchParams({ note: '   ' }))).status, 422);
});

test('a backdated bill: the bill on its own date and its payment by the bank line; Undo removes both', async () => {
  const vendorId = Object.values(app.ids.vendors)[1];
  const [id] = await bankSays([{ account: 'Operating Checking', amount: '-480.00', description: 'ACH FEED STORE' }]);
  const before = await t.snapshot();
  const f = await itemForm(app, id);
  assert.match(f.page, /Create a bill/);
  const res = await app.post(`/banking/item/${id}/bill`, new URLSearchParams([...await picks(app, id), ['rev', f.rev], ['evidence', f.evidence ?? ''], ['bill_vendor', await vendorName(vendorId)],
    ['bill_date', '2026-09-20'], ['bill_number', 'INV-77'], ['bill_account', 'Office Supplies'], ['bill_amount', '400.00'], ['bill_account', 'Repairs & Maintenance'], ['bill_amount', '80.00']]));
  assert.equal(res.status, 303);
  const after1 = await t.snapshot();
  t.checkTied(after1, 'backdated bill');
  t.expectChange(before, after1, { accounts: { [A.checking]: -48000, [A.office]: 40000, [A.repairs]: 8000 }, net: -48000, label: 'bill + payment' });
  const { rows: l } = await pool().query(`SELECT k.how, t.type, t.txn_date::text AS d, t.doc_number, t.open_cents FROM bank_feed_link k JOIN txn t ON t.txn_id = k.txn_id
    WHERE k.item_id = $1 ORDER BY t.txn_id`, [id]);
  assert.deepEqual(l.map(x => [x.how, x.type, x.d]), [['added', 'bill', '2026-09-20'], ['added', 'bill_payment', '2026-10-12']]);
  assert.deepEqual([l[0].doc_number, Number(l[0].open_cents)], ['INV-77', 0]);
  const g = await itemForm(app, id);
  await app.post(`/banking/item/${id}/undo`, new URLSearchParams({ plan: g.plan }));
  t.expectChange(before, await t.snapshot(), { label: 'undo the bill and its payment' });
});

test('a backdated bill is refused for money in, a bill date after the bank date, lines that don’t add up, or a bill needing approval', async () => {
  const vendorId = Object.values(app.ids.vendors)[1];
  const [inn, out] = await bankSays([{ account: 'Operating Checking', amount: '50.00', description: 'IN' }, { account: 'Operating Checking', amount: '-50.00', description: 'OUT' }]);
  const go = (itemId, extra) => backdatedBill(pool(), { ...S, itemId, vendorId, billDate: '2026-10-01', lines: [{ accountId: A.office, amount: '' }], actor, canApprove: true, ...extra });
  await assert.rejects(go(inn), /money out of a bank or card account/);
  await assert.rejects(go(out, { billDate: '2026-10-13' }), /can’t be after the bank date/);
  await assert.rejects(go(out, { lines: [{ accountId: A.office, amount: '40.00' }, { accountId: A.repairs, amount: '5.00' }] }), /add up to \$45\.00/);
  await assert.rejects(go(out, { canApprove: false }), /approves bills before they’re paid/);
  assert.equal((await pool().query(`SELECT review_state FROM bank_feed_item WHERE item_id = $1`, [out])).rows[0].review_state, 'new');
});

test('a file filed on a matched transaction moves when the line is undone and matched to another', async () => {
  const [v1, v2] = Object.values(app.ids.vendors);
  const mk = vendorId => withTransaction(pool(), tx => writeVendorDoc(tx, { ...S, actor, type: 'expense', vendorId, txnDate: '2026-10-11', accountId: A.card, memo: 'm',
    categoryLines: [{ accountId: A.office, amount: '17.43' }], itemLines: [] }));
  const ea = await mk(v1), eb = await mk(v2);
  const [id] = await bankSays([{ amount: '-17.43', description: 'MOVE FILE' }]);
  await attach(id);
  const match = async txn => { const f = await itemForm(app, id); return app.post(`/banking/item/${id}/match`, new URLSearchParams({ rev: f.rev, txn: String(txn), [`ver_${txn}`]: f.ver(txn) })); };
  await match(ea);
  assert.deepEqual((await docs(id)).map(d => [Number(d.txn_id), Number(d.vendor_id)]), [[ea, v1]]);
  const f = await itemForm(app, id);
  await app.post(`/banking/item/${id}/undo`, new URLSearchParams({ plan: f.plan }));
  assert.equal((await docs(id))[0].txn_id, null);
  await match(eb);
  assert.deepEqual((await docs(id)).map(d => [Number(d.txn_id), Number(d.vendor_id)]), [[eb, v2]]);
});
