import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './app-harness.js';
import { freshDb } from './harness.js';
import { buildSampleFeed, writeLedgerlineSample, sampleUuid } from '../lib/bankfeed/sample.js';
import { pullCompany } from '../lib/bankfeed/pull.js';
import { linkCompany, saveMappings } from '../lib/data/bankfeeds.js';
import { getBankItem } from '../lib/data/banking.js';
import { saveAiSettings } from '../lib/ai/provider.js';
import { settingsKey } from '../lib/secrets.js';
import { autoResearch } from '../lib/ai/auto-research.js';
import { learnedHistory, suggestFor, listRules } from '../lib/bankfeed/rules.js';
import { researchKey } from '../lib/bankfeed/wording.js';
import { saveVendor } from '../lib/data/vendors.js';
import { writeVendorDoc } from '../lib/data/payables.js';
import { withTransaction } from '../lib/db.js';

// Bank review v3, stage S5: vendor research on its own after a pull, for money-out lines nothing recognizes —
// bounded, reserved before the provider is asked, shared by payee, never posting anything.
const KEY = 'sk-ant-test-0000000000000000000000000000';
const SK = 'ab'.repeat(32);
const calls = [];
let reply = null;
const fakeFetch = async (url, init) => {
  calls.push({ url, body: JSON.parse(init.body) });
  const r = typeof reply === 'function' ? await reply(url, init) : reply;
  await new Promise(res => setTimeout(res, 20));
  return { ok: r.status === 200, status: r.status, json: async () => r.json };
};
const answer = obj => ({ status: 200, json: { content: [{ type: 'text', text: JSON.stringify(obj) }], usage: { input_tokens: 500, output_tokens: 80 }, stop_reason: 'end_turn' } });

let app, llDb, ll, feed, S, A;
const actor = 'tester';
const llId = name => feed.accounts.find(a => a.name === name).id;
const pool = () => app.db.pool;
before(async () => {
  llDb = await freshDb({ migrate: false });
  ll = llDb.pool;
  app = await startApp({ ledgerline: ll, aiFetch: fakeFetch, env: { SETTINGS_KEY: SK } });
  S = { orgId: app.ids.orgId, entityId: app.ids.entityId };
  A = app.ids.accounts;
  feed = await buildSampleFeed(pool(), { ...S, asOf: '2026-10-12' });
  await writeLedgerlineSample(ll, feed);
  await pool().query('UPDATE org SET ledgerline_org_id = $1 WHERE org_id = $2', [feed.org, S.orgId]);
  await linkCompany(pool(), ll, { ...S, llEntityId: feed.entities[0].id, actor });
  await pullCompany(pool(), ll, S);
  await saveMappings(pool(), { ...S, actor, choices: [{ id: llId('Business Card'), choice: String(A.card) }, { id: llId('Operating Checking'), choice: String(A.checking) },
    { id: llId('Business Savings'), choice: 'skip' }, { id: llId('Equipment Loan'), choice: 'skip' }] });
  await pullCompany(pool(), ll, S);
  // Everything the sample feed brought in is reviewed elsewhere: only this test's lines are new.
  await pool().query(`UPDATE bank_feed_item SET review_state = 'excluded' WHERE entity_id = $1 AND review_state = 'new'`, [S.entityId]);
});
after(async () => { await app.close(); await llDb.drop(); });

