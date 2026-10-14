import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { makeTotp } from '../lib/auth.js';
import { startApp } from './app-harness.js';
import { freshDb } from './harness.js';
import { generateSample } from '../lib/seed/generate.js';
import { writeSample } from '../lib/data/seed.js';
import { buildSampleFeed, writeLedgerlineSample, sampleUuid } from '../lib/bankfeed/sample.js';
import { pullCompany } from '../lib/bankfeed/pull.js';
import { linkCompany, linkChoices, saveMappings } from '../lib/data/bankfeeds.js';
import { addItem, matchItem, transferItem, undoItem, getBankItem, matchCandidates } from '../lib/data/banking.js';
import { saveTransfer, voidLedgerTxn, reconcileState } from '../lib/data/ledger-tools.js';
import { setUserCompanies } from '../lib/data/companies.js';
import { auditReport } from '../lib/reports/audit.js';
import { withTransaction } from '../lib/db.js';
import { writeVendorDoc } from '../lib/data/payables.js';

// Regression tests for the independent review of stages B1–B3. Each test names its finding.
const mailer = { kind: 'smtp', from: 'books@sample.example', async send() { return { status: 'sent' }; } };
let app, llDb, ll, feed, S, A, B;
const actor = 'tester';
const llId = name => feed.accounts.find(a => a.name === name).id;
const pool = () => app.db.pool;

before(async () => {
  llDb = await freshDb({ migrate: false });
  ll = llDb.pool;
  app = await startApp({ ledgerline: ll, mailer, env: { SETTINGS_KEY: 'cd'.repeat(32) } });
  S = { orgId: app.ids.orgId, entityId: app.ids.entityId };
  A = app.ids.accounts;
  feed = await buildSampleFeed(pool(), { ...S, asOf: '2026-10-12' });
  await writeLedgerlineSample(ll, feed);
  await pool().query('UPDATE org SET ledgerline_org_id = $1 WHERE org_id = $2', [feed.org, S.orgId]);
  await linkCompany(pool(), ll, { ...S, llEntityId: feed.entities[0].id, actor });
  await pullCompany(pool(), ll, S);
  await saveMappings(pool(), { ...S, actor, choices: [
    { id: llId('Operating Checking'), choice: String(A.checking) }, { id: llId('Business Savings'), choice: String(A.savings) },
    { id: llId('Business Card'), choice: String(A.card) }, { id: llId('Equipment Loan'), choice: 'skip' }] });
  await pullCompany(pool(), ll, S);
  const s = generateSample({ asOf: '2026-10-12', seed: 7 });
  s.entity = { ...s.entity, name: 'Second Ranch Supply' };
  B = { orgId: S.orgId, entityId: (await writeSample(pool(), s, { addCompany: true })).entityId };
});
after(async () => { await app.close(); await llDb.drop(); });

async function bankSays(rows, scope = S) {
  for (const r of rows) {
    await ll.query(`INSERT INTO core.transaction (org_id, transaction_id, account_id, amount, currency, posted_date, pending, description_raw, status, revision)
      VALUES ($1, $2, $3, $4, $5, $6, false, $7, 'active', 1)`, [feed.org, sampleUuid('rv', r.key), r.llAccount ?? llId(r.account), r.amount, r.currency ?? 'USD', r.date, r.description]);
  }
  await pullCompany(pool(), ll, scope);
}
const itemBy = async desc => Number((await pool().query('SELECT item_id FROM bank_feed_item WHERE description = $1 ORDER BY item_id DESC LIMIT 1', [desc])).rows[0]?.item_id);
const item = async id => (await pool().query('SELECT * FROM bank_feed_item WHERE item_id = $1', [id])).rows[0];
const cookieOf = res => (res.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).filter(c => !/=$/.test(c)).join('; ');

