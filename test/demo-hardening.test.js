import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { freshDb } from './harness.js';
import { createApp } from '../services/app/index.js';
import { tooMany, limiterKeys } from '../services/app/http.js';
import { fitBuckets, bucketCount, timeBuckets } from '../lib/reports/periods.js';
import { DEMO_NOTE, DEMO_HEAVY_PER_IP, DEMO_BATCH_MAX, DEMO_FORMS_PER_SESSION, demoBlock } from '../lib/domain/demo.js';
import { demoProblems, resetDemo, appTables, readMarker } from '../lib/data/demo.js';

// The public demo, hardened after review: report work is bounded before it starts and expensive pages are throttled;
// every import (vendors too) is closed; print/send batches take each item once and a few at a time; sessions keep only
// small, well-formed form ids and start afresh after the nightly reset; the reset wipes only the app's own tables and
// refuses foreign data; the running app re-checks its database; and streamed downloads carry the same headers.
const DEMO = { DEMO_MODE: '1', TRUST_PROXY: '1' };
const AS_OF = '2026-10-12';
let db;
const servers = [];
const pool = () => db.pool;
const one = async (sql, args) => (await pool().query(sql, args)).rows[0];
const n = async (sql, args) => Number((await one(sql, args)).n);

async function startDemo(opts = {}) {
  const server = http.createServer(createApp({ pool: pool(), env: DEMO, now: () => new Date(`${AS_OF}T17:00:00Z`), demoCheckMs: 10 * 60_000, ...opts }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
let addr = 0;
function visitor(base) {
  let cookie = '';
  const from = { 'x-forwarded-for': `203.0.113.${++addr}` };
  const keep = res => { const c = (res.headers.getSetCookie?.() ?? []).map(x => x.split(';')[0]).join('; '); if (c) v.cookie = cookie = c; return res; };
  const v = {
    get: path => fetch(base + path, { redirect: 'manual', headers: { cookie, ...from } }).then(keep),
    post: (path, body = []) => {
      const params = new URLSearchParams(body);
      if (!params.has('csrf')) params.set('csrf', v.csrf ?? '');
      return fetch(base + path, { method: 'POST', redirect: 'manual', body: params.toString(),
        headers: { cookie, ...from, 'content-type': 'application/x-www-form-urlencoded' } }).then(keep);
    },
    async start() {
      v.csrf = /name="csrf" value="([0-9a-f]+)"/.exec(await (await v.get('/customers')).text())?.[1];
      return v;
    },
  };
  return v;
}

let base;
before(async () => {
  db = await freshDb();
  await resetDemo(pool(), { env: { DEMO_MODE: '1' }, asOf: AS_OF });
  base = await startDemo();
});
after(async () => {
  for (const s of servers) await new Promise(resolve => s.close(resolve));
  await db.drop();
});

test('P1: column buckets are counted before any are built, so a centuries-wide range by days costs nothing', () => {
  const t = performance.now();
  const r = fitBuckets('days', '1900-01-01', '2199-12-31');
  assert.ok(performance.now() - t < 200, 'fast');
  assert.equal(r.unit, 'years');
  assert.equal(r.buckets.length, 120);
  assert.deepEqual([r.buckets[0].from, r.buckets.at(-1).to], ['2080-01-01', '2199-12-31'], 'the latest 120 years, as before');
  // The count matches what would be built, for every unit, fiscal year start and range.
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 400; i++) {
    const a = new Date(Date.UTC(1990, 0, 1) + rand() * 1.2e12).toISOString().slice(0, 10);
    const b = new Date(Date.parse(a) + rand() * 3e9).toISOString().slice(0, 10);
    const sm = 1 + Math.floor(rand() * 12);
    for (const u of ['days', 'weeks', 'months', 'quarters', 'years']) assert.equal(bucketCount(u, a, b, sm), timeBuckets(u, a, b, sm).length, `${u} ${a} ${b} ${sm}`);
  }
  assert.equal(fitBuckets('months', '2026-01-01', '2026-12-31').buckets.length, 12);
  assert.equal(fitBuckets('days', '2026-01-01', '2026-12-31').unit, 'weeks');
  assert.deepEqual(fitBuckets('days', null, '2026-12-31').buckets, []);
});

test('P1: in the demo a report spans at most about 10 years, and shared report defaults can’t be changed', async () => {
  const v = await visitor(base).start();
  const t = performance.now();
  const res = await v.get('/reports/r/profit_and_loss?run=1&period=custom&from=1900-01-01&to=2199-12-31&columns=days');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /This demo shows at most about 10 years at a time, so the report starts 2189-01-01\./);
  assert.ok(performance.now() - t < 5000, 'not seconds of work');
  const def = await v.post('/reports/r/profit_and_loss/default', [['scope', 'this'], ['q', 'run=1&period=custom&from=1900-01-01&to=2199-12-31&columns=days']]);
  assert.equal(def.status, 403);
  assert.match(await def.text(), /default settings for every visitor is turned off/);
  assert.equal(await n('SELECT count(*) AS n FROM report_default'), 0);
});

test('P1: reports, exports, PDFs and downloads are limited per address, and only a few are built at once', async () => {
  const v = await visitor(base).start();
  let limited = null;
  for (let i = 0; i <= DEMO_HEAVY_PER_IP + 1 && !limited; i++) {
    const res = await v.get(i % 2 ? '/reports' : '/search?q=a');
    if (res.status === 429) limited = await res.text();
  }
  assert.ok(limited, 'the limit kicked in');
  assert.match(limited, /a lot of reports and downloads in a short time/);
  assert.ok(limited.includes(DEMO_NOTE));
  assert.equal((await v.get('/customers')).status, 200, 'ordinary pages still work');
  // Nothing expensive when none may run at once; and the count comes back down after each one (one at a time works).
  const none = await startDemo({ demoHeavyAtOnce: 0 });
  const busy = await visitor(none).get('/reports');
  assert.equal(busy.status, 503);
  assert.match(await busy.text(), /busy building other reports/);
  const single = await startDemo({ demoHeavyAtOnce: 1 });
  const s = visitor(single);
  for (let i = 0; i < 5; i++) assert.equal((await s.get('/reports')).status, 200, `request ${i + 1}`);
  const inv = await one(`SELECT txn_id FROM txn WHERE type = 'invoice' LIMIT 1`);
  assert.equal((await s.get(`/txns/${inv.txn_id}.pdf`)).status, 200);
  assert.equal((await s.get('/export/books.xlsx')).status, 200);
  assert.equal((await s.get('/reports')).status, 200, 'downloads released their slot too');
});

test('P2: every import is closed, the vendor CSV import included', async () => {
  const v = await visitor(base).start();
  const vendors = await n('SELECT count(*) AS n FROM vendor');
  const csv = `Name\n${Array.from({ length: 50 }, (_, i) => `Bulk Vendor ${i}`).join('\n')}`;
  for (const [method, path, body] of [['GET', '/vendors/import'], ['POST', '/vendors/import', [['step', 'import'], ['csv', csv]]], ['POST', '/vendors/import', [['csv', csv]]],
    ['POST', '/import/customers', [['step', 'import'], ['csv', 'Name\nX']]], ['POST', '/import/items', [['step', 'import'], ['csv', 'Name\nX']]],
    ['POST', '/import/accounts', [['step', 'import'], ['csv', 'Name\nX']]]]) {
    const res = method === 'GET' ? await v.get(path) : await v.post(path, body);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.match(await res.text(), /Importing is turned off in this public demo/, `${method} ${path}`);
  }
  assert.equal(await n('SELECT count(*) AS n FROM vendor'), vendors);
});

test('P2: print and send batches take each transaction once, and at most a batch’s worth', async () => {
  const v = await visitor(base).start();
  await pool().query(`UPDATE customer SET email = 'customer' || customer_id || '@example.com' WHERE email IS NULL`);
  const { rows } = await pool().query(`SELECT txn_id FROM txn WHERE type = 'invoice' AND voided_at IS NULL ORDER BY txn_id LIMIT ${DEMO_BATCH_MAX + 5}`);
  assert.equal(rows.length, DEMO_BATCH_MAX + 5);
  const [first] = rows;
  await pool().query('UPDATE txn SET print_later = true, send_later = true WHERE txn_id = $1', [first.txn_id]);
  const pages = buf => (buf.toString('latin1').match(/\/Type \/Page[^s]/g) ?? []).length;
  const alone = await v.post('/sales-queue/print', [['ids', first.txn_id]]);
  assert.equal(alone.status, 200);
  const onePdf = pages(Buffer.from(await alone.arrayBuffer()));
  await pool().query('UPDATE txn SET print_later = true WHERE txn_id = $1', [first.txn_id]);
  const thrice = await v.post('/sales-queue/print', [['ids', first.txn_id], ['ids', first.txn_id], ['ids', first.txn_id]]);
  assert.equal(thrice.status, 200);
  assert.equal(pages(Buffer.from(await thrice.arrayBuffer())), onePdf, 'one copy, not three');
  const messages = () => n('SELECT count(*) AS n FROM message WHERE related_txn_id = $1', [first.txn_id]);
  const before = await messages();
  const sent = await v.post('/sales-queue/send', [['ids', first.txn_id], ['ids', first.txn_id], ['ids', first.txn_id]]);
  assert.equal(sent.status, 303);
  assert.equal(await messages(), before + 1, 'recorded once');
  // More than DEMO_BATCH_MAX selections are refused outright (nothing sent); a full batch is taken in one go.
  const ids = rows.map(r => r.txn_id);
  await pool().query('UPDATE txn SET send_later = true WHERE txn_id = ANY($1)', [ids]);
  const big = await v.post('/sales-queue/send', ids.map(id => ['ids', id]));
  assert.equal(big.status, 403);
  assert.match(await big.text(), new RegExp(`at most ${DEMO_BATCH_MAX} at a time`));
  assert.equal(await n('SELECT count(*) AS n FROM txn WHERE txn_id = ANY($1) AND send_later', [ids]), ids.length);
  const full = await v.post('/sales-queue/send', ids.slice(0, DEMO_BATCH_MAX).map(id => ['ids', id]));
  assert.equal(full.status, 303);
  assert.equal(await n('SELECT count(*) AS n FROM txn WHERE txn_id = ANY($1) AND send_later', [ids]), 5);
});

test('P2: sessions keep only well-formed form ids, a bounded number, and not for pages that don’t exist', async () => {
  const v = await visitor(base).start();
  const customers = () => n(`SELECT count(*) AS n FROM customer WHERE display_name LIKE 'Once Test %'`);
  let k = 0;
  const save = once => v.post('/customers', [['displayName', `Once Test ${++k}`], ['active', '1'], ['form_once', once]]);
  // A huge made-up id isn't remembered (so it can't fill memory): both saves go through.
  const huge = 'x'.repeat(60_000);
  for (let i = 0; i < 2; i++) assert.equal((await save(huge)).status, 303);
  assert.equal(await customers(), 2);
  // A real one is: the second submit is ignored.
  const id = () => Math.random().toString(36).slice(2).padEnd(16, '0').slice(0, 16);
  const once = id();
  for (let i = 0; i < 2; i++) await save(once);
  assert.equal(await customers(), 3);
  // Sent to a page that doesn't exist, it's forgotten again.
  const lost = id();
  assert.equal((await v.post('/no-such-page', [['form_once', lost]])).status, 404);
  await save(lost);
  assert.equal(await customers(), 4);
  // At most DEMO_FORMS_PER_SESSION are kept: the oldest goes first.
  const company = (await one('SELECT entity_id FROM entity')).entity_id;
  const firstId = id();
  const switchWith = token => v.post('/company/switch', [['entity_id', company], ['form_once', token]]);
  assert.equal((await switchWith(firstId)).headers.get('location'), '/home');
  assert.equal((await switchWith(firstId)).headers.get('location'), '/', 'remembered: the repeat is ignored');
  for (let i = 0; i < DEMO_FORMS_PER_SESSION; i++) await switchWith(`${String(i).padStart(4, '0')}abcdefghijkl`);
  assert.equal((await switchWith(firstId)).headers.get('location'), '/home', 'dropped once over the limit');
});

test('P2: the running demo re-checks its database: it stops serving one that isn’t a clean demo, and every session starts afresh after a reset', async () => {
  const watched = await startDemo({ demoCheckMs: 0 });
  const v = visitor(watched);
  assert.equal((await v.get('/customers')).status, 200);
  const cookie = v.cookie;
  assert.equal((await v.get('/customers')).headers.get('set-cookie'), null, 'same session');
  const { org_id: org } = await one('SELECT org_id FROM org');
  await pool().query(`INSERT INTO app_user (org_id, name, email, role) VALUES ($1, 'Ada', 'ada@example.com', 'admin')`, [org]);
  const refused = await v.get('/customers');
  assert.equal(refused.status, 503);
  assert.match(await refused.text(), /The demo isn’t available right now/);
  assert.equal((await fetch(`${watched}/healthz`)).status, 200, 'the health check still answers');
  await pool().query('DELETE FROM app_user');
  assert.equal((await v.get('/customers')).status, 200, 'serving again');
  await resetDemo(pool(), { env: { DEMO_MODE: '1' }, asOf: AS_OF });
  const after = await v.get('/customers');
  assert.equal(after.status, 200);
  assert.match(after.headers.get('set-cookie') ?? '', /fb_session=/, 'a new session after the nightly reset');
  assert.notEqual(v.cookie, cookie);
});

test('P2 operator: the reset empties only the app’s own tables, and refuses data it didn’t make', async () => {
  const known = await appTables();
  assert.ok(known.has('customer') && known.has('audit_log') && !known.has('demo_marker') && !known.has('schema_migrations'));
  // An unrelated table with data: the demo is refused and the reset won't touch it.
  await pool().query(`CREATE TABLE "Other_Data" (note text); INSERT INTO "Other_Data" VALUES ('keep me')`);
  try {
    assert.match((await demoProblems(pool())).join('\n'), /data in a table the app doesn’t make \("Other_Data"\)/);
    await assert.rejects(resetDemo(pool(), { env: { DEMO_MODE: '1' }, asOf: AS_OF }), /holds things a demo never makes[^]*Other_Data[^]*Nothing was changed/);
    assert.equal(await n(`SELECT count(*) AS n FROM "Other_Data"`), 1);
    // Empty, it's left alone: the reset runs and the table is still there, untouched.
    await pool().query(`DELETE FROM "Other_Data"`);
    await resetDemo(pool(), { env: { DEMO_MODE: '1' }, asOf: AS_OF });
    assert.equal(await n(`SELECT count(*) AS n FROM "Other_Data"`), 0);
    // A table of someone else's that refers to the app's tables stops it too (a wipe would have to cascade into it).
    await pool().query('CREATE TABLE other_link (customer_id bigint REFERENCES customer (customer_id))');
    assert.match((await demoProblems(pool())).join('\n'), /a table the app doesn’t make \(other_link\) refers to the app’s tables/);
    await assert.rejects(resetDemo(pool(), { env: { DEMO_MODE: '1' }, asOf: AS_OF }), /other_link/);
  } finally {
    await pool().query('DROP TABLE IF EXISTS other_link; DROP TABLE IF EXISTS "Other_Data"');
  }
  // A mark from a database of the same name on another server (a different internal id) is a copy.
  const marker = await readMarker(pool());
  assert.equal(marker.here, true);
  await pool().query('UPDATE demo_marker SET database_oid = 1');
  try {
    assert.equal((await readMarker(pool())).here, false);
    await assert.rejects(resetDemo(pool(), { env: { DEMO_MODE: '1' }, asOf: AS_OF }), /another database’s demo mark/);
  } finally { await pool().query(`UPDATE demo_marker SET database_oid = (SELECT oid FROM pg_database WHERE datname = current_database())`); }
  assert.deepEqual(await demoProblems(pool()), []);
});

test('P3: a streamed ZIP download carries the same headers as every other response', async () => {
  const v = await visitor(base).start();
  const res = await v.get('/export/documents.zip');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  await res.arrayBuffer();
});

test('shared settings and reconciliation history stay as the sample has them; the limiter’s memory is bounded', async () => {
  const v = await visitor(base).start();
  for (const path of ['/settings/accounting', '/settings/sales', '/settings/messages', '/settings/form-styles', '/settings/currencies/on', '/reconcile/1/undo']) {
    const res = await v.post(path, [['x', '1']]);
    assert.equal(res.status, 403, path);
    assert.match(await res.text(), /turned off in this public demo/, path);
  }
  for (const path of ['/settings/accounting', '/settings/sales', '/settings/form-styles']) assert.equal((await v.get(path)).status, 200, `can look at ${path}`);
  assert.equal(demoBlock('POST', '/settings/terms'), null, 'lists stay editable');
  // Many distinct keys never grow the limiter past its cap.
  for (let i = 0; i < 60_000; i++) tooMany(`flood:${i}`, 5);
  assert.ok(limiterKeys() <= 50_000, String(limiterKeys()));
});

// ---- second review round (codex-demo-review-2) ----

test('round 2: a management package renders at most a few sections, each over a bounded span', async () => {
  const { managementPdf } = await import('../lib/reports/management.js');
  const { DEMO_MGMT_SECTIONS, DEMO_REPORT_YEARS } = await import('../lib/domain/demo.js');
  const { rows: [e] } = await pool().query('SELECT org_id, entity_id FROM entity ORDER BY entity_id LIMIT 1');
  const mgmt = { name: 'Thirty ledgers', period: 'all', basis: 'accrual', cover_title: null, intro: null, closing: null, prepared_by: null,
    sections: Array.from({ length: 30 }, () => ({ key: 'general_ledger', query: '', title: '', note: '' })) };
  const r = await managementPdf(pool(), { orgId: Number(e.org_id), entityId: Number(e.entity_id), mgmt, today: AS_OF, timeZone: 'America/Chicago',
    maxSections: DEMO_MGMT_SECTIONS, maxYears: DEMO_REPORT_YEARS });
  assert.equal(r.sections, DEMO_MGMT_SECTIONS);
});

test('round 2: every print, send and batch action refuses more than a batch’s worth of selections', async () => {
  const v = await visitor(base).start();
  const { rows: [c] } = await pool().query('SELECT customer_id FROM customer ORDER BY customer_id LIMIT 1');
  const many = Array.from({ length: DEMO_BATCH_MAX + 1 }, (_, i) => ['ids', String(i + 1)]);
  for (const path of [`/customers/${c.customer_id}/batch`, '/vendors/batch', '/vtxns/batch', '/checks/print', '/sales-queue/print', '/sales-queue/send']) {
    const res = await v.post(path, many);
    assert.equal(res.status, 403, path);
    assert.match(await res.text(), new RegExp(`at most ${DEMO_BATCH_MAX} at a time`), path);
  }
});

test('round 2: a table anywhere that inherits from the app’s stops the demo and the reset, and is never emptied', async () => {
  await pool().query(`CREATE SCHEMA review_extra; CREATE TABLE review_extra.customer_archive () INHERITS (public.customer)`);
  try {
    assert.match((await demoProblems(pool())).join('\n'), /tables inherit from the app’s \(review_extra\.customer_archive\)/);
    await assert.rejects(resetDemo(pool(), { env: { DEMO_MODE: '1' }, asOf: AS_OF }), /customer_archive/);
  } finally { await pool().query('DROP SCHEMA review_extra CASCADE'); }
  assert.deepEqual(await demoProblems(pool()), []);
});

// ---- third review round (codex-demo-review-3) ----

test('round 3: "All dates" reports start at the demo’s span limit too', async () => {
  const v = await visitor(base).start();
  const res = await v.get('/reports/r/general_ledger?period=all&run=1');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /This demo shows at most about \d+ years at a time, so the report starts \d{4}-01-01\./);
});