let seq = 0;
async function bankSays(rows) {
  const keys = [];
  for (const r of rows) {
    const key = `ar-${++seq}`;
    keys.push(key);
    await ll.query(`INSERT INTO core.transaction (org_id, transaction_id, account_id, amount, currency, posted_date, pending, description_raw, merchant_name, status, revision)
      VALUES ($1, $2, $3, $4, 'USD', $5, $6, $7, $8, 'active', 1)`, [feed.org, sampleUuid('ar', key), llId(r.account ?? 'Business Card'), r.amount, r.date ?? new Date().toISOString().slice(0, 10),
      Boolean(r.pending), r.description, r.merchant ?? null]);
  }
  await pullCompany(pool(), ll, S);
  const ids = [];
  for (const k of keys) ids.push(Number((await pool().query('SELECT item_id FROM bank_feed_item WHERE ll_transaction_id = $1', [sampleUuid('ar', k)])).rows[0].item_id));
  return ids;
}
const item = id => getBankItem(pool(), { ...S, itemId: id });
const suggest = async id => suggestFor(pool(), { ...S, item: await item(id), rules: await listRules(pool(), S), history: await learnedHistory(pool(), S) });
const run = (o = {}) => autoResearch(pool(), { ...S, key: settingsKey({ SETTINGS_KEY: SK }), fetchImpl: fakeFetch, ...o });
const clean = async () => {
  await pool().query(`UPDATE bank_feed_item SET review_state = 'excluded' WHERE entity_id = $1 AND review_state = 'new'`, [S.entityId]);
  await pool().query('DELETE FROM vendor_research WHERE entity_id = $1', [S.entityId]);
  await pool().query('DELETE FROM vendor_research_attempt WHERE entity_id = $1', [S.entityId]);
  calls.length = 0;
};

test('the payee words a research is shared by: never ORIG CO NAME, the merchant name first', () => {
  assert.equal(researchKey({ description: 'ORIG CO NAME:QUILLBACK MU CO ENTRY DESCR:ISA PYMENT SEC:PPD ORIG ID:9000123456' }), 'QUILLBACK MU ISA');
  assert.equal(researchKey({ description: 'ORIG CO NAME:PAYPAL ORIG ID:PAYPALSI77 DESC DATE:251014' }), '', 'only boilerplate and payment wording: nothing to share by');
  assert.notEqual(researchKey({ description: 'ORIG CO NAME:QUILLBACK MU CO ENTRY' }), researchKey({ description: 'ORIG CO NAME:VERIZON WIRELESS CO ENTRY' }));
  assert.equal(researchKey({ description: 'EPIC GAMES 4471', merchant_name: 'Epic Games' }), 'EPIC GAMES');
});

test('no AI provider set up: nothing is asked', async () => {
  await clean();
  await bankSays([{ amount: '-16.91', description: 'KESTREL GAMES STORE' }]);
  assert.deepEqual(await run(), { off: true, asked: 0 });
  assert.equal(calls.length, 0);
});

test('lines nothing recognizes are researched once per payee; the answer fills them all in; nothing posts', async () => {
  await saveAiSettings(pool(), { ...S, provider: 'anthropic', apiKey: KEY, key: settingsKey({ SETTINGS_KEY: SK }), actor });
  await clean();
  // Known from the bank wording in the books: not asked about.
  const v = await saveVendor(pool(), { ...S, fields: { displayName: 'Plover Paper' }, actor });
  for (const d of ['2026-07-01', '2026-08-01', '2026-09-01']) {
    await withTransaction(pool(), tx => writeVendorDoc(tx, { ...S, actor, type: 'expense', vendorId: v, txnDate: d, accountId: A.card, memo: 'PLOVER PAPER CO 4412',
      categoryLines: [{ accountId: A.office, amount: '9.00' }], itemLines: [] }));
  }
  const [g1, g2, known, , income] = await bankSays([{ amount: '-16.91', description: 'EPIC GAMES', merchant: 'Epic Games' }, { amount: '-27.06', description: 'EPIC GAMES', merchant: 'Epic Games' },
    { amount: '-11.11', description: 'PLOVER PAPER CO 4412' }, { amount: '-5.55', description: 'SANDERLING SURF', pending: true },
    { account: 'Operating Checking', amount: '40.00', description: 'REFUND FROM SANDERLING' }]);
  reply = answer({ business_name: 'Epic Games', what_they_do: 'Video games', vendor_id: null, new_vendor: { display_name: 'Epic Games', website: 'epicgames.com', city: null, state: null },
    category_account_id: A.office, confidence: 'high', reasons: 'Fortnite purchases', sources: [] });
  const out = await run();
  assert.equal(out.asked, 1, 'one payee, one call (not the known, the pending or the money-in line)');
  assert.equal(calls.length, 1);
  for (const id of [g1, g2]) {
    const s = await suggest(id);
    assert.deepEqual([s.source, s.accountId], ['ai', A.office]);
    assert.equal((await item(id)).review_state, 'new', 'only a suggestion');
  }
  assert.notEqual((await suggest(known))?.source, 'ai');
  assert.notEqual((await suggest(income))?.source, 'ai', 'research is never used for money in');
  // Asked about lately: not again.
  assert.equal((await run()).asked, 0);
  assert.equal(calls.length, 1);
});