test('#1 an admin limited to some companies can’t manage people or companies, or widen their own access', async () => {
  const res = await app.post('/settings/users', new URLSearchParams([['name', 'Ada Admin'], ['email', 'ada@sample.example'], ['role', 'admin'], ['companyAccess', '1'],
    ['company', String(S.entityId)]]));
  assert.equal(res.status, 200);
  const path = /\/invite\/([A-Za-z0-9_-]{43})/.exec(await res.text())[0];
  const pageRes = await fetch(app.base + path);
  const html = await pageRes.text();
  const nonce = /name="nonce" value="([^"]+)"/.exec(html)[1];
  const secret = /class="secret">([A-Z2-7 ]+)</.exec(html)[1].replace(/ /g, '');
  app.advance(30_000);
  const done = await fetch(app.base + path, { method: 'POST', redirect: 'manual', headers: { cookie: cookieOf(pageRes), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ nonce, password: 'correct horse battery', password2: 'correct horse battery', code: makeTotp(secret).generate({ timestamp: app.clock() }) }).toString() });
  assert.equal(done.status, 303);
  const cookie = cookieOf(done).split('; ').find(c => c.startsWith('fb_session='));
  const get = p => fetch(app.base + p, { redirect: 'manual', headers: { cookie } });
  assert.equal((await get('/settings/users')).status, 403);
  assert.equal((await get('/settings/companies')).status, 403);
  const settings = await (await get('/settings')).text();
  assert.doesNotMatch(settings, /href="\/settings\/users"/);
  assert.match(settings, /href="\/settings\/accounts"/, 'still administers this company’s books');
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(settings)[1];
  const { rows: [u] } = await pool().query(`SELECT user_id FROM app_user WHERE email = 'ada@sample.example'`);
  const widen = await fetch(app.base + `/settings/users/${u.user_id}`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, name: 'Ada Admin', email: 'ada@sample.example', role: 'admin', companyAccess: '1', allCompanies: '1' }).toString() });
  assert.equal(widen.status, 403);
  assert.equal((await pool().query('SELECT all_companies FROM app_user WHERE user_id = $1', [u.user_id])).rows[0].all_companies, false);
});

test('#17 company access can’t be changed for a person of another organization', async () => {
  const { rows: [u] } = await pool().query(`SELECT user_id FROM app_user WHERE email = 'ada@sample.example'`);
  await assert.rejects(setUserCompanies(pool(), { orgId: S.orgId + 999, userId: u.user_id, all: true }), /User not found/);
  assert.equal((await pool().query('SELECT count(*)::int AS n FROM app_user_company WHERE user_id = $1', [u.user_id])).rows[0].n, 1);
});

test('#2 only the organization’s own ledgerline tenant is read', async () => {
  // Another customer's company in the same ledgerline.
  const otherOrg = sampleUuid('other-org');
  await ll.query(`INSERT INTO core.entity (org_id, entity_id, slug, display_name, has_books, active) VALUES ($1, $2, 'x', 'Someone Else LLC', true, true)`,
    [otherOrg, sampleUuid('other-entity')]);
  const choices = await linkChoices(pool(), ll, B);
  assert.ok(!choices.some(c => c.name === 'Someone Else LLC'));
  await assert.rejects(linkCompany(pool(), ll, { ...B, llEntityId: sampleUuid('other-entity'), actor }), /isn’t linked to another company/);
  await pool().query('UPDATE org SET ledgerline_org_id = NULL WHERE org_id = $1', [S.orgId]);
  try {
    await assert.rejects(linkChoices(pool(), ll, B), /isn’t assigned a ledgerline account/);
    await assert.rejects(pullCompany(pool(), ll, S), /isn’t assigned a ledgerline account/);
  } finally {
    await pool().query('UPDATE org SET ledgerline_org_id = $1 WHERE org_id = $2', [feed.org, S.orgId]);
  }
});

