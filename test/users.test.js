import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeTotp } from '../lib/auth.js';
import { canAccess } from '../lib/domain/roles.js';
import { startApp } from './app-harness.js';

const sent = [];
const mailer = { kind: 'smtp', from: 'books@sample.example', async send(m) { sent.push(m); return { status: 'sent' }; } };
let app;
before(async () => { app = await startApp({ mailer, env: { SETTINGS_KEY: 'ab'.repeat(32) } }); });
after(async () => { await app.close(); });

const cookieOf = res => (res.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).filter(c => !/=$/.test(c)).join('; ');
const form = (path, body, cookie) => fetch(app.base + path, { method: 'POST', redirect: 'manual',
  headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });

// A signed-in client for someone else (cookie from their own sign-in).
function client(cookie) {
  let csrf = null;
  const get = path => fetch(app.base + path, { redirect: 'manual', headers: { cookie } });
  return {
    get,
    async post(path, body = {}) {
      if (!csrf) {
        const home = (await get('/')).headers.get('location');
        csrf = /name="csrf" value="([0-9a-f]+)"/.exec(await (await get(home)).text())[1];
      }
      return form(path, { csrf, ...body }, cookie);
    },
  };
}

async function invite(fields) {
  const res = await app.post('/settings/users', { canApproveBills: '', ...fields });
  assert.equal(res.status, 200, await res.clone().text());
  const page = await res.text();
  return /\/invite\/([A-Za-z0-9_-]{43})/.exec(page)[0];
}

async function acceptInvite(path, password = 'correct horse battery') {
  const pageRes = await fetch(app.base + path);
  assert.equal(pageRes.status, 200);
  const nonceCookie = cookieOf(pageRes);
  const html = await pageRes.text();
  const nonce = /name="nonce" value="([^"]+)"/.exec(html)[1];
  const secret = /class="secret">([A-Z2-7 ]+)</.exec(html)[1].replace(/ /g, '');
  app.advance(30_000);
  const res = await form(path, { nonce, password, password2: password, code: makeTotp(secret).generate({ timestamp: app.clock() }) }, nonceCookie);
  assert.equal(res.status, 303, await res.clone().text());
  return { cookie: cookieOf(res).split('; ').find(c => c.startsWith('fb_session=')), secret };
}

test('roles: each role reaches only its side; reports can look but not change', () => {
  assert.ok(canAccess('admin', 'POST', '/settings/users'));
  assert.ok(!canAccess('standard', 'GET', '/settings/users'));
  assert.ok(!canAccess('standard', 'GET', '/settings/accounts/12'));
  assert.ok(canAccess('standard', 'POST', '/settings/terms'));
  assert.ok(canAccess('customers', 'GET', '/customers/5'));
  assert.ok(canAccess('customers', 'POST', '/deposits'));
  assert.ok(!canAccess('customers', 'GET', '/vendors'));
  assert.ok(!canAccess('customers', 'GET', '/settings'));
  assert.ok(canAccess('vendors', 'POST', '/pay-bills'));
  assert.ok(canAccess('vendors', 'GET', '/vendors.csv'));
  assert.ok(!canAccess('vendors', 'GET', '/customers'));
  assert.ok(canAccess('reports', 'GET', '/vendors/3'));
  assert.ok(!canAccess('reports', 'POST', '/customers'));
  assert.ok(!canAccess('reports', 'GET', '/settings/users'));
  assert.ok(canAccess('reports', 'POST', '/logout'));
  assert.ok(!canAccess('nobody', 'GET', '/customers'));
});