test('a failed answer counts and isn’t retried for a week; the daily limit holds', async () => {
  await clean();
  await bankSays([{ amount: '-3.00', description: 'GODWIT GADGETS' }, { amount: '-4.00', description: 'CURLEW CANDLES' }, { amount: '-6.00', description: 'DOWITCHER DELI' }]);
  reply = { status: 500, json: { error: { message: 'busy' } } };
  assert.equal((await run({ perDay: 2 })).asked, 2, 'the limit: two today');
  const { rows } = await pool().query(`SELECT status FROM vendor_research WHERE entity_id = $1 ORDER BY research_id`, [S.entityId]);
  assert.deepEqual(rows.map(r => r.status), ['failed', 'failed']);
  reply = answer({ business_name: 'X', vendor_id: null, new_vendor: { display_name: 'X' }, category_account_id: A.office, confidence: 'low', reasons: '', sources: [] });
  assert.equal((await run({ perDay: 2 })).asked, 0, 'today’s calls are used up, failures included');
  assert.equal((await run({ perDay: 10 })).asked, 1, 'only the payee not yet asked about');
});

test('two pulls at once never pay twice for the same payee', async () => {
  await clean();
  await bankSays([{ amount: '-8.80', description: 'WHIMBREL WAX' }, { amount: '-9.90', description: 'WHIMBREL WAX' }]);
  reply = answer({ business_name: 'Whimbrel', vendor_id: null, new_vendor: { display_name: 'Whimbrel Wax' }, category_account_id: A.office, confidence: 'medium', reasons: '', sources: [] });
  const [a, b] = await Promise.all([run(), run()]);
  assert.equal(a.asked + b.asked, 1);
  assert.equal(calls.length, 1);
  assert.equal((await pool().query(`SELECT count(*)::int AS n FROM vendor_research WHERE entity_id = $1 AND status = 'pending'`, [S.entityId])).rows[0].n, 0);
});

test('a pull can run it (and waits for it when asked to)', async () => {
  await clean();
  reply = answer({ business_name: 'Sora Supplies', vendor_id: null, new_vendor: { display_name: 'Sora Supplies' }, category_account_id: A.office, confidence: 'high', reasons: '', sources: [] });
  const key = `ar-${++seq}`;
  await ll.query(`INSERT INTO core.transaction (org_id, transaction_id, account_id, amount, currency, posted_date, pending, description_raw, status, revision)
    VALUES ($1, $2, $3, '-12.12', 'USD', current_date, false, 'SORA SUPPLIES', 'active', 1)`, [feed.org, sampleUuid('ar', key), llId('Business Card')]);
  const r = await pullCompany(pool(), ll, { ...S, key: settingsKey({ SETTINGS_KEY: SK }), research: 'wait', aiFetch: fakeFetch });
  assert.equal(r.research.asked, 1);
});

// ---- Codex S5 round 1 ----
const okAnswer = name => answer({ business_name: name, vendor_id: null, new_vendor: { display_name: name }, category_account_id: A.office, confidence: 'high', reasons: '', sources: [] });

