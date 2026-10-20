import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { startApp } from './app-harness.js';
import { freshDb } from './harness.js';
import { mvOrg, mvUser, signInAs, mvCompleteSetup } from './morning-fixtures.js';
import { trustedActor, validateActorIn, validateMorningIdentityIn } from '../lib/data/morning/access.js';
import { grantSecondViewer, secondViewer } from '../lib/data/morning/identity.js';
import { resetSignIn, resendInvite, updateUser, setUserActive, sessionUser } from '../lib/data/users.js';
import { setUserCompanies } from '../lib/data/companies.js';
import { saveDeliverySettings } from '../lib/data/morning/settings.js';
import { createApp } from '../services/app/index.js';
import { settingsKey } from '../lib/secrets.js';
import { runDailyJobs } from '../services/jobs/index.js';

async function fixture(t, { designated = true, beforeStart, afterAuth } = {}) {
  let account, f;
  const observed = new Map(), sent = [];
  const app = await startApp({
    env: { SETTINGS_KEY: 'ab'.repeat(32), APP_BASE_URL: 'https://books.sample.example',
      ...(designated ? { APP_OWNER_USER_ID: '1' } : {}) },
    mailer: { kind: 'smtp', from: 'books@sample.example', async send(m) { sent.push(m); return { status: 'sent' }; } },
    seed: async db => {
      f = await mvOrg(db, { slug: 'sample' });
      account = await mvUser(db, { orgId: f.orgId, email: 'owner@sample.example', role: 'reports', allCompanies: false });
      assert.equal(account.userId, 1);
      // Ordinary access to one company lets the pre-feature fixture sign in successfully.
      await db.query('INSERT INTO app_user_company (org_id,user_id,entity_id) VALUES ($1,$2,$3)',
        [f.orgId, account.userId, f.entities['Sample company A']]);
      await beforeStart?.(db, f, account);
      return { ...f, entityId: f.entities['Sample company A'] };
    },
    onAuthenticatedForTest: async info => {
      observed.set(info.session.userId, info);
      await afterAuth?.(info);
    },
  });
  t.after(() => app.close());
  const db = app.db.pool, orgId = f.orgId;
  const client = await signInAs(app, { ...account, email: 'owner@sample.example' });
  const info = observed.get(account.userId);
  const identity = trustedActor(info.who, orgId, client.session, designated ? account.userId : null);
  const owner = trustedActor({ owner: true }, orgId, app.ownerSession, designated ? account.userId : null);
  return { app, db, orgId, f, account, client, identity, owner, info, sent, key: settingsKey(app.env) };
}

async function scheduleOwnerReport(c, reportKey = 'balance_sheet') {
  const saved = await c.client.post(`/reports/r/${reportKey}/save`, { q: 'period=today&run=1', name: 'Sample owner schedule', mode: 'new' });
  assert.equal(saved.status, 303);
  const s = (await c.db.query('SELECT * FROM saved_report ORDER BY saved_id DESC LIMIT 1')).rows[0];
  assert.equal(s.owner_key, String(c.account.userId), 'saved reports retain the numeric account identity');
  assert.equal((await c.client.post(`/reports/saved/${s.saved_id}/edit`, {
    name: s.name, freq: 'daily', to: 'recipient@sample.example', format: 'csv',
  })).status, 303);
  return s.saved_id;
}

