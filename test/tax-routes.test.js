// test/tax-routes.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './app-harness.js';
import { canAccess } from '../lib/domain/roles.js';
import { appNav, GROUPS } from '../lib/views/nav.js';
import { createCompany } from '../lib/data/companies.js';
import { openPeriod, saveProfile } from '../lib/tax/periods.js';
import { makeTotp } from '../lib/auth.js';

let app, pool, S;
const errorOf = async res => (/role="alert">([^<]*)</.exec(await res.clone().text()) ?? [])[1] ?? '';
before(async () => { app = await startApp({ env: { SETTINGS_KEY: 'ab'.repeat(32) } }); pool = app.db.pool; S = { orgId: app.ids.orgId, entityId: app.ids.entityId }; });
after(async () => { await app.close(); });

// The admin owner invites a person and we finish the invite as them (the invite page shows the link even without a mailer).
// Returns a signed-in session: get/post on the app as that person, with the csrf token read from the profile page.
async function signInAs({ name, email, role, companyIds = null }) {
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
  const profilePage = await (await get(`/tax/${S.entityId}/profile`)).text();
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(profilePage)[1];
  return { get, post: (path, body) => rawPost(path, { csrf, ...body }, cookie), profilePage };
}

test('menu and roles: Tax sits in Accounting; everyone who keeps books sees it; standard users only read it; reports-only may edit tax setup (where the company allows); shared parties and finalization are admin-only', () => {
  assert.ok(GROUPS.find(g => g.key === 'accounting').items.some(i => i.href === '/tax'));
  for (const [role, see, edit, admin] of [['admin', true, true, true], ['standard', true, false, false], ['reports', true, true, false], ['customers', false, false, false], ['vendors', false, false, false]]) {
    assert.equal(canAccess(role, 'GET', '/tax'), see, `${role} sees`);
    assert.equal(canAccess(role, 'GET', `/tax/${S.entityId}/profile`), see, `${role} opens profile`);
    assert.equal(canAccess(role, 'POST', `/tax/${S.entityId}/profile`), edit, `${role} edits`);
    assert.equal(canAccess(role, 'POST', `/tax/${S.entityId}/activities`), edit, `${role} adds activities`);
    // Spec §11: shared parties (tax_party) are edited only by org admins; the route then also asks for ctx.orgAdmin.
    assert.equal(canAccess(role, 'POST', `/tax/${S.entityId}/parties`), admin, `${role} edits parties`);
    assert.equal(canAccess(role, 'POST', `/tax/${S.entityId}/2025/final`), admin, `${role} finalizes`);
    const nav = appNav({ role, can: p => canAccess(role, 'GET', p), path: '/home', search: '', title: 'Home', csrf: 'x', entityName: 'Co', bookmarks: [], pins: undefined });
    assert.equal(String(nav.panel).includes('href="/tax"'), see, `${role} menu`);
  }
});

test('/tax lists every company the person may open with its tax setup; computed parts say not yet available', async () => {
  await createCompany(pool, { orgId: S.orgId, name: 'Second Ranch', timeZone: 'America/Chicago' });
  const body = await (await app.get('/tax')).text();
  for (const s of ['Sample Feed Co.', 'Second Ranch', 'Not set up', 'Not yet available', `href="/tax/${S.entityId}/profile"`]) assert.ok(body.includes(s), `page shows ${s}`);
  assert.doesNotMatch(body, /\$[0-9]/, 'no computed amounts in T1');
});

test('the profile page saves defaults, parties, activities and opens a period; refusals come back as 422 with the reason', async () => {
  let res = await app.post(`/tax/${S.entityId}/profile`, { return_type: 'form_1065', tax_method: 'cash', book_basis: 'accrual', state_codes: 'AZ', business_code: '459990', date_started: '2022-09-14', reason: 'as filed', accountant_may_edit: '1' });
  assert.equal(res.status, 303, await errorOf(res));
  let page = await (await app.get(`/tax/${S.entityId}/profile`)).text();
  assert.match(page, /<option value="form_1065" selected/);
  res = await app.post(`/tax/${S.entityId}/profile`, { return_type: 'form_1120s', tax_method: 'cash', book_basis: 'accrual', state_codes: '', business_code: '', date_started: '', reason: '', accountant_may_edit: '1' });
  assert.equal(res.status, 422); assert.match(await errorOf(res), /reason/);
  res = await app.post(`/tax/${S.entityId}/parties`, { kind: 'individual', name: 'Pat Owner', tax_id: '' });
  assert.equal(res.status, 303, await errorOf(res));
  res = await app.post(`/tax/${S.entityId}/activities`, { kind: 'holding', name: 'Own activity', schedule: 'p1', from: '2017-01-05', to: '', disposed_on: '' });
  assert.equal(res.status, 303, await errorOf(res));
  res = await app.post(`/tax/${S.entityId}/periods`, { year: '2025', initial: '' });
  assert.equal(res.status, 303, await errorOf(res));
  page = await (await app.get(`/tax/${S.entityId}/profile`)).text();
  for (const s of ['Pat Owner', 'Own activity', '2025', 'Owners and capital', 'available in a later stage']) assert.ok(page.includes(s), s);
  // Another company's profile is not reachable through this company's path, and an unknown company is a 404.
  assert.equal((await app.get('/tax/999999/profile')).status, 404);
});