test('one merchant, very different purchases: the vendor is shared, the category only for a like amount (Codex S5 #1)', async () => {
  await clean();
  const [small, big, like] = await bankSays([{ amount: '-19.01', description: 'GROSBEAK MACHINE WORKS' }, { amount: '-12001.02', description: 'GROSBEAK MACHINE WORKS' },
    { amount: '-25.00', description: 'GROSBEAK MACHINE WORKS' }]);
  reply = okAnswer('Grosbeak Machine Works');
  // Ask about the small one only.
  await pool().query(`UPDATE bank_feed_item SET review_state = 'excluded' WHERE item_id = ANY($1)`, [[big, like]]);
  assert.equal((await run()).asked, 1);
  await pool().query(`UPDATE bank_feed_item SET review_state = 'new' WHERE item_id = ANY($1)`, [[big, like]]);
  assert.deepEqual([(await suggest(small)).accountId, (await suggest(like)).accountId], [A.office, A.office]);
  const sb = await suggest(big);
  assert.deepEqual([sb.source, sb.accountId, sb.confidence], ['ai', null, 'low']);
});

test('merchants told apart by their numbers aren’t merged; a bank text thinned to one word is the line’s own (Codex S5 #2)', () => {
  assert.notEqual(researchKey({ merchant_name: 'Studio 54' }), researchKey({ merchant_name: 'Studio 88' }));
  assert.equal(researchKey({ description: 'STUDIO 54', ll_transaction_id: 'abc' }), 'STUDIO 54', 'a short number is part of the name');
  assert.equal(researchKey({ description: 'ROBLOX' }), 'ROBLOX');
});

test('unmapping a feed resets neither the daily limit nor the week’s wait (Codex S5 #3)', async () => {
  await clean();
  const [x] = await bankSays([{ amount: '-7.70', description: 'MERGANSER MILLS' }]);
  reply = { status: 500, json: { error: { message: 'busy' } } };
  assert.equal((await run({ perDay: 1 })).asked, 1);
  // The bank line (and its research rows) go, as unmapping does; the attempt stays.
  await pool().query('DELETE FROM bank_feed_item WHERE item_id = $1', [x]);
  await bankSays([{ amount: '-7.71', description: 'MERGANSER MILLS' }, { amount: '-3.30', description: 'SCAUP SUPPLY' }]);
  assert.equal((await run({ perDay: 1 })).asked, 0, 'today’s one call is still counted');
  assert.equal((await run({ perDay: 5 })).asked, 1, 'and Merganser waits its week: only Scaup');
});

test('a line the bank changes while it’s asked about doesn’t keep the answer (Codex S5 #4)', async () => {
  await clean();
  const [id] = await bankSays([{ amount: '-5.15', description: 'PHALAROPE FISH MARKET' }]);
  // The bank corrects the line while the provider is thinking.
  reply = async () => {
    await pool().query(`UPDATE bank_feed_item SET description = 'TEAL TOOL RENTAL', revision = revision + 1 WHERE item_id = $1`, [id]);
    return okAnswer('Phalarope Fish Market');
  };
  await run();
  const { rows: [r] } = await pool().query('SELECT status, error, proposal FROM vendor_research WHERE item_id = $1', [id]);
  assert.deepEqual([r.status, r.proposal], ['failed', null]);
  assert.match(r.error, /changed while it was researched/);
  assert.notEqual((await suggest(id))?.source, 'ai');
});

test('turning AI off stops the queued calls; an abandoned reservation is let go (Codex S5 #5, #6)', async () => {
  await clean();
  await bankSays([{ amount: '-1.11', description: 'AVOCET APPAREL' }, { amount: '-2.22', description: 'BOOBY BAKERY' }]);
  reply = async () => { await pool().query(`UPDATE ai_settings SET provider = 'off' WHERE org_id = $1`, [S.orgId]); return okAnswer('Avocet'); };
  const out = await run();
  assert.equal(out.asked, 1, 'the second payee is never asked about once AI is off');
  await saveAiSettings(pool(), { ...S, provider: 'anthropic', apiKey: KEY, key: settingsKey({ SETTINGS_KEY: SK }), actor });
  // A reservation left pending (a crash) for longer than the lease.
  await clean();
  const [id] = await bankSays([{ amount: '-4.44', description: 'COOT COFFEE' }]);
  await pool().query(`INSERT INTO vendor_research (org_id, entity_id, item_id, payee_key, status, created_by, auto, created_at)
    VALUES ($1, $2, $3, 'COOT COFFEE', 'pending', 'x', true, now() - interval '1 hour')`, [S.orgId, S.entityId, id]);
  reply = okAnswer('Coot Coffee');
  await run();
  const { rows } = await pool().query(`SELECT status FROM vendor_research WHERE item_id = $1 ORDER BY research_id`, [id]);
  assert.deepEqual(rows.map(r => r.status), ['failed', 'done'], 'let go, then asked');
});

