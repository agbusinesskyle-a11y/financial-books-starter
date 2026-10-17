// test/tax-mapping-routes.test.js — /tax/:entity/:year/mapping: roles, the page, binding through the form, included books a person may
// not open, accepting suggestions.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './app-harness.js';
import { signInAs } from './tax-signin.js';
import { canAccess } from '../lib/domain/roles.js';
import { createCompany } from '../lib/data/companies.js';
import { saveJournalEntry } from '../lib/data/ledger-tools.js';
import { saveProfile, openPeriod } from '../lib/tax/periods.js';
import { saveActivity, includeBooks } from '../lib/tax/activities.js';
import { saveParty } from '../lib/tax/parties.js';
import { saveAccount } from '../lib/data/ledger.js';

let app, pool, S, A, here;
const errorOf = async res => (/role="alert">([^<]*)</.exec(await res.clone().text()) ?? [])[1] ?? '';
// What the editor showed for one measurement: the partition version and the binding set fingerprint a decision is made against.
const shown = async (client, source, account, m) => {
  const page = await (await client.get(`${here}?source=${source}&account=${account}`)).text();
  return { [`version_${m}`]: new RegExp(`name="version_${m}" value="([0-9a-f]{32})"`).exec(page)[1], [`set_${m}`]: new RegExp(`name="set_${m}" value="([0-9a-f]{32})"`).exec(page)[1] };
};
const profile = { returnType: 'form_1065', taxMethodDefault: 'accrual', bookBasisDefault: 'accrual', yearEndMonth: 12 };
before(async () => {
  app = await startApp({ env: { SETTINGS_KEY: 'ab'.repeat(32) } });
  pool = app.db.pool; S = { orgId: app.ids.orgId, entityId: app.ids.entityId }; A = app.ids.accounts;
  await saveProfile(pool, { ...S, fields: profile, reason: 'test setup', actor: 'test' });
  await openPeriod(pool, { ...S, year: 2026, actor: 'test' });
  here = `/tax/${S.entityId}/2026/mapping`;
});
after(async () => { await app.close(); });

test('roles: everyone who reads tax opens the mapping page; standard users only read; the accountant may write; customers and vendors never', () => {
  for (const [role, see, write] of [['admin', true, true], ['standard', true, false], ['reports', true, true], ['customers', false, false], ['vendors', false, false]]) {
    assert.equal(canAccess(role, 'GET', here), see, `${role} GET`);
    for (const a of ['bind', 'clear', 'line', 'unline', 'accept', 'accept-sure', 'copy-forward']) assert.equal(canAccess(role, 'POST', `${here}/${a}`), write, `${role} POST ${a}`);
  }
});

test('the page lists coverage phone-first and says what is provisional; the profile links to it; unknown periods and accounts are 404', async () => {
  const res = await app.get(here);
  assert.equal(res.status, 200);
  const body = await res.text();
  for (const s of ['Mapping: Sample Feed Co. 2026', 'Feed Sales', 'Needs mapping', 'class="table-scroll"', 'data-label="Account"', 'The 2026 forms are not in the app yet', 'never counted as zero']) assert.ok(body.includes(s), s);
  assert.ok((await (await app.get(`/tax/${S.entityId}/profile`)).text()).includes(`href="${here}"`));
  assert.equal((await app.get(`/tax/${S.entityId}/2031/mapping`)).status, 404);
  assert.equal((await app.get(`${here}?source=${S.entityId}&account=999999`)).status, 404);
});

