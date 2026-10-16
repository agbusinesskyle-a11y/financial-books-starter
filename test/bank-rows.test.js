import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './app-harness.js';
import { freshDb } from './harness.js';
import { tieout } from './tieout.js';
import { buildSampleFeed, writeLedgerlineSample, sampleUuid } from '../lib/bankfeed/sample.js';
import { pullCompany } from '../lib/bankfeed/pull.js';
import { linkCompany, saveMappings } from '../lib/data/bankfeeds.js';
import { getBankItem, addItem } from '../lib/data/banking.js';
import { saveRule, deleteRule } from '../lib/bankfeed/rules.js';
import { resolveCategory, resolvePayee, payeeChoices, categoryChoices, payeeValues } from '../lib/bankfeed/pickers.js';
import { saveAccount } from '../lib/data/ledger.js';
import { saveVendor } from '../lib/data/vendors.js';
import { saveCustomer } from '../lib/data/writes.js';
import { writeVendorDoc } from '../lib/data/payables.js';
import { withTransaction } from '../lib/db.js';
import { hidden, itemForm, picks } from './bank-forms.js';

// Bank review v2, stage BR-2: For review rows reviewed in place — payee and category typed into the row from
// searchable lists, Post or Match — with and without JavaScript, and the item page's pickers.
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
    const key = `rows-${++seq}`;
    keys.push(key);
    await ll.query(`INSERT INTO core.transaction (org_id, transaction_id, account_id, amount, currency, posted_date, pending, description_raw, status, revision)
      VALUES ($1, $2, $3, $4, 'USD', $5, $7, $6, 'active', 1)`, [feed.org, sampleUuid('rows', key), llId(r.account), r.amount, r.date ?? '2026-10-12', r.description, Boolean(r.pending)]);
  }
  await pullCompany(pool(), ll, S);
  const ids = [];
  for (const k of keys) ids.push(Number((await pool().query('SELECT item_id FROM bank_feed_item WHERE ll_transaction_id = $1', [sampleUuid('rows', k)])).rows[0].item_id));
  return ids;
}
const item = id => getBankItem(pool(), { ...S, itemId: id });
const listPage = async (account = 'Business Card', extra = '') => (await app.get(`/banking?account=${llId(account)}&tab=review${extra}`)).text();
// The row's own form fields, as a browser would send them (the hidden ones in its form plus what's typed in the row).
async function rowPost(id, typed, { json = true, account = 'Business Card' } = {}) {
  const page = await listPage(account);
  const form = new RegExp(`<form id="row-${id}"[^>]*>([\\s\\S]*?)</form>`).exec(page)?.[1];
  assert.ok(form, `row ${id} has its own form`);
  const body = new URLSearchParams();
  for (const m of form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) body.set(m[1], m[2].replace(/&amp;/g, '&'));
  // ...and the row's own fields (form="row-<id>"), as they were filled in.
  for (const m of page.matchAll(new RegExp(`<input name="(payee|category|memo)" form="row-${id}"[^>]*? value="([^"]*)"`, 'g'))) body.set(m[1], m[2].replace(/&amp;/g, '&'));
  for (const [k, v] of Object.entries(typed)) body.set(k, v);
  return app.raw(`/banking/item/${id}/row`, { method: 'POST', body: body.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(json ? { accept: 'application/json' } : {}) } });
}
const officeName = async () => (await pool().query('SELECT name FROM account WHERE account_id = $1', [A.office])).rows[0].name;

test('the list: every reviewable row has its own form outside the table, fields pointing at it, and the shared lists', async () => {
  const [id] = await bankSays([{ account: 'Business Card', amount: '-12.34', description: 'ROW LAYOUT SHOP' }]);
  const page = await listPage();
  assert.match(page, new RegExp(`<tr id="item-${id}" data-row="${id}"`));
  assert.equal((page.match(new RegExp(`id="row-${id}"`, 'g')) ?? []).length, 1, 'one element per id: the form');
  assert.match(page, new RegExp(`<input name="category" form="row-${id}" list="bank-cats-out"`));
  assert.match(page, new RegExp(`<input name="payee" form="row-${id}" list="bank-payees"`));
  assert.match(page, new RegExp(`<input type="checkbox" name="item" value="${id}" form="bank-batch"`));
  // No form inside the table; the row forms come after it; the batch form is closed before it.
  const table = page.slice(page.indexOf('<table class="grid bank-items in-row">'), page.indexOf('</table>'));
  assert.doesNotMatch(table, /<form/);
  assert.ok(page.indexOf(`<form id="row-${id}"`) > page.indexOf('</table>'));
  assert.match(page, /<datalist id="bank-payees">/);
  assert.match(page, /<datalist id="bank-cats-out">/);
  // Money out lists expense accounts first.
  const out = page.slice(page.indexOf('<datalist id="bank-cats-out">'), page.indexOf('</datalist>', page.indexOf('<datalist id="bank-cats-out">')));
  assert.match(out.slice(0, 400), /label="Expense/);
});

test('a pending row lines up with the columns: its amount under Spent, nothing to choose until it posts', async () => {
  const [id] = await bankSays([{ account: 'Business Card', amount: '-34.52', description: 'PENDING INSURANCE PYMENT', pending: true }]);
  const page = await listPage();
  const head = page.slice(page.indexOf('<table class="grid bank-items in-row">'), page.indexOf('</thead>'));
  const row = new RegExp(`<tr id="item-${id}"[^>]*>([\\s\\S]*?)</tr>`).exec(page)[1];
  const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1]);
  assert.equal(cells.length, (head.match(/<th[ >]/g) ?? []).length, 'one cell per column');
  assert.equal(cells[5].trim(), '$34.52', 'under Spent');
  assert.equal(cells[6].trim(), '', 'nothing under Received');
  assert.match(cells[4], /Can be reviewed once the bank posts it/);
  assert.doesNotMatch(page, new RegExp(`form="row-${id}"|id="row-${id}"|value="${id}" form="bank-batch"`));
});