test('an invited person sets a password and authenticator from the emailed link, then signs in with their email', async () => {
  const link = await invite({ name: 'Dana Clerk', email: 'dana@sample.example', role: 'customers' });
  const mail = sent.at(-1);
  assert.equal(mail.to, 'dana@sample.example');
  assert.match(mail.text, new RegExp(link.replace(/[/\\-]/g, '\\$&')));
  assert.match(await (await app.get('/settings/users')).text(), /Dana Clerk[\s\S]*Invited/);

  // Short or mismatched passwords are refused without using up the link.
  const pageRes = await fetch(app.base + link);
  const nonceCookie = cookieOf(pageRes);
  const nonce = /name="nonce" value="([^"]+)"/.exec(await pageRes.text())[1];
  const weak = await form(link, { nonce, password: 'short', password2: 'short', code: '123456' }, nonceCookie);
  assert.equal(weak.status, 422);
  assert.match(await weak.text(), /at least 12 characters/);
  const noNonce = await form(link, { nonce: 'wrong', password: 'x'.repeat(12), password2: 'x'.repeat(12), code: '123456' }, nonceCookie);
  assert.equal(noNonce.status, 403);

  const { cookie, secret } = await acceptInvite(link);
  const dana = client(cookie);
  assert.equal((await dana.get('/')).headers.get('location'), '/customers');
  const customers = await (await dana.get('/customers')).text();
  assert.doesNotMatch(customers, /href="\/vendors"/, 'Vendors link hidden for customers-only');
  assert.doesNotMatch(customers, /href="\/settings"/, 'Settings link hidden');
  assert.equal((await dana.get('/vendors')).status, 403);
  assert.equal((await dana.get('/settings/users')).status, 403);

  // Their name goes on what they do.
  const res = await dana.post('/customers', { displayName: 'Walk-in Rancher' });
  assert.equal(res.status, 303);
  const { rows } = await app.db.pool.query(`SELECT actor FROM activity_event WHERE summary ILIKE '%Walk-in Rancher%' ORDER BY event_id DESC LIMIT 1`);
  assert.equal(rows[0].actor, 'Dana Clerk');

  // The link works once.
  assert.equal((await fetch(app.base + link)).status, 404);

  // Sign in from the login page with email + password + code.
  const login = await fetch(app.base + '/login');
  const challenge = /name="challenge" value="([0-9a-f]+)"/.exec(await login.text())[1];
  app.advance(30_000);
  const code = makeTotp(secret).generate({ timestamp: app.clock() });
  const wrong = await form('/login', { challenge, email: 'dana@sample.example', password: 'not the password', code, next: '/customers' }, cookieOf(login));
  assert.equal(wrong.status, 401);
  assert.match(await wrong.text(), /value="dana@sample.example"/, 'email kept on the form');
  const ok = await form('/login', { challenge, email: 'DANA@sample.example', password: 'correct horse battery', code, next: '/customers' }, cookieOf(login));
  assert.equal(ok.status, 303);
  const replay = await form('/login', { challenge, email: 'dana@sample.example', password: 'correct horse battery', code, next: '/customers' }, cookieOf(login));
  assert.equal(replay.status, 401, 'a code works once');
});

test('reports-only can open pages but not change anything; standard can’t open Users', async () => {
  const { cookie } = await acceptInvite(await invite({ name: 'Rita Reader', email: 'rita@sample.example', role: 'reports' }));
  const rita = client(cookie);
  assert.equal((await rita.get('/vendors')).status, 200);
  const res = await rita.post('/customers', { displayName: 'Should Not Exist' });
  assert.equal(res.status, 403);
  assert.match(await res.text(), /look but not change/);

  const { cookie: c2 } = await acceptInvite(await invite({ name: 'Sam Standard', email: 'sam@sample.example', role: 'standard' }));
  const sam = client(c2);
  assert.equal((await sam.get('/settings/users')).status, 403);
  assert.equal((await sam.get('/settings/company')).status, 403);
  const index = await (await sam.get('/settings')).text();
  assert.doesNotMatch(index, /href="\/settings\/users"/);
  assert.match(index, /href="\/settings\/terms"/);
});

test('bill approval needs “Can approve bills”', async () => {
  const { cookie } = await acceptInvite(await invite({ name: 'Val Vendors', email: 'val@sample.example', role: 'vendors' }));
  const val = client(cookie);
  const bill = (await app.db.pool.query(`SELECT txn_id FROM txn WHERE type = 'bill' AND voided_at IS NULL LIMIT 1`)).rows[0].txn_id;
  await app.db.pool.query(`UPDATE txn SET approval_status = 'awaiting' WHERE txn_id = $1`, [bill]);
  assert.equal((await val.post(`/vtxns/${bill}/approve`)).status, 403);
  const id = (await app.db.pool.query(`SELECT user_id FROM app_user WHERE email = 'val@sample.example'`)).rows[0].user_id;
  assert.equal((await app.post(`/settings/users/${id}`, { name: 'Val Vendors', email: 'val@sample.example', role: 'vendors', canApproveBills: '1' })).status, 303);
  assert.equal((await val.post(`/vtxns/${bill}/approve`)).status, 303);
  assert.equal((await app.db.pool.query('SELECT approval_status, approved_by FROM txn WHERE txn_id = $1', [bill])).rows[0].approved_by, 'Val Vendors');
});

