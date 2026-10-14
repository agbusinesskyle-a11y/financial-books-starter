import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeTotp } from '../lib/auth.js';
import { generateSample } from '../lib/seed/generate.js';
import { writeSample } from '../lib/data/seed.js';
import { startApp } from './app-harness.js';

// Stage B1: a person can be limited to some companies (Settings → Users → Companies). They work only in those, can't
// switch to the others, and can't open the others' records.
const mailer = { kind: 'smtp', from: 'books@sample.example', async send() { return { status: 'sent' }; } };
let app, B;
before(async () => {
  app = await startApp({ mailer, env: { SETTINGS_KEY: 'ab'.repeat(32) } });
  const s = generateSample({ asOf: '2026-10-12', seed: 7 });
  s.entity = { ...s.entity, name: 'Second Ranch Supply' };
  for (const c of s.customers) c.display_name = `Zeta ${c.display_name}`;
  const b = await writeSample(app.db.pool, s, { addCompany: true });
  B = b.entityId;
});
after(async () => { await app.close(); });

const cookieOf = res => (res.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).filter(c => !/=$/.test(c)).join('; ');
const form = (path, body, cookie) => fetch(app.base + path, { method: 'POST', redirect: 'manual',
  headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });

async function inviteAndAccept(fields) {
  const res = await app.post('/settings/users', fields);
  assert.equal(res.status, 200, await res.clone().text());
  const path = /\/invite\/([A-Za-z0-9_-]{43})/.exec(await res.text())[0];
  const pageRes = await fetch(app.base + path);
  const nonceCookie = cookieOf(pageRes);
  const html = await pageRes.text();
  const nonce = /name="nonce" value="([^"]+)"/.exec(html)[1];
  const secret = /class="secret">([A-Z2-7 ]+)</.exec(html)[1].replace(/ /g, '');
  app.advance(30_000);
  const done = await form(path, { nonce, password: 'correct horse battery', password2: 'correct horse battery', code: makeTotp(secret).generate({ timestamp: app.clock() }) }, nonceCookie);
  assert.equal(done.status, 303);
  return cookieOf(done).split('; ').find(c => c.startsWith('fb_session='));
}

test('a person limited to company B works only in B', async () => {
  const form1 = await (await app.get('/settings/users/new')).text();
  assert.match(form1, /All companies, including ones added later/, 'Companies section shown when there are several');
  const p = new URLSearchParams({ name: 'Bea Bookkeeper', email: 'bea@sample.example', role: 'standard', companyAccess: '1' });
  p.append('company', String(B));
  const cookie = await inviteAndAccept(p);
  const get = path => fetch(app.base + path, { redirect: 'manual', headers: { cookie } });
  const page = await (await get('/customers')).text();
  assert.match(page, /Zeta /, 'opens in company B');
  for (const id of Object.values(app.ids.customers)) assert.ok(!page.includes(`href="/customers/${id}"`), 'none of company A');
  assert.doesNotMatch(page, /Switch company/, 'only one company to work in, so no switcher');
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(page)[1];
  const sw = await form('/company/switch', { csrf, entity_id: String(app.ids.entityId) }, cookie);
  assert.equal(sw.status, 404, 'can’t switch to company A');
  assert.equal((await get(`/customers/${app.ids.customers.redriver}`)).status, 404, 'can’t open company A’s customer');
  // The admin opens their access to all companies: they can switch now.
  const u = (await app.db.pool.query(`SELECT user_id FROM app_user WHERE email = 'bea@sample.example'`)).rows[0].user_id;
  const all = await app.post(`/settings/users/${u}`, { name: 'Bea Bookkeeper', email: 'bea@sample.example', role: 'standard', companyAccess: '1', allCompanies: '1' });
  assert.equal(all.status, 303);
  assert.equal((await form('/company/switch', { csrf, entity_id: String(app.ids.entityId) }, cookie)).status, 303);
  assert.ok((await (await get('/customers')).text()).includes(`href="/customers/${app.ids.customers.redriver}"`), 'company A open now');
});

test('an admin must give a person at least one company', async () => {
  const res = await app.post('/settings/users', { name: 'No Co', email: 'noco@sample.example', role: 'standard', companyAccess: '1' });
  assert.equal(res.status, 422);
  assert.match(await res.text(), /Choose at least one company/);
});