test('#3 audit entries that can’t be placed in a company show in none', async () => {
  await pool().query(`INSERT INTO audit_log (org_id, entity_id, actor, action, table_name, row_id, before, after) VALUES ($1, NULL, 'old', 'update', 'customer', 1, '{"display_name":"Old"}', '{"display_name":"ZZ-UNPLACED"}')`, [S.orgId]);
  const r = await auditReport(pool(), { ...S, from: '2000-01-01', to: '2100-01-01', timeZone: 'UTC' });
  assert.ok(!JSON.stringify(r).includes('ZZ-UNPLACED'));
});

test('#4 an account that moves to another company: each company sees only its days, and only the owner its balance', async () => {
  const hay = feed.entities[1].id;
  const card = llId('Business Card');
  await ll.query(`UPDATE core.account_entity SET valid = daterange('2020-01-01', '2026-10-05') WHERE account_id = $1`, [card]);
  await ll.query(`INSERT INTO core.account_entity (org_id, account_id, entity_id, valid) VALUES ($1, $2, $3, daterange('2026-10-05', NULL))`, [feed.org, card, hay]);
  await linkCompany(pool(), ll, { ...B, llEntityId: hay, actor });
  await pullCompany(pool(), ll, B);
  const { rows: [bCard] } = await pool().query('SELECT owned_now, bank_balance_cents FROM ledgerline_account WHERE entity_id = $1 AND ll_account_id = $2', [B.entityId, card]);
  assert.equal(bCard.owned_now, true);
  assert.ok(bCard.bank_balance_cents !== null);
  const bBooks = (await pool().query(`SELECT account_id FROM account WHERE entity_id = $1 AND type = 'credit_card' AND system_key IS NULL LIMIT 1`, [B.entityId])).rows[0].account_id;
  await saveMappings(pool(), { ...B, actor, choices: [{ id: card, choice: String(bBooks) }] });
  await pullCompany(pool(), ll, B);
  const { rows: bItems } = await pool().query('SELECT posted_date FROM bank_feed_item WHERE entity_id = $1', [B.entityId]);
  assert.ok(bItems.length > 0 && bItems.every(i => i.posted_date >= '2026-10-05'), 'B gets the days it owns the card');
  await pullCompany(pool(), ll, S);
  const { rows: [aCard] } = await pool().query('SELECT owned_now, bank_balance_cents FROM ledgerline_account WHERE entity_id = $1 AND ll_account_id = $2', [S.entityId, card]);
  assert.deepEqual([aCard.owned_now, aCard.bank_balance_cents], [false, null], 'A no longer sees today’s balance');
  // Put it back for the rest of the tests.
  await ll.query(`DELETE FROM core.account_entity WHERE account_id = $1 AND entity_id = $2`, [card, hay]);
  await ll.query(`UPDATE core.account_entity SET valid = daterange('2020-01-01', NULL) WHERE account_id = $1`, [card]);
  await pool().query('DELETE FROM bank_feed_item WHERE entity_id = $1', [B.entityId]);
});

test('#5 one pull per company; an older version never replaces a newer one', async () => {
  const c = new pg.Client({ connectionString: app.db.url });
  await c.connect();
  try {
    await c.query('SELECT pg_advisory_lock(815215002, $1::int)', [S.entityId]);
    const r = await pullCompany(pool(), ll, S);
    assert.match(r.error, /Another pull for this company is running/);
  } finally { await c.end(); }
  await bankSays([{ key: 'rev', account: 'Operating Checking', amount: '-10.00', date: '2026-10-11', description: 'REVISION TEST' }]);
  const id = await itemBy('REVISION TEST');
  await pool().query('UPDATE bank_feed_item SET revision = 5, amount_cents = -1100 WHERE item_id = $1', [id]);
  await pullCompany(pool(), ll, S);
  assert.equal((await item(id)).amount_cents, -1100, 'revision 1 from the source didn’t overwrite revision 5');
});

