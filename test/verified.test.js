import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './app-harness.js';
import { freshDb } from './harness.js';
import { buildSampleFeed, writeLedgerlineSample } from '../lib/bankfeed/sample.js';
import { pullCompany } from '../lib/bankfeed/pull.js';
import { linkCompany, saveMappings } from '../lib/data/bankfeeds.js';
import { verifiedMonths, acceptConfident, excludeItems, addItem } from '../lib/data/banking.js';

// Stage B6: ledgerline's verified months — each certified statement's balances, checked against the books, offered as a
// starting point in Reconcile, and flagged when the books disagree.
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
  await pool().query('UPDATE org SET ledgerline_org_id = $1 WHERE org_id = $2', [feed.org, S.orgId]);
  await linkCompany(pool(), ll, { ...S, llEntityId: feed.entities[0].id, actor });
  await pullCompany(pool(), ll, S);
  await saveMappings(pool(), { ...S, actor, choices: [{ id: llId('Operating Checking'), choice: String(A.checking) }, { id: llId('Business Savings'), choice: 'skip' },
    { id: llId('Business Card'), choice: 'skip' }, { id: llId('Equipment Loan'), choice: 'skip' }] });
  await pullCompany(pool(), ll, S);
});
after(async () => { await app.close(); await llDb.drop(); });

const months = () => verifiedMonths(pool(), { ...S, accountId: A.checking });

test('each verified month keeps its statement balances, and the books account for every cent', async () => {
  const m = await months();
  assert.equal(m.length, feed.certifications.length);
  const last = feed.certifications.at(-1);
  assert.equal(m[0].closing, Math.round(Number(last.closing) * 100));
  assert.equal(m[0].periodEnd, new Date(Date.parse(`${last.to}T00:00:00Z`) - 86400000).toISOString().slice(0, 10));
  // Nothing reviewed yet: it's all waiting, nothing is off.
  assert.ok(m.every(x => x.difference === 0), JSON.stringify(m.filter(x => x.difference)));
  assert.ok(m[0].waitingCount > 0);
  // Review: matches move items from waiting to cleared; an excluded item is shown apart. Still nothing off.
  await acceptConfident(pool(), { ...S, llAccountId: llId('Operating Checking'), actor });
  const { rows: fees } = await pool().query(`SELECT item_id FROM bank_feed_item WHERE entity_id = $1 AND description = 'MONTHLY SERVICE FEE' AND review_state = 'new'
    ORDER BY posted_date LIMIT 2`, [S.entityId]);
  await addItem(pool(), { ...S, itemId: fees[0].item_id, lines: [{ accountId: A.bank_fees, amount: '' }], actor });
  await excludeItems(pool(), { ...S, itemIds: [fees[1].item_id], actor });
  const after = await months();
  assert.ok(after.every(x => x.difference === 0));
  assert.ok(after[0].cleared > m[0].cleared - m[0].waiting, 'more cleared now');
  assert.ok(after.some(x => x.excluded === -1500));
});

test('when the books disagree with a verified month, the banking card and Reconcile say so', async () => {
  // Ledgerline's statement for the last verified month says $100 more than the books can explain.
  await ll.query(`UPDATE verify.statement SET closing_balance = closing_balance + 100 WHERE upper(period) = (SELECT max(upper(period)) FROM verify.statement)`);
  await pullCompany(pool(), ll, S);
  const [m] = await months();
  assert.equal(m.difference, 10000);
  let page = await (await app.get('/banking')).text();
  assert.match(page, /Books off by \$100\.00 at /);
  page = await (await app.get('/reconcile')).text();
  assert.match(page, /Verified by ledgerline/);
  assert.match(page, /books off by \$100\.00/);
  const link = new RegExp(`href="/reconcile/start\\?account=${A.checking}&amp;date=${m.periodEnd}&amp;ending=${(m.closing / 100).toFixed(2)}"`);
  assert.match(page, link);
  page = await (await app.get(`/reconcile/start?account=${A.checking}&date=${m.periodEnd}&ending=${(m.closing / 100).toFixed(2)}`)).text();
  assert.match(page, /Ledgerline verified this statement:<\/strong> ending balance/);
  assert.match(page, /The books are off by <strong>\$100\.00<\/strong>/);
  page = await (await app.get(`/reconcile/start?account=${A.checking}&date=${m.periodEnd}&ending=1.00`)).text();
  assert.match(page, /The ending balance entered \(\$1\.00\) isn’t the verified one/);
  // Put it back: the books agree again.
  await ll.query(`UPDATE verify.statement SET closing_balance = closing_balance - 100 WHERE upper(period) = (SELECT max(upper(period)) FROM verify.statement)`);
  await pullCompany(pool(), ll, S);
  assert.equal((await months())[0].difference, 0);
  page = await (await app.get(`/reconcile/start?account=${A.checking}&date=${m.periodEnd}&ending=${(m.closing / 100 - 1).toFixed(2)}`)).text();
  assert.match(page, /bank items? through this date still need review|The books agree/);
});

test('a month already reconciled isn’t offered again', async () => {
  const all = await months();
  const oldest = all.at(-1);
  await pool().query(`INSERT INTO reconciliation (org_id, entity_id, account_id, statement_date, beginning_cents, ending_cents, completed_by)
    VALUES ($1, $2, $3, $4, 0, $5, 'test')`, [S.orgId, S.entityId, A.checking, oldest.periodEnd, oldest.closing]);
  const page = await (await app.get('/reconcile')).text();
  assert.ok(!page.includes(`date=${oldest.periodEnd}&amp;`));
  assert.ok(page.includes(`date=${all[0].periodEnd}&amp;`));
});