test('round 3: visitors who hang up while the demo re-checks its database don’t use up the report slots', async () => {
  const fresh = await startDemo(); // a new app: its first request runs the database check
  const hold = await pool().connect();
  try {
    await hold.query('BEGIN');
    await hold.query('LOCK TABLE demo_marker IN ACCESS EXCLUSIVE MODE'); // the check waits on this
    const aborts = [];
    for (let i = 0; i < 4; i++) {
      const ctl = new AbortController();
      aborts.push(fetch(`${fresh}/reports/r/profit_and_loss?run=1`, { signal: ctl.signal, headers: { 'x-forwarded-for': `198.51.100.${i + 1}` } }).catch(() => null));
      setTimeout(() => ctl.abort(), 150);
    }
    await Promise.all(aborts);
    await new Promise(resolve => setTimeout(resolve, 200));
  } finally {
    await hold.query('COMMIT');
    hold.release();
  }
  await new Promise(resolve => setTimeout(resolve, 500));
  const v = await visitor(fresh).start();
  for (let i = 0; i < 3; i++) assert.equal((await v.get('/reports/r/profit_and_loss?run=1')).status, 200, `report ${i + 1} after the hang-ups`);
});

// ---- the features ported from the private books: bank review v2/v3, Loans, card credit, Tax Books ----

