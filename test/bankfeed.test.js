import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './app-harness.js';
import { freshDb } from './harness.js';
import { generateSample } from '../lib/seed/generate.js';
import { writeSample } from '../lib/data/seed.js';
import { buildSampleFeed, writeLedgerlineSample } from '../lib/bankfeed/sample.js';
import { ledgerlinePool, toCents } from '../lib/bankfeed/source.js';
import { pullCompany, runBankPulls } from '../lib/bankfeed/pull.js';
import { saveMappings, linkChoices } from '../lib/data/bankfeeds.js';
import { canAccess } from '../lib/domain/roles.js';

// Stage B2: linking a company to ledgerline, mapping its accounts, and pulling bank items — new, corrected, pending →
// posted, removed — against a sample ledgerline database shaped like ledgerline's serve views.
let app, llDb, ll, feed, A, B, pool;
before(async () => {
  llDb = await freshDb({ migrate: false });
  ll = llDb.pool;
  app = await startApp({ ledgerline: ll });
  pool = app.db.pool;
  A = { orgId: app.ids.orgId, entityId: app.ids.entityId };
  feed = await buildSampleFeed(pool, { ...A, asOf: '2026-10-12' });
  await writeLedgerlineSample(ll, feed);
  await app.db.pool.query('UPDATE org SET ledgerline_org_id = $1 WHERE org_id = $2', [feed.org, app.ids.orgId]);
  const s = generateSample({ asOf: '2026-10-12', seed: 7 });
  s.entity = { ...s.entity, name: 'Second Ranch Supply' };
  B = { orgId: app.ids.orgId, entityId: (await writeSample(pool, s, { addCompany: true })).entityId };
});
after(async () => { await app.close(); await llDb.drop(); });

const items = async (where = 'TRUE', args = []) => (await pool.query(`SELECT * FROM bank_feed_item WHERE entity_id = $1 AND ${where}`, [A.entityId, ...args])).rows;
const llAccount = name => feed.accounts.find(a => a.name === name).id;

test('amounts convert exactly', () => {
  assert.equal(toCents('-84.17'), -8417);
  assert.equal(toCents('1250'), 125000);
  assert.equal(toCents('0.5'), 50);
  assert.equal(toCents('12345678901.99'), 1234567890199);
  assert.throws(() => toCents('1e3'));
});

test('ledgerline is read with a read-only session', async () => {
  const ro = ledgerlinePool({ LEDGERLINE_URL: llDb.url });
  try {
    await assert.rejects(ro.query("INSERT INTO core.dimension (org_id, dimension_id) VALUES (gen_random_uuid(), gen_random_uuid())"), /read-only/);
  } finally { await ro.end(); }
  assert.equal(ledgerlinePool({}), null, 'off when LEDGERLINE_URL is not set');
});

test('only admins open Bank connections; anyone who keeps the books can refresh', () => {
  assert.equal(canAccess('admin', 'GET', '/settings/bank-feeds'), true);
  assert.equal(canAccess('standard', 'GET', '/settings/bank-feeds'), false);
  assert.equal(canAccess('standard', 'POST', '/bank-feeds/refresh'), true);
  assert.equal(canAccess('reports', 'POST', '/bank-feeds/refresh'), false);
  assert.equal(canAccess('customers', 'POST', '/bank-feeds/refresh'), false);
});

test('link: choose the ledgerline company, then its accounts come in unmapped', async () => {
  let page = await (await app.get('/settings/bank-feeds')).text();
  assert.match(page, /Link to ledgerline/);
  assert.match(page, /High Plains Hay LLC/);
  const res = await app.post('/settings/bank-feeds/link', { ll_entity_id: feed.entities[0].id });
  assert.equal(res.status, 303);
  page = await (await app.get('/settings/bank-feeds')).text();
  for (const a of ['Operating Checking', 'Business Savings', 'Business Card', 'Equipment Loan']) assert.match(page, new RegExp(a));
  assert.doesNotMatch(page, /Hay Barn Checking/, 'another ledgerline company’s account');
  assert.equal((await items()).length, 0, 'nothing comes in until an account is matched');
  // Suggestions by kind and name.
  assert.match(page, /Operating Checking \(suggested\)/);
  assert.match(page, /Business Card \(suggested\)/);
  assert.match(page, /Savings \(suggested\)/);
  const { rows: [l] } = await pool.query('SELECT * FROM ledgerline_link WHERE entity_id = $1', [A.entityId]);
  assert.equal(l.ll_entity_name, feed.entities[0].name);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ledgerline_verified_month WHERE org_id = $1`, [A.orgId])).rows[0].n, feed.certifications.length);
});

test('map accounts: items come in, pending kept apart, removed ones never shown', async () => {
  const { rows: books } = await pool.query(`SELECT account_id, name FROM account WHERE entity_id = $1`, [A.entityId]);
  const id = n => String(books.find(b => b.name === n).account_id);
  const p = new URLSearchParams();
  for (const [ll, choice] of [['Operating Checking', id('Operating Checking')], ['Business Savings', id('Savings')], ['Business Card', id('Business Card')], ['Equipment Loan', 'new']]) {
    p.append('account', llAccount(ll));
    p.set(`books_${llAccount(ll)}`, choice);
    p.set(`start_${llAccount(ll)}`, '');
  }
  const res = await app.post('/settings/bank-feeds/accounts', p);
  assert.equal(res.status, 303, await res.clone().text());
  const mine = new Set(feed.accounts.filter(a => a.entity === feed.entities[0].id).map(a => a.id));
  const expected = feed.items.filter(i => mine.has(i.account) && i.status === 'active');
  const got = await items();
  assert.equal(got.length, expected.length);
  assert.equal(got.filter(i => i.pending).length, 1);
  assert.ok(!got.some(i => i.description === 'DUPLICATE AUTH HOLD'), 'already removed at the bank');
  assert.ok(got.every(i => i.review_state === 'new' && i.bank_state === 'active'));
  // The bank sign: a card purchase is money out.
  assert.equal(got.find(i => i.description.startsWith('TRACTOR SUPPLY')).amount_cents, -8417);
  const loan = (await pool.query(`SELECT a.name, a.type FROM ledgerline_account l JOIN account a ON a.account_id = l.books_account_id WHERE l.ll_account_id = $1`,
    [llAccount('Equipment Loan')])).rows[0];
  assert.deepEqual(loan, { name: 'Equipment Loan (0042)', type: 'long_term_liability' });
  // Books are untouched: bank items aren't transactions until they're reviewed (stage B3).
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM posting p JOIN account a USING (account_id) WHERE a.name = 'Equipment Loan (0042)'`)).rows[0].n, 0);
  const page = await (await app.get('/settings/bank-feeds')).text();
  assert.match(page, /Through /, 'verified months shown');
  assert.match(page, /1 pending/);
});

