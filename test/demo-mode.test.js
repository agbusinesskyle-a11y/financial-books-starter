import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { freshDb } from './harness.js';
import { createApp } from '../services/app/index.js';
import { createAuth, parseCookies } from '../lib/auth.js';
import { runDailyJobs } from '../services/jobs/index.js';
import { mailerFor } from '../lib/data/settings.js';
import { generateSample } from '../lib/seed/generate.js';
import { writeSample } from '../lib/data/seed.js';
import { startBooks } from '../lib/data/companies.js';
import {
  isDemo, checkDemoMode, demoBlock, DEMO_NOTE, DEMO_ROBOTS, DEMO_MAX_SESSIONS, DEMO_WRITES_PER_IP,
} from '../lib/domain/demo.js';
import { demoProblems, guardDatabase, resetDemo, refuseDemoDatabase, databaseState, readMarker } from '../lib/data/demo.js';

// The public demo (DEMO_MODE=1): no sign-in, every page says it's a demo, nothing reaches outside, and it runs only on a
// database made by `npm run demo-reset` — which itself refuses to wipe anything that might be real books.
const DEMO = { DEMO_MODE: '1' };
const AS_OF = '2026-10-12';
let db, server, base, transports = 0, aiCalls = 0;
const pool = () => db.pool;
const one = async (sql, args) => (await pool().query(sql, args)).rows[0];
const n = async (sql, args) => Number((await one(sql, args)).n);

// A visitor's browser: keeps the session cookie, and comes from its own address (via the trusted proxy header).
let visitors = 0;
function visitor() {
  let cookie = '';
  const from = { 'x-forwarded-for': `198.51.100.${++visitors}` };
  const keep = res => { const c = (res.headers.getSetCookie?.() ?? []).map(x => x.split(';')[0]).join('; '); if (c) cookie = c; return res; };
  const v = {
    get: path => fetch(base + path, { redirect: 'manual', headers: { cookie, ...from } }).then(keep),
    post: (path, body = {}) => fetch(base + path, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ csrf: v.csrf ?? '', ...body }).toString(),
      headers: { cookie, ...from, 'content-type': 'application/x-www-form-urlencoded' } }).then(keep),
    raw: (path, init = {}) => fetch(base + path, { redirect: 'manual', ...init, headers: { cookie, ...from, ...init.headers } }).then(keep),
    async start() {
      const res = await v.get('/customers');
      v.csrf = /name="csrf" value="([0-9a-f]+)"/.exec(await res.text())?.[1];
      return v;
    },
  };
  return v;
}

before(async () => {
  db = await freshDb();
  await resetDemo(pool(), { env: DEMO, asOf: AS_OF });
  const app = createApp({ pool: pool(), env: { ...DEMO, TRUST_PROXY: '1' }, now: () => new Date(`${AS_OF}T17:00:00Z`), demoCheckMs: 10 * 60_000,
    // Both are ignored in the demo: no test mailer, no SMTP transport, no AI.
    mailer: { kind: 'smtp', from: 'x@example.com', send: async () => { transports++; return { status: 'sent' }; } },
    makeTransport: () => { transports++; return { sendMail: async () => ({}) }; },
    aiFetch: async () => { aiCalls++; throw new Error('no'); } });
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); await db.drop(); });

test('only DEMO_MODE=1 turns it on; a typo or a real server’s settings stop it', () => {
  assert.equal(isDemo({ DEMO_MODE: '1' }), true);
  for (const v of [undefined, '', '0', 'true', 'yes', ' 1']) assert.equal(isDemo({ DEMO_MODE: v }), false, String(v));
  for (const v of [undefined, '', '0']) assert.equal(checkDemoMode({ DEMO_MODE: v }), 'off');
  assert.equal(checkDemoMode(DEMO), 'demo');
  assert.equal(checkDemoMode({ ...DEMO, APP_ORG: 'sample', NODE_ENV: 'production', APP_BASE_URL: 'https://demo.example' }), 'demo');
  for (const v of ['true', 'yes', 'on', '2', ' 1', '1 ', 'demo']) assert.throws(() => checkDemoMode({ DEMO_MODE: v }), /DEMO_MODE must be/, v);
  for (const [k, v] of [['APP_ORG', 'mybooks'], ['BOOKS_MODE', 'practice'], ['SETTINGS_KEY', 'a'.repeat(64)], ['APP_LOGIN_PASSWORD_HASH', '$2a$x'],
    ['APP_TOTP_SECRET', 'ABC'], ['DEV_NO_AUTH', '1'], ['LEDGERLINE_URL', 'postgres://x'], ['LEDGERLINE_ORG_ID', 'x'], ['PAYMENTS_TEST_MODE', '1']]) {
    assert.throws(() => checkDemoMode({ ...DEMO, [k]: v }), new RegExp(`DEMO_MODE=1 refused[^]*${k}`), k);
    assert.throws(() => createApp({ pool: pool(), env: { ...DEMO, [k]: v } }), /DEMO_MODE=1 refused/, `createApp ${k}`);
  }
});