test('Post from the row (JavaScript): payee and category by name, exact postings, the next row comes back', async () => {
  const [a, b] = await bankSays([{ account: 'Business Card', amount: '-27.18', description: 'ROW POST ONE' }, { account: 'Business Card', amount: '-31.09', description: 'ROW POST TWO' }]);
  const vendor = (await pool().query('SELECT display_name FROM vendor WHERE entity_id = $1 AND active ORDER BY vendor_id LIMIT 1', [S.entityId])).rows[0].display_name;
  const before = await t.snapshot();
  const res = await rowPost(a, { payee: vendor, category: await officeName() });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.ok, true);
  assert.match(out.message, /Posted: ROW POST ONE/);
  const after1 = await t.snapshot();
  t.checkTied(after1, 'row post');
  t.expectChange(before, after1, { accounts: { [A.card]: -2718, [A.office]: 2718 }, net: -2718, label: 'row post' });
  const { rows: [x] } = await pool().query(`SELECT txn_party(k.txn_id) AS party, e.source FROM bank_feed_link k JOIN bank_review_event e ON e.item_id = k.item_id WHERE k.item_id = $1`, [a]);
  assert.deepEqual([x.party, x.source], [vendor, 'row']);
  assert.ok(out.next === b || out.next, 'the next row is named');
});

test('Post from the row without JavaScript lands back on the list at the next row', async () => {
  const [a, b] = await bankSays([{ account: 'Business Card', amount: '-44.01', description: 'NOJS ONE' }, { account: 'Business Card', amount: '-44.02', description: 'NOJS TWO' }]);
  const res = await rowPost(a, { category: await officeName() }, { json: false });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /tab=review&page=\d+&focus=\d+#item-\d+/);
  assert.equal((await item(a)).review_state, 'added');
  assert.equal((await item(b)).review_state, 'new');
});

test('an unknown payee: the row offers to create it, then posts', async () => {
  const [id] = await bankSays([{ account: 'Business Card', amount: '-19.99', description: 'BRAND NEW SHOP' }]);
  let res = await rowPost(id, { payee: 'Brand New Shop LLC', category: await officeName() });
  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { ok: false, error: '“Brand New Shop LLC” isn’t a vendor or customer yet.', create: 'Brand New Shop LLC' });
  // Without JavaScript, the list comes back with what was typed and the two buttons.
  const page = await (await rowPost(id, { payee: 'Brand New Shop LLC', category: await officeName() }, { json: false })).text();
  assert.match(page, /value="Brand New Shop LLC"/);
  assert.match(page, /Create vendor “Brand New Shop LLC”/);
  res = await rowPost(id, { payee: 'Brand New Shop LLC', category: await officeName(), create: 'vendor' });
  assert.equal(res.status, 200);
  const { rows: [v] } = await pool().query(`SELECT vendor_id FROM vendor WHERE entity_id = $1 AND display_name = 'Brand New Shop LLC'`, [S.entityId]);
  assert.ok(v);
  assert.equal((await pool().query('SELECT txn_party_key(txn_id) AS k FROM bank_feed_link WHERE item_id = $1', [id])).rows[0].k, `v:${v.vendor_id}`);
});

