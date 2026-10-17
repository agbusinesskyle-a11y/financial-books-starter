// test/tax-company-pages.test.js — the Tax section per company (the owner's scoping, 2026-10-16): /tax opens the company being worked
// in; All returns and the party directory are for org admins; a disregarded company says where it is reported; a parent lists the books
// it includes; owners and members are edited on the company's page. Sample names only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './app-harness.js';
import { signInAs } from './tax-signin.js';
import { canAccess } from '../lib/domain/roles.js';
import { createCompany } from '../lib/data/companies.js';
import { saveProfile, openPeriod } from '../lib/tax/periods.js';
import { saveActivity, includeBooks } from '../lib/tax/activities.js';
import { reportingChain } from '../lib/tax/reporting.js';
import { coverage } from '../lib/tax/coverage.js';
import { saveParty } from '../lib/tax/parties.js';
import { acct, je } from './tax-t2-fixtures.js';

let app, pool, S, child, hidden, ret;
const errorOf = async res => (/role="alert">([^<]*)</.exec(await res.clone().text()) ?? [])[1] ?? '';
before(async () => {
  app = await startApp({ env: { SETTINGS_KEY: 'ab'.repeat(32) } });
  pool = app.db.pool; S = { orgId: app.ids.orgId, entityId: app.ids.entityId };
  await saveProfile(pool, { ...S, fields: { returnType: 'form_1065', taxMethodDefault: 'accrual', bookBasisDefault: 'accrual', yearEndMonth: 12, accountantMayEdit: true }, reason: 'setup', actor: 'test' });
  ret = Number(await openPeriod(pool, { ...S, year: 2025, actor: 'test' }));
  const act = Number(await saveActivity(pool, { ...S, fields: { kind: 'trade', name: 'Sample trade', schedule: 'p1', from: '2020-01-01', to: '', disposedOn: '' } }));
  for (const name of ['Sample Feed Sub LLC', 'Sample Hidden Sub LLC']) {
    const id = await createCompany(pool, { orgId: S.orgId, name, timeZone: 'America/Chicago' });
    await openPeriod(pool, { orgId: S.orgId, entityId: id, year: 2025, actor: 'test', profile: { returnType: 'disregarded' } });
    await includeBooks(pool, { ...S, returnId: ret, activityId: act, sourceEntityId: id, approvedBy: 'test' });
    if (name.includes('Hidden')) hidden = id; else child = id;
  }
  await saveParty(pool, { orgId: S.orgId, fields: { kind: 'individual', name: 'Pat Sample Partner', taxId: '' }, env: {} });
  await saveParty(pool, { orgId: S.orgId, fields: { kind: 'individual', name: 'Lee Sample Partner', taxId: '' }, env: {} });
});
after(async () => { await app.close(); });
const partyId = async n => String((await pool.query('SELECT party_id FROM tax_party WHERE org_id = $1 AND name = $2', [S.orgId, n])).rows[0].party_id);

test('roles: All returns and the party directory are admin-only paths; owners are written like the rest of the tax setup', () => {
  for (const [role, admin, edit] of [['admin', true, true], ['standard', false, false], ['reports', false, true]]) {
    assert.equal(canAccess(role, 'GET', '/tax/all'), admin, `${role} /tax/all`);
    assert.equal(canAccess(role, 'GET', '/tax/parties'), admin, `${role} /tax/parties`);
    assert.equal(canAccess(role, 'POST', `/tax/${S.entityId}/interests`), edit, `${role} interests`);
  }
});

test('/tax opens the company being worked in; All returns and the directory are only for an admin who can open every company', async () => {
  const res = await app.get('/tax');
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes('Tax setup: Sample Feed Co.'), 'the company being worked in');
  assert.equal((await app.get('/tax/all')).status, 200);
  assert.ok((await (await app.get('/tax/parties')).text()).includes('Pat Sample Partner'));
  const lim = await signInAs(app, { name: 'Lim Sample', email: 'lim.pages@sample.example', role: 'admin', companyIds: [S.entityId, child], csrfFrom: `/tax/${S.entityId}/profile` });
  assert.equal((await lim.get('/tax/all')).status, 403);
  assert.equal((await lim.get('/tax/parties')).status, 403);
  const page = await (await lim.get(`/tax/${S.entityId}/profile`)).text();
  assert.ok(!page.includes('<h2>Parties</h2>') && !page.includes('href="/tax/parties"'), 'no party directory on a company page for this person');
});