test('an admin maps an account through the editor; a refusal comes back as 422 with the reason', async () => {
  const editor = await (await app.get(`${here}?source=${S.entityId}&account=${A.feed_sales}`)).text();
  assert.ok(editor.includes('id="edit"') && editor.includes('<optgroup label="Page 1: income and deductions">'));
  const form = { source_entity_id: String(S.entityId), account_id: String(A.feed_sales), measurement: 'activity', split: 'whole', ...await shown(app, S.entityId, A.feed_sales, 'activity') };
  // A form that does not say what it showed is refused (Codex r2 B5).
  let res = await app.post(`${here}/bind`, { ...form, set_activity: '', what_0: 'input:f1065.p1.1a' });
  assert.equal(res.status, 422);
  assert.match(await errorOf(res), /Reload the page/);
  res = await app.post(`${here}/bind`, { ...form, what_0: 'not_tax:', memo: '' });
  assert.equal(res.status, 422);
  assert.match(await errorOf(res), /memo is required/);
  res = await app.post(`${here}/bind`, { ...form, what_0: 'input:f1065.p1.1a', make_default: '1' });
  assert.equal(res.status, 303, await errorOf(res));
  const { rows: [b] } = await pool.query(`SELECT b.destination, b.catalog_edition, b.slot_key FROM tax_binding b JOIN tax_return r USING (org_id, return_id)
    WHERE r.org_id = $1 AND r.entity_id = $2 AND b.account_id = $3`, [S.orgId, S.entityId, A.feed_sales]);
  assert.deepEqual(b, { destination: 'f1065.p1.1a', catalog_edition: 2025, slot_key: 'f1065.p1.1a|activity' });
  assert.ok((await (await app.get(`${here}?show=all`)).text()).includes('Activity in the period: p1.1a Gross receipts or sales'));
  // A memo or label edited by someone else after the page was shown: a stale form is refused, never saved over it.
  const before = await shown(app, S.entityId, A.feed_sales, 'activity');
  res = await app.post(`${here}/bind`, { ...form, ...before, what_0: 'statement_row:f1065.p1.21', label_0: 'Sales, first label' });
  assert.equal(res.status, 303, await errorOf(res));
  const mid = await shown(app, S.entityId, A.feed_sales, 'activity');
  assert.equal((await app.post(`${here}/bind`, { ...form, ...mid, what_0: 'statement_row:f1065.p1.21', label_0: 'Sales, second label' })).status, 303);
  res = await app.post(`${here}/bind`, { ...form, ...mid, what_0: 'statement_row:f1065.p1.21', label_0: 'Sales, stale form' });
  assert.equal(res.status, 422, 'the label changed since that form was shown');
  assert.match(await errorOf(res), /Someone changed this mapping/);
  res = await app.post(`${here}/bind`, { ...form, ...await shown(app, S.entityId, A.feed_sales, 'activity'), what_0: 'input:f1065.p1.1a', make_default: '1' });
  assert.equal(res.status, 303, await errorOf(res));
  const lines = await (await app.get(`${here}?source=${S.entityId}&account=${A.feed_sales}&lines=1`)).text();
  assert.ok(lines.includes('Lines in this period') && lines.includes(`action="${here}/line"`));
});

test('a standard user reads but cannot map; the accountant maps only while the company allows it', async () => {
  const std = await signInAs(app, { name: 'Stan Sample', email: 'stan.t2@sample.example', role: 'standard', csrfFrom: `/tax/${S.entityId}/profile` });
  const page = await (await std.get(here)).text();
  assert.ok(page.includes('Mapping: Sample Feed Co. 2026') && !page.includes(`${here}/copy-forward`) && !page.includes('Accept all sure'));
  const body = { source_entity_id: String(S.entityId), account_id: String(A.checking), measurement: 'end', split: 'whole', what_0: 'input:f1065.L.1', ...await shown(app, S.entityId, A.checking, 'end') };
  assert.equal((await std.post(`${here}/bind`, body)).status, 403);
  const acct = await signInAs(app, { name: 'Ann Sample', email: 'ann.t2@sample.example', role: 'reports', csrfFrom: `/tax/${S.entityId}/profile` });
  await saveProfile(pool, { ...S, fields: { ...profile, accountantMayEdit: false }, actor: 'test' });
  assert.equal((await acct.post(`${here}/bind`, body)).status, 403);
  await saveProfile(pool, { ...S, fields: { ...profile, accountantMayEdit: true }, actor: 'test' });
  const res = await acct.post(`${here}/bind`, body);
  assert.equal(res.status, 303, await errorOf(res));
});

