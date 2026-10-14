import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './app-harness.js';
import { freshDb } from './harness.js';
import { buildSampleFeed, writeLedgerlineSample, sampleUuid } from '../lib/bankfeed/sample.js';
import { pullCompany } from '../lib/bankfeed/pull.js';
import { linkCompany, saveMappings } from '../lib/data/bankfeeds.js';
import { mailerFor } from '../lib/data/settings.js';
import { runDailyJobs } from '../services/jobs/index.js';
import { isPractice, checkBooksMode, PRACTICE_NOTE } from '../lib/domain/practice.js';
import { ensureLedger } from '../lib/data/ledger.js';

// Changeover CH-2: a practice copy of the books, run alongside QuickBooks, never acts on its own — no daily
// jobs, no email, no online payments, bank rules and Refresh only suggest, Accept takes only ticked items — and every
// page says it's the practice copy.
let app, llDb, ll, feed, S, A;
const actor = 'tester';
const PRACTICE = { BOOKS_MODE: 'practice' };
const llId = name => feed.accounts.find(a => a.name === name).id;
const pool = () => app.db.pool;
const count = async (sql, args) => (await pool().query(sql, args)).rows[0].n;
const txnCount = () => count('SELECT count(*)::int AS n FROM txn WHERE entity_id = $1', [S.entityId]);
// The message shown after a redirect: on the page it leads to.
const flash = async res => decodeURIComponent(res.headers.get('set-cookie') ?? '') + (await (await app.get(res.headers.get('location'))).text());

before(async () => {
  llDb = await freshDb({ migrate: false });
  ll = llDb.pool;
  app = await startApp({ ledgerline: ll, env: PRACTICE });
  S = { orgId: app.ids.orgId, entityId: app.ids.entityId };
  A = app.ids.accounts;
  feed = await buildSampleFeed(pool(), { ...S, asOf: '2026-10-12' });
  await writeLedgerlineSample(ll, feed);
  await pool().query('UPDATE org SET ledgerline_org_id = $1 WHERE org_id = $2', [feed.org, S.orgId]);
  await linkCompany(pool(), ll, { ...S, llEntityId: feed.entities[0].id, actor });
  await pullCompany(pool(), ll, { ...S, env: PRACTICE });
  await saveMappings(pool(), { ...S, actor, choices: [
    { id: llId('Operating Checking'), choice: String(A.checking) }, { id: llId('Business Savings'), choice: String(A.savings) },
    { id: llId('Business Card'), choice: String(A.card) }, { id: llId('Equipment Loan'), choice: 'skip' }] });
  await pullCompany(pool(), ll, { ...S, env: PRACTICE });
});
after(async () => { await app.close(); await llDb.drop(); });

test('only BOOKS_MODE=practice turns it on', () => {
  assert.equal(isPractice({ BOOKS_MODE: 'practice' }), true);
  for (const v of [undefined, '', 'live', 'Practice', '1']) assert.equal(isPractice({ BOOKS_MODE: v }), false, String(v));
  // A typo must stop the app rather than quietly run as live books.
  for (const v of [undefined, '', 'live']) assert.equal(checkBooksMode({ BOOKS_MODE: v }), 'live');
  assert.equal(checkBooksMode({ BOOKS_MODE: 'practice' }), 'practice');
  for (const v of ['Practice', 'PRACTICE', 'practice ', '1', 'yes']) assert.throws(() => checkBooksMode({ BOOKS_MODE: v }), /BOOKS_MODE must be/, v);
});

test('every page says it is the practice copy', async () => {
  for (const path of ['/customers', '/banking', '/reports']) {
    const html = await (await app.get(path)).text();
    assert.ok(html.includes(`<div class="practice-banner" role="status">${PRACTICE_NOTE}</div>`), path);
    assert.equal(html.split('class="practice-banner"').length, 2, `once on ${path}`);
  }
  // Signed out, public links and errors too.
  for (const [path, status] of [['/login', 200], ['/invite/not-a-real-invite', 404], ['/vendor-info/not-a-real-link', 404]]) {
    const res = await fetch(app.base + path, { redirect: 'manual' });
    assert.equal(res.status, status, path);
    assert.ok((await res.text()).includes(PRACTICE_NOTE), path);
  }
  const missing = await app.get('/no-such-page');
  assert.equal(missing.status, 404);
  assert.ok((await missing.text()).includes(PRACTICE_NOTE), 'error page');
});

test('daily jobs do nothing: no recurring, late fees, reminders, bill payments or report emails', async () => {
  const before = await txnCount();
  const logs = [];
  const r = await runDailyJobs({ pool: pool(), env: PRACTICE, now: () => new Date('2026-10-13T12:00:00Z'), log: m => logs.push(m) });
  assert.deepEqual(r, { practice: true });
  assert.match(logs.join('\n'), /practice copy — daily jobs are off/);
  assert.equal(await txnCount(), before);
});

test('email is record-only, even with the company’s own mail server set up', async () => {
  await pool().query(`INSERT INTO email_settings (org_id, entity_id, mode, from_name, from_email, smtp_host, smtp_port, smtp_user)
    VALUES ($1, $2, 'smtp', 'Books', 'books@example.com', 'smtp.example.com', 587, 'books') ON CONFLICT (org_id, entity_id) DO UPDATE SET mode = 'smtp', smtp_host = 'smtp.example.com'`,
  [S.orgId, S.entityId]);
  assert.equal((await mailerFor(pool(), { ...S, env: PRACTICE })).kind, 'log');
  assert.equal((await mailerFor(pool(), { ...S, env: {} })).kind, 'smtp', 'outside practice the same settings send for real');
  await pool().query('DELETE FROM email_settings WHERE org_id = $1 AND entity_id = $2', [S.orgId, S.entityId]);
});

