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

test('Morning demo: settings writes are blocked and the sample owner is the only viewer', async () => {
  const other = await freshDb();
  try {
    await resetDemo(other.pool, { env: DEMO, asOf: AS_OF });
    const b = await startDemo({ pool: other.pool, demoCheckMs: 0 });
    const v = await visitor(b).start();
    const page = await v.get('/morning');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /First look/);
    assert.equal((await v.get('/settings/morning')).status, 200);
    const state = async () => {
      const result = {};
      for (const table of ['morning_viewer', 'morning_preference', 'morning_delivery_setting', 'morning_transport', 'morning_message_claim'])
        result[table] = (await other.pool.query(`SELECT * FROM ${table}`)).rows;
      return result;
    };
    const initial = await state();
    assert.deepEqual(initial.morning_viewer.map(r => [r.viewer_key, r.enrollment_state]), [['owner', 'ready']]);
    for (const action of ['viewer', 'delivery', 'transport-approve', 'preferences']) {
      const path = `/settings/morning/${action}`;
      assert.equal(demoBlock('POST', path), 'Morning messages and viewer changes are off in the demo');
      assert.equal(demoBlock('GET', path), null);
      const response = await v.post(path, { action: 'grant', user_id: '1', enabled: '1', channel: 'sms' });
      assert.equal(response.status, 403, path);
      assert.match(await response.text(), /Morning messages and viewer changes are off in the demo/);
    }
    assert.deepEqual(await state(), initial, 'blocked settings change no Morning state');
    assert.deepEqual(await demoProblems(other.pool), []);
    await resetDemo(other.pool, { env: DEMO, asOf: AS_OF });
    const next = await visitor(b).start();
    const resetPage = await next.get('/morning');
    assert.equal(resetPage.status, 200, 'the running demo restores its owner viewer after nightly reset');
    assert.match(await resetPage.text(), /First look/);
    assert.deepEqual((await state()).morning_viewer.map(r => r.viewer_key), ['owner']);
  } finally { await other.drop(); }
});

test('Morning demo: the message runner returns before any database or provider work', async () => {
  const { runMorningMessages } = await import('../lib/data/morning/messages.js');
  const noDatabase = new Proxy({}, { get() { assert.fail('demo messages must not touch the database'); } });
  assert.deepEqual(await runMorningMessages({ pool: noDatabase, env: DEMO }), { demo: true });
  assert.deepEqual(await runMorningMessages({ pool: noDatabase, env: { ...DEMO, BOOKS_MODE: 'practice' } }), { demo: true });
});

test('Morning demo: sample and probe helpers refuse demo mode and a marked database before writes', async () => {
  const { seedMorningScenario } = await import('../scripts/morning-sample.mjs');
  const { prepareProbe, seedProbe } = await import('../scripts/morning-probe.mjs');
  let writes = 0;
  const guarded = { query: (sql, args) => {
    if (/\b(?:TRUNCATE|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(typeof sql === 'string' ? sql : sql.text)) {
      writes++;
      throw new Error('Unexpected write before demo refusal');
    }
    return pool().query(sql, args);
  } };
  const clock = { now: () => new Date(), set() { assert.fail('sample must not change the clock'); } };
  const sample = env => seedMorningScenario({ url: db.url, pool: guarded }, { scenario: 'first-look', clock,
    env: { NODE_ENV: 'test', DATABASE_URL: db.url, ...env } });
  await assert.rejects(sample(DEMO), /doesn’t run with DEMO_MODE=1/);
  await assert.rejects(sample({}), /public demo/);
  for (const fn of [prepareProbe, seedProbe]) {
    await assert.rejects(fn(guarded, { env: DEMO }), /doesn’t run with DEMO_MODE=1/);
    await assert.rejects(fn(guarded, { env: {} }), /public demo/);
  }
  assert.equal(writes, 0);
});

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
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(import.meta.dirname, 'fb-demo-baseline-'));
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

// ---- Tax Books T2, ported: the party directory and EIN settlement, "Accept all sure", the reconcile CLI, the reset ----

test('ported T2: the party directory and settling an EIN conflict are closed in the demo; the mapping AI routes are closed too', async () => {
  const v = await visitor(base).start();
  const { entity_id: company } = await one('SELECT entity_id FROM entity ORDER BY entity_id LIMIT 1');
  for (const [path, body, why] of [
    ['/tax/parties', [['kind', 'individual'], ['name', 'Visitor Person'], ['tax_id', '123-45-6789']], /Tax parties and tax ids is turned off/],
    [`/tax/${company}/parties/1/ein`, [['evidence_id', '1'], ['keep', 'party']], /Tax parties and tax ids is turned off/],
    [`/tax/${company}/2026/mapping/ai`, [], /AI help is turned off/],
    [`/tax/${company}/2026/mapping/ai-accept`, [], /AI help is turned off/],
    [`/tax/${company}/2026/mapping/ai-reject`, [], /AI help is turned off/],
  ]) {
    const res = await v.post(path, body);
    assert.equal(res.status, 403, path);
    assert.match(await res.text(), why, path);
  }
  assert.equal((await v.get(`/tax/${company}/2026/mapping/ai`)).status, 403, 'the AI routes are closed for reading too');
  assert.equal(await n('SELECT count(*) AS n FROM tax_party'), 0);
  assert.equal(await n('SELECT count(*) AS n FROM tax_party_tax_id_evidence'), 0);
  assert.equal(await n('SELECT count(*) AS n FROM entity WHERE ein_enc IS NOT NULL'), 0);
  // Reading the directory stays open, and so do a company's owners and its mapping actions.
  assert.equal((await v.get('/tax/parties')).status, 200);
  for (const p of [`/tax/${company}/interests`, `/tax/${company}/2026/mapping/bind`, `/tax/${company}/2026/mapping/accept-sure`]) assert.equal(demoBlock('POST', p), null, p);
});