test('daily jobs email the designated account reports using its effective owner role', async t => {
  const c = await fixture(t);
  const ids = [await scheduleOwnerReport(c), await scheduleOwnerReport(c, 'audit_log')];
  const sent = [];
  const run = () => runDailyJobs({ pool: c.db, env: c.app.env, now: () => new Date('2026-10-13T17:00:00Z'),
    mailer: { async send(message) { sent.push(message); return { status: 'sent' }; } } });
  const result = await run();
  assert.equal(result.reportsSent, 2);
  assert.equal(result.reportsFailed, 0);
  assert.equal(sent.length, 2);
  assert.ok(sent.every(m => m.to === 'recipient@sample.example' && m.attachments[0].filename.endsWith('.csv')));
  const rows = (await c.db.query('SELECT owner_key,sched_freq,sched_next,last_error,last_sent_at FROM saved_report WHERE saved_id=ANY($1)', [ids])).rows;
  assert.equal(rows.length, 2);
  for (const s of rows) {
    assert.equal(s.owner_key, String(c.account.userId));
    assert.equal(s.sched_freq, 'daily');
    assert.equal(s.sched_next, '2026-10-14');
    assert.equal(s.last_error, null);
    assert.ok(s.last_sent_at);
  }
  assert.equal((await run()).reportsSent, 0, 'not twice on the same day');
});

test('scheduled owner authority requires the server designation, APP_ORG, active account and credentials', async t => {
  const c = await fixture(t);
  const savedId = await scheduleOwnerReport(c, 'audit_log');
  const original = (await c.db.query('SELECT * FROM app_user WHERE user_id=$1', [c.account.userId])).rows[0];
  const foreign = await mvOrg(c.db, { slug: 'foreign' });
  const other = await mvUser(c.db, { orgId: c.orgId, email: 'other@sample.example', role: 'reports' });
  const foreignUser = await mvUser(c.db, { orgId: foreign.orgId, email: 'foreign@sample.example', role: 'reports' });
  const cases = [
    { name: 'unset designation', env: { APP_OWNER_USER_ID: undefined } },
    { name: 'another account designated', env: { APP_OWNER_USER_ID: String(other.userId) } },
    { name: 'another configured organization', env: { APP_ORG: 'foreign' } },
    { name: 'missing configured organization', env: { APP_ORG: 'missing' } },
    { name: 'foreign report owner', env: { APP_OWNER_USER_ID: String(foreignUser.userId) }, ownerKey: String(foreignUser.userId) },
    { name: 'inactive account with stored admin role', active: false },
    { name: 'reset credentials with stored admin role', password: null, totp: null },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    // Inactive and reset accounts must be refused even when their stored role would permit sending.
    await c.db.query('UPDATE app_user SET role=$2,active=$3,password_hash=$4,totp_enc=$5 WHERE user_id=$1',
      [c.account.userId, scenario.env ? 'reports' : 'admin', scenario.active ?? true,
        Object.hasOwn(scenario, 'password') ? scenario.password : original.password_hash,
        Object.hasOwn(scenario, 'totp') ? scenario.totp : original.totp_enc]);
    await c.db.query("UPDATE saved_report SET owner_key=$2,sched_freq='daily',sched_next='2026-10-13',last_error=NULL WHERE saved_id=$1",
      [savedId, scenario.ownerKey ?? String(c.account.userId)]);
    const sent = [];
    const result = await runDailyJobs({ pool: c.db, env: { ...c.app.env, ...scenario.env }, now: () => new Date('2026-10-13T17:00:00Z'),
      mailer: { async send(message) { sent.push(message); return { status: 'sent' }; } } });
    assert.equal(result.reportsSent, 0);
    assert.equal(result.reportsFailed, 1);
    assert.equal(sent.length, 0);
    const row = (await c.db.query('SELECT owner_key,sched_freq,sched_next,last_error FROM saved_report WHERE saved_id=$1', [savedId])).rows[0];
    assert.equal(row.owner_key, scenario.ownerKey ?? String(c.account.userId));
    assert.equal(row.sched_freq, 'none');
    assert.equal(row.sched_next, null);
    assert.match(row.last_error, /can no longer email/);
  });
});

