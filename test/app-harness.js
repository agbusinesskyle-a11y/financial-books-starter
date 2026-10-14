import http from 'node:http';
import bcrypt from 'bcryptjs';
import * as OTPAuth from 'otpauth';
import { freshDb } from './harness.js';
import { generateSample } from '../lib/seed/generate.js';
import { writeSample } from '../lib/data/seed.js';
import { createApp } from '../services/app/index.js';
import { makeTotp } from '../lib/auth.js';

// A running app over a seeded throwaway database, plus a signed-in HTTP client.
export async function startApp({ asOf = '2026-10-12', now = new Date('2026-10-12T17:00:00Z'), mailer, env: moreEnv = {}, makeTransport, ledgerline = null, aiFetch, smsFetch } = {}) {
  const password = 'test password';
  const totpSecret = new OTPAuth.Secret({ size: 20 }).base32;
  const env = { APP_LOGIN_PASSWORD_HASH: bcrypt.hashSync(password, 4), APP_TOTP_SECRET: totpSecret, ...moreEnv };
  const db = await freshDb();
  const ids = await writeSample(db.pool, generateSample({ asOf }));
  let clock = now.getTime();
  const server = http.createServer(createApp({ pool: db.pool, env, now: () => new Date(clock), ...(mailer ? { mailer } : {}), makeTransport, ledgerline, aiFetch, smsFetch }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const cookieOf = res => (res.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ');
  const rawGet = (path, cookie = '') => fetch(base + path, { redirect: 'manual', headers: { cookie } });
  const rawPost = (path, body, cookie = '') => fetch(base + path, {
    method: 'POST', redirect: 'manual', body: body instanceof URLSearchParams ? body.toString() : new URLSearchParams(body).toString(),
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  });

  const loginPage = await rawGet('/login');
  const challenge = /name="challenge" value="([0-9a-f]+)"/.exec(await loginPage.text())[1];
  clock += 30_000;
  const res = await rawPost('/login', { challenge, password, code: makeTotp(totpSecret).generate({ timestamp: clock }), next: '/customers' }, cookieOf(loginPage));
  if (res.status !== 303) throw new Error(`login failed: ${res.status}`);
  const cookie = cookieOf(res);
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(await (await rawGet('/customers', cookie)).text())[1];

  return {
    db, ids, csrf, base, env,
    clock: () => clock,
    advance: ms => { clock += ms; },
    get: path => rawGet(path, cookie),
    raw: (path, init = {}) => fetch(base + path, { redirect: 'manual', ...init, headers: { cookie, ...init.headers } }),
    // body: object or URLSearchParams; csrf added unless body.csrf === null.
    post: (path, body = {}) => {
      const params = body instanceof URLSearchParams ? body : new URLSearchParams(Object.entries(body).filter(([, v]) => v !== null));
      if (!params.has('csrf') && body.csrf !== null) params.set('csrf', csrf);
      return rawPost(path, params, cookie);
    },
    async close() { await new Promise(resolve => server.close(resolve)); await db.drop(); },
  };
}
