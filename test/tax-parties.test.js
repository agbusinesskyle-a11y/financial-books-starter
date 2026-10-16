// test/tax-parties.test.js — Codex t1-r1 B9: household membership keeps its history and is read as of a date; household members
// and grantor owners are individuals; a grantor owner row says whether it was reviewed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './harness.js';
import { generateSample } from '../lib/seed/generate.js';
import { writeSample } from '../lib/data/seed.js';
import { createCompany } from '../lib/data/companies.js';
import { ValidationError } from '../lib/data/writes.js';
import { saveParty, saveGrantorReporting, grantorOwnersOn, saveHouseholdMembers, householdMembers, householdMembersOn } from '../lib/tax/parties.js';

let db, pool, H, pat, sam, alex, outside, trust;
const person = name => saveParty(pool, { orgId: H.orgId, fields: { kind: 'individual', name }, env: {} });
before(async () => {
  db = await freshDb(); pool = db.pool;
  const ids = await writeSample(pool, generateSample({ asOf: '2026-10-12' }));
  H = { orgId: ids.orgId, entityId: await createCompany(pool, { orgId: ids.orgId, name: 'Sample Household', timeZone: 'America/Chicago' }) };
  pat = await person('Pat Sample'); sam = await person('Sam Sample'); alex = await person('Alex Sample');
  outside = await saveParty(pool, { orgId: H.orgId, fields: { kind: 'entity_outside', name: 'Outside Corp' }, env: {} });
  trust = await saveParty(pool, { orgId: H.orgId, fields: { kind: 'grantor_trust', name: 'Sample Family Trust' }, env: {} });
});
after(async () => { await db.drop(); });

const on = async asOf => (await householdMembersOn(pool, { ...H, asOf })).map(m => [m.party_id, m.role]);

test('saving next year’s household closes this year’s membership instead of deleting it; members are read as of a date', async () => {
  await saveHouseholdMembers(pool, { ...H, members: [{ partyId: pat, role: 'taxpayer', from: '2025-01-01' }, { partyId: sam, role: 'spouse', from: '2025-01-01' }] });
  await saveHouseholdMembers(pool, { ...H, members: [{ partyId: pat, role: 'taxpayer', from: '2026-01-01' }, { partyId: alex, role: 'spouse', from: '2026-01-01' }] });
  assert.deepEqual(await on('2024-12-31'), [], 'nobody before the first change');
  assert.deepEqual(await on('2025-06-30'), [[sam, 'spouse'], [pat, 'taxpayer']], 'the 2025 return keeps its taxpayer and spouse');
  assert.deepEqual(await on('2025-12-31'), [[sam, 'spouse'], [pat, 'taxpayer']]);
  assert.deepEqual(await on('2026-01-01'), [[alex, 'spouse'], [pat, 'taxpayer']]);
  assert.deepEqual((await householdMembers(pool, H)).map(m => [m.party_id, m.role]), [[alex, 'spouse'], [pat, 'taxpayer']], 'the current members');
  const { rows } = await pool.query('SELECT party_id, effective_from::text AS f, effective_to::text AS t FROM tax_household_member WHERE org_id = $1 AND entity_id = $2 ORDER BY effective_from, party_id', [H.orgId, H.entityId]);
  assert.deepEqual(rows.map(r => [r.party_id, r.f, r.t]), [[pat, '2025-01-01', '2025-12-31'], [sam, '2025-01-01', '2025-12-31'], [pat, '2026-01-01', null], [alex, '2026-01-01', null]]);
  // A change dated before the latest one is refused (edit that one); one change has one date.
  await assert.rejects(saveHouseholdMembers(pool, { ...H, members: [{ partyId: pat, role: 'taxpayer', from: '2025-07-01' }] }), e => e instanceof ValidationError && /later change/.test(e.message));
  await assert.rejects(saveHouseholdMembers(pool, { ...H, members: [{ partyId: pat, role: 'taxpayer', from: '2027-01-01' }, { partyId: sam, role: 'spouse', from: '2027-02-01' }] }), e => e instanceof ValidationError && /same date/.test(e.message));
  // Re-saving the latest change's own date corrects that change; earlier history is untouched.
  await saveHouseholdMembers(pool, { ...H, members: [{ partyId: pat, role: 'taxpayer', from: '2026-01-01' }] });
  assert.deepEqual(await on('2026-06-30'), [[pat, 'taxpayer']]);
  assert.deepEqual(await on('2025-06-30'), [[sam, 'spouse'], [pat, 'taxpayer']], 'the 2025 membership survives a correction of 2026');
  await assert.rejects(householdMembersOn(pool, { ...H, asOf: 'June' }), e => e instanceof ValidationError && /date/.test(e.message));
});

