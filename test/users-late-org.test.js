import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import bcrypt from 'bcryptjs';
import { freshDb } from './harness.js';
import { mvOrg, mvUser } from './morning-fixtures.js';
import { createApp } from '../services/app/index.js';
import { makeTotp } from '../lib/auth.js';

const cookieOf = res => res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');

async function lateBooks(t, mode) {
  const db = await freshDb();
  let server;
  t.after(async () => {
    try { if (server) await new Promise(resolve => server.close(resolve)); }
    finally { await db.drop(); }
  });
  const now = new Date('2026-10-20T12:00:00Z'), secret = 'JBSWY3DPEHPK3PXP', password = 'sample password 1';
  const env = { APP_ORG: 'latebooks', SETTINGS_KEY: 'ab'.repeat(32),
    ...(mode === 'development' ? { DEV_NO_AUTH: '1' }
      : { APP_LOGIN_PASSWORD_HASH: bcrypt.hashSync(password, 4), APP_TOTP_SECRET: secret }) };
  const sent = [];
  server = http.createServer(createApp({ pool: db.pool, env, now: () => now,
    mailer: { async send(message) { sent.push(message); return { status: 'sent' }; } } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const get = path => fetch(base + path, { redirect: 'manual', headers: { cookie } });
  const post = (path, body) => fetch(base + path, { method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  assert.equal((await get('/healthz')).status, 200, 'startup finished before APP_ORG exists');
  if (mode === 'break-glass') {
    const page = await get('/login');
    const challenge = /name="challenge" value="([^"]+)"/.exec(await page.text())[1];
    cookie = cookieOf(page);
    const login = await post('/login', { challenge, email: '', password, code: makeTotp(secret).generate({ timestamp: +now }) });
    assert.equal(login.status, 303);
    cookie = cookieOf(login);
  }
  assert.equal((await get('/settings/users')).status, 503, 'no books yet');
  const foreign = await mvOrg(db.pool, { slug: 'foreign' });
  const foreignUser = await mvUser(db.pool, { orgId: foreign.orgId, email: 'foreign@sample.example' });
  const f = await mvOrg(db.pool, { slug: 'latebooks' });
  const user = await mvUser(db.pool, { orgId: f.orgId, email: 'person@sample.example' });
  const home = await get('/home');
  assert.equal(home.status, 200);
  if (mode === 'development') cookie = cookieOf(home);
  const csrf = /name="csrf" value="([^"]+)"/.exec(await home.text())[1];
  return { db: db.pool, ...f, user, foreignUser, sent, get, post: (path, body = {}) => post(path, { csrf, ...body }) };
}

for (const mode of ['break-glass', 'development']) {
  test(`${mode}: Users list and detail recover after late organization import`, async t => {
    const c = await lateBooks(t, mode);
    const list = await c.get('/settings/users');
    const detail = await c.get(`/settings/users/${c.user.userId}`);
    assert.deepEqual([list.status, detail.status], [200, 200]);
    assert.match(await list.text(), /person@sample\.example/);
    assert.match(await detail.text(), /person@sample\.example/);
    assert.equal((await c.get(`/settings/users/${c.foreignUser.userId}`)).status, 404);
  });

  test(`${mode}: Users writes have a trusted actor after late organization import`, async t => {
    const c = await lateBooks(t, mode);
    const created = await c.post('/settings/users', { name: 'Sample invited user', email: 'invited@sample.example', role: 'standard' });
    assert.equal(created.status, 200);
    assert.equal(c.sent.length, 1, 'invite and company access both succeeded');
    const path = `/settings/users/${c.user.userId}`, entityId = c.entities['Sample company B'];
    assert.equal((await c.post(path, { name: 'Sample updated user', email: 'person@sample.example', role: 'reports',
      canApproveBills: '1', companyAccess: '1', company: String(entityId) })).status, 303);
    const row = async () => (await c.db.query('SELECT * FROM app_user WHERE user_id=$1', [c.user.userId])).rows[0];
    const updated = await row();
    assert.equal(updated.name, 'Sample updated user');
    assert.equal(updated.role, 'reports');
    assert.equal(updated.can_approve_bills, true);
    assert.equal(updated.all_companies, false);
    assert.deepEqual((await c.db.query('SELECT entity_id FROM app_user_company WHERE user_id=$1', [c.user.userId])).rows, [{ entity_id: entityId }]);
    assert.equal((await c.post(`${path}/deactivate`)).status, 303);
    assert.equal((await row()).active, false);
    assert.equal((await c.post(`${path}/activate`)).status, 303);
    assert.equal((await row()).active, true);
    assert.equal((await c.post(`${path}/reset`)).status, 200);
    assert.equal((await row()).password_hash, null);
    assert.equal((await c.post(`${path}/resend`)).status, 200);
    assert.equal(c.sent.length, 3);
    assert.equal((await c.post(`/settings/users/${c.foreignUser.userId}/deactivate`)).status, 404);
    assert.equal((await c.db.query('SELECT active FROM app_user WHERE user_id=$1', [c.foreignUser.userId])).rows[0].active, true);
  });
}