test('a row can’t post over a possible duplicate, a stale page, or an unknown category', async () => {
  const e = await withTransaction(pool(), tx => writeVendorDoc(tx, { ...S, actor, type: 'expense', txnDate: '2026-10-12', accountId: A.card, memo: 'by hand',
    categoryLines: [{ accountId: A.office, amount: '55.55' }], itemLines: [] }));
  const [dup] = await bankSays([{ account: 'Business Card', amount: '-55.55', description: 'DUP ROW' }, { account: 'Business Card', amount: '-55.55', description: 'DUP ROW 2' }]);
  // (Two lines, one expense: the first line shows the match; post the second as an Add.)
  const [, second] = (await pool().query(`SELECT item_id FROM bank_feed_item WHERE description LIKE 'DUP ROW%' ORDER BY item_id`)).rows.map(r => Number(r.item_id));
  let res = await rowPost(second, { mode: 'add', category: await officeName() });
  const j = await res.json();
  assert.equal(res.status, 422);
  assert.equal(j.duplicate, true);
  assert.ok(e && dup);
  const [st] = await bankSays([{ account: 'Business Card', amount: '-66.66', description: 'STALE ROW' }]);
  const page = await listPage();
  const rev = hidden(new RegExp(`<form id="row-${st}"[^>]*>([\\s\\S]*?)</form>`).exec(page)[1], 'rev');
  await pool().query('UPDATE bank_feed_item SET amount_cents = -6767, revision = revision + 1 WHERE item_id = $1', [st]);
  res = await app.raw(`/banking/item/${st}/row`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: app.csrf, rev, mode: 'add', category: await officeName() }).toString() });
  assert.equal(res.status, 422);
  assert.equal((await item(st)).review_state, 'new');
  res = await rowPost(st, { category: 'No Such Account' });
  assert.match((await res.json()).error, /No account called “No Such Account”/);
});

test('Match from the row', async () => {
  const e = await withTransaction(pool(), tx => writeVendorDoc(tx, { ...S, actor, type: 'expense', txnDate: '2026-10-12', accountId: A.card, memo: 'match me',
    categoryLines: [{ accountId: A.office, amount: '71.23' }], itemLines: [] }));
  const [id] = await bankSays([{ account: 'Business Card', amount: '-71.23', description: 'ROW MATCH' }]);
  const page = await listPage();
  assert.match(new RegExp(`<form id="row-${id}"[^>]*>([\\s\\S]*?)</form>`).exec(page)[1], /name="mode" value="match"/);
  const before = await t.snapshot();
  const res = await rowPost(id, {});
  assert.equal(res.status, 200);
  t.expectChange(before, await t.snapshot(), { label: 'row match moves nothing' });
  assert.equal(Number((await pool().query('SELECT txn_id FROM bank_feed_link WHERE item_id = $1', [id])).rows[0].txn_id), e);
});

test('a memo typed on the row is the transaction memo; a rule fills its memo in', async () => {
  const [id] = await bankSays([{ account: 'Business Card', amount: '-14.14', description: 'ROW MEMO SHOP' }]);
  const res = await rowPost(id, { category: await officeName(), memo: 'Printer toner for the office' });
  assert.equal(res.status, 200);
  const { rows: [x] } = await pool().query('SELECT t.memo FROM bank_feed_link k JOIN txn t ON t.txn_id = k.txn_id WHERE k.item_id = $1', [id]);
  assert.equal(x.memo, 'Printer toner for the office');
  await saveRule(pool(), { ...S, actor, fields: { name: 'Memo rule', money: 'out', mode: 'suggest', conditions: [{ field: 'description', op: 'contains', value: 'ROW MEMO RULE' }], accountId: A.office, memo: 'From the rule' } });
  const [r] = await bankSays([{ account: 'Business Card', amount: '-15.15', description: 'ROW MEMO RULE' }]);
  assert.match(await listPage(), new RegExp(`<input name="memo" form="row-${r}" class="row-memo" value="From the rule"`));
});

test('a rule’s suggestion posted from the row records the rule', async () => {
  const r = await saveRule(pool(), { ...S, actor, fields: { name: 'Row rule', money: 'out', mode: 'suggest', conditions: [{ field: 'description', op: 'contains', value: 'ROW RULE SHOP' }], accountId: A.office } });
  const [id] = await bankSays([{ account: 'Business Card', amount: '-13.13', description: 'ROW RULE SHOP' }]);
  const page = await listPage();
  assert.match(page, new RegExp(`<input name="category" form="row-${id}" list="bank-cats-out" value="${await officeName()}"`));
  const res = await rowPost(id, {});
  assert.equal(res.status, 200);
  const { rows: [ev] } = await pool().query(`SELECT basis, rule_id FROM bank_review_event WHERE item_id = $1 AND kind = 'added'`, [id]);
  assert.deepEqual([ev.basis, Number(ev.rule_id)], ['rule', r]);
});

test('the item page uses the same searchable pickers', async () => {
  const [id] = await bankSays([{ account: 'Business Card', amount: '-20.20', description: 'ITEM PAGE PICKERS' }]);
  const page = await (await app.get(`/banking/item/${id}`)).text();
  assert.match(page, /<input name="payee" list="item-payees"/);
  assert.match(page, /<input name="line_account" list="item-cats"/);
  const rev = hidden(page, 'rev');
  const res = await app.post(`/banking/item/${id}/add`, new URLSearchParams([...await picks(app, id), ['rev', rev], ['payee', ''], ['line_account', await officeName()], ['line_amount', ''], ['line_description', '']]));
  assert.equal(res.status, 303);
  assert.equal((await item(id)).review_state, 'added');
});