test('designated email account is owner with full access and owner-only Morning controls', async t => {
  const c = await fixture(t);
  assert.equal(c.info.who.owner, true);
  assert.equal(c.info.who.role, 'admin');
  assert.equal(c.info.who.allCompanies, true);
  assert.equal(c.info.who.canApproveBills, true);
  assert.equal(c.identity.owner, true);
  assert.equal(c.identity.userId, c.account.userId, 'account identity must survive owner promotion');
  assert.equal(c.identity.viewerKey, 'owner');
  for (const path of ['/morning', '/settings/users', '/settings/companies', '/settings/company', '/settings/morning']) {
    const res = await c.client.get(path);
    assert.equal(res.status, 200, `${path}: ${await res.text()}`);
  }
  const companyB = c.f.entities['Sample company B'];
  assert.equal((await c.client.post('/company/switch', { entity_id: companyB })).status, 303);
  assert.equal((await c.client.post('/settings/morning/company-threshold', { entity_id: companyB, threshold: '125.00' })).status, 303);
  assert.equal((await c.client.post('/settings/morning/delivery', { enabled: '1' })).status, 303);
  assert.equal((await c.db.query('SELECT large_threshold_cents FROM morning_company_setting WHERE entity_id=$1', [companyB])).rows[0].large_threshold_cents, 12500);
  assert.equal(await secondViewer(c.db, c), null);
});

test('email and blank-email owner share observations, preferences and dismissals', async t => {
  const c = await fixture(t);
  assert.equal((await c.app.get('/morning')).status, 200);
  const visit = async () => (await c.db.query('SELECT * FROM morning_visit WHERE org_id=$1', [c.orgId])).rows;
  const first = await visit();
  c.app.advance(61 * 60_000);
  assert.equal((await c.client.get('/morning')).status, 200);
  const second = await visit();
  assert.equal(second.length, 1);
  assert.equal(second[0].viewer_key, 'owner');
  assert.equal(second[0].comparison_generation_id, first[0].latest_generation_id);
  c.app.advance(61 * 60_000);
  assert.equal((await c.app.get('/morning')).status, 200);
  assert.equal((await visit())[0].comparison_generation_id, second[0].latest_generation_id);
  assert.equal((await c.client.post('/settings/morning/preferences', {
    send_time: '07:15', channel: 'email', email: 'owner@sample.example', detail_threshold: '123.00',
  })).status, 303);
  assert.match(await (await c.app.get('/settings/morning')).text(), /07:15/);
  await c.db.query("INSERT INTO morning_dismissal(org_id,viewer_key,item_key,item_version,rule_version,note) VALUES ($1,'owner','bill:1',$2,1,'sample dismissal')", [c.orgId, 'a'.repeat(64)]);
  assert.equal((await c.client.post('/morning/undismiss', { item_key: 'bill:1' })).status, 303);
  assert.equal((await c.db.query('SELECT count(*)::int n FROM morning_dismissal')).rows[0].n, 0);
});

test('designated owner keeps account navigation when opening Morning View', async t => {
  const c = await fixture(t);
  assert.equal((await c.client.post('/bookmarks/add', { href: '/reports', label: 'Sample owner reports' })).status, 303);
  assert.match(await (await c.client.get('/home')).text(), /Sample owner reports/);
  assert.match(await (await c.client.get('/morning')).text(), /Sample owner reports/);
  assert.doesNotMatch(await (await c.app.get('/morning')).text(), /Sample owner reports/);
});

test('ordinary admins cannot change the designated account through routes or shared writes', async t => {
  const c = await fixture(t);
  const admin = await mvUser(c.db, { orgId: c.orgId, email: 'admin@sample.example', role: 'admin' });
  const client = await signInAs(c.app, { ...admin, email: 'admin@sample.example' });
  const actorCtx = trustedActor(await sessionUser(c.db, client.session), c.orgId, client.session, c.account.userId);
  const args = { orgId: c.orgId, userId: c.account.userId, actorCtx, key: c.key,
    fields: { name: 'the owner', email: 'changed@sample.example', role: 'admin' }, active: false, all: true };
  const row = async () => (await c.db.query('SELECT * FROM app_user WHERE user_id=$1', [c.account.userId])).rows[0];
  const before = await row();
  for (const suffix of ['/reset', '/resend', '/deactivate', '/activate', '']) {
    const res = await client.post(`/settings/users/${c.account.userId}${suffix}`, {
      name: 'the owner', email: 'changed@sample.example', role: 'admin', allCompanies: '1',
    });
    assert.equal(res.status, 403, suffix || 'edit');
    assert.match(await res.text(), /Only the owner/);
    assert.deepEqual(await row(), before);
  }
  for (const fn of [resetSignIn, resendInvite, updateUser, setUserActive, setUserCompanies]) {
    await assert.rejects(fn(c.db, args), /Only the owner/);
    assert.deepEqual(await row(), before);
  }
  assert.equal((await client.post(`/settings/users/${c.account.userId}/delete`)).status, 404, 'there is no user-delete route');
  const page = await (await client.get(`/settings/users/${c.account.userId}`)).text();
  assert.match(page, /Owner account/);
  assert.doesNotMatch(page, /action="\/settings\/users\/1(?:\/[^"]*)?"/);
  assert.match(await (await client.get('/settings/users')).text(), /Owner account/);
  assert.equal(c.sent.length, 0);
});