test('ported: AI research, bank-line files, rules import and tax parties are closed in the demo; the new pages still work', async () => {
  const v = await visitor(base).start();
  const { entity_id: company } = await one('SELECT entity_id FROM entity ORDER BY entity_id LIMIT 1');
  for (const [method, path, why] of [
    ['POST', '/banking/item/1/research', /AI research is turned off/], ['POST', '/banking/research/1/accept', /AI research is turned off/],
    ['POST', '/banking/research/1/reject', /AI research is turned off/], ['POST', '/banking/item/1/attach', /File uploads is turned off/],
    ['POST', '/banking/item/1/attachment/2/delete', /File uploads is turned off/], ['GET', '/banking/rules/import', /Importing is turned off/],
    ['POST', '/banking/rules/import', /Importing is turned off/], ['POST', `/tax/${company}/parties`, /Tax parties and tax ids is turned off/],
  ]) {
    const res = method === 'GET' ? await v.get(path) : await v.post(path, [['kind', 'individual'], ['name', 'Visitor Person'], ['tax_id', '123-45-6789']]);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.match(await res.text(), why, `${method} ${path}`);
  }
  assert.equal(await n('SELECT count(*) AS n FROM tax_party'), 0);
  for (const path of ['/banking', '/banking/rules', '/loans', '/tax', `/tax/${company}/profile`, '/vendors?show=contractors']) assert.equal((await v.get(path)).status, 200, path);
  assert.equal(demoBlock('POST', `/tax/${company}/profile`), null, 'the tax profile stays editable');
  assert.equal(demoBlock('POST', '/loans/pay'), null, 'loan payments stay possible');
});