test('names resolve to exactly one record: no internal ids, no colliding values', async () => {
  const cats = await categoryChoices(pool(), S);
  assert.deepEqual(resolveCategory(cats, await officeName()), { id: A.office });
  assert.deepEqual(resolveCategory(cats, `6700 ${await officeName()}`), { id: A.office });
  assert.ok(resolveCategory(cats, String(A.office)).error, 'an internal id is not a name');
  assert.equal(resolveCategory(cats, ''), null);
  assert.ok(resolveCategory(cats, 'nope').error);
  // Two vendors and a customer whose names collide with each other's suffixed values: every value names one record.
  const ps = [{ key: 'v:1', name: 'Acme', kind: 'Vendor' }, { key: 'c:2', name: 'Acme', kind: 'Customer' }, { key: 'v:3', name: 'Acme (customer)', kind: 'Vendor' },
    { key: 'c:4', name: 'v:1', kind: 'Customer' }];
  const values = payeeValues(ps);
  assert.equal(new Set(values.map(p => p.value.toLowerCase())).size, values.length);
  assert.deepEqual(values.map(p => p.value), ['Acme (vendor)', 'Acme (customer #2)', 'Acme (customer) (vendor)', 'v:1']);
  // Every value means its own record; a shared name, or a label another record now has as its name, is refused.
  for (const v of values) assert.deepEqual(resolvePayee(values, v.value), { key: v.key });
  assert.ok(resolvePayee(values, 'Acme').error, 'a vendor and a customer share the name: the list says which');
  assert.ok(resolvePayee(values, 'acme (customer)').error, 'the customer’s label and the vendor’s name');
  assert.deepEqual(resolvePayee(values, 'v:1'), { key: 'c:4' }, 'a raw key is just a name');
  assert.deepEqual(resolvePayee(values, 'Zed'), { unknown: 'Zed' });
  // S05: a label shown before another record took the name now fits two records — refused, not given to the newcomer.
  const before = payeeValues([{ key: 'v:10', name: 'S05 row', kind: 'Vendor' }]);
  assert.deepEqual(before.map(p => p.value), ['S05 row']);
  const after = payeeValues([{ key: 'v:10', name: 'S05 row', kind: 'Vendor' }, { key: 'c:9', name: 'S05 row', kind: 'Customer' }]);
  assert.ok(resolvePayee(after, 'S05 row').error);
  // S06: "S06 row (customer)" was the customer's label; a vendor now has it as its name — refused.
  const s06 = payeeValues([{ key: 'v:12', name: 'S06 row', kind: 'Vendor' }, { key: 'c:11', name: 'S06 row', kind: 'Customer' }, { key: 'v:13', name: 'S06 row (customer)', kind: 'Vendor' }]);
  assert.ok(resolvePayee(s06, 'S06 row (customer)').error);
  // S07: every fallback is checked too; each record still gets a value that means only it.
  const s07 = payeeValues([{ key: 'v:16', name: 'S07 Acme', kind: 'Vendor' }, { key: 'c:13', name: 'S07 Acme', kind: 'Customer' }, { key: 'v:17', name: 'S07 Acme (vendor)', kind: 'Vendor' },
    { key: 'v:18', name: 'S07 Acme (vendor #16)', kind: 'Vendor' }, { key: 'v:19', name: 'S07 Acme (vendor #16) (2)', kind: 'Vendor' }]);
  for (const v of s07) assert.deepEqual(resolvePayee(s07, v.value), { key: v.key }, v.value);
  const real = await payeeChoices(pool(), S);
  assert.ok(real.length > 0 && real.every(p => p.value));
});

test('an account named like another account’s internal id posts to the account with that name (R10)', async () => {
  const id = await saveAccount(pool(), { ...S, actor, fields: { name: String(A.office), number: '8104', type: 'expense' } });
  const [row] = await bankSays([{ account: 'Business Card', amount: '-810.03', description: 'NUMERIC NAME' }]);
  const page = await listPage();
  assert.match(page, new RegExp(`<option value="${A.office}" label="Expense`), 'offered by its name');
  const res = await rowPost(row, { category: String(A.office) });
  assert.equal(res.status, 200);
  const { rows } = await pool().query(`SELECT p.account_id, p.amount_cents FROM bank_feed_link k JOIN posting p ON p.txn_id = k.txn_id WHERE k.item_id = $1 AND p.account_id <> $2`, [row, A.card]);
  assert.deepEqual(rows.map(r => [Number(r.account_id), Number(r.amount_cents)]), [[id, 81003]]);
});

test('a customer’s value never posts as a vendor with a colliding name (R09)', async () => {
  const v22 = await saveVendor(pool(), { ...S, actor, fields: { displayName: 'R09 Collision' } });
  const c12 = await saveCustomer(pool(), { ...S, actor, fields: { displayName: 'R09 Collision', active: true, isNew: true } });
  const v23 = await saveVendor(pool(), { ...S, actor, fields: { displayName: 'R09 Collision (customer)' } });
  const values = await payeeChoices(pool(), S);
  const c = values.find(p => p.key === `c:${c12}`);
  assert.equal(values.filter(p => p.value.toLowerCase() === c.value.toLowerCase()).length, 1);
  const [row] = await bankSays([{ account: 'Business Card', amount: '-809.09', description: 'R09 REFUND' }]);
  const res = await rowPost(row, { payee: c.value, category: await officeName() });
  assert.equal(res.status, 200);
  const { rows: [t] } = await pool().query('SELECT t.type, txn_party_key(t.txn_id) AS party FROM bank_feed_link k JOIN txn t ON t.txn_id = k.txn_id WHERE k.item_id = $1', [row]);
  assert.deepEqual([t.type, t.party], ['journal_entry', `c:${c12}`]);
  assert.ok(v22 && v23);
});