test('either owner form may edit the account and recover its setup without taking the second slot', async t => {
  const c = await fixture(t);
  const fields = { name: 'the owner', email: 'owner@sample.example', role: 'reports', allCompanies: '1' };
  assert.equal((await c.client.post(`/settings/users/${c.account.userId}`, fields)).status, 303);
  const reset = await c.client.post(`/settings/users/${c.account.userId}/reset`);
  assert.equal(reset.status, 200);
  assert.match(await reset.text(), /It was not emailed/);
  assert.equal((await c.client.get('/morning')).status, 303);
  const resend = await c.app.post(`/settings/users/${c.account.userId}/resend`);
  assert.equal(resend.status, 200);
  const token = /\/invite\/([A-Za-z0-9_-]{43})/.exec(await resend.text())[1];
  const done = await mvCompleteSetup(c.app, { token });
  assert.equal((await fetch(c.app.base + '/morning', { headers: { cookie: done.cookie }, redirect: 'manual' })).status, 200);
  assert.equal(await secondViewer(c.db, c), null);
  assert.equal(c.sent.length, 0);
  assert.equal((await c.app.post(`/settings/users/${c.account.userId}/deactivate`)).status, 303);
  assert.equal((await c.app.get('/morning')).status, 200, 'break-glass survives account deactivation');
});

test('owner account cannot be granted as second viewer and is absent from candidates', async t => {
  const c = await fixture(t);
  const viewer = await mvUser(c.db, { orgId: c.orgId, email: 'viewer@sample.example' });
  const args = { orgId: c.orgId, actorCtx: c.owner, key: c.key, now: new Date(c.app.clock()) };
  await grantSecondViewer(c.db, { ...args, userId: viewer.userId });
  await assert.rejects(grantSecondViewer(c.db, { ...args, userId: c.account.userId }), /owner account/i);
  assert.equal((await secondViewer(c.db, c)).userId, viewer.userId);
  const res = await c.client.post('/settings/morning/viewer', { action: 'grant', user_id: c.account.userId });
  assert.equal(res.status, 422);
  assert.equal((await secondViewer(c.db, c)).userId, viewer.userId);
  const page = await (await c.app.get('/settings/morning')).text();
  const candidates = /<select name="user_id">([\s\S]*?)<\/select>/.exec(page)[1];
  assert.doesNotMatch(candidates, new RegExp(`<option value="${c.account.userId}">`));
});

test('designation retires any existing second-viewer membership for the owner account', async t => {
  const c = await fixture(t, { beforeStart: async (db, f, account) => {
    await db.query("INSERT INTO morning_viewer(org_id,viewer_key,user_id,enrollment_state) VALUES ($1,$2,$3,'ready')", [f.orgId, String(account.userId), account.userId]);
    await db.query('INSERT INTO morning_preference(org_id,viewer_key,membership_epoch) VALUES ($1,$2,1)', [f.orgId, String(account.userId)]);
  } });
  assert.equal(await secondViewer(c.db, c), null);
  assert.equal((await c.client.get('/morning')).status, 200);
  assert.equal((await c.db.query("SELECT count(*)::int n FROM morning_preference WHERE viewer_key<>'owner'")).rows[0].n, 0);
});