test('ported: a bank review batch, "all N matching" included, takes at most a batch’s worth', async () => {
  const v = await visitor(base).start();
  const res = await v.post('/banking/batch', [['account', 'x'], ['all', `exclude:${DEMO_BATCH_MAX + 1}`]]);
  assert.equal(res.status, 403);
  assert.match(await res.text(), new RegExp(`at most ${DEMO_BATCH_MAX} at a time`));
  const ticked = await v.post('/banking/batch', Array.from({ length: DEMO_BATCH_MAX + 1 }, (_, i) => ['item', String(i + 1)]));
  assert.equal(ticked.status, 403);
  assert.notEqual((await v.post('/banking/batch', [['account', 'x'], ['all', 'exclude:3']])).status, 403, 'a few are fine (no such account here)');
});

test('ported: tracking vendors for 1099s takes at most a batch’s worth in the demo (Codex starter-port r1 B1)', async () => {
  const v = await visitor(base).start();
  const ids = (await pool().query('SELECT vendor_id FROM vendor ORDER BY vendor_id')).rows.map(r => String(r.vendor_id));
  const list = k => Array.from({ length: k }, (_, i) => ['vendor', ids[i % ids.length] ?? String(900000 + i)]);
  const tracked = async () => n('SELECT count(*) AS n FROM vendor WHERE track_1099');
  const before = await tracked();
  const res = await v.post('/vendors/1099/track', [['year', '2026'], ...list(DEMO_BATCH_MAX + 1)]);
  assert.equal(res.status, 403);
  assert.match(await res.text(), new RegExp(`at most ${DEMO_BATCH_MAX} at a time`));
  assert.equal(await tracked(), before, 'nothing changed');
  assert.equal((await v.post('/vendors/1099/track', [['year', '2026'], ...list(DEMO_BATCH_MAX)])).status, 303, 'a full batch is taken');
});