test('#11 accounts in another currency can’t be mapped, and their items aren’t brought in as dollars', async () => {
  await ll.query(`UPDATE core.account SET currency = 'CAD' WHERE account_id = $1`, [llId('Equipment Loan')]);
  await pullCompany(pool(), ll, S);
  await assert.rejects(saveMappings(pool(), { ...S, actor, choices: [{ id: llId('Equipment Loan'), choice: 'new' }] }), /in CAD/);
  await bankSays([{ key: 'cad', account: 'Operating Checking', amount: '-99.00', currency: 'CAD', date: '2026-10-11', description: 'CAD ITEM' }]);
  assert.ok(Number.isNaN(await itemBy('CAD ITEM')));
  const { rows: [p] } = await pool().query('SELECT warning FROM bank_feed_pull WHERE entity_id = $1 ORDER BY pull_id DESC LIMIT 1', [S.entityId]);
  assert.match(p.warning, /another currency/);
});

test('#9 deleting one of several matched transactions flags the bank item', async () => {
  const mk = (amount, memo) => withTransaction(pool(), tx => writeVendorDoc(tx, { ...S, actor, type: 'expense', txnDate: '2026-10-10', accountId: A.checking, memo,
    categoryLines: [{ accountId: A.office, amount }], itemLines: [] }));
  const t1 = await mk('60.00', 'part one'), t2 = await mk('40.00', 'part two');
  await bankSays([{ key: 'multi', account: 'Operating Checking', amount: '-100.00', date: '2026-10-11', description: 'MULTI MATCH' }]);
  const id = await itemBy('MULTI MATCH');
  // (#16) the two show as candidates to tick together.
  const cands = await matchCandidates(pool(), { ...S, item: await getBankItem(pool(), { ...S, itemId: id }), others: true });
  assert.ok([t1, t2].every(t => cands.others.some(c => c.txn_id === t)));
  const res = await app.post(`/banking/item/${id}/match`, new URLSearchParams([['txn', String(t1)], ['txn', String(t2)]]));
  assert.equal(res.status, 303);
  assert.equal((await item(id)).review_state, 'matched');
  const { deleteVendorTxn } = await import('../lib/data/payables.js');
  await deleteVendorTxn(pool(), { ...S, txnId: t2, actor });
  assert.deepEqual([(await item(id)).review_state, (await item(id)).attention], ['matched', 'changed']);
  assert.equal(await undoItem(pool(), { ...S, itemId: id, actor }), 'unmatched');
});

test('#10 editing or voiding a linked transaction flags its bank items; fixing it clears the flag', async () => {
  await bankSays([{ key: 'tr-o', account: 'Operating Checking', amount: '-500.00', date: '2026-10-09', description: 'TRANSFER OUT RV' },
    { key: 'tr-i', account: 'Business Savings', amount: '500.00', date: '2026-10-09', description: 'TRANSFER IN RV' }]);
  const out = await itemBy('TRANSFER OUT RV'), into = await itemBy('TRANSFER IN RV');
  const { txnId } = await transferItem(pool(), { ...S, itemId: out, otherAccountId: A.savings, actor });
  await saveTransfer(pool(), { ...S, type: 'transfer', txnId, fromId: A.checking, toId: A.savings, amountText: '700.00', txnDate: '2026-10-09', memo: '' });
  assert.equal((await item(out)).attention, 'changed');
  assert.equal((await item(into)).attention, 'changed');
  await saveTransfer(pool(), { ...S, type: 'transfer', txnId, fromId: A.checking, toId: A.savings, amountText: '500.00', txnDate: '2026-10-09', memo: '' });
  assert.equal((await item(out)).attention, null);
  await voidLedgerTxn(pool(), { ...S, txnId });
  assert.equal((await item(out)).attention, 'changed');
  // #14 a flagged item isn't pre-ticked in Reconcile.
  const st = await reconcileState(pool(), { ...S, accountId: A.checking, through: '2026-10-12' });
  assert.ok(!st.items.some(i => i.txn_id === txnId && i.bank_cleared));
});