// Spec §11: every cross-company reference made through a parent return needs access to the child company. The dropdowns offer
// only the companies the person may open; the server refuses a forged id all the same. Shared parties are org-admin only.
test('a person limited to some companies cannot include a company they may not open, and does not edit the shared parties', async () => {
  const hidden = await createCompany(pool, { orgId: S.orgId, name: 'Hidden Holdings', timeZone: 'America/Chicago' });
  await openPeriod(pool, { orgId: S.orgId, entityId: hidden, year: 2025, actor: 'test', profile: { returnType: 'disregarded', taxMethodDefault: 'cash', bookBasisDefault: 'accrual' } });
  const { rows: [ret] } = await pool.query('SELECT return_id FROM tax_return WHERE org_id = $1 AND entity_id = $2', [S.orgId, S.entityId]);
  const { rows: [act] } = await pool.query('SELECT activity_id FROM tax_activity WHERE org_id = $1 AND return_entity_id = $2', [S.orgId, S.entityId]);
  // An admin who may open only company A (so not an org admin).
  const lim = await signInAs({ name: 'Lim Ited', email: 'lim@sample.example', role: 'admin', companyIds: [S.entityId] });
  assert.ok(!lim.profilePage.includes('Hidden Holdings'), 'the dropdowns do not offer the hidden company');
  assert.ok(!lim.profilePage.includes(`action="/tax/${S.entityId}/parties"`), 'no Add party form for someone who is not an org admin');
  assert.ok(lim.profilePage.includes(`action="/tax/${S.entityId}/activities"`), 'the company-limited admin still gets the activity form');
  // Forged POSTs name the hidden company: refused as not found, and nothing is written.
  let res = await lim.post(`/tax/${S.entityId}/inclusions`, { return_id: String(ret.return_id), activity_id: String(act.activity_id), source_entity_id: String(hidden) });
  assert.equal(res.status, 404, 'inclusion of a company the person cannot open');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM activity_inclusion WHERE org_id = $1', [S.orgId])).rows[0].n, 0);
  // Shared parties are not this person's to edit at all (spec §11): refused before any company check, and nothing is written.
  const partiesBefore = (await pool.query('SELECT count(*)::int AS n FROM tax_party WHERE org_id = $1', [S.orgId])).rows[0].n;
  res = await lim.post(`/tax/${S.entityId}/parties`, { kind: 'individual', name: 'Not Allowed', tax_id: '' });
  assert.equal(res.status, 403, 'a company-limited admin adding a party');
  res = await lim.post(`/tax/${S.entityId}/parties`, { kind: 'entity_in_org', name: 'Hidden Holdings', tax_id: '', entity_id: String(hidden) });
  assert.equal(res.status, 403, 'party pointed at a company the person cannot open');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM tax_party WHERE org_id = $1', [S.orgId])).rows[0].n, partiesBefore);
  // The admin owner, who may open every company, makes the same inclusion and party: the fixtures themselves are valid.
  res = await app.post(`/tax/${S.entityId}/inclusions`, { return_id: String(ret.return_id), activity_id: String(act.activity_id), source_entity_id: String(hidden) });
  assert.equal(res.status, 303, await errorOf(res));
  res = await app.post(`/tax/${S.entityId}/parties`, { kind: 'entity_in_org', name: 'Hidden Holdings', tax_id: '', entity_id: String(hidden) });
  assert.equal(res.status, 303, await errorOf(res));
});