test('a parent lists the books it includes (links only where the person may open them); a disregarded company says where it is reported', async () => {
  const lim = await signInAs(app, { name: 'Lim Two Sample', email: 'lim2.pages@sample.example', role: 'admin', companyIds: [S.entityId, child], csrfFrom: `/tax/${S.entityId}/profile` });
  const parent = await (await lim.get(`/tax/${S.entityId}/profile`)).text();
  assert.ok(parent.includes('<h2>Books included in this return</h2>'));
  assert.ok(parent.includes(`<a href="/tax/${child}/profile">Sample Feed Sub LLC</a>`));
  assert.ok(parent.includes('Sample Hidden Sub LLC <span class="muted small">(you cannot open this company)</span>') && !parent.includes(`href="/tax/${hidden}/profile"`));
  const sub = await (await lim.get(`/tax/${child}/profile`)).text();
  assert.ok(sub.includes(`Disregarded — reported on <a href="/tax/${S.entityId}/profile">Sample Feed Co.</a>’s Partnership (Form 1065) (2025).`), 'where it is reported, linked');
  assert.ok(!sub.includes('Filed returns on record') && !sub.includes('<h2>Worksheet</h2>'), 'no return setup it does not need');
});

test('owners and members are edited on the company page: admin, the accountant where allowed, never a standard user', async () => {
  const here = `/tax/${S.entityId}`;
  let res = await app.post(`${here}/interests`, { party_id: await partyId('Pat Sample Partner'), role: 'general_partner', from: '2025-01-01', to: '', profit: '1/2', loss: '1/2', capital: '' });
  assert.equal(res.status, 303, await errorOf(res));
  res = await app.post(`${here}/interests`, { party_id: await partyId('Lee Sample Partner'), role: 'shareholder', from: '2025-01-01', to: '', profit: '1/2', loss: '', capital: '' });
  assert.equal(res.status, 422);
  assert.match(await errorOf(res), /general partner/);
  const acct = await signInAs(app, { name: 'Ann Sample', email: 'ann.pages@sample.example', role: 'reports', csrfFrom: `${here}/profile` });
  // The accountant names only parties already linked to companies they may open (Codex r5 R5-N4): Lee is not linked yet.
  const lee = { party_id: await partyId('Lee Sample Partner'), role: 'limited_partner', from: '2025-01-01', to: '', profit: '1/2', loss: '1/2', capital: '' };
  assert.equal((await acct.post(`${here}/interests`, lee)).status, 404);
  res = await app.post(`${here}/interests`, { ...lee, capital: '' });
  assert.equal(res.status, 303, await errorOf(res));
  res = await acct.post(`${here}/interests`, { ...lee, profit: '1/2', capital: '' });
  assert.equal(res.status, 303, 'once linked by an admin, the accountant edits that owner');
  const std = await signInAs(app, { name: 'Stan Sample', email: 'stan.pages@sample.example', role: 'standard', csrfFrom: `${here}/profile` });
  assert.equal((await std.post(`${here}/interests`, { party_id: await partyId('Lee Sample Partner'), role: 'limited_partner', from: '2026-01-01' })).status, 403);
  const page = await (await app.get(`${here}/profile`)).text();
  assert.ok(page.includes('<h2>Owners and members</h2>') && page.includes('Pat Sample Partner') && page.includes('unknown'));
  assert.match(page, /capital shares are not known yet/);
  const id = /action="\/tax\/\d+\/interests\/(\d+)\/end"/.exec(page)[1];
  res = await app.post(`${here}/interests/${id}/end`, { to: '2025-12-31' });
  assert.equal(res.status, 303, await errorOf(res));
});