test('ported: imported tax baselines are something a demo never has, and the baseline import refuses the demo', async () => {
  const other = await freshDb();
  try {
    await resetDemo(other.pool, { env: { DEMO_MODE: '1' }, asOf: AS_OF });
    assert.deepEqual(await demoProblems(other.pool), []);
    const { org_id: orgId, entity_id: entityId } = (await other.pool.query('SELECT org_id, entity_id FROM entity ORDER BY entity_id LIMIT 1')).rows[0];
    const { saveProfile } = await import('../lib/tax/periods.js');
    const { importBaseline } = await import('../lib/tax/baselines.js');
    await saveProfile(other.pool, { orgId, entityId, fields: { returnType: 'form_1065', taxMethodDefault: 'cash', bookBasisDefault: 'accrual', yearEndMonth: 12 }, reason: 'setup', actor: 'tester' });
    await importBaseline(other.pool, { orgId, entityId, actor: 'tester', payload: {
      importKey: 'filed-2025-sample', payloadVersion: 1, kind: 'imported_filed', returnType: 'form_1065', formEdition: 2025, bookBasis: 'accrual', consolidationPolicy: 'inclusion_edges',
      sourcePeriodStart: '2025-01-01', sourcePeriodEnd: '2025-12-31', sourceDocument: { hash: 'sha256:abc', pages: '1-4' }, extractionStatus: 'verified',
      facts: [{ factKind: 'schedule_l_end', fieldId: 'f1065.L.1', measurement: 'end', effectiveOn: '2025-12-31', amountCents: '125000', state: 'known', provenance: {}, reviewStatus: 'verified' }] } });
    assert.match((await demoProblems(other.pool)).join('\n'), /imported tax baselines/);
  } finally { await other.drop(); }

  // The command line: refused with DEMO_MODE=1, and refused on a demo database without it; nothing imported either way.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'fb-demo-baseline-'));
  try {
    const file = join(dir, 'payload.json');
    await writeFile(file, '{"facts":[]}');
    const { entity_id: entityId } = await one('SELECT entity_id FROM entity ORDER BY entity_id LIMIT 1');
    const envOf = more => ({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DATABASE_URL: db.url, ALLOW_SUPERUSER: '1', ...more });
    const run = (script, args, more) => promisify(execFile)(process.execPath, [script, ...args], { env: envOf(more) });
    await assert.rejects(run('scripts/tax-baseline-import.mjs', ['sample', String(entityId), file], { DEMO_MODE: '1' }), e => e.code === 1 && /doesn’t run with DEMO_MODE=1/.test(e.stderr));
    await assert.rejects(run('scripts/tax-baseline-import.mjs', ['sample', String(entityId), file], {}), e => e.code === 1 && /public demo/.test(e.stderr));
    await assert.rejects(run('scripts/repair-bank-dims.js', ['--apply'], {}), e => e.code !== 0 && /public demo/.test(e.stderr));
    assert.equal(await n('SELECT count(*) AS n FROM tax_baseline'), 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
