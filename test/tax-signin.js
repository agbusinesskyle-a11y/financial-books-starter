// test/tax-signin.js — sign in as an invited person (role, optional company list) on a running test app (test/app-harness.js).
// The same steps as test/tax-routes.test.js's local helper; not a test file. csrfFrom: a page of the app that carries a csrf field.
import assert from 'node:assert/strict';
import { makeTotp } from '../lib/auth.js';

export async function signInAs(app, { name, email, role, companyIds = null, csrfFrom }) {
  const p = new URLSearchParams({ name, email, role });
  if (companyIds) { p.set('companyAccess', '1'); for (const id of companyIds) p.append('company', String(id)); }
  const invite = await app.post('/settings/users', p);
  assert.equal(invite.status, 200, await invite.clone().text());
  const invitePath = /\/invite\/([A-Za-z0-9_-]{43})/.exec(await invite.text())[0];
  const pageRes = await fetch(app.base + invitePath);
  const cookieOf = res => (res.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).filter(c => !/=$/.test(c)).join('; ');
  const html = await pageRes.text();
  const nonce = /name="nonce" value="([^"]+)"/.exec(html)[1];
  const secret = /class="secret">([A-Z2-7 ]+)</.exec(html)[1].replace(/ /g, '');
  app.advance(30_000);
  const rawPost = (path, body, cookie) => fetch(app.base + path, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
  const done = await rawPost(invitePath, { nonce, password: 'correct horse battery', password2: 'correct horse battery', code: makeTotp(secret).generate({ timestamp: app.clock() }) }, cookieOf(pageRes));
  assert.equal(done.status, 303);
  const cookie = cookieOf(done).split('; ').find(c => c.startsWith('fb_session='));
  const get = path => fetch(app.base + path, { redirect: 'manual', headers: { cookie } });
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(await (await get(csrfFrom)).text())[1];
  return { get, post: (path, body) => rawPost(path, { csrf, ...body }, cookie) };
}