test('ported T2: "Accept all sure" takes at most a batch’s worth of suggestions in the demo', async () => {
  const v = await visitor(base).start();
  const { entity_id: company } = await one('SELECT entity_id FROM entity ORDER BY entity_id LIMIT 1');
  const sure = k => Array.from({ length: k }, (_, i) => ['sure', `decision-${i}`]);
  const res = await v.post(`/tax/${company}/2026/mapping/accept-sure`, sure(DEMO_BATCH_MAX + 1));
  assert.equal(res.status, 403);
  assert.match(await res.text(), new RegExp(`at most ${DEMO_BATCH_MAX} at a time`));
  assert.notEqual((await v.post(`/tax/${company}/2026/mapping/accept-sure`, sure(DEMO_BATCH_MAX))).status, 403, 'a full batch reaches the page (no period here)');
});

test('ported T2: the own-company EIN reconcile refuses the demo, with DEMO_MODE=1 or on a demo database', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const envOf = more => ({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DATABASE_URL: db.url, ALLOW_SUPERUSER: '1', ...more });
  const run = more => promisify(execFile)(process.execPath, ['scripts/tax-reconcile-own-tax-ids.mjs', 'sample'], { env: envOf(more) });
  await assert.rejects(run({ DEMO_MODE: '1' }), e => e.code === 1 && /doesn’t run with DEMO_MODE=1/.test(e.stderr));
  await assert.rejects(run({}), e => e.code === 1 && /public demo/.test(e.stderr));
  assert.equal(await n('SELECT count(*) AS n FROM tax_party WHERE own_tax_id_state IS NOT NULL'), 0);
  assert.equal(await n('SELECT count(*) AS n FROM entity WHERE ein_enc IS NOT NULL'), 0);
});