test('an included company the person may not open shows as blocked, never its accounts, and a forged id is not found', async () => {
  const hidden = await createCompany(pool, { orgId: S.orgId, name: 'Hidden Sample Sub', timeZone: 'America/Chicago' });
  await openPeriod(pool, { orgId: S.orgId, entityId: hidden, year: 2026, actor: 'test', profile: { returnType: 'disregarded' } });
  const act = await saveActivity(pool, { ...S, fields: { kind: 'trade', name: 'Sample sub trade', schedule: 'p1', from: '2020-01-01', to: '', disposedOn: '' } });
  const { rows: [r] } = await pool.query(`SELECT return_id FROM tax_return WHERE org_id = $1 AND entity_id = $2 AND period_end = '2026-12-31'`, [S.orgId, S.entityId]);
  await includeBooks(pool, { ...S, returnId: r.return_id, activityId: act, sourceEntityId: hidden, approvedBy: 'test' });
  const named = async n => Number((await pool.query('SELECT account_id FROM account WHERE org_id = $1 AND entity_id = $2 AND name = $3', [S.orgId, hidden, n])).rows[0].account_id);
  const hb = await named('Checking'), hs = await named('Services');
  await saveJournalEntry(pool, { orgId: S.orgId, entityId: hidden, actor: 'test', txnDate: '2026-05-01', docNumber: '', memo: 'Sub sale',
    lines: [{ accountId: String(hb), debit: '250.00', credit: '' }, { accountId: String(hs), debit: '', credit: '250.00' }] });
  assert.ok((await (await app.get(here)).text()).includes('included as Sample sub trade'));
  const lim = await signInAs(app, { name: 'Lim Sample', email: 'lim.t2@sample.example', role: 'admin', companyIds: [S.entityId], csrfFrom: `/tax/${S.entityId}/profile` });
  assert.ok((await (await lim.get(here)).text()).includes('You cannot open this company'));
  assert.equal((await lim.get(`${here}?source=${hidden}&account=${hb}`)).status, 404);
  const count = async () => (await pool.query('SELECT count(*)::int AS n FROM tax_binding WHERE org_id = $1 AND source_entity_id = $2', [S.orgId, hidden])).rows[0].n;
  const before = await count();
  const body = { source_entity_id: String(hidden), account_id: String(hb), measurement: 'end', split: 'whole', what_0: 'input:f1065.L.1' };
  assert.equal((await lim.post(`${here}/bind`, body)).status, 404);
  assert.equal(await count(), before, 'nothing written');
  const res = await app.post(`${here}/bind`, { ...body, ...await shown(app, hidden, hb, 'end') });
  assert.equal(res.status, 303, `the admin who may open it maps it: ${await errorOf(res)}`);
});

test('accepting one suggestion, then “Accept all sure”, binds exactly what the page listed', async () => {
  let page = await (await app.get(here)).text();
  const one = /<form method="post" action="[^"]*\/mapping\/accept" class="inline">([\s\S]*?)<\/form>/.exec(page);
  assert.ok(one, 'the page offers a suggestion to accept');
  const fields = Object.fromEntries([...one[1].matchAll(/name="([^"]+)" value="([^"]*)"/g)].map(m => [m[1], m[2].replaceAll('&amp;', '&')]).filter(([k]) => !['csrf', 'form_once'].includes(k)));
  let res = await app.post(`${here}/accept`, fields);
  assert.equal(res.status, 303, await errorOf(res));
  page = await (await app.get(here)).text();
  const shown = [...page.matchAll(/name="sure" value="([^"]+)"/g)].map(m => m[1]);
  res = await app.post(`${here}/accept-sure`, new URLSearchParams(shown.map(v => ['sure', v])));
  assert.equal(res.status, 303);
  const { rows: [{ n }] } = await pool.query(`SELECT count(*)::int AS n FROM tax_binding_suggestion WHERE org_id = $1 AND status = 'accepted'`, [S.orgId]);
  assert.equal(n, shown.length + 1);
});

