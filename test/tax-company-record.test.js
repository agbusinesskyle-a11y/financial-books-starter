// test/tax-company-record.test.js — one company record: Settings → Company, the add-company form and the Tax setup page share one tax profile.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './app-harness.js';
import { signInAs } from './tax-signin.js';
import { getCompany, saveCompany } from '../lib/data/settings.js';
import { companyToValues } from '../lib/views/settings.js';
import { createCompany } from '../lib/data/companies.js';
import { getProfile } from '../lib/tax/periods.js';
import { listParties, saveParty, reconcileOwnCompanyTaxIds, reconcileOwnCompanyTaxIdsIn, resolveOwnTaxIdConflict, partyTaxId } from '../lib/tax/parties.js';
import { createCompanyWithTax } from '../lib/tax/company-record.js';
import { settingsKey, encryptSecret, decryptSecret } from '../lib/secrets.js';

const KEY = 'ab'.repeat(32);
let app, pool, S;
const errorOf = async res => (/role="alert">([^<]*)</.exec(await res.clone().text()) ?? [])[1] ?? '';
before(async () => { app = await startApp({ env: { SETTINGS_KEY: KEY } }); pool = app.db.pool; S = { orgId: app.ids.orgId, entityId: app.ids.entityId }; });
after(async () => { await app.close(); });

// The company form as it stands, so a test changes only what it means to change.
const companyForm = async () => Object.fromEntries(Object.entries(companyToValues(await getCompany(pool, S))).map(([k, v]) => [k, v ?? '']));
const tax = { return_type: 'form_1065', activity_kind: '', tax_method: 'cash', book_basis: 'accrual', state_codes: 'TX', business_code: '459990', date_started: '', s_election_date: '', reason: 'initial setup' };
const selected = (page, name, value) => new RegExp(`name="${name}">(?:(?!</select>)[\\s\\S])*<option value="${value}" selected`).test(page);

test('Settings → Company has a Tax section; what it saves is what the Tax setup page shows, and back', async () => {
  const page = await (await app.get('/settings/company')).text();
  assert.ok(page.includes('<h2>Tax</h2>') && page.includes('name="return_type"'));
  let res = await app.post('/settings/company', { ...await companyForm(), ...tax });
  assert.equal(res.status, 303, await errorOf(res));
  const profilePage = await (await app.get(`/tax/${S.entityId}/profile`)).text();
  assert.ok(selected(profilePage, 'return_type', 'form_1065'));
  assert.ok(profilePage.includes('value="TX"') && profilePage.includes('value="459990"'));
  // Back: the Tax setup page changes the method (a reviewed change, with its reason); Settings → Company shows it.
  res = await app.post(`/tax/${S.entityId}/profile`, { return_type: 'form_1065', tax_method: 'accrual', book_basis: 'accrual', state_codes: 'TX', business_code: '459990',
    date_started: '', s_election_date: '', reason: 'books and return on accrual', accountant_may_edit: '1' });
  assert.equal(res.status, 303, await errorOf(res));
  assert.ok(selected(await (await app.get('/settings/company')).text(), 'tax_method', 'accrual'));
  assert.equal((await getProfile(pool, S)).tax_method_default, 'accrual');
});

test('the reviewed-change rule fires from Settings too, and a refused save changes nothing — not even the company details', async () => {
  const before = await getCompany(pool, S);
  const res = await app.post('/settings/company', { ...await companyForm(), name: 'Sample Feed Co. Renamed', ...tax, return_type: 'form_1120s', tax_method: 'accrual', reason: '' });
  assert.equal(res.status, 422);
  assert.match(await errorOf(res), /reason/);
  assert.equal((await getCompany(pool, S)).name, before.name);
  assert.equal((await getProfile(pool, S)).return_type, 'form_1065');
});