test('#13 undoing a paired transfer from the side that made it keeps it for the other side, which then deletes it', async () => {
  await bankSays([{ key: 'p-o', account: 'Operating Checking', amount: '-250.00', date: '2026-10-08', description: 'PAIR OUT' },
    { key: 'p-i', account: 'Business Savings', amount: '250.00', date: '2026-10-08', description: 'PAIR IN' }]);
  const out = await itemBy('PAIR OUT'), into = await itemBy('PAIR IN');
  const { txnId } = await transferItem(pool(), { ...S, itemId: out, otherAccountId: A.savings, actor });
  assert.equal(await undoItem(pool(), { ...S, itemId: out, actor }), 'unmatched');
  assert.ok((await pool().query('SELECT 1 FROM txn WHERE txn_id = $1', [txnId])).rowCount, 'the transfer still records the other side');
  assert.equal((await pool().query('SELECT how FROM bank_feed_link WHERE txn_id = $1', [txnId])).rows[0].how, 'added');
  assert.equal(await undoItem(pool(), { ...S, itemId: into, actor }), 'deleted');
  assert.equal((await pool().query('SELECT 1 FROM txn WHERE txn_id = $1', [txnId])).rowCount, 0);
});

test('#15 a later start date keeps watching items the books already used', async () => {
  await bankSays([{ key: 'early', account: 'Business Card', amount: '-33.00', date: '2026-09-15', description: 'EARLY USED ITEM' }]);
  const id = await itemBy('EARLY USED ITEM');
  await addItem(pool(), { ...S, itemId: id, lines: [{ accountId: A.office, amount: '' }], actor });
  await saveMappings(pool(), { ...S, actor, choices: [{ id: llId('Business Card'), choice: String(A.card), start: '2026-10-01' }] });
  await ll.query(`UPDATE core.transaction SET amount = -35.00, revision = 2 WHERE transaction_id = $1`, [sampleUuid('rv', 'early')]);
  await pullCompany(pool(), ll, S);
  assert.deepEqual([(await item(id)).amount_cents, (await item(id)).attention], [-3500, 'changed']);
  await ll.query(`UPDATE core.transaction SET status = 'removed' WHERE transaction_id = $1`, [sampleUuid('rv', 'early')]);
  await pullCompany(pool(), ll, S);
  assert.deepEqual([(await item(id)).bank_state, (await item(id)).attention], ['removed', 'removed']);
});

test('#18 the Add form as a browser posts it: one category, blank amount, two empty rows', async () => {
  await bankSays([{ key: 'form', account: 'Operating Checking', amount: '-27.50', date: '2026-10-11', description: 'FORM TEST' }]);
  const id = await itemBy('FORM TEST');
  const res = await app.post(`/banking/item/${id}/add`, new URLSearchParams([['payee', ''],
    ['line_account', String(A.office)], ['line_amount', ''], ['line_description', ''],
    ['line_account', ''], ['line_amount', ''], ['line_description', ''],
    ['line_account', ''], ['line_amount', ''], ['line_description', ''], ['memo', '']]));
  assert.equal(res.status, 303, await res.clone().text());
  assert.equal((await item(id)).review_state, 'added');
});

test('#19 /banking pages through items in the database', async () => {
  const first = await (await app.get(`/banking?account=${llId('Operating Checking')}&tab=review`)).text();
  assert.match(first, /Older ›/);
  const second = await (await app.get(`/banking?account=${llId('Operating Checking')}&tab=review&page=2`)).text();
  assert.match(second, /‹ Newer/);
  const ids = html => new Set([...html.matchAll(/\/banking\/item\/(\d+)"/g)].map(m => m[1]));
  const a = ids(first), b = ids(second);
  assert.ok(b.size > 0 && [...b].every(x => !a.has(x)), 'page 2 shows different items');
});