test('every line treatment can be completed and repaired through the page (B8): reason, K-1 payer, row label, owner; orphans; lines past the first page', async () => {
  const R = { orgId: S.orgId, entityId: await createCompany(pool, { orgId: S.orgId, name: 'Route Lines Sample Co', timeZone: 'America/Chicago' }) };
  await saveProfile(pool, { ...R, fields: profile, reason: 'test setup', actor: 'test' });
  await openPeriod(pool, { ...R, year: 2026, actor: 'test' });
  await saveAccount(pool, { ...R, fields: { name: 'Mixed Costs', number: '', type: 'expense', parentId: '', description: '', active: true } });
  const named = async n => Number((await pool.query('SELECT account_id FROM account WHERE org_id = $1 AND entity_id = $2 AND name = $3', [S.orgId, R.entityId, n])).rows[0].account_id);
  const mixed = await named('Mixed Costs'), bank = await named('Checking');
  const txns = [];
  for (let i = 0; i < 105; i += 1) {
    txns.push(Number(await saveJournalEntry(pool, { ...R, actor: 'test', txnDate: '2026-02-01', docNumber: '', memo: `Cost ${i + 1}`,
      lines: [{ accountId: String(mixed), debit: '10.00', credit: '' }, { accountId: String(bank), debit: '', credit: '10.00' }] })));
  }
  await saveParty(pool, { orgId: S.orgId, fields: { kind: 'entity_outside', name: 'Route Sample Payer LP', taxId: '' }, env: {} });
  await saveParty(pool, { orgId: S.orgId, fields: { kind: 'individual', name: 'Route Sample Partner', taxId: '' }, env: {} });
  const partyId = async n => String((await pool.query('SELECT party_id FROM tax_party WHERE org_id = $1 AND name = $2', [S.orgId, n])).rows[0].party_id);
  const rHere = `/tax/${R.entityId}/2026/mapping`;
  const linesPage = async from => (await app.get(`${rHere}?source=${R.entityId}&account=${mixed}&lines=1&from=${from}`)).text();
  // The line form of one transaction on a page, as the browser would submit it (hidden fields included).
  const formOf = (page, txnId) => {
    const f = [...page.matchAll(/<form method="post" action="[^"]*\/mapping\/line" class="editor">([\s\S]*?)<\/form>/g)].find(m => m[1].includes(`name="txn_id" value="${txnId}"`));
    assert.ok(f, `a form for transaction ${txnId}`);
    return Object.fromEntries([...f[1].matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)].map(m => [m[1], m[2]]).filter(([k]) => !['csrf', 'form_once'].includes(k)));
  };
  let page = await linesPage(0);
  assert.ok(page.includes('Lines 1–100 of 105') && page.includes('Later lines'));
  const post = async (txnId, fields, from = 0) => app.post(`${rHere}/line`, { ...formOf(await linesPage(from), txnId), ...fields });
  let res = await post(txns[0], { what_0: 'not_tax:', memo: 'Owner’s personal purchase, repaid' });
  assert.equal(res.status, 303, await errorOf(res));
  res = await post(txns[1], { what_0: 'k1_booked:', k1_0: await partyId('Route Sample Payer LP') });
  assert.equal(res.status, 303, await errorOf(res));
  res = await post(txns[2], { what_0: 'statement_row:f1065.p1.21', label_0: 'Trade show booth' });
  assert.equal(res.status, 303, await errorOf(res));
  res = await post(txns[3], { what_0: 'guaranteed_payment:services', owner_0: await partyId('Route Sample Partner') });
  assert.equal(res.status, 303, await errorOf(res));
  res = await post(txns[102], { what_0: 'input:f1065.p1.11' }, 100);
  assert.equal(res.status, 303, await errorOf(res));
  const { rows } = await pool.query('SELECT txn_id, treatment, memo, row_label, k1_issuer_party_id, interest_party_id FROM tax_binding_line WHERE org_id = $1 AND account_id = $2 ORDER BY txn_id', [S.orgId, mixed]);
  assert.deepEqual(rows.map(r => [Number(r.txn_id), r.treatment]), [[txns[0], 'not_tax'], [txns[1], 'k1_booked'], [txns[2], 'statement_row'], [txns[3], 'guaranteed_payment'], [txns[102], 'input']]);
  assert.deepEqual([rows[0].memo, rows[2].row_label, String(rows[1].k1_issuer_party_id), String(rows[3].interest_party_id)],
    ['Owner’s personal purchase, repaid', 'Trade show booth', await partyId('Route Sample Payer LP'), await partyId('Route Sample Partner')]);
  // An attribution whose line was deleted is still listed, marked, and removable from the page.
  await pool.query('DELETE FROM txn WHERE org_id = $1 AND txn_id = $2', [S.orgId, txns[2]]);
  page = await linesPage(0);
  assert.ok(page.includes('The line no longer posts to this account in the period'));
  const lineId = String((await pool.query('SELECT binding_line_id FROM tax_binding_line WHERE org_id = $1 AND txn_id = $2', [S.orgId, txns[2]])).rows[0].binding_line_id);
  res = await app.post(`${rHere}/unline`, { source_entity_id: String(R.entityId), account_id: String(mixed), binding_line_id: lineId });
  assert.equal(res.status, 303, await errorOf(res));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM tax_binding_line WHERE org_id = $1 AND txn_id = $2', [S.orgId, txns[2]])).rows[0].n, 0);
});