test('the question is bounded: long text cut, the lists cut off, one continuation at most (Codex S5 #7)', async () => {
  await clean();
  for (let n = 0; n < 500; n++) await saveVendor(pool(), { ...S, fields: { displayName: `Vendor ${'Q'.repeat(60)} ${n}` }, actor });
  await bankSays([{ amount: '-9.09', description: `REDSHANK ${'Z'.repeat(2000)}` }]);
  let rounds = 0;
  reply = () => { rounds++; return { status: 200, json: { content: [{ type: 'text', text: '{}' }], usage: {}, stop_reason: 'pause_turn' } }; };
  await run();
  const sent = calls.at(-1).body.messages[0].content;
  assert.ok(sent.length <= 24000, String(sent.length));
  assert.ok(!sent.includes('Z'.repeat(400)));
  assert.equal(rounds, 2, 'a paused search is sent back once');
});

// ---- Codex S5 round 2 ----
test('a line’s own research stops applying when the bank changes the line (Codex S5 r2 #1)', async () => {
  await clean();
  const [id] = await bankSays([{ amount: '-19.01', description: 'LONGSPUR LUMBER' }]);
  reply = okAnswer('Longspur Lumber');
  assert.equal((await run()).asked, 1);
  assert.equal((await suggest(id)).accountId, A.office);
  // The bank corrects the amount: the research was about a $19.01 purchase.
  await pool().query(`UPDATE bank_feed_item SET amount_cents = -1200102, revision = revision + 1 WHERE item_id = $1`, [id]);
  assert.notEqual((await suggest(id))?.source, 'ai');
});

test('the research card and Accept follow the same rules as the suggestion (Codex S5 r2 #2)', async () => {
  await clean();
  const [small, big] = await bankSays([{ amount: '-12.34', description: 'REDPOLL RADIO' }, { amount: '-4000.00', description: 'REDPOLL RADIO' }]);
  await pool().query(`UPDATE bank_feed_item SET review_state = 'excluded' WHERE item_id = $1`, [big]);
  reply = okAnswer('Redpoll Radio');
  await run();
  await pool().query(`UPDATE bank_feed_item SET review_state = 'new' WHERE item_id = $1`, [big]);
  const page = await (await app.get(`/banking/item/${big}`)).text();
  assert.match(page, /researched for a purchase of a different size/);
  const { rows: [r] } = await pool().query('SELECT research_id FROM vendor_research WHERE item_id = $1', [small]);
  const res = await app.post(`/banking/research/${r.research_id}/accept`, { item: String(big) });
  assert.equal(res.status, 303);
  const loc = res.headers.get('location');
  assert.equal(loc, `/banking/item/${big}?research=${r.research_id}`);
  const filled = await (await app.get(loc)).text();
  assert.match(filled, /<input name="payee" list="item-payees" autocomplete="off" value="Redpoll Radio"/);
  assert.match(filled, /<input name="line_account" list="item-cats" autocomplete="off" value=""/, 'the category isn’t filled in for a purchase of a different size');
  // The researched line changed: Accept refused.
  await pool().query(`UPDATE bank_feed_item SET description = 'SISKIN SIGNS', revision = revision + 1 WHERE item_id = $1`, [small]);
  await pool().query(`UPDATE vendor_research SET decision = NULL WHERE research_id = $1`, [r.research_id]);
  const res2 = await app.post(`/banking/research/${r.research_id}/accept`, { item: String(small) });
  assert.equal(res2.status, 303);
  assert.equal(res2.headers.get('location'), `/banking/item/${small}`, 'refused: back to the line, nothing filled in');
});