test('company pages never list the party directory (Codex r5 R5-N4): pickers show only parties linked to companies the person may open, and posts are checked', async () => {
  await saveParty(pool, { orgId: S.orgId, fields: { kind: 'individual', name: 'Unrelated Sample Person', taxId: '' }, env: {} });
  await saveParty(pool, { orgId: S.orgId, fields: { kind: 'entity_in_org', name: 'Hidden Sub Tax Party', entityId: hidden, taxId: '' }, env: {} });
  const lim = await signInAs(app, { name: 'Lim Three Sample', email: 'lim3.pages@sample.example', role: 'admin', companyIds: [S.entityId, child], csrfFrom: `/tax/${S.entityId}/profile` });
  for (const url of [`/tax/${S.entityId}/profile`, `/tax/${S.entityId}/2025/mapping?source=${S.entityId}&account=${app.ids.accounts.checking}`]) {
    const page = await (await lim.get(url)).text();
    assert.ok(!page.includes('Unrelated Sample Person') && !page.includes('Hidden Sub Tax Party'), `no unrelated party on ${url}`);
  }
  assert.ok((await (await lim.get(`/tax/${S.entityId}/profile`)).text()).includes('Pat Sample Partner'), 'an owner of this company is offered');
  const forged = await partyId('Unrelated Sample Person');
  assert.equal((await lim.post(`/tax/${S.entityId}/interests`, { party_id: forged, role: 'limited_partner', from: '2026-01-01' })).status, 404);
  const editor = await (await lim.get(`/tax/${S.entityId}/2025/mapping?source=${S.entityId}&account=${app.ids.accounts.checking}`)).text();
  const token = m => new RegExp(`name="${m}" value="([0-9a-f]{32})"`).exec(editor)[1];
  const res = await lim.post(`/tax/${S.entityId}/2025/mapping/bind`, { source_entity_id: String(S.entityId), account_id: String(app.ids.accounts.checking), measurement: 'activity', split: 'whole',
    what_0: 'equity_event:distribution_cash', owner_0: forged, version_activity: token('version_activity'), set_activity: token('set_activity') });
  assert.equal(res.status, 404, 'a forged owner on the mapping page is not found');
});