for (const [name, change, reason] of [
  ['stale version', 'signin_version=signin_version+1', 'stale_session'],
  ['inactive', 'active=false', 'stale_session'],
  ['missing password and TOTP', 'password_hash=NULL,totp_enc=NULL', 'stale_session'],
  ['wrong organization', 'org_id=$2', 'foreign_org'],
]) test(`owner account ${name} is refused by request and operation revalidation`, async t => {
  const c = await fixture(t);
  assert.equal(c.identity.owner, true, 'exercise owner-by-account, never a downgraded ordinary actor');
  const foreign = await mvOrg(c.db, { slug: 'foreign' });
  if (name === 'wrong organization') await c.db.query('DELETE FROM app_user_company WHERE user_id=$1', [c.account.userId]);
  await c.db.query(`UPDATE app_user SET ${change} WHERE user_id=$1`, name === 'wrong organization' ? [c.account.userId, foreign.orgId] : [c.account.userId]);
  await assert.rejects(validateActorIn(c.db, c.identity), e => e.reason === reason);
  await assert.rejects(validateMorningIdentityIn(c.db, { identity: c.identity, ownerOnly: true }), e => e.reason === reason);
  await assert.rejects(saveDeliverySettings(c.db, { actorCtx: c.identity, enabled: true }), e => e.reason === reason);
  const response = await c.client.get('/morning');
  assert.equal(response.status, 303);
  assert.match(response.headers.get('location'), /^\/login/);
  assert.equal((await c.app.get('/morning')).status, 200);
});

test('unset designation keeps email accounts ordinary and blank-email owner working', async t => {
  const c = await fixture(t, { designated: false });
  assert.equal(c.info.who.owner, undefined);
  assert.equal(c.identity.owner, false);
  assert.equal((await c.client.get('/morning')).status, 403);
  assert.equal((await c.client.get('/settings/users')).status, 403);
  assert.equal((await c.app.get('/morning')).status, 200);
  assert.equal((await c.app.get('/settings/users')).status, 200);
});

test('malformed APP_OWNER_USER_ID refuses app construction with a clear error', async t => {
  const db = await freshDb();
  t.after(() => db.drop());
  for (const value of ['', '0', '-1', '1.5', '1e2', ' 1 ', 'abc', '9007199254740992']) {
    assert.throws(() => createApp({ pool: db.pool, env: { APP_OWNER_USER_ID: value } }), /APP_OWNER_USER_ID/, JSON.stringify(value));
  }
});

async function startup(env) {
  const child = spawn(process.execPath, ['services/app/index.js'], {
    cwd: process.cwd(), env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      RUN_JOBS: '0', BANK_PULLS: '0', PORT: '0', HOST: '127.0.0.1', ALLOW_SUPERUSER: '1', ...env },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  // Terminate only this test's own child if the old implementation starts listening.
  const append = chunk => { output += chunk; if (/listening on/.test(output)) child.kill(); };
  child.stdout.on('data', append); child.stderr.on('data', append);
  const timer = setTimeout(() => child.kill(), 15000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  clearTimeout(timer);
  return { code, output };
}

test('invalid designation refuses actual startup before listening', async t => {
  const db = await freshDb();
  t.after(() => db.drop());
  const org = await mvOrg(db.pool, { slug: 'sample' });
  const foreign = await mvOrg(db.pool, { slug: 'foreign' });
  const user = await mvUser(db.pool, { orgId: foreign.orgId, email: 'foreign@sample.example' });
  for (const value of ['bad', '999999', String(user.userId)]) {
    const result = await startup({ DATABASE_URL: db.url, APP_ORG: 'sample', APP_OWNER_USER_ID: value });
    assert.notEqual(result.code, 0);
    assert.doesNotMatch(result.output, /listening on/);
    assert.match(result.output, /APP_OWNER_USER_ID/);
  }
  assert.ok(org.orgId);
});