test('an account emptied of its only line still renders, and its orphan is removed through the page (Codex r2 B8, N2)', async () => {
  const R = { orgId: S.orgId, entityId: await createCompany(pool, { orgId: S.orgId, name: 'Single Line Sample Co', timeZone: 'America/Chicago' }) };
  await saveProfile(pool, { ...R, fields: profile, reason: 'test setup', actor: 'test' });
  await openPeriod(pool, { ...R, year: 2026, actor: 'test' });
  await saveAccount(pool, { ...R, fields: { name: 'Single Cost', number: '', type: 'expense', parentId: '', description: '', active: true } });
  const named = async n => Number((await pool.query('SELECT account_id FROM account WHERE org_id = $1 AND entity_id = $2 AND name = $3', [S.orgId, R.entityId, n])).rows[0].account_id);
  const single = await named('Single Cost'), bank = await named('Checking');
  const txn = Number(await saveJournalEntry(pool, { ...R, actor: 'test', txnDate: '2026-03-01', docNumber: '', memo: 'The only cost',
    lines: [{ accountId: String(single), debit: '40.00', credit: '' }, { accountId: String(bank), debit: '', credit: '40.00' }] }));
  const rHere = `/tax/${R.entityId}/2026/mapping`, linesUrl = `${rHere}?source=${R.entityId}&account=${single}&lines=1`;
  let page = await (await app.get(linesUrl)).text();
  const f = /<form method="post" action="[^"]*\/mapping\/line" class="editor">([\s\S]*?)<\/form>/.exec(page)[1];
  const fields = Object.fromEntries([...f.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)].map(m => [m[1], m[2]]).filter(([k]) => !['csrf', 'form_once'].includes(k)));
  let res = await app.post(`${rHere}/line`, { ...fields, what_0: 'input:f1065.p1.11' });
  assert.equal(res.status, 303, await errorOf(res));
  await pool.query('DELETE FROM txn WHERE org_id = $1 AND txn_id = $2', [S.orgId, txn]);
  for (const url of [rHere, `${rHere}?show=all`, linesUrl]) assert.equal((await app.get(url)).status, 200, url);
  page = await (await app.get(linesUrl)).text();
  assert.ok(page.includes('The line no longer posts to this account in the period') && page.includes('Lines 0–0 of 0'));
  const rm = /<form method="post" action="[^"]*\/mapping\/unline"[^>]*>([\s\S]*?)<\/form>/.exec(page)[1];
  const rmFields = Object.fromEntries([...rm.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map(m => [m[1], m[2]]).filter(([k]) => !['csrf', 'form_once'].includes(k)));
  res = await app.post(`${rHere}/unline`, rmFields);
  assert.equal(res.status, 303, await errorOf(res));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM tax_binding_line WHERE org_id = $1 AND account_id = $2', [S.orgId, single])).rows[0].n, 0);
});