test('Settings → Company stays admin-only: neither the accountant nor a standard user writes the tax setup through it', async () => {
  const acct = await signInAs(app, { name: 'Ann Record', email: 'ann.record@sample.example', role: 'reports', csrfFrom: `/tax/${S.entityId}/profile` });
  const std = await signInAs(app, { name: 'Stan Record', email: 'stan.record@sample.example', role: 'standard', csrfFrom: `/tax/${S.entityId}/profile` });
  const body = { ...await companyForm(), ...tax, return_type: 'form_1120s', tax_method: 'accrual', reason: 'should not apply' };
  for (const who of [acct, std]) assert.equal((await who.post('/settings/company', body)).status, 403);
  assert.equal((await getProfile(pool, S)).return_type, 'form_1065');
});

test('adding a company offers the tax fields and the return its business type suggests, and never applies a suggestion by itself', async () => {
  const page = await (await app.get('/settings/companies')).text();
  assert.ok(page.includes('name="businessType"') && page.includes('name="return_type"'));
  assert.ok(page.includes('S corporation: S corporation (Form 1120-S)'), 'the suggestions are on the form');
  let res = await app.post('/settings/companies', { name: 'Suggested Sample Corp', timeZone: 'America/Chicago', businessType: 's_corp', return_type: 'none', tax_method: 'cash', book_basis: 'accrual' });
  assert.equal(res.status, 303, await errorOf(res));
  assert.match(await (await app.get('/home')).text(), /Suggested tax return: S corporation \(Form 1120-S\)/);
  const { rows: [c] } = await pool.query(`SELECT entity_id, business_type FROM entity WHERE org_id = $1 AND name = 'Suggested Sample Corp'`, [S.orgId]);
  assert.equal(c.business_type, 's_corp');
  assert.equal((await getProfile(pool, { orgId: S.orgId, entityId: c.entity_id })).exists, false, 'a suggestion is never saved by itself');
  // The new company is open now: Settings → Company shows the suggestion beside its Tax section.
  assert.ok((await (await app.get('/settings/company')).text()).includes('Suggested from the business type: S corporation (Form 1120-S)'));
  res = await app.post('/settings/companies', { name: 'Chosen Sample Partners', timeZone: 'America/Chicago', businessType: 'partnership', return_type: 'form_1065', tax_method: 'cash', book_basis: 'accrual', state_codes: 'NM' });
  assert.equal(res.status, 303, await errorOf(res));
  const { rows: [d] } = await pool.query(`SELECT entity_id FROM entity WHERE org_id = $1 AND name = 'Chosen Sample Partners'`, [S.orgId]);
  const p = await getProfile(pool, { orgId: S.orgId, entityId: d.entity_id });
  assert.deepEqual([p.return_type, p.state_codes], ['form_1065', ['NM']]);
  res = await app.post('/settings/companies', { name: 'Bad Sample Co', timeZone: 'America/Chicago', return_type: 'disregarded', tax_method: 'cash', book_basis: 'accrual' });
  assert.equal(res.status, 422);
  assert.match(await errorOf(res), /kind of activity/);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM entity WHERE org_id = $1 AND name = 'Bad Sample Co'`, [S.orgId])).rows[0].n, 0, 'checked before the company is created');
  await app.post('/company/switch', { entity_id: String(S.entityId) });
});

test('a party that is one of our companies shows that company’s EIN (last four) and takes no tax id of its own', async () => {
  const B = await createCompany(pool, { orgId: S.orgId, name: 'Party Sample Co', timeZone: 'America/Chicago' });
  await saveCompany(pool, { orgId: S.orgId, entityId: B, fields: { name: 'Party Sample Co', ein: '12-3456789' }, env: { SETTINGS_KEY: KEY } });
  await assert.rejects(saveParty(pool, { orgId: S.orgId, fields: { kind: 'entity_in_org', name: 'Party Sample Co', entityId: B, taxId: '98-7654321' }, env: { SETTINGS_KEY: KEY } }), /Settings → Company/);
  const id = await saveParty(pool, { orgId: S.orgId, fields: { kind: 'entity_in_org', name: 'Party Sample Co', entityId: B, taxId: '' }, env: {} });
  const p = (await listParties(pool, { orgId: S.orgId })).find(x => Number(x.party_id) === Number(id));
  assert.deepEqual([p.has_tax_id, p.tax_id_last4], [true, '6789']);
  // Its own tax page shows it (only its own party); the org-wide directory lists every party (Task 13B).
  assert.ok((await (await app.get(`/tax/${B}/profile`)).text()).includes('Party Sample Co: tax ID •••• 6789'));
  assert.ok((await (await app.get('/tax/parties')).text()).includes('•••• 6789'));
});

test('existing T1 parties of our own companies are reconciled once (B9): moved, company-only, matching and conflicting ids, idempotent, readers agree', async () => {
  const env = { SETTINGS_KEY: KEY }, key = settingsKey(env);
  const make = async (name, partyDigits, companyDigits) => {
    const id = await createCompany(pool, { orgId: S.orgId, name, timeZone: 'America/Chicago' });
    if (companyDigits) await saveCompany(pool, { orgId: S.orgId, entityId: id, fields: { name, ein: companyDigits }, env });
    // A party as T1 stored it: its own encrypted id, not reconciled.
    const { rows: [p] } = await pool.query(`INSERT INTO tax_party (org_id, kind, name, entity_id, tax_id_enc, tax_id_last4) VALUES ($1, 'entity_in_org', $2, $3, $4, $5) RETURNING party_id`,
      [S.orgId, name, id, partyDigits ? encryptSecret(key, partyDigits) : null, partyDigits ? partyDigits.slice(-4) : null]);
    return { entityId: id, partyId: Number(p.party_id) };
  };
  const moved = await make('Moved Sample Co', '111111111', null);
  const companyOnly = await make('Company Only Sample Co', null, '222222222');
  const matching = await make('Matching Sample Co', '333333333', '333333333');
  const conflict = await make('Conflict Sample Co', '444444444', '555555555');
  const view = async id => (await listParties(pool, { orgId: S.orgId })).find(x => Number(x.party_id) === id);
  assert.deepEqual([(await view(moved.partyId)).has_tax_id, (await view(moved.partyId)).tax_id_last4, (await view(moved.partyId)).tax_id_needs_review], [true, '1111', true], 'before: the legacy id still shows, flagged');
  assert.deepEqual(await reconcileOwnCompanyTaxIds(pool, { orgId: S.orgId, env }), { companyOnly: 1, moved: 1, matched: 1, conflicts: 1 });
  assert.deepEqual(await reconcileOwnCompanyTaxIds(pool, { orgId: S.orgId, env }), { companyOnly: 0, moved: 0, matched: 0, conflicts: 0 }, 'a rerun changes nothing');
  assert.equal((await getCompany(pool, { orgId: S.orgId, entityId: moved.entityId })).ein_last4, '1111', 'the party’s id moved onto the company');
  for (const [c, digits] of [[moved, '111111111'], [companyOnly, '222222222'], [matching, '333333333']]) {
    const v = await view(c.partyId);
    assert.deepEqual([v.own_tax_id_state, v.has_tax_id, v.tax_id_last4, v.tax_id_needs_review], ['company', true, digits.slice(-4), false]);
    assert.equal(await partyTaxId(pool, { orgId: S.orgId, partyId: c.partyId, env }), digits, 'the full reader uses the same authority as the masked one');
  }
  const v = await view(conflict.partyId);
  assert.deepEqual([v.own_tax_id_state, v.has_tax_id, v.tax_id_last4, v.tax_id_needs_review], ['conflict', false, null, true], 'a conflict shows no id, never a silent winner');
  await assert.rejects(partyTaxId(pool, { orgId: S.orgId, partyId: conflict.partyId, env }), /differ/);
  // Both ciphertexts are kept as evidence before anything is chosen (Codex r2 B9).
  const evidence = async () => (await pool.query('SELECT evidence_id, party_tax_id_enc, company_ein_enc, decision, decided_by FROM tax_party_tax_id_evidence WHERE party_id = $1', [conflict.partyId])).rows;
  const [ev] = await evidence();
  const key2 = settingsKey(env);
  assert.deepEqual([decryptSecret(key2, ev.party_tax_id_enc), decryptSecret(key2, ev.company_ein_enc), ev.decision], ['444444444', '555555555', null]);
  // While the conflict is open its candidates stay as recorded (Codex r3 R3-N4): a new EIN, or the same digits re-entered, is refused in
  // Settings → Company, so the evidence the Tax setup page shows can always be settled.
  const cName = (await getCompany(pool, { orgId: S.orgId, entityId: conflict.entityId })).name;
  for (const digits of ['666666666', '555555555']) {
    await assert.rejects(saveCompany(pool, { orgId: S.orgId, entityId: conflict.entityId, fields: { name: cName, ein: digits }, env }), /settle that on the Tax setup page/);
  }
  await assert.rejects(saveCompany(pool, { orgId: S.orgId, entityId: conflict.entityId, fields: { name: cName, clearEin: '1' }, env }), /settle that on the Tax setup page/);
  await saveCompany(pool, { orgId: S.orgId, entityId: conflict.entityId, fields: { name: cName }, env });
  // Settled on the company's Tax setup page, by an org admin only, against the evidence the page showed.
  const pageUrl = `/tax/${conflict.entityId}/profile`, settle = `/tax/${conflict.entityId}/parties/${conflict.partyId}/ein`;
  const page = await (await app.get(pageUrl)).text();
  assert.ok(page.includes('Keep Settings → Company’s (•••• 5555)') && page.includes('Keep this party’s (•••• 4444)'));
  const acct = await signInAs(app, { name: 'Ann Evidence', email: 'ann.evidence@sample.example', role: 'reports', csrfFrom: pageUrl });
  assert.equal((await acct.post(settle, { evidence_id: String(ev.evidence_id), keep: 'party' })).status, 403);
  let res = await app.post(settle, { evidence_id: String(Number(ev.evidence_id) + 999), keep: 'party' });
  assert.equal(res.status, 422);
  assert.match(await errorOf(res), /changed since the page was shown/);
  res = await app.post(settle, { evidence_id: String(ev.evidence_id), keep: 'party' });
  assert.equal(res.status, 303, await errorOf(res));
  assert.equal(await partyTaxId(pool, { orgId: S.orgId, partyId: conflict.partyId, env }), '444444444');
  assert.equal((await view(conflict.partyId)).tax_id_last4, '4444');
  const [after] = await evidence();
  assert.deepEqual([after.decision, decryptSecret(key2, after.company_ein_enc)], ['party', '555555555'], 'the replaced company EIN is still on record');
  assert.ok(after.decided_by);
  await assert.rejects(resolveOwnTaxIdConflict(pool, { orgId: S.orgId, entityId: conflict.entityId, partyId: conflict.partyId, evidenceId: ev.evidence_id, keep: 'company' }), /no EIN conflict/);
  await saveCompany(pool, { orgId: S.orgId, entityId: conflict.entityId, fields: { name: cName, ein: '777777777' }, env });
  assert.equal(await partyTaxId(pool, { orgId: S.orgId, partyId: conflict.partyId, env }), '777777777', 'settled: the EIN is edited in Settings → Company again');
  // Ordinary party edits never erase the kept evidence, and a party moved to another of our companies starts over (Codex r2 B9).
  const p = await view(moved.partyId);
  await assert.rejects(saveParty(pool, { orgId: S.orgId, partyId: moved.partyId, fields: { kind: 'entity_in_org', name: p.name, entityId: moved.entityId, clearTaxId: '1' }, env }), /kept as evidence/);
  const other = await createCompany(pool, { orgId: S.orgId, name: 'Moved Again Sample Co', timeZone: 'America/Chicago' });
  await saveParty(pool, { orgId: S.orgId, partyId: moved.partyId, fields: { kind: 'entity_in_org', name: p.name, entityId: other }, env });
  assert.deepEqual([(await view(moved.partyId)).own_tax_id_state, (await view(moved.partyId)).tax_id_needs_review], [null, true], 'another company: reconciled again');
});

test('a company and its tax setup are created in one transaction: a failing tax setup leaves no company behind (B9)', async () => {
  const tax = { returnType: 'form_1065', activityKind: null, taxMethodDefault: 'cash', bookBasisDefault: 'accrual', yearEndMonth: 12, stateCodes: '', businessCode: '', dateStarted: '', sElectionDate: '', accountantMayEdit: true };
  await assert.rejects(createCompanyWithTax(pool, { orgId: S.orgId, company: { name: 'Rollback Sample Co', timeZone: 'America/Chicago' }, tax, actor: 'test',
    saveTax: async () => { throw new Error('forced tax setup failure'); } }), /forced tax setup failure/);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM entity WHERE org_id = $1 AND name = 'Rollback Sample Co'`, [S.orgId])).rows[0].n, 0);
  const id = await createCompanyWithTax(pool, { orgId: S.orgId, company: { name: 'Committed Sample Co', timeZone: 'America/Chicago' }, tax, actor: 'test' });
  assert.equal((await getProfile(pool, { orgId: S.orgId, entityId: id })).return_type, 'form_1065');
});