test('interlock: a database not made by demo-reset is refused, and so is a demo holding anything a demo never makes', async () => {
  const plain = await freshDb();
  try {
    assert.match((await demoProblems(plain.pool)).join('\n'), /no demo mark/);
    await assert.rejects(guardDatabase(plain.pool, DEMO), /DEMO_MODE=1 refused: this database is not a demo database[^]*no demo mark/);
    await guardDatabase(plain.pool, {}); // normal books: fine
    // Even the sample books, made by npm run seed rather than demo-reset, aren't a demo.
    await writeSample(plain.pool, generateSample({ asOf: AS_OF }));
    await assert.rejects(guardDatabase(plain.pool, DEMO), /no demo mark/);
  } finally { await plain.drop(); }

  assert.deepEqual(await demoProblems(pool()), [], 'a fresh reset is a clean demo');
  await guardDatabase(pool(), DEMO);
  // Normal books never run on a demo database (it's wiped every night).
  await assert.rejects(guardDatabase(pool(), {}), /public demo that `npm run demo-reset` wipes every night/);
  await assert.rejects(refuseDemoDatabase(pool(), {}), /public demo/);
  await assert.rejects(refuseDemoDatabase(pool(), DEMO), /doesn’t run with DEMO_MODE=1/);

  const { org_id: org, entity_id: entity } = await one('SELECT org_id, entity_id FROM entity LIMIT 1');
  const vendor = (await one('SELECT vendor_id FROM vendor LIMIT 1')).vendor_id;
  const cases = [
    ['another organization', `INSERT INTO org (slug, name) VALUES ('mybooks', 'My Books')`, /books other than the sample \(1: "mybooks"\)/],
    ['another company', `INSERT INTO entity (org_id, name, time_zone) VALUES (${org}, 'Second Co', 'America/Chicago')`, /it has 2 companies, but the demo was built with 1/],
    ['a QuickBooks import', `INSERT INTO import_batch (org_id, entity_id, source, company_name, summary, imported_by) VALUES (${org}, ${entity}, 'qbo_import', 'X', '{}', 'x')`, /QuickBooks imports \(1\)/],
    ['an imported transaction', `UPDATE txn SET source = 'qbo_import' WHERE txn_id = (SELECT min(txn_id) FROM txn)`, /imported transactions \(1\)/],
    ['a user', `INSERT INTO app_user (org_id, name, email, role) VALUES (${org}, 'Ada', 'ada@example.com', 'admin')`, /users \(1\)/],
    ['an invitation', `WITH u AS (INSERT INTO app_user (org_id, name, email, role) VALUES (${org}, 'Bo', 'bo@example.com', 'admin') RETURNING user_id)
      INSERT INTO user_invite (org_id, user_id, token_hash, expires_at) SELECT ${org}, user_id, 'h', now() FROM u`, /invitations \(1\)/],
    ['an email server', `INSERT INTO email_settings (org_id, entity_id, mode, from_email, smtp_host, smtp_port) VALUES (${org}, ${entity}, 'smtp', 'a@example.com', 'smtp.example.com', 587)`, /an email server set up/],
    ['a mail password', `INSERT INTO email_settings (org_id, entity_id, smtp_password_enc) VALUES (${org}, ${entity}, 'v1:x:y:z')`, /stored secrets \(email_settings\.smtp_password_enc: 1\)/],
    ['an AI key', `INSERT INTO ai_settings (org_id, api_key_enc) VALUES (${org}, 'v1:x:y:z')`, /stored secrets \(ai_settings\.api_key_enc/],
    ['AI turned on', `INSERT INTO ai_settings (org_id, provider) VALUES (${org}, 'anthropic')`, /AI connected/],
    ['Twilio', `INSERT INTO sms_settings (org_id, account_sid, auth_token_enc) VALUES (${org}, 'AC${'0'.repeat(32)}', 'v1:x:y:z')`, /texted receipts set up[^]*sms_settings\.auth_token_enc/],
    ['a bank-data tenant', `UPDATE org SET ledgerline_org_id = gen_random_uuid() WHERE org_id = ${org}`, /bank-data tenant assigned/],
    ['a bank connection', `INSERT INTO ledgerline_link (org_id, entity_id, ll_entity_id, ll_entity_name, linked_by) VALUES (${org}, ${entity}, gen_random_uuid(), 'Bank', 'x')`, /bank connections \(1\)/],
    ['online payments', `INSERT INTO payments_settings (org_id, entity_id, enabled) VALUES (${org}, ${entity}, true)`, /online payments turned on/],
    ['a vendor tax ID', `UPDATE vendor SET tax_id_enc = 'v1:x:y:z' WHERE vendor_id = ${vendor}`, /stored secrets \(vendor\.tax_id_enc: 1\)/],
    ['a company EIN', `UPDATE entity SET ein_enc = 'v1:x:y:z' WHERE entity_id = ${entity}`, /stored secrets \(entity\.ein_enc: 1\)/],
    ['a copied demo', `UPDATE demo_marker SET database_name = 'somewhere_else'`, /mark belongs to another database \("somewhere_else"\)/],
    ['no mark', 'DELETE FROM demo_marker', /no demo mark/],
  ];
  for (const [what, sql, expected] of cases) {
    const c = await pool().connect();
    try {
      await c.query('BEGIN');
      await c.query(sql);
      const problems = await demoProblems(c);
      assert.match(problems.join('\n'), expected, what);
      await assert.rejects(guardDatabase(c, DEMO), /DEMO_MODE=1 refused/, what);
    } finally { await c.query('ROLLBACK'); c.release(); }
  }
  assert.deepEqual(await demoProblems(pool()), [], 'all rolled back');
});

test('no sign-in: every visitor works in the sample books as “Demo visitor”', async () => {
  const v = visitor();
  const home = await v.get('/');
  assert.equal(home.status, 303);
  assert.equal(home.headers.get('location'), '/home');
  assert.match(home.headers.get('set-cookie'), /fb_session=/);
  for (const path of ['/login', '/login?next=/settings', '/logout']) {
    const res = path === '/logout' ? await v.post(path) : await v.get(path);
    assert.equal(res.status, 303, path);
    assert.equal(res.headers.get('location'), '/', path);
  }
  await v.start();
  assert.ok(v.csrf);
  for (const path of ['/home', '/customers', '/vendors', '/reports', '/settings', '/settings/company', '/settings/accounts', '/banking', '/export']) {
    const res = await v.get(path);
    assert.equal(res.status, 200, path);
  }
  const res = await v.post('/customers', { displayName: 'Visitor Test Farm', active: '1' });
  assert.equal(res.status, 303);
  const c = await one(`SELECT customer_id FROM customer WHERE display_name = 'Visitor Test Farm'`);
  assert.ok(c);
  const audit = await one(`SELECT actor FROM audit_log WHERE table_name = 'customer' AND row_id = $1 AND action = 'insert'`, [c.customer_id]);
  assert.equal(audit.actor, 'Demo visitor');
  // Invoices, bills and reports work; exports and PDFs too.
  const inv = await one(`SELECT txn_id FROM txn WHERE type = 'invoice' AND voided_at IS NULL ORDER BY txn_id LIMIT 1`);
  const pdf = await v.get(`/txns/${inv.txn_id}.pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  const xlsx = await v.get('/export/books.xlsx');
  assert.equal(xlsx.status, 200);
  assert.match(xlsx.headers.get('content-type'), /spreadsheetml/);
  // Each visitor has a separate session (and form token).
  const other = await visitor().start();
  assert.notEqual(other.csrf, v.csrf);
});

test('each closed area answers with a clear reason, and changes nothing', async () => {
  const v = await visitor().start();
  const vendor = (await one('SELECT vendor_id FROM vendor LIMIT 1')).vendor_id;
  const before = await n('SELECT (SELECT count(*) FROM app_user) + (SELECT count(*) FROM org) + (SELECT count(*) FROM entity) + (SELECT count(*) FROM email_settings) + (SELECT count(*) FROM ai_settings) AS n');
  const closed = [
    ['GET', '/settings/users', /Users and sign-ins/], ['GET', '/settings/users/new', /Users and sign-ins/],
    ['POST', '/settings/users', /Users and sign-ins/, { name: 'Ada', email: 'ada@example.com', role: 'admin', allCompanies: '1' }],
    ['GET', '/settings/companies', /Adding companies/], ['POST', '/settings/companies', /Adding companies/, { name: 'New Co', timeZone: 'America/Chicago' }],
    ['POST', '/settings/company', /company’s name, details and logo/, { name: 'Defaced' }],
    ['POST', '/settings/company/logo/delete', /company’s name, details and logo/],
    ['GET', '/settings/email', /Email settings/], ['POST', '/settings/email', /Email settings/, { mode: 'smtp', smtpHost: 'smtp.example.com' }],
    ['POST', '/settings/email/test', /Email settings/, { to: 'a@example.com' }],
    ['GET', '/settings/ai', /AI help/], ['POST', '/settings/ai', /AI help/, { provider: 'anthropic', apiKey: 'sk-test' }],
    ['GET', '/settings/text-receipts', /Texted receipts/], ['POST', '/settings/text-receipts', /Texted receipts/],
    ['GET', '/settings/bank-feeds', /Bank connections/], ['POST', '/settings/bank-feeds/link', /Bank connections/], ['POST', '/bank-feeds/refresh', /Bank connections/],
    ['GET', '/settings/payments', /Online payments/], ['POST', '/settings/payments', /Online payments/, { enabled: '1' }],
    ['GET', '/import', /Importing/], ['POST', '/import/customers', /Importing/, { csv: 'Name\nX', step: 'import' }],
    ['POST', `/vendors/${vendor}/ask`, /Asking a vendor/],
    ['POST', '/banking/item/1/research', /AI research/],
    ['POST', '/vtxns/read', /Reading a bill or receipt with AI/],
  ];
  for (const [method, path, why, body] of closed) {
    const res = method === 'GET' ? await v.get(path) : await v.post(path, body);
    assert.equal(res.status, 403, `${method} ${path}`);
    const html = await res.text();
    assert.match(html, why, `${method} ${path}`);
    assert.match(html, /is turned off in this public demo/, `${method} ${path}`);
    assert.match(html, /Not in the demo/, `${method} ${path}`);
    assert.ok(html.includes(DEMO_NOTE), `banner on ${method} ${path}`);
  }
  // Public links that reach outside people or services, without a session too.
  for (const [method, path, why] of [['GET', '/pay/abc', /Online payments/], ['POST', '/webhooks/payments/test', /Online payments/],
    ['POST', '/twilio/sms', /Texted receipts/], ['GET', '/invite/abc', /Invitations/], ['GET', '/vendor-info/abc', /Vendor information links/]]) {
    const res = await fetch(base + path, { method, redirect: 'manual', ...(method === 'POST' ? { body: 'x=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } } : {}) });
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.match(await res.text(), why, `${method} ${path}`);
  }
  // Uploads are refused before the file is read: documents, vendor documents, the logo, imports.
  const cust = (await one('SELECT customer_id FROM customer LIMIT 1')).customer_id;
  for (const path of [`/customers/${cust}/documents`, `/vendors/${vendor}/documents`, '/vendors/import', '/settings/company/logo']) {
    const form = new FormData();
    form.set('csrf', v.csrf);
    form.set('file', new Blob([Buffer.alloc(1024, 1)], { type: 'application/pdf' }), 'big.pdf');
    form.set('logo', new Blob([Buffer.alloc(1024, 1)], { type: 'image/png' }), 'logo.png');
    const res = await v.raw(path, { method: 'POST', body: form });
    assert.equal(res.status, 403, path);
    const html = await res.text();
    assert.match(html, /File uploads is turned off in this public demo|company’s name, details and logo|Importing is turned off/, path);
  }
  assert.equal(await n('SELECT count(*) AS n FROM document'), 0);
  assert.equal(await n('SELECT (SELECT count(*) FROM app_user) + (SELECT count(*) FROM org) + (SELECT count(*) FROM entity) + (SELECT count(*) FROM email_settings) + (SELECT count(*) FROM ai_settings) AS n'), before);
  assert.equal(aiCalls, 0);
  // What stays open: the company's lists (terms, products, accounts…) and everyday work.
  assert.equal(demoBlock('POST', '/settings/terms'), null);
  assert.equal(demoBlock('GET', '/settings/company'), null);
  assert.equal(demoBlock('POST', '/customers'), null);
});

test('every page says it’s the demo, and search engines are asked to keep out', async () => {
  const v = await visitor().start();
  for (const path of ['/home', '/customers', '/reports', '/settings', '/no-such-page']) {
    const res = await v.get(path);
    const html = await res.text();
    assert.ok(html.includes(`<div class="practice-banner demo-banner" role="status">${DEMO_NOTE}</div>`), path);
    assert.equal(html.split('class="practice-banner').length, 2, `once on ${path}`);
    assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow', path);
  }
  assert.equal(DEMO_NOTE, 'Demo — sample data, anyone can see and change it. Resets every night.');
  const robots = await fetch(`${base}/robots.txt`);
  assert.equal(robots.status, 200);
  assert.equal(await robots.text(), DEMO_ROBOTS);
  assert.match(DEMO_ROBOTS, /User-agent: \*\nDisallow: \/\n/);
  assert.equal(robots.headers.get('x-robots-tag'), 'noindex, nofollow');
  const pdf = await v.get(`/txns/${(await one(`SELECT txn_id FROM txn WHERE type = 'invoice' LIMIT 1`)).txn_id}.pdf`);
  assert.equal(pdf.headers.get('x-robots-tag'), 'noindex, nofollow', 'downloads too');
});

test('nothing goes out: email is recorded only, daily jobs are off', async () => {
  const v = await visitor().start();
  const { org_id: org, entity_id: entity } = await one('SELECT org_id, entity_id FROM entity LIMIT 1');
  // Even with a mail server in the settings (which the interlock would refuse at startup), nothing is sent.
  await pool().query(`INSERT INTO email_settings (org_id, entity_id, mode, from_name, from_email, smtp_host, smtp_port, smtp_user)
    VALUES ($1, $2, 'smtp', 'Books', 'books@example.com', 'smtp.example.com', 587, 'books')`, [org, entity]);
  try {
    assert.equal((await mailerFor(pool(), { orgId: org, entityId: entity, env: DEMO })).kind, 'log');
    assert.equal((await mailerFor(pool(), { orgId: org, entityId: entity, env: {} })).kind, 'smtp', 'outside the demo the same settings send for real');
    const inv = await one(`SELECT t.txn_id FROM txn t JOIN customer c ON c.customer_id = t.customer_id
      WHERE t.type = 'invoice' AND t.voided_at IS NULL AND c.email IS NOT NULL ORDER BY t.txn_id LIMIT 1`);
    const res = await v.post(`/txns/${inv.txn_id}/send`);
    assert.equal(res.status, 303);
    const msg = await one('SELECT status FROM message WHERE related_txn_id = $1 ORDER BY message_id DESC LIMIT 1', [inv.txn_id]);
    assert.equal(msg.status, 'logged');
    const page = await (await v.get(res.headers.get('location'))).text();
    assert.match(page, /This is the public demo, so no email actually went out/);
    assert.equal(transports, 0, 'neither the injected mailer nor an SMTP transport was used');
  } finally {
    await pool().query('DELETE FROM email_settings WHERE org_id = $1', [org]);
  }
  const txns = await n('SELECT count(*) AS n FROM txn');
  const logs = [];
  assert.deepEqual(await runDailyJobs({ pool: pool(), env: DEMO, now: () => new Date('2026-11-30T12:00:00Z'), log: m => logs.push(m) }), { demo: true });
  assert.match(logs.join('\n'), /public demo — daily jobs are off/);
  assert.equal(await n('SELECT count(*) AS n FROM txn'), txns);
});

test('demo-reset refuses anything that may be real books, and needs DEMO_MODE=1', async () => {
  await assert.rejects(resetDemo(pool(), { env: {}, asOf: AS_OF }), /only runs with DEMO_MODE=1/);
  await assert.rejects(resetDemo(pool(), { env: { DEMO_MODE: 'yes' }, asOf: AS_OF }), /DEMO_MODE must be/);
  await assert.rejects(resetDemo(pool(), { env: { ...DEMO, SETTINGS_KEY: 'a'.repeat(64) }, asOf: AS_OF }), /SETTINGS_KEY is set/);

  const real = await freshDb();
  try {
    // Your own books (npm run new-books), and even the plain sample made by npm run seed: data, no mark.
    await startBooks(real.pool, { slug: 'mybooks', companyName: 'My Company LLC', timeZone: 'America/Chicago' });
    const snapshot = async () => (await real.pool.query('SELECT (SELECT count(*) FROM org)::int AS orgs, (SELECT count(*) FROM account)::int AS accounts')).rows[0];
    const had = await snapshot();
    assert.equal(await databaseState(real.pool), 'books');
    await assert.rejects(resetDemo(real.pool, { env: DEMO, asOf: AS_OF }), /has data but no demo mark — it may be real books\. Nothing was changed/);
    await assert.rejects(resetDemo(real.pool, { env: DEMO, asOf: AS_OF, ifNew: true }), /may be real books/);
    assert.deepEqual(await snapshot(), had, 'nothing changed');
    assert.equal(await readMarker(real.pool), null);
  } finally { await real.drop(); }

  // A demo database that somehow got a user (not possible through the app) is looked at by a person, not wiped.
  const { org_id: org } = await one('SELECT org_id FROM org');
  await pool().query(`INSERT INTO app_user (org_id, name, email, role) VALUES ($1, 'Ada', 'ada@example.com', 'admin')`, [org]);
  try {
    await assert.rejects(resetDemo(pool(), { env: DEMO, asOf: AS_OF }), /holds things a demo never makes[^]*users \(1\)[^]*Nothing was changed/);
    assert.equal(await n('SELECT count(*) AS n FROM app_user'), 1);
  } finally { await pool().query('DELETE FROM app_user'); }
  // A copy of a demo (its mark names another database) is refused too.
  await pool().query(`UPDATE demo_marker SET database_name = 'elsewhere'`);
  try {
    await assert.rejects(resetDemo(pool(), { env: DEMO, asOf: AS_OF }), /another database’s demo mark/);
  } finally { await pool().query('UPDATE demo_marker SET database_name = current_database()'); }
});

test('demo-reset builds a new database, rebuilds the clean sample as of today, and leaves a demo alone with --if-new', async () => {
  const fresh = await freshDb({ migrate: false });
  try {
    assert.equal(await databaseState(fresh.pool), 'empty', 'no tables at all');
    const r = await resetDemo(fresh.pool, { env: DEMO, asOf: '2027-03-15' });
    assert.equal(r.built, true);
    assert.equal(r.state, 'empty');
    assert.deepEqual(await demoProblems(fresh.pool), []);
    // Dated relative to the day it's built, so the demo always looks current.
    const latest = (await fresh.pool.query(`SELECT max(txn_date) AS d FROM txn`)).rows[0].d;
    assert.ok(latest <= '2027-03-15' && latest >= '2027-02-15', latest);
    const again = await resetDemo(fresh.pool, { env: DEMO, asOf: '2027-03-15', ifNew: true });
    assert.deepEqual(again, { state: 'demo', built: false });
  } finally { await fresh.drop(); }

  // A visitor's changes are gone after the nightly reset; the sample comes back exactly.
  const counts = async () => (await pool().query(`SELECT (SELECT count(*) FROM customer)::int AS customers, (SELECT count(*) FROM txn)::int AS txns,
    (SELECT count(*) FROM vendor)::int AS vendors, (SELECT count(*) FROM posting)::int AS postings, (SELECT count(*) FROM org)::int AS orgs`)).rows[0];
  const before = await one('SELECT reset_at FROM demo_marker');
  await pool().query(`INSERT INTO customer (org_id, entity_id, display_name) SELECT org_id, entity_id, 'Left Behind' FROM entity LIMIT 1`);
  const dirty = await counts();
  const r = await resetDemo(pool(), { env: DEMO, asOf: AS_OF });
  assert.equal(r.state, 'demo');
  const clean = await counts();
  assert.equal(clean.customers, dirty.customers - 2, 'the visitor’s customers are gone'); // one added here, one in the no-sign-in test
  assert.equal(await n(`SELECT count(*) AS n FROM customer WHERE display_name IN ('Left Behind', 'Visitor Test Farm')`), 0);
  assert.equal(await n(`SELECT count(*) AS n FROM audit_log WHERE actor = 'Demo visitor'`), 0, 'the audit log starts over too');
  assert.equal(clean.orgs, 1);
  assert.ok((await one('SELECT reset_at FROM demo_marker')).reset_at > before.reset_at);
  // Running it twice gives the same books (idempotent).
  await resetDemo(pool(), { env: DEMO, asOf: AS_OF });
  assert.deepEqual(await counts(), clean);
  assert.deepEqual(await demoProblems(pool()), []);
  // Identities restart, so the company keeps its id and open sessions carry on.
  assert.equal(Number((await one('SELECT entity_id FROM entity')).entity_id), 1);
  const v = await visitor().start();
  assert.equal((await v.get('/customers')).status, 200);
});

test('visitor sessions are capped: the least recently used go first', () => {
  const auth = createAuth({ env: {}, demo: true });
  const req = cookie => ({ headers: { cookie } });
  const first = auth.current(req('')).setCookie.split(';')[0];
  const second = auth.current(req('')).setCookie.split(';')[0];
  for (let i = 0; i < DEMO_MAX_SESSIONS - 2; i++) auth.current(req(''));
  assert.equal(auth.current(req(first)).setCookie, undefined, 'still kept');
  auth.current(req('')); // one over the cap: the least recently used (second) is dropped
  assert.equal(auth.current(req(first)).setCookie, undefined, 'first was used recently');
  assert.ok(auth.current(req(second)).setCookie, 'second was dropped and gets a new session');
  assert.ok(parseCookies(req(first).headers.cookie).fb_session);
  // Outside the demo nobody gets a session without signing in.
  assert.equal(createAuth({ env: {} }).current(req('')).session, null);
});

test('demo off: no banner, no robots.txt, no noindex, sign-in required (no change in behavior)', async () => {
  const plain = await freshDb();
  const s = http.createServer(createApp({ pool: plain.pool, env: { DEMO_MODE: '0' } }));
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  const b = `http://127.0.0.1:${s.address().port}`;
  try {
    const login = await fetch(`${b}/login`, { redirect: 'manual' });
    assert.equal(login.status, 200);
    const html = await login.text();
    assert.ok(!html.includes(DEMO_NOTE));
    assert.equal(login.headers.get('x-robots-tag'), null);
    const robots = await fetch(`${b}/robots.txt`, { redirect: 'manual' });
    assert.equal(robots.status, 303);
    assert.match(robots.headers.get('location'), /^\/login/);
    const home = await fetch(`${b}/customers`, { redirect: 'manual' });
    assert.equal(home.status, 303);
    assert.match(home.headers.get('location'), /^\/login/);
  } finally { await new Promise(resolve => s.close(resolve)); await plain.drop(); }
});

// Last: it uses up this address's write allowance.
test('writes are rate limited per visitor address', async () => {
  const v = await visitor().start();
  let limited = null;
  for (let i = 0; i <= DEMO_WRITES_PER_IP + 1 && !limited; i++) {
    const res = await v.post('/bookmarks/add', { path: '/customers', label: 'x' });
    if (res.status === 429) limited = await res.text();
  }
  assert.ok(limited, 'the limit kicked in');
  assert.match(limited, /a lot of changes in a short time for this public demo/);
  assert.ok(limited.includes(DEMO_NOTE));
  assert.equal((await v.get('/customers')).status, 200, 'looking still works');
});