test('a second pull with nothing new changes nothing', async () => {
  const r = await pullCompany(pool, ll, { ...A, trigger: 'refresh' });
  assert.deepEqual([r.status, r.new, r.updated, r.removed], ['ok', 0, 0, 0]);
});

test('corrections, pending → posted, and removals', async () => {
  const pend = feed.items.find(i => i.pending);
  const corr = feed.items.find(i => i.description === 'ACH DEBIT XCEL ENERGY');
  const gone = feed.items.find(i => i.description === 'SHELL OIL 57444 PLAINVIEW TX');
  const used = feed.items.find(i => i.description === 'AMZN MKTP US*2K4LM9 AMZN.COM/BILL WA');
  const usedLater = feed.items.find(i => i.description === 'TRACTOR SUPPLY #1234 LUBBOCK TX');
  // Pretend the books already used two items (stage B3 does this for real).
  await pool.query(`UPDATE bank_feed_item SET review_state = 'added' WHERE ll_transaction_id = ANY($1::uuid[])`, [[used.id, usedLater.id]]);
  await ll.query(`UPDATE core.transaction SET pending = false, revision = 2, posted_date = '2026-10-12' WHERE transaction_id = $1`, [pend.id]);
  await ll.query(`UPDATE core.transaction SET amount = -131.40, revision = 3 WHERE transaction_id = $1`, [corr.id]);
  await ll.query(`UPDATE core.transaction SET status = 'removed' WHERE transaction_id = ANY($1::uuid[])`, [[gone.id, used.id]]);
  await ll.query(`UPDATE core.transaction SET amount = -48.17, revision = 2 WHERE transaction_id = $1`, [usedLater.id]);
  const r = await pullCompany(pool, ll, { ...A, trigger: 'refresh' });
  assert.deepEqual([r.status, r.new, r.updated, r.removed], ['ok', 0, 3, 2]);
  const by = async id => (await items('ll_transaction_id = $2', [id]))[0];
  assert.equal((await by(pend.id)).pending, false);
  assert.equal((await by(corr.id)).amount_cents, -13140);
  assert.equal((await by(corr.id)).attention, null, 'not used yet: just updated');
  assert.deepEqual([(await by(gone.id)).bank_state, (await by(gone.id)).attention], ['removed', null], 'unreviewed: hidden');
  assert.deepEqual([(await by(used.id)).bank_state, (await by(used.id)).attention], ['removed', 'removed'], 'used by the books: flagged');
  assert.equal((await by(usedLater.id)).attention, 'changed');
  // The bank brings one back: it's active again and the flag clears.
  await ll.query(`UPDATE core.transaction SET status = 'active', revision = 2 WHERE transaction_id = $1`, [used.id]);
  const r2 = await pullCompany(pool, ll, { ...A, trigger: 'refresh' });
  assert.equal(r2.updated, 1);
  assert.deepEqual([(await by(used.id)).bank_state, (await by(used.id)).attention], ['active', null]);
  const page = await (await app.get('/settings/bank-feeds')).text();
  assert.match(page, /need a look/);
});