test('the payee identity keeps a name’s short numbers and drops dates (Codex S5 r2 #3)', () => {
  assert.notEqual(researchKey({ description: 'STUDIO 54 NEW YORK' }), researchKey({ description: 'STUDIO 88 NEW YORK' }));
  assert.equal(researchKey({ description: 'TALLGRASS XXX-XXX-4729 IL 10/07' }), researchKey({ description: 'TALLGRASS XXX-XXX-4729 IL 11/07' }));
  assert.equal(researchKey({ description: 'STUDIO 5454', ll_transaction_id: 'q' }), 'line:q');
});

test('a rule made while research runs stops the next call; a line pointing at open bills isn’t researched (Codex S5 r2 #4, #5)', async () => {
  await clean();
  await bankSays([{ amount: '-1.01', description: 'PIPIT PAINT' }, { amount: '-2.02', description: 'TITMOUSE TILE' }]);
  const { saveRule } = await import('../lib/bankfeed/rules.js');
  reply = async () => {
    await saveRule(pool(), { ...S, actor, fields: { name: 'Tile', money: 'out', mode: 'suggest', conditions: [{ field: 'description', op: 'contains', value: 'TITMOUSE' }], accountId: A.office } });
    await saveRule(pool(), { ...S, actor, fields: { name: 'Paint', money: 'out', mode: 'suggest', conditions: [{ field: 'description', op: 'contains', value: 'PIPIT' }], accountId: A.office } });
    return okAnswer('First');
  };
  assert.equal((await run()).asked, 1);
  await clean();
  const v = await saveVendor(pool(), { ...S, fields: { displayName: 'Wren Welding' }, actor });
  const { approveBills } = await import('../lib/data/payables.js');
  const b = await withTransaction(pool(), tx => writeVendorDoc(tx, { ...S, actor, type: 'bill', vendorId: v, txnDate: '2026-10-01', memo: 'b', categoryLines: [{ accountId: A.office, amount: '500.00' }], itemLines: [] }));
  await approveBills(pool(), { ...S, txnIds: [b], actor });
  await bankSays([{ account: 'Operating Checking', amount: '-123.45', description: 'WREN WELDING' }]);
  assert.equal((await run()).asked, 0);
});

// ---- Codex S5 round 3 ----
test('an accepted research fills the form only while it applies to the line as it is now (Codex S5 r3 #1)', async () => {
  await clean();
  const [id] = await bankSays([{ amount: '-19.01', description: 'SNIPE SEAFOOD' }]);
  reply = okAnswer('Snipe Seafood');
  await run();
  const { rows: [r] } = await pool().query('SELECT research_id FROM vendor_research WHERE item_id = $1', [id]);
  const res = await app.post(`/banking/research/${r.research_id}/accept`, { item: String(id) });
  const loc = res.headers.get('location');
  assert.match(await (await app.get(loc)).text(), /<input name="payee" list="item-payees" autocomplete="off" value="Snipe Seafood"/);
  // The bank corrects the line; the same address no longer fills anything in.
  await pool().query(`UPDATE bank_feed_item SET amount_cents = -1200102, description = 'TEAL TOOL RENTAL', revision = revision + 1 WHERE item_id = $1`, [id]);
  const again = await (await app.get(loc)).text();
  assert.doesNotMatch(again, /<input name="payee" list="item-payees" autocomplete="off" value="Snipe Seafood"/);
  // Nor does a hand-made address with a payee and category.
  const v = (await pool().query(`SELECT vendor_id FROM vendor WHERE display_name = 'Snipe Seafood'`)).rows[0].vendor_id;
  assert.doesNotMatch(await (await app.get(`/banking/item/${id}?payee=v:${v}&category=${A.office}`)).text(), /<input name="payee" list="item-payees" autocomplete="off" value="Snipe Seafood"/);
});