// Spec §11: the accountant (reports role) writes tax setup only where the company says accountant_may_edit.
test('the accountant edits tax setup only while the company allows it: 403 when the admin unchecks the flag, 303 once it is checked again', async () => {
  const acct = await signInAs({ name: 'Ann Accountant', email: 'ann@sample.example', role: 'reports' });
  const profile = { return_type: 'form_1065', tax_method: 'cash', book_basis: 'accrual', state_codes: 'AZ', business_code: '459990', date_started: '2022-09-14', reason: '', accountant_may_edit: '1' };
  // The admin turns the flag off (same reviewed fields; the flag alone changes, so no reason is needed).
  let res = await app.post(`/tax/${S.entityId}/profile`, { ...profile, accountant_may_edit: '' });
  assert.equal(res.status, 303, await errorOf(res));
  let page = await (await acct.get(`/tax/${S.entityId}/profile`)).text();
  assert.ok(!page.includes('class="primary">Save'), 'no Save button for the accountant while the flag is off');
  assert.ok(!page.includes(`action="/tax/${S.entityId}/activities"`), 'no activity form for the accountant while the flag is off');
  res = await acct.post(`/tax/${S.entityId}/profile`, { ...profile, state_codes: 'AZ, NM' });
  assert.equal(res.status, 403, 'the accountant may not save while the flag is off');
  assert.match(await res.text(), /does not let the accountant change its tax setup/);
  res = await acct.post(`/tax/${S.entityId}/activities`, { kind: 'holding', name: 'Accountant activity', schedule: 'p1', from: '2017-01-05', to: '', disposed_on: '' });
  assert.equal(res.status, 403, 'nor add an activity');
  assert.equal((await pool.query('SELECT accountant_may_edit, state_codes FROM tax_profile WHERE org_id = $1 AND entity_id = $2', [S.orgId, S.entityId])).rows[0].accountant_may_edit, false, 'nothing written');
  // The admin turns the flag back on: the accountant's save goes through, and the flag itself is not something the accountant can flip.
  res = await app.post(`/tax/${S.entityId}/profile`, profile);
  assert.equal(res.status, 303, await errorOf(res));
  page = await (await acct.get(`/tax/${S.entityId}/profile`)).text();
  assert.ok(page.includes('class="primary">Save'), 'the Save button is back');
  assert.ok(!page.includes('name="accountant_may_edit"'), 'the accountant\'s page has no accountant_may_edit input');
  // The accountant posts the flag unchecked (an empty value, as a missing checkbox would): the stored grant stays true.
  res = await acct.post(`/tax/${S.entityId}/profile`, { ...profile, state_codes: 'AZ, NM', accountant_may_edit: '' });
  assert.equal(res.status, 303, await errorOf(res));
  const saved = (await pool.query('SELECT state_codes, accountant_may_edit FROM tax_profile WHERE org_id = $1 AND entity_id = $2', [S.orgId, S.entityId])).rows[0];
  assert.deepEqual(saved.state_codes, ['AZ', 'NM']);
  assert.equal(saved.accountant_may_edit, true, 'the accountant cannot revoke or grant the flag');
  // And the accountant's save does not lock them out: the page still offers Save afterwards.
  page = await (await acct.get(`/tax/${S.entityId}/profile`)).text();
  assert.ok(page.includes('class="primary">Save'), 'still editable after the accountant saved');
  // Shared parties stay admin-only even for an accountant the company trusts.
  res = await acct.post(`/tax/${S.entityId}/parties`, { kind: 'individual', name: 'Not Allowed', tax_id: '' });
  assert.equal(res.status, 403, 'the accountant does not edit shared parties');
});

test('a successful tax save tells the dispatcher the request is handled, so no later route runs after the redirect', async () => {
  const { taxRoutes } = await import('../services/app/tax-routes.js');
  const redirects = [];
  const h = { req: { method: 'POST' }, path: `/tax/${S.entityId}/activities`, pool, env: {}, actor: 'test', who: { role: 'admin' },
    form: new URLSearchParams({ kind: 'holding', name: 'Handled once', schedule: 'p1', from: '2018-02-01', to: '', disposed_on: '' }),
    ctx: { orgId: S.orgId, orgAdmin: true, companies: [{ entityId: S.entityId, name: 'Sample' }] },
    go: (...a) => { redirects.push(a); }, page: () => assert.fail('no page on success'), base: () => ({}), takeFlash: () => null };
  assert.equal(await taxRoutes(h), true);
  assert.equal(redirects.length, 1);
  assert.equal(redirects[0][0], `/tax/${S.entityId}/profile`);
});