test('an EIN edit and the reconciliation are serialized by the company row (Codex r4 R4-N3): whichever commits first, the other sees it', async () => {
  const env = { SETTINGS_KEY: KEY }, key = settingsKey(env);
  const make = async (name, partyDigits, companyDigits) => {
    const id = await createCompany(pool, { orgId: S.orgId, name, timeZone: 'America/Chicago' });
    await saveCompany(pool, { orgId: S.orgId, entityId: id, fields: { name, ein: companyDigits }, env });
    const { rows: [p] } = await pool.query(`INSERT INTO tax_party (org_id, kind, name, entity_id, tax_id_enc, tax_id_last4) VALUES ($1, 'entity_in_org', $2, $3, $4, $5) RETURNING party_id`,
      [S.orgId, name, id, encryptSecret(key, partyDigits), partyDigits.slice(-4)]);
    return { entityId: id, partyId: Number(p.party_id), name };
  };
  const waiting = p => Promise.race([p.then(() => 'done', () => 'done'), new Promise(r => setTimeout(() => r('waiting'), 300))]);
  // 1. The edit first, uncommitted: reconciliation waits, then records the EDITED candidate — and the page can settle it.
  const A = await make('Edit First Sample Co', '121212121', '343434343');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await saveCompany(c, { orgId: S.orgId, entityId: A.entityId, fields: { name: A.name, ein: '565656565' }, env });
    const rec = reconcileOwnCompanyTaxIds(pool, { orgId: S.orgId, env });
    assert.equal(await waiting(rec), 'waiting');
    await c.query('COMMIT');
    await rec;
  } finally { c.release(); }
  const { rows: [ev] } = await pool.query('SELECT evidence_id, company_ein_enc FROM tax_party_tax_id_evidence WHERE party_id = $1 AND decision IS NULL', [A.partyId]);
  assert.equal(decryptSecret(key, ev.company_ein_enc), '565656565', 'the evidence is the edited EIN');
  await resolveOwnTaxIdConflict(pool, { orgId: S.orgId, entityId: A.entityId, partyId: A.partyId, evidenceId: ev.evidence_id, keep: 'company', actor: 'test' });
  // 2. The reconciliation first, uncommitted: the edit waits, then refuses.
  const B = await make('Reconcile First Sample Co', '787878787', '909090909');
  const d = await pool.connect();
  try {
    await d.query('BEGIN');
    await reconcileOwnCompanyTaxIdsIn(d, { orgId: S.orgId, env });
    const edit = saveCompany(pool, { orgId: S.orgId, entityId: B.entityId, fields: { name: B.name, ein: '131313131' }, env });
    assert.equal(await waiting(edit), 'waiting');
    await d.query('COMMIT');
    await assert.rejects(edit, /settle that on the Tax setup page/);
  } finally { d.release(); }
});
