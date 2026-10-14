import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import * as OTPAuth from 'otpauth';
import { freshDb } from './harness.js';
import { generateSample } from '../lib/seed/generate.js';
import { writeSample } from '../lib/data/seed.js';
import { createApp } from '../services/app/index.js';
import { makeTotp } from '../lib/auth.js';
import { listTransactions } from '../lib/data/transactions.js';
import { parseTxnFilters } from '../lib/domain/filters.js';

const NOW = new Date('2026-10-12T17:00:00Z'); // noon in America/Chicago
const TODAY = '2026-10-12';
const PASSWORD = 'correct horse battery staple';
const TOTP_SECRET = new OTPAuth.Secret({ size: 20 }).base32;
let db, ids, server, base, clock = NOW.getTime();

const env = { APP_LOGIN_PASSWORD_HASH: bcrypt.hashSync(PASSWORD, 4), APP_TOTP_SECRET: TOTP_SECRET };

before(async () => {
  db = await freshDb();
  ids = await writeSample(db.pool, generateSample({ asOf: TODAY }));
  server = http.createServer(createApp({ pool: db.pool, env, now: () => new Date(clock) }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); await db.drop(); });

const cookieOf = res => (res.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ');
const get = (path, cookie = '') => fetch(base + path, { redirect: 'manual', headers: { cookie } });
const post = (path, form, cookie = '') => fetch(base + path, {
  method: 'POST', redirect: 'manual', body: new URLSearchParams(form).toString(),
  headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
});

async function login({ password = PASSWORD, code } = {}) {
  const page = await get('/login');
  const loginCookie = cookieOf(page);
  const challenge = /name="challenge" value="([0-9a-f]+)"/.exec(await page.text())[1];
  clock += 30_000; // a fresh TOTP step so replay protection never trips between tests
  const totp = code ?? makeTotp(TOTP_SECRET).generate({ timestamp: clock });
  return post('/login', { challenge, password, code: totp, next: '/customers' }, loginCookie);
}

let sessionCookie;
async function session() {
  if (!sessionCookie) {
    const res = await login();
    assert.equal(res.status, 303);
    sessionCookie = cookieOf(res);
  }
  return sessionCookie;
}

test('healthz and security headers', async () => {
  const res = await get('/healthz');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('unauthenticated requests go to login', async () => {
  const res = await get('/customers');
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/login?next=%2Fcustomers');
});

test('wrong password and wrong code are rejected', async () => {
  assert.equal((await login({ password: 'nope' })).status, 401);
  assert.equal((await login({ code: '000000' })).status, 401);
});

test('login without the form challenge cookie is rejected', async () => {
  const res = await post('/login', { challenge: 'a'.repeat(64), password: PASSWORD, code: '123456' });
  assert.equal(res.status, 401);
  assert.match(await res.text(), /expired/);
});

test('logout requires CSRF', async () => {
  const cookie = cookieOf(await login());
  assert.equal((await post('/logout', { csrf: 'wrong' }, cookie)).status, 403);
  const page = await (await get('/customers', cookie)).text();
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(page)[1];
  assert.equal((await post('/logout', { csrf }, cookie)).status, 303);
  assert.equal((await get('/customers', cookie)).status, 303, 'session ended');
});

test('customers list and search', async () => {
  const cookie = await session();
  const all = await (await get('/customers', cookie)).text();
  assert.match(all, /Red River Farm &amp; Ranch/);
  assert.match(all, /Inactive/);
  const one = await (await get('/customers?q=hilltop', cookie)).text();
  assert.match(one, /Hilltop Dairy/);
  assert.doesNotMatch(one, /Red River/);
});

test('customer page renders header, summary, tabs, statuses', async () => {
  const cookie = await session();
  const res = await get(`/customers/${ids.customers.redriver}`, cookie);
  assert.equal(res.status, 200);
  const page = await res.text();
  assert.match(page, /<h1>Red River Farm &amp; Ranch<\/h1>/);
  assert.match(page, /dale@redriverfarm\.example/);
  assert.match(page, /href="tel:9405550141"/);
  assert.match(page, /data-testid="open-balance">\$[\d,]+\.\d\d</);
  assert.match(page, /Overdue \d+ days/);
  for (const label of ['Transaction List', 'Activity Feed', 'Statements', 'Recurring Transactions', 'Projects', 'Customer Details', 'Late Fees', 'Documents', 'Conversations']) {
    assert.ok(page.includes(label), label);
  }
  assert.match(page, /1–\d+ of \d+/);
  assert.match(page, /class="total-row"/);
});

test('type filter only shows that type', async () => {
  const cookie = await session();
  const page = await (await get(`/customers/${ids.customers.redriver}?tab=transactions&type=payment`, cookie)).text();
  const body = page.slice(page.indexOf('<tbody>'), page.indexOf('</tbody>'));
  const types = [...body.matchAll(/<td>(Invoice|Payment|Sales Receipt|Credit Memo|Late Fee)<\/td>/g)].map(m => m[1]);
  assert.ok(types.length > 0);
  assert.ok(types.every(t => t === 'Payment'));
});

test('other tabs render', async () => {
  const cookie = await session();
  const activity = await (await get(`/customers/${ids.customers.prairie}?tab=activity`, cookie)).text();
  assert.match(activity, /voided/);
  const details = await (await get(`/customers/${ids.customers.prairie}?tab=details`, cookie)).text();
  assert.match(details, /Net 30/);
  for (const tab of ['statements', 'recurring', 'projects', 'late-fees', 'documents', 'conversations']) {
    const res = await get(`/customers/${ids.customers.prairie}?tab=${tab}`, cookie);
    assert.equal(res.status, 200, tab);
    assert.doesNotMatch(await res.text(), /Coming in a later build stage/, tab);
  }
});

test('unknown customer and transaction are 404', async () => {
  const cookie = await session();
  assert.equal((await get('/customers/999999999', cookie)).status, 404);
  assert.equal((await get('/txns/999999999', cookie)).status, 404);
  assert.equal((await get('/nope', cookie)).status, 404);
});

test('export returns a workbook matching the filtered list', async () => {
  const cookie = await session();
  const res = await get(`/customers/${ids.customers.redriver}/export.xlsx?status=overdue`, cookie);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /spreadsheetml/);
  assert.match(res.headers.get('content-disposition'), /Red-River-Farm-Ranch-transactions\.xlsx/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  const expected = await listTransactions(db.pool, { orgId: ids.orgId, customerId: ids.customers.redriver, filters: parseTxnFilters({ status: 'overdue' }, TODAY), today: TODAY, pageSize: 0 });
  assert.equal(wb.getWorksheet('Transactions').rowCount, expected.total + 1);
});

test('transaction view shows lines and applications', async () => {
  const cookie = await session();
  const page = await (await get(`/customers/${ids.customers.loneoak}?tab=transactions&type=invoice&status=paid`, cookie)).text();
  const txnId = /href="\/txns\/(\d+)\/edit"/.exec(page)[1];
  const view = await (await get(`/txns/${txnId}`, cookie)).text();
  assert.match(view, /Product\/service/);
  assert.match(view, /Payments and credits/);
});

test('database text is escaped', async () => {
  const cookie = await session();
  await db.pool.query(`UPDATE customer SET note_line = '<script>alert(1)</script>' WHERE customer_id = $1`, [ids.customers.hilltop]);
  const page = await (await get(`/customers/${ids.customers.hilltop}`, cookie)).text();
  assert.ok(!page.includes('<script>alert(1)</script>'));
  assert.ok(page.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('static files are whitelisted', async () => {
  assert.equal((await get('/public/app.css')).status, 200);
  assert.equal((await get('/public/../package.json')).status, 303); // normalized to /package.json -> login
  assert.equal((await get('/public/secret.txt')).status, 404);
});