// Codex t1-r1 B8: the page shows a requested first year as requested (openings unknown) and offers verification to admins only.
test('an initial period shows as requested until an admin verifies it; only admins see and use the verification', async () => {
  const fresh = await createCompany(pool, { orgId: S.orgId, name: 'Fresh Start Co', timeZone: 'America/Chicago' });
  const r = await openPeriod(pool, { orgId: S.orgId, entityId: fresh, year: 2025, initial: true, periodStart: '2025-04-01', actor: 'test', profile: { returnType: 'form_1065' } });
  const verifyAction = `action="/tax/${fresh}/periods/${r}/initial"`;
  let page = await (await app.get(`/tax/${fresh}/profile`)).text();
  assert.match(page, /Initial \(requested\)/);
  assert.match(page, /openings unknown/i);
  assert.ok(page.includes(verifyAction), 'the admin is offered the verification');
  for (const role of ['standard', 'reports']) assert.equal(canAccess(role, 'POST', `/tax/${fresh}/periods/${r}/initial`), false, `${role} may not verify`);
  assert.equal(canAccess('admin', 'POST', `/tax/${fresh}/periods/${r}/initial`), true);
  const acct = await signInAs({ name: 'Vera Accountant', email: 'vera@sample.example', role: 'reports' });
  assert.ok(!(await (await acct.get(`/tax/${fresh}/profile`)).text()).includes(verifyAction), 'the accountant is not offered the verification');
  assert.equal((await acct.post(`/tax/${fresh}/periods/${r}/initial`, { evidence: 'Articles' })).status, 403);
  // Evidence is required, and the company's start date must be on file as the period's first day (Codex t1-r2 B8).
  let res = await app.post(`/tax/${fresh}/periods/${r}/initial`, { evidence: '' });
  assert.equal(res.status, 422); assert.match(await errorOf(res), /evidence/);
  res = await app.post(`/tax/${fresh}/periods/${r}/initial`, { evidence: 'Articles of organization filed 2025-04-01' });
  assert.equal(res.status, 422); assert.match(await errorOf(res), /start/);
  await saveProfile(pool, { orgId: S.orgId, entityId: fresh, fields: { returnType: 'form_1065', taxMethodDefault: 'cash', bookBasisDefault: 'accrual', yearEndMonth: 12, dateStarted: '2025-04-01' }, actor: 'test' });
  res = await app.post(`/tax/${fresh}/periods/${r}/initial`, { evidence: 'Articles of organization filed 2025-04-01' });
  assert.equal(res.status, 303, await errorOf(res));
  const row = (await pool.query('SELECT initial_status, opening_state FROM tax_return WHERE return_id = $1', [r])).rows[0];
  assert.deepEqual([row.initial_status, row.opening_state], ['verified', 'zero']);
  page = await (await app.get(`/tax/${fresh}/profile`)).text();
  assert.match(page, /Initial \(verified\)/);
  assert.ok(!page.includes(verifyAction), 'nothing left to verify');
});

// Spec §11 (Codex T1 r1 B1): a standard user reads tax setup but writes nothing, not even the accountant grant.
test('a standard user reads tax setup but cannot change it or the accountant grant', async () => {
  const std = await signInAs({ name: 'Stan Dard', email: 'stan@sample.example', role: 'standard' });
  assert.ok(!std.profilePage.includes('<button class="primary">Save</button>'), 'no Save button for a standard user');
  for (const w of ['activities', 'periods', 'inclusions']) assert.ok(!std.profilePage.includes(`action="/tax/${S.entityId}/${w}"`), `no ${w} form for a standard user`);
  const before = (await pool.query('SELECT accountant_may_edit, state_codes FROM tax_profile WHERE org_id = $1 AND entity_id = $2', [S.orgId, S.entityId])).rows[0];
  for (const [what, body] of [['profile', { return_type: 'form_1065', tax_method: 'accrual', book_basis: 'accrual', state_codes: 'TX', business_code: '', date_started: '', reason: 'x', accountant_may_edit: before?.accountant_may_edit ? '' : '1' }],
    ['activities', { kind: 'holding', name: 'Std activity', schedule: 'p1', from: '2019-01-01', to: '', disposed_on: '' }], ['periods', { year: '2024', initial: '' }]]) {
    const res = await std.post(`/tax/${S.entityId}/${what}`, body);
    assert.equal(res.status, 403, `standard POST ${what}`);
  }
  assert.deepEqual((await pool.query('SELECT accountant_may_edit, state_codes FROM tax_profile WHERE org_id = $1 AND entity_id = $2', [S.orgId, S.entityId])).rows[0], before, 'nothing written');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM tax_activity WHERE org_id = $1 AND name = 'Std activity'`, [S.orgId])).rows[0].n, 0);
});