test('ported T2: the nightly reset empties every table migration 065 makes', async () => {
  const t2Tables = ['ownership_interest', 'tax_binding_default', 'tax_binding', 'tax_binding_line', 'tax_binding_suggestion', 'tax_party_tax_id_evidence'];
  const known = await appTables();
  for (const t of t2Tables) assert.ok(known.has(t), `${t} is one of the app's tables`);
  const other = await freshDb();
  try {
    await resetDemo(other.pool, { env: { DEMO_MODE: '1' }, asOf: AS_OF });
    const { org_id: orgId, entity_id: entityId } = (await other.pool.query('SELECT org_id, entity_id FROM entity ORDER BY entity_id LIMIT 1')).rows[0];
    const scope = { orgId: Number(orgId), entityId: Number(entityId) };
    const { saveProfile, openPeriod } = await import('../lib/tax/periods.js');
    const { saveParty } = await import('../lib/tax/parties.js');
    const { saveInterest } = await import('../lib/tax/ownership.js');
    const { saveBindings } = await import('../lib/tax/bindings.js');
    await saveProfile(other.pool, { ...scope, fields: { returnType: 'form_1065', taxMethodDefault: 'cash', bookBasisDefault: 'accrual', yearEndMonth: 12 }, reason: 'setup', actor: 'tester' });
    const returnId = Number(await openPeriod(other.pool, { ...scope, year: 2025, actor: 'tester' }));
    const partyId = Number(await saveParty(other.pool, { orgId: scope.orgId, fields: { kind: 'individual', name: 'Pat Sample', taxId: '' }, env: {} }));
    await saveInterest(other.pool, { ...scope, fields: { partyId, role: 'general_partner', from: '2025-01-01', profit: '1/1', loss: '1/1', capital: '1/1' }, actor: 'tester' });
    const { account_id: accountId } = (await other.pool.query(`SELECT account_id FROM account WHERE org_id = $1 AND entity_id = $2 AND type = 'expense' ORDER BY account_id LIMIT 1`, [orgId, entityId])).rows[0];
    await saveBindings(other.pool, { ...scope, returnId, sourceEntityId: scope.entityId, accountId: Number(accountId), measurement: 'activity', makeDefault: true, actor: 'tester',
      rows: [{ treatment: 'statement_row', destination: 'f1065.p1.21', rowLabel: 'Sample costs' }] });
    const counts = async () => Object.fromEntries(await Promise.all(t2Tables.map(async t => [t, Number((await other.pool.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n)])));
    const was = await counts();
    assert.ok(was.ownership_interest > 0 && was.tax_binding > 0 && was.tax_binding_default > 0, JSON.stringify(was));
    assert.deepEqual(await demoProblems(other.pool), [], 'a visitor’s T2 work is still a clean demo');
    await resetDemo(other.pool, { env: { DEMO_MODE: '1' }, asOf: AS_OF });
    assert.deepEqual(await counts(), Object.fromEntries(t2Tables.map(t => [t, 0])));
  } finally { await other.drop(); }
});

// ---- Tax Books T2, Codex starter-port-t2 r1: copying company defaults is held to a batch's worth too ----

// A separate demo database with its own demo app, for the tests that build tax mappings (the shared one stays as the sample has it).
async function taxDemo() {
  const other = await freshDb();
  await resetDemo(other.pool, { env: { DEMO_MODE: '1' }, asOf: AS_OF });
  const server = http.createServer(createApp({ pool: other.pool, env: DEMO, now: () => new Date(`${AS_OF}T17:00:00Z`), demoCheckMs: 10 * 60_000 }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const { org_id: orgId, entity_id: entityId } = (await other.pool.query('SELECT org_id, entity_id FROM entity ORDER BY entity_id LIMIT 1')).rows[0];
  const scope = { orgId: Number(orgId), entityId: Number(entityId) };
  const q = async (sql, args) => Number((await other.pool.query(sql, args)).rows[0].n);
  const { saveProfile } = await import('../lib/tax/periods.js');
  await saveProfile(other.pool, { ...scope, fields: { returnType: 'form_1065', taxMethodDefault: 'accrual', bookBasisDefault: 'accrual', yearEndMonth: 12 }, reason: 'setup', actor: 'tester' });
  return { other, scope, q, base: `http://127.0.0.1:${server.address().port}` };
}
// New accounts of one type in the demo's sample company; returns their ids in creation order.
async function newAccounts(pool, scope, prefix, type, k) {
  const { saveAccount } = await import('../lib/data/ledger.js');
  const ids = [];
  for (let i = 0; i < k; i++) {
    const name = `${prefix} ${String(i + 1).padStart(2, '0')}`;
    await saveAccount(pool, { ...scope, fields: { name, number: '', type, parentId: '', description: '', active: true } });
    ids.push(Number((await pool.query('SELECT account_id FROM account WHERE org_id = $1 AND entity_id = $2 AND name = $3', [scope.orgId, scope.entityId, name])).rows[0].account_id));
  }
  return ids;
}
const setsOf = (q, returnId) => q('SELECT count(*) AS n FROM (SELECT DISTINCT source_entity_id, account_id, measurement FROM tax_binding WHERE return_id = $1) s', [returnId]);
const returnOf = async (pool, scope, year) => Number((await pool.query('SELECT return_id FROM tax_return WHERE org_id = $1 AND entity_id = $2 AND period_end = $3::date',
  [scope.orgId, scope.entityId, `${year}-12-31`])).rows[0].return_id);
const flashAfter = async (v, res) => (await (await v.get(new URL(res.headers.get('location'), 'http://x').pathname)).text());

test('r1 B1: opening a period and "Copy the company defaults" copy at most a batch’s worth of mapping sets in the demo; copying again finishes', async () => {
  const { other, scope, q, base: b } = await taxDemo();
  try {
    const { openPeriod } = await import('../lib/tax/periods.js');
    const { saveBindings, copyForward } = await import('../lib/tax/bindings.js');
    const r25 = Number(await openPeriod(other.pool, { ...scope, year: 2025, actor: 'tester' }));
    const r27 = Number(await openPeriod(other.pool, { ...scope, year: 2027, actor: 'tester' })); // opened before any default exists: unmapped
    // DEMO_BATCH_MAX + 1 reusable company defaults, each a whole account/measurement set.
    const ids = await newAccounts(other.pool, scope, 'Demo cost', 'expense', DEMO_BATCH_MAX + 1);
    for (const [i, accountId] of ids.entries()) {
      await saveBindings(other.pool, { ...scope, returnId: r25, sourceEntityId: scope.entityId, accountId, measurement: 'activity', makeDefault: true, actor: 'tester',
        rows: [{ treatment: 'statement_row', destination: 'f1065.p1.21', rowLabel: `Demo cost ${i + 1}` }] });
    }
    assert.equal(await q('SELECT count(*) AS n FROM tax_binding_default'), DEMO_BATCH_MAX + 1);
    const postings = await q('SELECT count(*) AS n FROM posting');
    const v = await visitor(b).start();

    // Opening a period copies the defaults automatically: the first DEMO_BATCH_MAX, in account order; the visitor is told what is left.
    const opened = await v.post(`/tax/${scope.entityId}/periods`, [['year', '2026']]);
    assert.equal(opened.status, 303);
    assert.match(await flashAfter(v, opened), new RegExp(`at most ${DEMO_BATCH_MAX} company defaults at a time: 1 more is left unmapped`));
    const r26 = await returnOf(other.pool, scope, 2026);
    assert.equal(await setsOf(q, r26), DEMO_BATCH_MAX);
    assert.equal(await q('SELECT count(*) AS n FROM tax_binding WHERE return_id = $1 AND account_id = $2', [r26, ids.at(-1)]), 0, 'the last account in order is the one left');
    // The rest are copied from the mapping page.
    const more = await v.post(`/tax/${scope.entityId}/2026/mapping/copy-forward`);
    assert.equal(more.status, 303);
    assert.match(await flashAfter(v, more), /Copied 1 mapping from the company defaults\./);
    assert.equal(await setsOf(q, r26), DEMO_BATCH_MAX + 1);

    // The explicit copy into a period that has none: DEMO_BATCH_MAX, then the last one, then nothing more.
    const first = await v.post(`/tax/${scope.entityId}/2027/mapping/copy-forward`);
    assert.equal(first.status, 303);
    assert.match(await flashAfter(v, first), new RegExp(`Copied ${DEMO_BATCH_MAX} mappings from the company defaults\\. This demo copies at most ${DEMO_BATCH_MAX} accounts at a time: 1 more is left unmapped — copy again to continue\\.`));
    assert.equal(await setsOf(q, r27), DEMO_BATCH_MAX);
    const second = await v.post(`/tax/${scope.entityId}/2027/mapping/copy-forward`);
    assert.match(await flashAfter(v, second), /Copied 1 mapping from the company defaults\.(?! This demo)/);
    assert.equal(await setsOf(q, r27), DEMO_BATCH_MAX + 1);
    const third = await v.post(`/tax/${scope.entityId}/2027/mapping/copy-forward`);
    assert.match(await flashAfter(v, third), /Copied 0 mappings/);
    assert.equal(await setsOf(q, r27), DEMO_BATCH_MAX + 1);
    assert.equal(await q('SELECT count(*) AS n FROM posting'), postings, 'the ledger is untouched');
    assert.deepEqual(await demoProblems(other.pool), []);

    // Outside the demo nothing changed: one copy takes every default.
    const { rows: [{ return_id: r28 }] } = await other.pool.query(`INSERT INTO tax_return (org_id, entity_id, period_start, period_end, return_type, form_edition, tax_method, book_basis)
      VALUES ($1, $2, '2028-01-01', '2028-12-31', 'form_1065', 2028, 'accrual', 'accrual') RETURNING return_id`, [scope.orgId, scope.entityId]);
    const all = await copyForward(other.pool, { ...scope, returnId: r28, actor: 'tester' });
    assert.deepEqual([all.sets, all.left], [DEMO_BATCH_MAX + 1, 0]);
  } finally { await other.drop(); }
});

test('r1 B1: including books copies at most the limit (one budget shared by every return it reaches); a whole split set is never cut', async () => {
  const { t2Db, company, acct, period, activity } = await import('./tax-t2-fixtures.js');
  const { includeBooks } = await import('../lib/tax/activities.js');
  const { saveBindings, copyForward } = await import('../lib/tax/bindings.js');
  const t = await t2Db();
  try {
    const P = { orgId: t.orgId, entityId: await company(t.pool, t.orgId, 'Cap Partners') };
    const D = { orgId: t.orgId, entityId: await company(t.pool, t.orgId, 'Cap Single LLC') };
    const p25 = await period(t.pool, P, 2025), p26 = await period(t.pool, P, 2026);
    await period(t.pool, D, 2025, 'disregarded'); await period(t.pool, D, 2026, 'disregarded');
    const act = await activity(t.pool, P, { name: 'Cap trade' });
    await includeBooks(t.pool, { ...P, returnId: p25, activityId: act, sourceEntityId: D.entityId, approvedBy: 'tester' });
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(await acct(t.pool, D, `Cap cost ${i + 1}`, 'expense'));
    // The first set is a two-row split: it counts as one set and is copied whole.
    await saveBindings(t.pool, { ...P, returnId: p25, sourceEntityId: D.entityId, accountId: ids[0], measurement: 'activity', split: 'shares', makeDefault: true, actor: 'tester',
      rows: [{ treatment: 'statement_row', destination: 'f1065.p1.21', rowLabel: 'Cap A', share: '1/2', activityId: act }, { treatment: 'input', destination: 'f1065.p1.13', share: '1/2', activityId: act }] });
    for (const id of ids.slice(1)) await saveBindings(t.pool, { ...P, returnId: p25, sourceEntityId: D.entityId, accountId: id, measurement: 'activity', makeDefault: true, actor: 'tester',
      rows: [{ treatment: 'statement_row', destination: 'f1065.p1.21', rowLabel: `Cap ${id}`, activityId: act }] });
    const report = {};
    await includeBooks(t.pool, { ...P, returnId: p26, activityId: act, sourceEntityId: D.entityId, approvedBy: 'tester', report, maxSets: 2 });
    assert.deepEqual([report.sets, report.left], [2, 2]);
    const rows = (await t.pool.query('SELECT account_id FROM tax_binding WHERE return_id = $1 ORDER BY account_id', [p26])).rows.map(r => Number(r.account_id));
    assert.deepEqual(rows, [ids[0], ids[0], ids[1]], 'the split set whole, then the next account');
    const rest = await copyForward(t.pool, { ...P, returnId: p26, actor: 'tester', maxSets: 2 });
    assert.deepEqual([rest.sets, rest.left], [2, 0]);
  } finally { await t.db.drop(); }
});

test('r1 note 2-3: "Accept all sure" offers the first batch’s worth of real decisions in the demo; those succeed, one more is refused untouched', async () => {
  const { other, scope, q, base: b } = await taxDemo();
  try {
    const { openPeriod } = await import('../lib/tax/periods.js');
    const { coverage } = await import('../lib/tax/coverage.js');
    const { suggestionsFor } = await import('../lib/tax/suggest.js');
    const { saveJournalEntry } = await import('../lib/data/ledger-tools.js');
    const returnId = Number(await openPeriod(other.pool, { ...scope, year: 2026, actor: 'tester' }));
    // Bank accounts with balances: each one's beginning and ending balance is a sure Schedule L suggestion.
    const banks = await newAccounts(other.pool, scope, 'Demo bank', 'bank', 16);
    const [equity] = await newAccounts(other.pool, scope, 'Demo capital', 'equity', 1);
    await saveJournalEntry(other.pool, { ...scope, txnId: null, actor: 'tester', txnDate: '2025-12-01', docNumber: '', memo: 'Demo balances',
      lines: [...banks.map(id => ({ accountId: String(id), debit: '100.00', credit: '', description: '' })), { accountId: String(equity), debit: '', credit: (banks.length * 100).toFixed(2), description: '' }] });
    const v = await visitor(b).start();
    const page = await (await v.get(`/tax/${scope.entityId}/2026/mapping`)).text();
    const shown = [...page.matchAll(/name="sure" value="([^"]+)"/g)].map(m => m[1].replace(/&amp;/g, '&'));
    const all = (await suggestionsFor(other.pool, { orgId: scope.orgId, cov: await coverage(other.pool, { ...scope, returnId }), companyIds: [scope.entityId] })).filter(s => s.sure).map(s => s.decision);
    assert.ok(all.length > DEMO_BATCH_MAX, `${all.length} sure suggestions`);
    assert.deepEqual(shown, all.slice(0, DEMO_BATCH_MAX), 'the form sends the first batch’s worth, in page order');
    assert.match(page, new RegExp(`This demo accepts at most ${DEMO_BATCH_MAX} at a time`));
    assert.match(page, new RegExp(`Accept the first ${DEMO_BATCH_MAX} sure`));
    const counts = async () => [await q('SELECT count(*) AS n FROM tax_binding'), await q('SELECT count(*) AS n FROM tax_binding_default'), await q('SELECT count(*) AS n FROM tax_binding_suggestion')];
    // One real decision more than the limit: refused, nothing written.
    const over = await v.post(`/tax/${scope.entityId}/2026/mapping/accept-sure`, all.slice(0, DEMO_BATCH_MAX + 1).map(k => ['sure', k]));
    assert.equal(over.status, 403);
    assert.deepEqual(await counts(), [0, 0, 0]);
    // The form as the page rendered it: every one accepted.
    const ok = await v.post(`/tax/${scope.entityId}/2026/mapping/accept-sure`, shown.map(k => ['sure', k]));
    assert.equal(ok.status, 303);
    assert.match(await flashAfter(v, ok), new RegExp(`Accepted ${DEMO_BATCH_MAX} sure suggestions\\.`));
    assert.deepEqual(await counts(), [DEMO_BATCH_MAX, DEMO_BATCH_MAX, DEMO_BATCH_MAX]);
  } finally { await other.drop(); }
});

test('r1 note 3: the reset empties line attributions and suggestions too, and refuses (never wipes) a stored EIN candidate', async () => {
  const { other, scope, q } = await taxDemo();
  try {
    const { openPeriod } = await import('../lib/tax/periods.js');
    const { attributeLine } = await import('../lib/tax/bindings.js');
    const { acceptSuggestion, suggestionsFor } = await import('../lib/tax/suggest.js');
    const { coverage } = await import('../lib/tax/coverage.js');
    const { saveJournalEntry } = await import('../lib/data/ledger-tools.js');
    const { saveParty } = await import('../lib/tax/parties.js');
    const returnId = Number(await openPeriod(other.pool, { ...scope, year: 2026, actor: 'tester' }));
    const [cost] = await newAccounts(other.pool, scope, 'Demo line cost', 'expense', 1);
    const [bank] = await newAccounts(other.pool, scope, 'Demo line bank', 'bank', 1);
    const txnId = await saveJournalEntry(other.pool, { ...scope, txnId: null, actor: 'tester', txnDate: '2026-03-01', docNumber: '', memo: 'Demo line',
      lines: [{ accountId: String(cost), debit: '50.00', credit: '', description: '' }, { accountId: String(bank), debit: '', credit: '50.00', description: '' }] });
    const { line_no: lineNo } = (await other.pool.query('SELECT line_no FROM posting WHERE txn_id = $1 AND account_id = $2', [txnId, cost])).rows[0];
    await attributeLine(other.pool, { ...scope, returnId, sourceEntityId: scope.entityId, accountId: cost, txnId, lineNo, expectTxnVersion: (await other.pool.query('SELECT txn_version($1) AS v', [txnId])).rows[0].v, target: { treatment: 'statement_row', destination: 'f1065.p1.21', rowLabel: 'Demo line' }, actor: 'tester' });
    const [s] = (await suggestionsFor(other.pool, { orgId: scope.orgId, cov: await coverage(other.pool, { ...scope, returnId }), companyIds: [scope.entityId] })).filter(x => x.sure);
    await acceptSuggestion(other.pool, { ...scope, returnId, companyIds: [scope.entityId], decision: s.decision, actor: 'tester' });
    assert.ok(await q('SELECT count(*) AS n FROM tax_binding_line') > 0 && await q('SELECT count(*) AS n FROM tax_binding_suggestion') > 0);
    assert.deepEqual(await demoProblems(other.pool), []);
    await resetDemo(other.pool, { env: { DEMO_MODE: '1' }, asOf: AS_OF });
    for (const t of ['tax_binding_line', 'tax_binding_suggestion', 'tax_binding', 'tax_binding_default', 'tax_return']) assert.equal(await q(`SELECT count(*) AS n FROM ${t}`), 0, t);
    // An EIN candidate kept as evidence holds ciphertext: a demo never has one, and the reset refuses rather than wiping it.
    const partyId = Number(await saveParty(other.pool, { orgId: scope.orgId, fields: { kind: 'entity_in_org', name: 'Sample own party', entityId: scope.entityId, taxId: '' }, env: {} }));
    await other.pool.query(`INSERT INTO tax_party_tax_id_evidence (org_id, party_id, entity_id, party_tax_id_enc, party_tax_id_last4, company_ein_enc, company_ein_last4)
      VALUES ($1, $2, $3, 'placeholder-a', '1111', 'placeholder-b', '2222')`, [scope.orgId, partyId, scope.entityId]);
    assert.match((await demoProblems(other.pool)).join('\n'), /stored secrets \(tax_party_tax_id_evidence\.company_ein_enc: 1\)[^]*tax_party_tax_id_evidence\.party_tax_id_enc: 1/);
    await assert.rejects(resetDemo(other.pool, { env: { DEMO_MODE: '1' }, asOf: AS_OF }), /holds things a demo never makes[^]*tax_party_tax_id_evidence/);
    assert.equal(await q('SELECT count(*) AS n FROM tax_party_tax_id_evidence'), 1, 'nothing was wiped');
  } finally { await other.drop(); }
});

// ---- Tax Books T3: whole-return work, bulk typed answers, and the comparison CLI ----

test('ported T3: every worksheet page and POST takes a heavy-work slot before computing or writing', async t => {
  const { other, scope, base: b } = await taxDemo();
  try {
    const { openPeriod } = await import('../lib/tax/periods.js');
    const { computeReturn } = await import('../lib/tax/engine/compute.js');
    const { acct, activity, bind, bill, expense, importedJe } = await import('./tax-t3-fixtures.js');
    const { default: pg } = await import('pg');
    const p = other.pool;
    const returnId = Number(await openPeriod(p, { ...scope, year: 2025, actor: 'tester' }));
    const act = await activity(p, scope, { name: 'Demo shop' });
    const bank = await acct(p, scope, 'Demo bank', 'bank');
    const cost = await acct(p, scope, 'Demo supplies', 'expense');
    const stock = await acct(p, scope, 'Demo inventory', 'other_current_asset');
    const income = await acct(p, scope, 'Demo sales', 'income');
    const equity = await acct(p, scope, 'Demo equity', 'equity');
    const meals = await newAccounts(p, scope, 'Demo meals', 'expense', 2);
    await expense(p, scope, '2025-06-01', bank, meals.map(id => [id, 2000]));
    for (const id of meals) await bind(p, scope, returnId, id, 'activity', [{ treatment: 'statement_row', destination: 'f1065.p1.21', rowLabel: `Sample meals ${id}` }]);
    const billId = await bill(p, scope, '2025-12-20', [[cost, 6000]]);
    const movementId = await bill(p, scope, '2025-06-01', [[stock, 5000]]);
    const closingId = await importedJe(p, scope, '2025-12-31', [[income, 1000], [equity, -1000]], { doc: 'CJE-DEMO' });
    const row = async (sql, args = []) => (await p.query(sql, args)).rows[0];
    const version = async id => (await row('SELECT txn_version($1) AS v', [id])).v;
    const r = await computeReturn(p, { ...scope, returnId });
    const proposals = r.proposals.filter(x => x.accountName.startsWith('Demo meals '));
    assert.equal(proposals.length, 2, 'real, unanswered proposals for accept and reject');
    const keys = r.needs.filter(x => x.key !== 'answer:k1_inflows').slice(0, DEMO_BATCH_MAX).map(x => ['key', x.key]);
    assert.equal(keys.length, DEMO_BATCH_MAX, 'a real full manual/rest batch');

    const none = await startDemo({ pool: p, demoHeavyAtOnce: 0 });
    const blocked = await visitor(none).start(), allowed = await visitor(b).start();
    assert.ok(blocked.csrf && allowed.csrf, 'authenticated visitors with genuine CSRF tokens');
    const path = `/tax/${scope.entityId}/2025`;
    let observed = null;
    const query = pg.Client.prototype.query;
    // All pool and transaction queries pass here, including computeIn under answerProposal's write locks.
    // Count the engine's first query and any DML attempt, even one subsequently rolled back.
    t.mock.method(pg.Client.prototype, 'query', function (sql, ...args) {
      const text = typeof sql === 'string' ? sql : sql.text;
      if (observed) {
        if (/^SELECT r\.return_id, r\.entity_id, r\.status, r\.return_type\b/.test(text)) observed.computations++;
        if (/\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE)\b/i.test(text)) observed.writes++;
      }
      return query.call(this, sql, ...args);
    });
    const request = async (v, method, suffix, body) => {
      observed = { computations: 0, writes: 0 };
      try {
        const res = method === 'GET' ? await v.get(path + suffix) : await v.post(path + suffix, body);
        const text = await res.text();
        return { status: res.status, ...observed, text };
      } finally { observed = null; }
    };
    const refuse = async (method, suffix, body, label = '') => {
      let response;
      await t.test(`${method} ${suffix || '/'} ${label}`.trim(), async () => {
        response = await request(blocked, method, suffix, body);
        const { text, ...result } = response;
        assert.deepEqual(result, { status: 503, computations: 0, writes: 0 });
        assert.match(text, /busy building other reports/);
      });
      return response;
    };
    for (const suffix of ['', '/manual', '/adjustments', '/cash', '/cogs']) await refuse('GET', suffix);
    // A positive control proves the counter observes an actual whole-return computation.
    const page = await request(allowed, 'GET', '/manual');
    assert.equal(page.status, 200);
    assert.equal(page.computations, 1);

    // Successful controls seed the rows needed by clear/withdraw/unclassify. Each valid form is first sent to the
    // zero-capacity app; invalid forms also cover the ValidationError -> show() -> computeReturn path.
    const cases = [
      ['/manual/save', { item_key: 'answer:k1_inflows', status: 'not_applicable' }],
      ['/manual/clear', { item_key: 'answer:k1_inflows' }],
      ['/manual/rest', keys, [['key', 'missing-item']], 303], // unknown keys are ignored by this action
      ['/adjustments/add', { purpose: 'other', memo: 'Sample correction', evidence: 'Sample workpaper', slot_0: 'f1065.p1.16a|activity', amount_0: '5.00', class_0: 'other' }],
      ['/adjustments/withdraw', async () => ({ group_id: (await row("SELECT group_id FROM tax_adjustment_group WHERE source = 'person' AND status = 'accepted' ORDER BY group_id LIMIT 1")).group_id, reason: 'Sample correction withdrawn' })],
      ['/adjustments/answer', { key: proposals[0].key, version: proposals[0].version, decision: 'accept' }, { key: 'missing-proposal', version: 'missing', decision: 'accept' }],
      ['/adjustments/answer', { key: proposals[1].key, version: proposals[1].version, decision: 'reject', reason: 'Sample review' }, { key: proposals[1].key, version: 'stale', decision: 'reject', reason: 'Sample review' }],
      ['/cash/review', { txn_id: billId, kind: 'related_party_accrual', decision: 'exclude', reason: 'Sample unpaid accrual' }],
      ['/cash/clear', async () => ({ review_id: (await row('SELECT review_id FROM cash_timing_review WHERE txn_id = $1', [billId])).review_id })],
      ['/cash/classify', { txn_id: closingId, txn_version: await version(closingId), class: 'closing', line: '1' }, null],
      ['/cash/unclassify', { txn_id: closingId }],
      ['/cogs/save', { activity_id: act, path: 'reconstruct', treatment: 'inventory_as_booked', method: 'cost', begin: '0.00', end: '50.00' }],
      ['/cogs/movement', { account_id: stock, txn_id: movementId, line_no: '1', txn_version: await version(movementId), class: 'purchase' }],
      ['/cogs/unclassify', { account_id: stock, txn_id: movementId, line_no: '1' }],
      ['/revisions', {}, { unexpected: 'ignored' }, 303], // revisions take no form fields
    ];
    for (const [suffix, valid, invalid = {}, invalidStatus = 422] of cases) {
      let body = typeof valid === 'function' ? await valid() : valid;
      if (suffix === '/cash/classify') body = [...Object.entries(body), ['line', '2']];
      await refuse('POST', suffix, invalid ?? {}, 'invalid form');
      const denied = await refuse('POST', suffix, body, `valid form${suffix === '/adjustments/answer' ? ` (${body.decision})` : ''}`);
      const bad = await request(allowed, 'POST', suffix, invalid ?? {});
      assert.equal(bad.status, invalidStatus, `${suffix} invalid control`);
      if (invalidStatus === 422) assert.ok(bad.computations >= 1, `${suffix} validation renders the whole return`);
      // During a failing regression run a bypass may already have consumed a clear/answer form.
      const ok = denied.status === 503 ? await request(allowed, 'POST', suffix, body) : denied;
      assert.equal(ok.status, 303, `${suffix} valid control: ${ok.text}`);
      assert.ok(ok.writes > 0, `${suffix} control proves a write was prevented`);
    }
    // Rejecting with no reason and an invalid decision also reach validation, while an oversized batch must be
    // admitted before even the existing bulk check (that cap is exercised with available capacity below).
    await refuse('POST', '/adjustments/answer', { decision: 'reject' }, 'missing rejection reason');
    await refuse('POST', '/adjustments/answer', { decision: 'invalid' }, 'invalid decision');
    await refuse('POST', '/manual/rest', [...keys, ['key', 'extra-item']], 'oversized batch');
    assert.equal((await blocked.get(`/tax/${scope.entityId}/profile`)).status, 200, 'tax setup stays available');
  } finally { await other.drop(); }
});

test('ported T3: remaining typed items take at most a demo batch, the rendered batch succeeds, and reset clears the T3 work', async () => {
  const { other, scope, q, base: b } = await taxDemo();
  try {
    const { openPeriod } = await import('../lib/tax/periods.js');
    const { computeReturn } = await import('../lib/tax/engine/compute.js');
    const { K1_ANSWER } = await import('../lib/tax/manual.js');
    const returnId = Number(await openPeriod(other.pool, { ...scope, year: 2025, actor: 'tester' }));
    const r = await computeReturn(other.pool, { ...scope, returnId });
    const keys = r.needs.filter(n => n.key !== K1_ANSWER).map(n => n.key);
    assert.ok(keys.length > DEMO_BATCH_MAX, `${keys.length} real typed items`);
    const v = await visitor(b).start(), path = `/tax/${scope.entityId}/2025`;
    const page = await v.get(`${path}/manual`);
    assert.equal(page.status, 200);
    const shown = [...(await page.text()).matchAll(/name="key" value="([^"]+)"/g)].map(m => m[1].replaceAll('&amp;', '&'));
    assert.deepEqual(shown, keys.slice(0, DEMO_BATCH_MAX), 'the page offers the first batch in order');
    const postings = await q('SELECT count(*) AS n FROM posting');
    const over = await v.post(`${path}/manual/rest`, keys.slice(0, DEMO_BATCH_MAX + 1).map(k => ['key', k]));
    assert.equal(over.status, 403);
    assert.match(await over.text(), new RegExp(`at most ${DEMO_BATCH_MAX} at a time`));
    assert.equal(await q('SELECT count(*) AS n FROM tax_manual_item'), 0, 'an oversized request writes nothing');
    const ok = await v.post(`${path}/manual/rest`, shown.map(k => ['key', k]));
    assert.equal(ok.status, 303);
    assert.match(await flashAfter(v, ok), new RegExp(`${DEMO_BATCH_MAX} items marked not applicable`));
    assert.equal(await q('SELECT count(*) AS n FROM tax_manual_item'), DEMO_BATCH_MAX);
    assert.equal((await v.post(`${path}/manual/rest`, keys.slice(DEMO_BATCH_MAX).map(k => ['key', k]))).status, 303);
    assert.equal(await q('SELECT count(*) AS n FROM tax_manual_item'), keys.length);
    assert.equal(await q('SELECT count(*) AS n FROM tax_manual_item WHERE item_key = $1', [K1_ANSWER]), 0, 'the K-1 answer remains explicit');
    for (const suffix of ['', '/adjustments', '/cash', '/cogs']) assert.equal((await v.get(path + suffix)).status, 200, suffix || 'worksheet');
    assert.equal((await v.post(`${path}/revisions`)).status, 303);
    assert.equal(await q('SELECT count(*) AS n FROM tax_return_revision'), 1);
    assert.equal(await q('SELECT count(*) AS n FROM posting'), postings, 'the ledger is untouched');
    assert.deepEqual(await demoProblems(other.pool), []);
    const tables = ['tax_return_revision', 'book_entry_classification', 'cash_timing_review', 'tax_manual_item',
      'tax_adjustment_group', 'tax_adjustment', 'tax_cogs_workpaper', 'tax_cogs_movement'];
    const known = await appTables();
    for (const table of tables) assert.ok(known.has(table), `${table} is a resettable app table`);
    await resetDemo(other.pool, { env: { DEMO_MODE: '1' }, asOf: AS_OF });
    for (const table of tables) assert.equal(await q(`SELECT count(*) AS n FROM ${table}`), 0, table);
  } finally { await other.drop(); }
});

test('ported T3: the baseline comparison refuses demo mode and a demo database before reading books or files', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { randomUUID } = await import('node:crypto');
  // These paths are never created. An absent organization and resolver must not be read before the demo refusal.
  const dir = join(tmpdir(), `fb-demo-compare-${randomUUID()}`), out = join(dir, 'comparison.json');
  const envOf = more => ({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DATABASE_URL: db.url, ALLOW_SUPERUSER: '1', ...more });
  const run = more => promisify(execFile)(process.execPath, ['scripts/tax-compare-baseline.mjs', '--org', 'missing-comparison-org', '--entity', '1',
    '--year', '2025', '--out', out, '--resolve', join(dir, 'resolve.json')], { env: envOf(more) });
  await assert.rejects(run({ DEMO_MODE: '1' }), e => e.code === 1 && /doesn’t run with DEMO_MODE=1/.test(e.stderr));
  await assert.rejects(run({}), e => e.code === 1 && /public demo/.test(e.stderr));
  assert.equal(existsSync(dir), false, 'no comparison output was created');
});