test('online payments are closed', async () => {
  for (const [path, method] of [['/pay/anything', 'GET'], ['/pay/anything', 'POST'], ['/webhooks/payments/test', 'POST']]) {
    const res = await fetch(app.base + path, { method, redirect: 'manual', ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}) });
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.match(await res.text(), /Online payments are off in this practice copy/);
  }
});

test('an automatic bank rule only suggests; Refresh adds nothing; Accept needs ticked items', async () => {
  const waiting = () => count(`SELECT count(*)::int AS n FROM bank_feed_item WHERE entity_id = $1 AND description = 'MONTHLY SERVICE FEE' AND review_state = 'new'`, [S.entityId]);
  const before = { txns: await txnCount(), fees: await waiting() };
  assert.ok(before.fees > 0, 'the sample feed has service fees waiting');
  const res = await app.post('/banking/rules', new URLSearchParams([['name', 'Bank fees'], ['priority', '10'], ['money', 'out'], ['llAccount', llId('Operating Checking')],
    ['matchAll', '1'], ['cond_field', 'description'], ['cond_op', 'is'], ['cond_value', 'MONTHLY SERVICE FEE'], ['cond_value2', ''], ['payee', ''],
    ['accountId', String(A.bank_fees)], ['memo', ''], ['mode', 'auto'], ['active', '1']]));
  assert.equal(res.status, 303);
  assert.match(await flash(res), /Practice copy: it suggests, it doesn’t add\./);
  assert.deepEqual({ txns: await txnCount(), fees: await waiting() }, before, 'saving the rule added nothing');

  await ll.query(`INSERT INTO core.transaction (org_id, transaction_id, account_id, amount, currency, posted_date, pending, description_raw, status, revision)
    VALUES ($1, $2, $3, -15.00, 'USD', '2026-10-12', false, 'MONTHLY SERVICE FEE', 'active', 1)`, [feed.org, sampleUuid('practice-fee'), llId('Operating Checking')]);
  const r = await pullCompany(pool(), ll, { ...S, env: PRACTICE });
  assert.equal(r.status, 'ok');
  assert.equal(r.practice, true);
  assert.equal(r.autoAdded, undefined);
  assert.equal(await txnCount(), before.txns, 'Refresh added nothing');
  assert.equal(await waiting(), before.fees + 1, 'the new fee waits for a person');

  const accept = await app.post('/banking/batch', { account: llId('Operating Checking'), action: 'accept' });
  assert.equal(accept.status, 303);
  assert.match(await flash(accept), /Practice copy: tick the items to accept\./);
  assert.equal(await txnCount(), before.txns, 'accept-all took nothing');

  // The same rule, outside practice, would have added them — so practice is what held them back.
  const live = await pullCompany(pool(), ll, { ...S, env: {} });
  assert.equal(live.autoAdded, before.fees + 1);
});

test('a transfer leaves the other account’s bank line for a person to match', async () => {
  for (const [n, acct, amt] of [[1, 'Operating Checking', '-123.45'], [2, 'Business Savings', '123.45']]) {
    await ll.query(`INSERT INTO core.transaction (org_id, transaction_id, account_id, amount, currency, posted_date, pending, description_raw, status, revision)
      VALUES ($1, $2, $3, $4, 'USD', '2026-10-12', false, 'ONLINE TRANSFER', 'active', 1)`, [feed.org, sampleUuid('practice-xfer', n), llId(acct), amt]);
  }
  await pullCompany(pool(), ll, { ...S, env: PRACTICE });
  const item = async acct => (await pool().query(`SELECT item_id, review_state FROM bank_feed_item WHERE entity_id = $1 AND ll_account_id = $2 AND description = 'ONLINE TRANSFER'`,
    [S.entityId, llId(acct)])).rows[0];
  const from = await item('Operating Checking');
  const res = await app.post(`/banking/item/${from.item_id}/transfer`, { other: String(A.savings) });
  assert.equal(res.status, 303);
  assert.equal((await item('Operating Checking')).review_state, 'added');
  assert.equal((await item('Business Savings')).review_state, 'new', 'the savings line waits; it can be matched to the transfer by hand');
});

test('startup in practice counts transactions missing their postings and writes nothing', async () => {
  const { rows: [t] } = await pool().query(`SELECT txn_id FROM txn WHERE entity_id = $1 AND type = 'invoice' AND voided_at IS NULL AND total_cents > 0 ORDER BY txn_id LIMIT 1`, [S.entityId]);
  const postings = async () => Number((await pool().query('SELECT count(*) FROM posting WHERE txn_id = $1', [t.txn_id])).rows[0].count);
  const had = await postings();
  assert.ok(had > 0);
  await pool().query('DELETE FROM posting WHERE txn_id = $1', [t.txn_id]);
  const accounts = async () => Number((await pool().query('SELECT count(*) FROM account')).rows[0].count);
  const acctsBefore = await accounts();
  const r = await ensureLedger(pool(), { repair: false });
  assert.equal(await accounts(), acctsBefore, 'no system accounts created either');
  assert.equal(r.reposted, 0);
  assert.equal(r.missing, 1);
  assert.equal(await postings(), 0, 'nothing written');
  // Repairing is a deliberate step (outside practice it's what startup does).
  assert.equal((await ensureLedger(pool())).reposted, 1);
  assert.equal(await postings(), had);
});