test('a row filled in by a rule: a changed rule is refused, and a 422 retry keeps the rule and its class and location (R13)', async () => {
  const cls = (await pool().query(`INSERT INTO class (org_id, entity_id, name) VALUES ($1, $2, 'R13 class A'), ($1, $2, 'R13 class B') RETURNING class_id`, [S.orgId, S.entityId])).rows.map(r => Number(r.class_id));
  const fields = c => ({ name: 'R13 rule', money: 'out', mode: 'suggest', conditions: [{ field: 'description', op: 'contains', value: 'R13 SHOP' }], accountId: A.office, classId: c, memo: 'Rule memo' });
  const ruleId = await saveRule(pool(), { ...S, actor, fields: fields(cls[0]) });
  const [a, b] = await bankSays([{ account: 'Business Card', amount: '-813.02', description: 'R13 SHOP A' }, { account: 'Business Card', amount: '-813.03', description: 'R13 SHOP B' }]);
  // The page is shown, then the rule changes: the old row is refused, nothing posted.
  const old = await listPage();
  await saveRule(pool(), { ...S, ruleId, actor, fields: fields(cls[1]) });
  const form = new RegExp(`<form id="row-${a}"[^>]*>([\\s\\S]*?)</form>`).exec(old)[1];
  const body = new URLSearchParams({ csrf: app.csrf, category: await officeName(), memo: 'Rule memo' });
  for (const m of form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) body.set(m[1], m[2].replace(/&amp;/g, '&'));
  let res = await app.raw(`/banking/item/${a}/row`, { method: 'POST', body: body.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' } });
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /rule that filled this row in was changed/);
  assert.equal((await item(a)).review_state, 'new');
  // S01: the same old form with a mistyped category is refused for the rule first; the row comes back afresh, with the rule as
  // it is now (class B), not the old typing.
  body.set('category', 'Offfice');
  const html1 = await (await app.raw(`/banking/item/${a}/row`, { method: 'POST', body: body.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } })).text();
  assert.match(html1, /rule that filled this row in was changed/);
  const fresh = new RegExp(`<form id="row-${a}"[^>]*>([\\s\\S]*?)</form>`).exec(html1)[1];
  assert.notEqual(hidden(fresh, 'rule_at'), hidden(form, 'rule_at'));
  assert.doesNotMatch(html1, /value="Offfice"/);
  // Without JavaScript: a mistyped category comes back with the rule still on the row; the corrected retry keeps it.
  const bad = await (await rowPost(b, { category: 'Offfice' }, { json: false })).text();
  const retryForm = new RegExp(`<form id="row-${b}"[^>]*>([\\s\\S]*?)</form>`).exec(bad)[1];
  assert.match(retryForm, new RegExp(`name="rule" value="${ruleId}"`));
  const retry = new URLSearchParams({ csrf: app.csrf, category: await officeName(), memo: 'Rule memo' });
  for (const m of retryForm.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) retry.set(m[1], m[2].replace(/&amp;/g, '&'));
  res = await app.raw(`/banking/item/${b}/row`, { method: 'POST', body: retry.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' } });
  assert.equal(res.status, 200);
  const { rows: [t] } = await pool().query(`SELECT t.class_id, e.basis, e.rule_id FROM bank_feed_link k JOIN txn t ON t.txn_id = k.txn_id
    JOIN bank_review_event e ON e.item_id = k.item_id AND e.kind = 'added' WHERE k.item_id = $1`, [b]);
  assert.deepEqual([Number(t.class_id), t.basis, Number(t.rule_id)], [cls[1], 'rule', ruleId]);
  const { rows: posts } = await pool().query('SELECT DISTINCT p.class_id FROM bank_feed_link k JOIN posting p ON p.txn_id = k.txn_id WHERE k.item_id = $1', [b]);
  assert.deepEqual(posts.map(p => Number(p.class_id)), [cls[1]]);
});

test('a new payee is kept only when its posting is (R05, R06); a new customer is active and found next time (R04)', async () => {
  const [own] = await bankSays([{ account: 'Business Card', amount: '-805.00', description: 'R05 OWN ACCOUNT' }]);
  const cardName = (await pool().query('SELECT name FROM account WHERE account_id = $1', [A.card])).rows[0].name;
  let res = await rowPost(own, { payee: 'R05 New Vendor', category: cardName, create: 'vendor' });
  assert.equal(res.status, 422);
  assert.equal((await pool().query(`SELECT 1 FROM vendor WHERE display_name = 'R05 New Vendor'`)).rowCount, 0, 'refused posting, no vendor left behind');
  // The item page: a split that doesn't add up.
  const f = await itemForm(app, own);
  res = await app.post(`/banking/item/${own}/add`, new URLSearchParams([...await picks(app, own), ['rev', f.rev], ['evidence', f.evidence ?? ''], ['payee', 'R06 New Vendor'], ['create', 'vendor'],
    ['line_account', await officeName()], ['line_amount', '1.00']]));
  assert.equal(res.status, 422);
  assert.equal((await pool().query(`SELECT 1 FROM vendor WHERE display_name = 'R06 New Vendor'`)).rowCount, 0);
  // Create customer: active, and the next row finds it by name.
  const [x, y] = await bankSays([{ account: 'Operating Checking', amount: '804.14', description: 'R04 IN' }, { account: 'Operating Checking', amount: '804.15', description: 'R04 IN 2' }]);
  res = await rowPost(x, { payee: 'R04 New Customer', category: 'Interest Income', create: 'customer' }, { account: 'Operating Checking' });
  assert.equal(res.status, 200);
  assert.equal((await pool().query(`SELECT active FROM customer WHERE display_name = 'R04 New Customer'`)).rows[0].active, true);
  res = await rowPost(y, { payee: 'R04 New Customer', category: 'Interest Income' }, { account: 'Operating Checking' });
  assert.equal(res.status, 200);
});

test('a rule deleted after the page was shown: the row is refused, then shown afresh without it (S02)', async () => {
  const ruleId = await saveRule(pool(), { ...S, actor, fields: { name: 'S02 rule', money: 'out', mode: 'suggest', conditions: [{ field: 'description', op: 'contains', value: 'S02 SHOP' }],
    accountId: A.office } });
  const [id] = await bankSays([{ account: 'Business Card', amount: '-902.02', description: 'S02 SHOP' }]);
  const page = await listPage();
  const form = new RegExp(`<form id="row-${id}"[^>]*>([\\s\\S]*?)</form>`).exec(page)[1];
  await deleteRule(pool(), { ...S, ruleId });
  const body = new URLSearchParams({ csrf: app.csrf, category: 'Offfice' });
  for (const m of form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) body.set(m[1], m[2].replace(/&amp;/g, '&'));
  const html1 = await (await app.raw(`/banking/item/${id}/row`, { method: 'POST', body: body.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } })).text();
  assert.match(html1, /rule that filled this row in was changed/);
  const fresh = new RegExp(`<form id="row-${id}"[^>]*>([\\s\\S]*?)</form>`).exec(html1)[1];
  assert.equal(hidden(fresh, 'rule'), null, 'no rule any more');
  assert.equal((await item(id)).review_state, 'new');
});

test('a choice means the record the page showed, even if it was renamed and its name reused since (T01–T03)', async () => {
  // T03: the account shown as “T03 row” is renamed and a new account takes the name before the old form is posted.
  const old = await saveAccount(pool(), { ...S, actor, fields: { name: 'T03 row', number: '9300', type: 'expense' } });
  const [a] = await bankSays([{ account: 'Business Card', amount: '-1003.01', description: 'T03 SHOP' }]);
  const page = await listPage();
  const formOf = (pg, id) => new RegExp(`<form id="row-${id}"[^>]*>([\\s\\S]*?)</form>`).exec(pg)[1];
  const post = async (id, pg, typed) => {
    const body = new URLSearchParams({ csrf: app.csrf, ...typed });
    for (const m of formOf(pg, id).matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) body.set(m[1], m[2].replace(/&amp;/g, '&'));
    return app.raw(`/banking/item/${id}/row`, { method: 'POST', body: body.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' } });
  };
  await saveAccount(pool(), { ...S, accountId: old, actor, fields: { name: 'T03 row renamed', number: '9300', type: 'expense' } });
  const reused = await saveAccount(pool(), { ...S, actor, fields: { name: 'T03 row', number: '9400', type: 'expense' } });
  let res = await post(a, page, { category: 'T03 row' });
  assert.equal(res.status, 200);
  const acct = async id => (await pool().query(`SELECT p.account_id FROM bank_feed_link k JOIN posting p ON p.txn_id = k.txn_id WHERE k.item_id = $1 AND p.account_id <> $2`, [id, A.card])).rows.map(r => Number(r.account_id));
  assert.deepEqual(await acct(a), [old], 'the account the page showed, not the newcomer');
  assert.ok(reused);
  // T02: the vendor shown as “T02 row” is renamed and a customer takes the name.
  const v = await saveVendor(pool(), { ...S, actor, fields: { displayName: 'T02 row' } });
  const [b] = await bankSays([{ account: 'Business Card', amount: '1002.01', description: 'T02 REFUND' }]);
  const page2 = await listPage();
  await saveVendor(pool(), { ...S, vendorId: v, actor, fields: { displayName: 'T02 row renamed' }, key: undefined });
  await saveCustomer(pool(), { ...S, actor, fields: { displayName: 'T02 row', active: true, isNew: true } });
  res = await post(b, page2, { payee: 'T02 row', category: await officeName() });
  assert.equal(res.status, 200);
  const party = async id => (await pool().query('SELECT txn_party_key(txn_id) AS k FROM bank_feed_link WHERE item_id = $1', [id])).rows[0].k;
  assert.equal(await party(b), `v:${v}`);
  // A vendor made inactive since is refused, not swapped.
  const gone = await saveVendor(pool(), { ...S, actor, fields: { displayName: 'T02 gone' } });
  const [c] = await bankSays([{ account: 'Business Card', amount: '-1002.02', description: 'T02 GONE' }]);
  const page3 = await listPage();
  await saveVendor(pool(), { ...S, vendorId: gone, actor, fields: { displayName: 'T02 gone', active: false } });
  res = await post(c, page3, { payee: 'T02 gone', category: await officeName() });
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /made inactive or removed since the page was shown/);
  // T01: a newcomer literally named the customer's shown fallback doesn't take it over.
  const cust = await saveCustomer(pool(), { ...S, actor, fields: { displayName: 'T01 row', active: true, isNew: true } });
  for (const n of ['T01 row', 'T01 row (customer)', 'T01 row (customer #' + cust + ')']) await saveVendor(pool(), { ...S, actor, fields: { displayName: n } });
  const [d] = await bankSays([{ account: 'Business Card', amount: '-1001.01', description: 'T01 REFUND' }]);
  const page4 = await listPage();
  const shown = (await payeeChoices(pool(), S)).find(x => x.key === `c:${cust}`).value;
  await saveVendor(pool(), { ...S, actor, fields: { displayName: shown } });
  res = await post(d, page4, { payee: shown, category: await officeName() });
  assert.equal(res.status, 200);
  assert.equal(await party(d), `c:${cust}`);
  // A page whose lists are unknown (a hand-made or very old form) is refused.
  const [e] = await bankSays([{ account: 'Business Card', amount: '-1001.02', description: 'T01 OLD FORM' }]);
  const page5 = (await listPage()).replace(/name="cats_v" value="[0-9a-f]+"/g, 'name="cats_v" value=""');
  res = await post(e, page5, { category: await officeName() });
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /out of date/);
});

test('a form shown again after an error keeps each choice as the same record, under its label now (U01, U02); snapshots in use are kept (U04)', async () => {
  const formOf = (pg, id) => new RegExp(`<form id="row-${id}"[^>]*>([\\s\\S]*?)</form>`).exec(pg)[1];
  const fieldsOf = (pg, id) => {
    const body = new URLSearchParams({ csrf: app.csrf });
    for (const m of formOf(pg, id).matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) body.set(m[1], m[2].replace(/&amp;/g, '&'));
    return body;
  };
  const typedIn = (pg, id, name) => new RegExp(`<input name="${name}" form="row-${id}"[^>]*? value="([^"]*)"`).exec(pg)?.[1];
  // U02: the category's account is renamed and its old name reused; the post comes back for an unknown payee; Create vendor
  // from that page still posts to the account first chosen.
  const old = await saveAccount(pool(), { ...S, actor, fields: { name: 'U02 row', number: '9600', type: 'expense' } });
  const [a] = await bankSays([{ account: 'Business Card', amount: '-1102.01', description: 'U02 SHOP' }]);
  const page = await listPage();
  await saveAccount(pool(), { ...S, accountId: old, actor, fields: { name: 'U02 row renamed', number: '9600', type: 'expense' } });
  await saveAccount(pool(), { ...S, actor, fields: { name: 'U02 row', number: '9700', type: 'expense' } });
  const body = fieldsOf(page, a);
  body.set('category', 'U02 row');
  body.set('payee', 'U02 New Vendor');
  const again = await (await app.raw(`/banking/item/${a}/row`, { method: 'POST', body: body.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } })).text();
  assert.equal(typedIn(again, a, 'category'), 'U02 row renamed', 'carried to the same account’s label now');
  const retry = fieldsOf(again, a);
  retry.set('category', typedIn(again, a, 'category'));
  retry.set('payee', typedIn(again, a, 'payee'));
  retry.set('create', 'vendor');
  const res = await app.raw(`/banking/item/${a}/row`, { method: 'POST', body: retry.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' } });
  assert.equal(res.status, 200);
  const posted = (await pool().query('SELECT p.account_id FROM bank_feed_link k JOIN posting p ON p.txn_id = k.txn_id WHERE k.item_id = $1 AND p.account_id <> $2', [a, A.card])).rows;
  assert.deepEqual(posted.map(r => Number(r.account_id)), [old]);
  // U01: the payee is renamed and its name taken by a customer; a mistyped category comes back with the payee carried.
  const v = await saveVendor(pool(), { ...S, actor, fields: { displayName: 'U01 row' } });
  const [b] = await bankSays([{ account: 'Business Card', amount: '1101.01', description: 'U01 REFUND' }]);
  const page2 = await listPage();
  await saveVendor(pool(), { ...S, vendorId: v, actor, fields: { displayName: 'U01 row renamed' } });
  await saveCustomer(pool(), { ...S, actor, fields: { displayName: 'U01 row', active: true, isNew: true } });
  const body2 = fieldsOf(page2, b);
  body2.set('payee', 'U01 row');
  body2.set('category', 'Offfice');
  const again2 = await (await app.raw(`/banking/item/${b}/row`, { method: 'POST', body: body2.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } })).text();
  assert.equal(typedIn(again2, b, 'payee'), 'U01 row renamed');
  // U04: a snapshot shown again is refreshed, so the cleanup never takes one a page is using.
  const hash = hidden(formOf(page2, b), 'cats_v');
  await pool().query(`UPDATE bank_picker_snapshot SET used_at = now() - interval '61 days' WHERE hash = $1`, [hash]);
  await saveVendor(pool(), { ...S, actor, fields: { displayName: 'U04 newcomer' } });
  const page3 = await listPage();
  assert.equal(hidden(new RegExp('<form id="row-[0-9]+"[^>]*>([\\s\\S]*?)</form>').exec(page3)[1], 'cats_v'), hash);
  assert.equal((await pool().query('SELECT 1 FROM bank_picker_snapshot WHERE hash = $1', [hash])).rowCount, 1);
});

test('Create vendor never posts to a customer added meanwhile with that name, nor Create customer to a vendor (W01)', async () => {
  const [a, b] = await bankSays([{ account: 'Business Card', amount: '-1301.01', description: 'W01 OUT' }, { account: 'Operating Checking', amount: '1301.11', description: 'W01 IN' }]);
  let res = await rowPost(a, { payee: 'W01 row vendor', category: await officeName() });
  assert.equal((await res.json()).create, 'W01 row vendor');
  await saveCustomer(pool(), { ...S, actor, fields: { displayName: 'W01 row vendor', active: true, isNew: true } });
  res = await rowPost(a, { payee: 'W01 row vendor', category: await officeName(), create: 'vendor' });
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /was just added as a customer by someone else, so nothing was created/);
  assert.equal((await item(a)).review_state, 'new');
  // The item page, the other way round.
  const f = await itemForm(app, b);
  await saveVendor(pool(), { ...S, actor, fields: { displayName: 'W01 row customer' } });
  res = await app.post(`/banking/item/${b}/add`, new URLSearchParams([...await picks(app, b), ['rev', f.rev], ['evidence', f.evidence ?? ''], ['payee', 'W01 row customer'],
    ['create', 'customer'], ['line_account', 'Interest Income'], ['line_amount', '']]));
  assert.equal(res.status, 422);
  assert.match(await res.text(), /was just added as a vendor by someone else/);
  assert.equal((await item(b)).review_state, 'new');
  assert.equal((await pool().query(`SELECT 1 FROM customer WHERE display_name = 'W01 row customer'`)).rowCount, 0);
});