test('making someone inactive or resetting their sign-in ends their session at once', async () => {
  const { cookie } = await acceptInvite(await invite({ name: 'Ina Active', email: 'ina@sample.example', role: 'standard' }));
  const ina = client(cookie);
  assert.equal((await ina.get('/customers')).status, 200);
  const id = (await app.db.pool.query(`SELECT user_id FROM app_user WHERE email = 'ina@sample.example'`)).rows[0].user_id;
  assert.equal((await app.post(`/settings/users/${id}/deactivate`)).status, 303);
  assert.equal((await ina.get('/customers')).status, 303, 'sent to sign in');
  assert.equal((await app.post(`/settings/users/${id}/activate`)).status, 303);

  const { cookie: again } = await acceptInvite(await resetLink(id));
  assert.equal((await client(again).get('/customers')).status, 200);
  const before = client(again);
  await resetLink(id);
  assert.equal((await before.get('/customers')).status, 303, 'old password and session stop working');
});

async function resetLink(id) {
  const res = await app.post(`/settings/users/${id}/reset`);
  assert.equal(res.status, 200);
  return /\/invite\/([A-Za-z0-9_-]{43})/.exec(await res.text())[0];
}

test('the last active admin can’t be demoted or made inactive; duplicate emails are refused', async () => {
  const { cookie } = await acceptInvite(await invite({ name: 'Ada Admin', email: 'ada@sample.example', role: 'admin', canApproveBills: '1' }));
  const ada = client(cookie);
  const id = (await app.db.pool.query(`SELECT user_id FROM app_user WHERE email = 'ada@sample.example'`)).rows[0].user_id;
  const demote = await app.post(`/settings/users/${id}`, { name: 'Ada Admin', email: 'ada@sample.example', role: 'standard' });
  assert.equal(demote.status, 422);
  assert.match(await demote.text(), /last active admin/);
  const off = await app.post(`/settings/users/${id}/deactivate`);
  assert.equal(off.status, 303);
  assert.equal((await app.db.pool.query('SELECT active FROM app_user WHERE user_id = $1', [id])).rows[0].active, true);
  assert.equal((await ada.get('/settings/users')).status, 200, 'admins see Users');
  const dup = await app.post('/settings/users', { name: 'Other Ada', email: 'ADA@sample.example', role: 'standard' });
  assert.equal(dup.status, 422);
  assert.match(await dup.text(), /already signs in as/);
});

test('company legal info: EIN stored encrypted and shown only as the last 4; logo upload checks the file', async () => {
  const res = await app.post('/settings/company', { name: 'Sample Feed Co.', legalName: 'Sample Feed Co. LLC', businessType: 'llc', ein: '12-3456789',
    website: 'samplefeed.example', customerEmail: 'billing@samplefeed.example', c_line1: 'PO Box 9', c_city: 'Gainesville', c_state: 'TX', c_postal: '76241' });
  assert.equal(res.status, 303);
  const row = (await app.db.pool.query('SELECT ein_enc, ein_last4, website, customer_address FROM entity WHERE entity_id = $1', [app.ids.entityId])).rows[0];
  assert.doesNotMatch(row.ein_enc, /123456789/);
  assert.equal(row.ein_last4, '6789');
  assert.equal(row.website, 'https://samplefeed.example');
  assert.equal(row.customer_address.line1, 'PO Box 9');
  const page = await (await app.get('/settings/company')).text();
  assert.doesNotMatch(page, /123456789|3456789/);
  assert.match(page, /ending in 6789/);
  // Saving again with the EIN blank keeps it.
  await app.post('/settings/company', { name: 'Sample Feed Co.', legalName: 'Sample Feed Co. LLC' });
  assert.equal((await app.db.pool.query('SELECT ein_last4 FROM entity WHERE entity_id = $1', [app.ids.entityId])).rows[0].ein_last4, '6789');
  assert.equal((await app.post('/settings/company', { name: 'Sample Feed Co.', ein: '1234' })).status, 422);

  const upload = (name, bytes) => {
    const fd = new FormData();
    fd.set('csrf', app.csrf);
    fd.set('logo', new Blob([bytes]), name);
    return app.raw('/settings/company/logo', { method: 'POST', body: fd });
  };
  const notImage = await upload('logo.png', Buffer.from('<svg onload=alert(1)>'));
  assert.equal(notImage.status, 422);
  assert.match(await notImage.text(), /PNG or JPEG/);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  assert.equal((await upload('logo.png', png)).status, 303);
  const logo = await app.get('/company/logo');
  assert.equal(logo.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await logo.arrayBuffer()).length, png.length);
  assert.equal((await upload('big.jpg', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1024 * 1024)]))).status, 422);
  assert.equal((await app.post('/settings/company/logo/delete')).status, 303);
  assert.equal((await app.get('/company/logo')).status, 404);
});

test('the Users page lists the break-glass owner sign-in', async () => {
  const page = await (await app.get('/settings/users')).text();
  assert.match(page, /Break-glass/);
  assert.match(page, /Owner sign-in/);
});