test('where a disregarded company is reported follows the chain to the filing return for the period shown (Codex r5 R5-N5)', async () => {
  // R (partnership) → M (disregarded) → L (disregarded), 2025.
  const mk = async (name, type) => { const id = await createCompany(pool, { orgId: S.orgId, name, timeZone: 'America/Chicago' });
    return { id, ret: Number(await openPeriod(pool, { orgId: S.orgId, entityId: id, year: 2025, actor: 'test', profile: { returnType: type } })) }; };
  const R = await mk('Sample Chain Partners', 'form_1065'), M = await mk('Sample Chain Middle LLC', 'disregarded'), L = await mk('Sample Chain Leaf LLC', 'disregarded');
  const act = async (id, name) => Number(await saveActivity(pool, { orgId: S.orgId, entityId: id, fields: { kind: 'trade', name, schedule: 'p1', from: '2020-01-01', to: '', disposedOn: '' } }));
  await includeBooks(pool, { orgId: S.orgId, entityId: M.id, returnId: M.ret, activityId: await act(M.id, 'Chain middle trade'), sourceEntityId: L.id, approvedBy: 'test' });
  await includeBooks(pool, { orgId: S.orgId, entityId: R.id, returnId: R.ret, activityId: await act(R.id, 'Chain trade'), sourceEntityId: M.id, approvedBy: 'test' });
  const leaf = await (await app.get(`/tax/${L.id}/profile`)).text();
  assert.ok(leaf.includes(`Disregarded — reported on <a href="/tax/${R.id}/profile">Sample Chain Partners</a>’s Partnership (Form 1065) (2025), through <a href="/tax/${M.id}/profile">Sample Chain Middle LLC</a>.`), 'the filing return, not the middle company');
  const middle = await (await app.get(`/tax/${M.id}/profile`)).text();
  assert.ok(middle.includes('Books this company includes') && middle.includes(`<a href="/tax/${L.id}/profile">Sample Chain Leaf LLC</a>`), 'a disregarded parent lists what it includes');
  // A person who may open R and L, not M: the filing return is still found, but nothing past the hidden company is a link — the same
  // every-company-on-path rule as the included-books list (Codex r6).
  const lim = await signInAs(app, { name: 'Chain Sample', email: 'chain.pages@sample.example', role: 'admin', companyIds: [R.id, L.id], csrfFrom: `/tax/${R.id}/profile` });
  const seen = await (await lim.get(`/tax/${L.id}/profile`)).text();
  assert.ok(seen.includes('Sample Chain Partners <span class="muted small">(you cannot open this company)</span>') && seen.includes('Sample Chain Middle LLC <span class="muted small">(you cannot open this company)</span>'));
  assert.ok(!seen.includes(`href="/tax/${R.id}/profile"`));
  // L opens 2026, not included yet: the page says so for 2026, and shows 2025 only as history.
  await openPeriod(pool, { orgId: S.orgId, entityId: L.id, year: 2026, actor: 'test', profile: { returnType: 'disregarded' } });
  const later = await (await app.get(`/tax/${L.id}/profile`)).text();
  assert.ok(later.includes('Disregarded — not included in a return for 2026-01-01 – 2026-12-31') && later.includes('Earlier: reported on'));
  // A middle company whose own period is part-year: the leaf's books reach it for part of the year only — not reported.
  const M2 = { id: await createCompany(pool, { orgId: S.orgId, name: 'Sample Short Middle LLC', timeZone: 'America/Chicago' }) };
  await saveProfile(pool, { orgId: S.orgId, entityId: M2.id, fields: { returnType: 'disregarded', activityKind: 'trade', taxMethodDefault: 'cash', bookBasisDefault: 'accrual', yearEndMonth: 12, dateStarted: '2025-04-01' }, reason: 'setup', actor: 'test' });
  M2.ret = Number(await openPeriod(pool, { orgId: S.orgId, entityId: M2.id, year: 2025, initial: true, periodStart: '2025-04-01', actor: 'test' }));
  const L2 = await mk('Sample Short Leaf LLC', 'disregarded');
  await includeBooks(pool, { orgId: S.orgId, entityId: M2.id, returnId: M2.ret, activityId: Number(await saveActivity(pool, { orgId: S.orgId, entityId: M2.id, fields: { kind: 'trade', name: 'Short trade', schedule: 'p1', from: '2025-04-01', to: '', disposedOn: '' } })), sourceEntityId: L2.id, approvedBy: 'test' });
  const chain = await reportingChain(pool, { orgId: S.orgId, entityId: L2.id, periodStart: '2025-01-01', periodEnd: '2025-12-31' });
  assert.deepEqual([chain.filing, chain.blocked], [null, false], 'the short middle is included nowhere: not reported');
  // The short middle included into a full-year partnership, and a short LEAF under it (Codex r6 R6-N3): the page, the inclusion graph
  // and coverage agree — the leaf's books reach the partnership through a part-year edge and are not reported.
  const R3 = await mk('Sample Short Partners', 'form_1065');
  await includeBooks(pool, { orgId: S.orgId, entityId: R3.id, returnId: R3.ret, activityId: await act(R3.id, 'Short partners trade'), sourceEntityId: M2.id, approvedBy: 'test' });
  const L3 = { id: await createCompany(pool, { orgId: S.orgId, name: 'Sample Short Leaf Two LLC', timeZone: 'America/Chicago' }) };
  await saveProfile(pool, { orgId: S.orgId, entityId: L3.id, fields: { returnType: 'disregarded', activityKind: 'trade', taxMethodDefault: 'cash', bookBasisDefault: 'accrual', yearEndMonth: 12, dateStarted: '2025-04-01' }, reason: 'setup', actor: 'test' });
  await openPeriod(pool, { orgId: S.orgId, entityId: L3.id, year: 2025, initial: true, periodStart: '2025-04-01', actor: 'test' });
  const short = (await pool.query('SELECT activity_id FROM tax_activity WHERE org_id = $1 AND return_entity_id = $2', [S.orgId, M2.id])).rows[0].activity_id;
  await includeBooks(pool, { orgId: S.orgId, entityId: M2.id, returnId: M2.ret, activityId: short, sourceEntityId: L3.id, approvedBy: 'test' });
  const leafChain = await reportingChain(pool, { orgId: S.orgId, entityId: L3.id, periodStart: '2025-04-01', periodEnd: '2025-12-31' });
  assert.deepEqual([leafChain.filing, leafChain.blocked, leafChain.hops.map(h => h.entityId)], [null, true, [M2.id, R3.id]]);
  const { rows: [g] } = await pool.query('SELECT period_matches FROM tax_inclusion_sources($1, $2) WHERE source_entity_id = $3', [S.orgId, R3.ret, L3.id]);
  assert.equal(g.period_matches, false, 'the inclusion graph blocks it');
  const cov = await coverage(pool, { orgId: S.orgId, entityId: R3.id, returnId: R3.ret });
  assert.equal(cov.sources.find(x => x.entityId === L3.id).status, 'blocked', 'and so does coverage');
  assert.match(await (await app.get(`/tax/${L3.id}/profile`)).text(), /for part of the year only, which cannot be combined yet/);
  // The middle company itself is a direct child: included for the partnership's whole year, reported.
  assert.ok((await reportingChain(pool, { orgId: S.orgId, entityId: M2.id, periodStart: '2025-04-01', periodEnd: '2025-12-31' })).filing);
});