test('a history suggestion posted unchanged from the row keeps its class and location (X01)', async () => {
  const cls = Number((await pool().query(`INSERT INTO class (org_id, entity_id, name) VALUES ($1, $2, 'X01 class') RETURNING class_id`, [S.orgId, S.entityId])).rows[0].class_id);
  const loc = Number((await pool().query(`INSERT INTO location (org_id, entity_id, name) VALUES ($1, $2, 'X01 location') RETURNING location_id`, [S.orgId, S.entityId])).rows[0].location_id);
  const v = await saveVendor(pool(), { ...S, actor, fields: { displayName: 'X01 vendor' } });
  const past = await bankSays([1, 2, 3].map(n => ({ account: 'Business Card', amount: `-14.0${n}`, description: 'XHIST DIMENSION SHOP' })));
  for (const id of past) await addItem(pool(), { ...S, itemId: id, payee: `v:${v}`, lines: [{ accountId: A.office, amount: '' }], dims: { classId: cls, locationId: loc }, actor });
  const [a, b] = await bankSays([{ account: 'Business Card', amount: '-1401.21', description: 'XHIST DIMENSION SHOP' }, { account: 'Business Card', amount: '-1401.31', description: 'XHIST DIMENSION SHOP' }]);
  const dims = async id => (await pool().query(`SELECT t.class_id, t.location_id, e.basis FROM bank_feed_link k JOIN txn t ON t.txn_id = k.txn_id
    JOIN bank_review_event e ON e.item_id = k.item_id AND e.kind = 'added' WHERE k.item_id = $1`, [id])).rows[0];
  assert.equal((await rowPost(a, {})).status, 200);
  assert.deepEqual(Object.values(await dims(a)).map(String), [String(cls), String(loc), 'history']);
  // Changing the category: a person's choice, without the history's class and location.
  assert.equal((await rowPost(b, { category: 'Repairs & Maintenance' })).status, 200);
  const d = await dims(b);
  assert.deepEqual([d.class_id, d.location_id, d.basis], [null, null, 'person']);
});