test('guard: an account that suddenly returns nothing removes nothing', async () => {
  const savings = llAccount('Business Savings');
  const before = (await items(`ll_account_id = $2 AND bank_state = 'active'`, [savings])).length;
  assert.ok(before > 0);
  await ll.query(`UPDATE core.transaction SET status = 'removed' WHERE account_id = $1`, [savings]);
  const r = await pullCompany(pool, ll, { ...A, trigger: 'refresh' });
  assert.equal(r.removed, 0);
  assert.match(r.warning, /Business Savings: \d+ of \d+ items no longer came back/);
  assert.equal((await items(`ll_account_id = $2 AND bank_state = 'active'`, [savings])).length, before);
  await ll.query(`UPDATE core.transaction SET status = 'active' WHERE account_id = $1`, [savings]);
});

test('start date: only items from then on', async () => {
  const card = llAccount('Business Card');
  const { rows: [m] } = await pool.query('SELECT books_account_id FROM ledgerline_account WHERE ll_account_id = $1', [card]);
  await saveMappings(pool, { ...A, actor: 'test', choices: [{ id: card, choice: String(m.books_account_id), start: '2026-10-01' }] });
  // Two of the card's items are "used"; their mapping can't move, but a start date alone is fine.
  await pullCompany(pool, ll, { ...A, trigger: 'refresh' });
  const fresh = await items(`ll_account_id = $2 AND review_state = 'new' AND bank_state = 'active'`, [card]);
  assert.ok(fresh.length > 0 && fresh.every(i => i.posted_date >= '2026-10-01'));
});

test('a mapping can’t move once its items are in the books', async () => {
  const card = llAccount('Business Card');
  const { rows: [other] } = await pool.query(`SELECT account_id FROM account WHERE entity_id = $1 AND type = 'credit_card' AND name <> 'Business Card' AND system_key IS NULL`, [A.entityId]);
  const target = other?.account_id ?? (await pool.query(`INSERT INTO account (org_id, entity_id, name, type) VALUES ($1, $2, 'Spare Card', 'credit_card') RETURNING account_id`, [A.orgId, A.entityId])).rows[0].account_id;
  await assert.rejects(saveMappings(pool, { ...A, actor: 'test', choices: [{ id: card, choice: String(target), start: '' }] }), /already in the books/);
  await assert.rejects(saveMappings(pool, { ...A, actor: 'test', choices: [{ id: llAccount('Business Savings'), choice: String(target), start: '' }] }), /matching books account/);
  const res = await app.post('/settings/bank-feeds/unlink', {});
  assert.equal(res.status, 422);
  assert.match(await res.text(), /already in the books/);
});

test('scheduled pulls run after a ledgerline sync, not before', async () => {
  assert.equal((await runBankPulls({ pool, ll })).pulled, 0, 'no sync since the last pull');
  await ll.query(`UPDATE core.sample_connection SET last_acceptance_at = now() + interval '1 minute'`);
  assert.equal((await runBankPulls({ pool, ll })).pulled, 1);
  assert.equal((await runBankPulls({ pool, ll })).pulled, 0);
  assert.equal((await runBankPulls({ pool, ll, now: () => new Date(Date.now() + 7 * 3600_000) })).pulled, 1, 'at least every 6 hours');
  const { rows } = await pool.query(`SELECT trigger FROM bank_feed_pull WHERE entity_id = $1 ORDER BY pull_id DESC LIMIT 2`, [A.entityId]);
  assert.deepEqual(rows.map(r => r.trigger), ['schedule', 'schedule']);
});

test('companies stay apart: another company can’t link the same ledgerline company or touch its accounts', async () => {
  const choices = await linkChoices(pool, ll, B);
  assert.deepEqual(choices.map(c => c.name), ['High Plains Hay LLC']);
  await assert.rejects(saveMappings(pool, { ...B, actor: 'test', choices: [{ id: llAccount('Operating Checking'), choice: 'skip', start: '' }] }), /isn’t one of this company’s/);
  await assert.rejects(pullCompany(pool, ll, { ...B, trigger: 'refresh' }), /Link this company/);
  // Switch to B: its Bank connections page shows only the free ledgerline company.
  const csrf = app.csrf;
  assert.equal((await app.post('/company/switch', { entity_id: String(B.entityId), csrf })).status, 303);
  const page = await (await app.get('/settings/bank-feeds')).text();
  assert.match(page, /High Plains Hay LLC/);
  assert.ok(!page.includes(`value="${feed.entities[0].id}"`), 'company A’s ledgerline company isn’t offered');
  const res = await app.post('/settings/bank-feeds/link', { ll_entity_id: feed.entities[0].id });
  assert.equal(res.status, 422);
  assert.equal((await app.post('/bank-feeds/refresh', {})).status, 303);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM bank_feed_item WHERE entity_id = $1', [B.entityId])).rows[0].n, 0);
  assert.equal((await app.post('/company/switch', { entity_id: String(A.entityId) })).status, 303);
});

test('without ledgerline the page says how to connect it', async () => {
  const plain = await startApp();
  try {
    const page = await (await plain.get('/settings/bank-feeds')).text();
    assert.match(page, /Ledgerline isn’t connected/);
    assert.match(page, /LEDGERLINE_URL/);
    assert.equal((await plain.post('/settings/bank-feeds/link', { ll_entity_id: 'x' })).status, 404);
  } finally { await plain.close(); }
});