test('research about money in never lends its category to money out (Codex S5 r3 #2)', async () => {
  await clean();
  const [outLine] = await bankSays([{ amount: '-45.67', description: 'CRANE CREAMERY' }]);
  await pool().query(`INSERT INTO vendor_research (org_id, entity_id, item_id, payee_key, status, proposal, created_by, amount_cents, context)
    VALUES ($1, $2, $3, 'CRANE CREAMERY', 'done', $4, 'x', 4567, 'other')`, [S.orgId, S.entityId, outLine,
    JSON.stringify({ business_name: 'Crane', vendor_id: null, category_account_id: A.office, confidence: 'high' })]);
  assert.notEqual((await suggest(outLine))?.source, 'ai');
});

test('research that no longer applies doesn’t stop a fresh look once the wait is over (Codex S5 r3 #3)', async () => {
  await clean();
  const [id] = await bankSays([{ amount: '-6.06', description: 'EGRET ELECTRIC' }]);
  reply = okAnswer('Egret Electric');
  assert.equal((await run()).asked, 1);
  await pool().query(`UPDATE bank_feed_item SET amount_cents = -60600, revision = revision + 1 WHERE item_id = $1`, [id]);
  await pool().query(`UPDATE vendor_research_attempt SET at = now() - interval '8 days' WHERE entity_id = $1`, [S.entityId]);
  assert.equal((await run()).asked, 1, 'asked again about the line as it is now');
});

// ---- Codex S5 round 4 ----
test('a line with a fitting texted receipt is never researched, and its receipt comes before shared AI research (Codex S5 r4 #1)', async () => {
  await clean();
  const pect = await saveVendor(pool(), { ...S, fields: { displayName: 'Pectoral Hardware' }, actor });
  const [a, b] = await bankSays([{ amount: '-30.30', description: 'PECTORAL HDWE' }, { amount: '-31.31', description: 'PECTORAL HDWE' }]);
  const sid = `MM${String(Date.now()).padStart(32, '0')}`;
  await pool().query(`INSERT INTO receipt (org_id, entity_id, from_phone, message_sid, status, extracted, vendor_id, account_id, item_id, content, filename, content_type, size_bytes)
    VALUES ($1, $2, '+15555550100', $3, 'review', $4, $5, $6, $7, 'x', 'r.jpg', 'image/jpeg', 1)`,
  [S.orgId, S.entityId, sid, JSON.stringify({ vendor: 'Pectoral Hardware', total_cents: 3030, date: new Date().toISOString().slice(0, 10), confidence: 'high' }), pect, A.repairs, a]);
  reply = okAnswer('Pectoral');
  await run();
  const { rows } = await pool().query('SELECT item_id FROM vendor_research WHERE entity_id = $1', [S.entityId]);
  assert.deepEqual(rows.map(r => Number(r.item_id)), [b], 'only the line without a receipt');
  const page = await (await app.get(`/banking?account=${llId('Business Card')}&tab=review`)).text();
  const row = new RegExp(`<tr id="item-${a}"[^>]*>([\\s\\S]*?)</tr>`).exec(page)[1];
  assert.match(row, /<input name="payee"[^>]*value="Pectoral Hardware"/);
  const { rows: [rep] } = await pool().query('SELECT name FROM account WHERE account_id = $1', [A.repairs]);
  assert.ok(row.includes(`value="${rep.name.replace(/&/g, '&amp;')}"`), 'the receipt’s category, not the AI’s');
});