test('a full-year company included in a short-year return is only partly reported (Codex r7 R7-N2): the page, the chain and coverage agree on the dates', async () => {
  // L: disregarded for all of 2025. R: an initial partnership year from 2025-04-01 that includes L. L earns 100 dollars in January, 200 in July.
  const L = { orgId: S.orgId, entityId: await createCompany(pool, { orgId: S.orgId, name: 'Sample Year Leaf LLC', timeZone: 'America/Chicago' }) };
  await openPeriod(pool, { ...L, year: 2025, actor: 'test', profile: { returnType: 'disregarded' } });
  const R = { orgId: S.orgId, entityId: await createCompany(pool, { orgId: S.orgId, name: 'Sample Late Partners', timeZone: 'America/Chicago' }) };
  await saveProfile(pool, { ...R, fields: { returnType: 'form_1065', activityKind: 'trade', taxMethodDefault: 'accrual', bookBasisDefault: 'accrual', yearEndMonth: 12, dateStarted: '2025-04-01' }, reason: 'setup', actor: 'test' });
  const rRet = Number(await openPeriod(pool, { ...R, year: 2025, initial: true, periodStart: '2025-04-01', actor: 'test' }));
  const rAct = Number(await saveActivity(pool, { ...R, fields: { kind: 'trade', name: 'Late partners trade', schedule: 'p1', from: '2025-04-01', to: '', disposedOn: '' } }));
  await includeBooks(pool, { ...R, returnId: rRet, activityId: rAct, sourceEntityId: L.entityId, approvedBy: 'test' });
  const bank = await acct(pool, L, 'Checking'), sales = await acct(pool, L, 'Services');
  await je(pool, L, '2025-01-15', [[bank, 10000], [sales, -10000]]);
  await je(pool, L, '2025-07-15', [[bank, 20000], [sales, -20000]]);
  // The chain reaches R, whose graph combines L, but R covers April–December only: partly reported, January–March not included.
  const chain = await reportingChain(pool, { ...L, periodStart: '2025-01-01', periodEnd: '2025-12-31' });
  assert.deepEqual([chain.filing, chain.blocked, chain.hops.map(h => h.entityId)], [null, true, [R.entityId]]);
  assert.deepEqual(chain.partial, { covered: { start: '2025-04-01', end: '2025-12-31' }, uncovered: [{ start: '2025-01-01', end: '2025-03-31' }] });
  // Coverage applies R's dates: 200 dollars of L's revenue is measured on R, not the year's 300.
  const cov = await coverage(pool, { ...R, returnId: rRet });
  const src = cov.sources.find(x => x.entityId === L.entityId);
  assert.equal(src.accounts.find(a => a.accountId === sales).activity, -20000n);
  const page = await (await app.get(`/tax/${L.entityId}/profile`)).text();
  assert.ok(page.includes(`Partly reported for 2025-01-01 – 2025-12-31:</span> 2025-04-01 – 2025-12-31 on <a href="/tax/${R.entityId}/profile">Sample Late Partners</a>’s Partnership (Form 1065) (2025); 2025-01-01 – 2025-03-31 not included in any return`), 'the dates reported and the dates not included');
  assert.ok(!page.includes('Disregarded — reported on'), 'never an unqualified success');
});