test('household members and grantor owners are individuals — refused by the module and by the database', async () => {
  await assert.rejects(saveHouseholdMembers(pool, { ...H, members: [{ partyId: outside, role: 'taxpayer', from: '2027-01-01' }] }), e => e instanceof ValidationError && /individual/.test(e.message));
  await assert.rejects(saveHouseholdMembers(pool, { ...H, members: [{ partyId: pat, role: 'taxpayer', from: '2027-01-01' }, { partyId: trust, role: 'spouse', from: '2027-01-01' }] }), e => e instanceof ValidationError && /individual/.test(e.message));
  await assert.rejects(pool.query(`INSERT INTO tax_household_member (org_id, entity_id, party_id, role, effective_from) VALUES ($1, $2, $3, 'taxpayer', '2030-01-01')`, [H.orgId, H.entityId, outside]), /individual/);
  await assert.rejects(saveGrantorReporting(pool, { orgId: H.orgId, trustPartyId: trust, rows: [{ ownerPartyId: outside, shareNum: 1, shareDen: 1, from: '2025-01-01' }], method: 'optional_1', reviewedBy: 'reviewer', evidenceNote: 'trust instrument' }),
    e => e instanceof ValidationError && /individual/.test(e.message));
  await assert.rejects(pool.query(`INSERT INTO grantor_reporting (org_id, trust_party_id, owner_party_id, share_num, share_den, effective_from, method) VALUES ($1, $2, $3, 1, 1, '2025-01-01', 'optional_1')`, [H.orgId, trust, outside]), /individual/);
  // A party that is a household member (or a grantor owner) keeps its kind while it is one.
  await assert.rejects(saveParty(pool, { orgId: H.orgId, partyId: pat, fields: { kind: 'entity_outside', name: 'Pat Sample' }, env: {} }), /individual/);
  await assert.rejects(pool.query(`UPDATE tax_party SET kind = 'trust' WHERE party_id = $1`, [pat]), /individual/);
});

test('grantor owners carry their review state: an unreviewed allocation is distinguishable from a reviewed one', async () => {
  await saveGrantorReporting(pool, { orgId: H.orgId, trustPartyId: trust, rows: [{ ownerPartyId: pat, shareNum: 1, shareDen: 2, from: '2025-01-01' }, { ownerPartyId: sam, shareNum: 1, shareDen: 2, from: '2025-01-01' }],
    method: 'optional_1', reviewedBy: null, evidenceNote: null });
  let owners = await grantorOwnersOn(pool, { orgId: H.orgId, trustPartyId: trust, on: '2025-06-30' });
  assert.deepEqual(owners.map(o => [o.owner_party_id, o.review_status, o.reviewed_by, o.evidence_note]), [[pat, 'unreviewed', null, null], [sam, 'unreviewed', null, null]]);
  // A reviewer without evidence is not a reviewed allocation either.
  await saveGrantorReporting(pool, { orgId: H.orgId, trustPartyId: trust, rows: [{ ownerPartyId: pat, shareNum: 1, shareDen: 1, from: '2026-01-01' }], method: 'optional_1', reviewedBy: 'reviewer', evidenceNote: null });
  assert.equal((await grantorOwnersOn(pool, { orgId: H.orgId, trustPartyId: trust, on: '2026-06-30' }))[0].review_status, 'unreviewed');
  await saveGrantorReporting(pool, { orgId: H.orgId, trustPartyId: trust, rows: [{ ownerPartyId: pat, shareNum: 1, shareDen: 1, from: '2027-01-01' }], method: 'optional_1', reviewedBy: 'reviewer', evidenceNote: 'Trust instrument art. 4; 2027 workpaper' });
  owners = await grantorOwnersOn(pool, { orgId: H.orgId, trustPartyId: trust, on: '2027-06-30' });
  assert.deepEqual(owners.map(o => [o.owner_party_id, o.review_status, o.reviewed_by, o.evidence_note]), [[pat, 'reviewed', 'reviewer', 'Trust instrument art. 4; 2027 workpaper']]);
});