test('the item page’s Add form also starts from the receipt, not shared AI research; Add posts what it shows (Codex S5 r5 #1)', async () => {
  await clean();
  const plover = await saveVendor(pool(), { ...S, fields: { displayName: 'Ploverton Hardware' }, actor });
  const [a, b] = await bankSays([{ amount: '-30.30', description: 'PLOVERTON HDWE' }, { amount: '-31.31', description: 'PLOVERTON HDWE' }]);
  const sid = `MM${String(Date.now() + 1).padStart(32, '0')}`;
  await pool().query(`INSERT INTO receipt (org_id, entity_id, from_phone, message_sid, status, extracted, vendor_id, account_id, item_id, content, filename, content_type, size_bytes)
    VALUES ($1, $2, '+15555550100', $3, 'review', $4, $5, $6, $7, 'x', 'r.jpg', 'image/jpeg', 1)`,
  [S.orgId, S.entityId, sid, JSON.stringify({ vendor: 'Ploverton Hardware', total_cents: 3030, date: new Date().toISOString().slice(0, 10), confidence: 'high' }), plover, A.repairs, a]);
  reply = okAnswer('Ploverton');
  await run();
  assert.equal((await suggest(a)).source, 'ai', 'the shared research is there');
  const page = await (await app.get(`/banking/item/${a}`)).text();
  assert.match(page, /<input name="payee" list="item-payees" autocomplete="off" value="Ploverton Hardware"/);
  const { rows: [rep] } = await pool().query('SELECT name FROM account WHERE account_id = $1', [A.repairs]);
  assert.match(page, new RegExp(`<input name="line_account" list="item-cats" autocomplete="off" value="${rep.name.replace(/&/g, '&amp;')}"`));
  // Add, as the form shows it.
  const { picks, itemForm } = await import('./bank-forms.js');
  const res = await app.post(`/banking/item/${a}/add`, new URLSearchParams([...await picks(app, a), ['rev', (await itemForm(app, a)).rev], ['payee', 'Ploverton Hardware'],
    ['line_account', rep.name], ['line_amount', ''], ['line_description', ''], ['memo', '']]));
  assert.equal(res.status, 303);
  const { rows } = await pool().query(`SELECT p.account_id FROM bank_feed_link k JOIN posting p ON p.txn_id = k.txn_id WHERE k.item_id = $1 AND p.amount_cents > 0`, [a]);
  assert.deepEqual(rows.map(r => Number(r.account_id)), [A.repairs]);
  assert.ok(b);
});

// ---- seen on the practice copy, 2026-10-15: transfers and card payments were researched ----
test('transfers between the organization’s own accounts and card payments are never researched; a weak AI guess never fills a row', async () => {
  const { looksLikeTransfer } = await import('../lib/ai/auto-research.js');
  assert.ok(looksLikeTransfer({ description: 'WEB TFR TO *6150 INSURANCE REIMBURSEMENT 101426' }));
  assert.ok(looksLikeTransfer({ description: 'CHASE CREDIT CRD EPAY PAT SAMPLE' }));
  assert.ok(looksLikeTransfer({ description: 'PAYMENT 6150 OUT' }) === false);
  assert.ok(looksLikeTransfer({ description: 'MOVE TO *6150' }, new Set(['6150'])));
  assert.ok(!looksLikeTransfer({ description: 'EPIC GAMES' }));
  await clean();
  const [t, g] = await bankSays([{ amount: '-800.00', description: 'WEB TFR TO *8150 FUNDS TRANSFER VIA ONLINE 101426' }, { amount: '-5.67', description: 'GALLINULE GOODS' }]);
  reply = answer({ business_name: 'Unidentified', vendor_id: null, new_vendor: { display_name: 'Unidentified payee' }, category_account_id: A.office, confidence: 'low', reasons: '', sources: [] });
  assert.equal((await run()).asked, 1, 'only the purchase, not the transfer');
  assert.equal((await pool().query('SELECT count(*)::int AS n FROM vendor_research WHERE item_id = $1', [t])).rows[0].n, 0);
  assert.equal((await suggest(g)).confidence, 'low');
  const page = await (await app.get(`/banking?account=${llId('Business Card')}&tab=review`)).text();
  const row = new RegExp(`<tr id="item-${g}"[^>]*>([\\s\\S]*?)</tr>`).exec(page)[1];
  assert.match(row, /<input name="category"[^>]*value=""/, 'a weak guess is a hint, not a prefill');
  const ip = await (await app.get(`/banking/item/${g}`)).text();
  assert.match(ip, /<input name="line_account" list="item-cats" autocomplete="off" value=""/);
});
