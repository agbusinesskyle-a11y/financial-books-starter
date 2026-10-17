// test/tax-copy-forward.test.js — defaults reused period by period: copy-forward and the re-resolution of period-specific references.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { t2Db, company, acct, je, period, activity, include, party } from './tax-t2-fixtures.js';
import { saveBindings, listBindings, listDefaults, copyForward, resolveReferences, T2_RESOLVERS } from '../lib/tax/bindings.js';
import { openPeriod } from '../lib/tax/periods.js';
import { includeBooks } from '../lib/tax/activities.js';

let t, pool, orgId, P, C, A, ids;
before(async () => {
  t = await t2Db(); pool = t.pool; orgId = t.orgId;
  P = { orgId, entityId: await company(pool, orgId, 'Pine Partners') };
  C = { orgId, entityId: await company(pool, orgId, 'Pine Rental LLC') };
  ids = {};
  ids.r25 = await period(pool, P, 2025, 'form_1065');
  ids.c25 = await period(pool, C, 2025, 'disregarded', { activityKind: 'rental' });
  ids.north25 = await activity(pool, P, { name: 'North rental 2025', kind: 'rental', schedule: 'f8825', from: '2025-01-01', to: '2025-12-31' });
  ids.north26 = await activity(pool, P, { name: 'North rental 2026', kind: 'rental', schedule: 'f8825', from: '2026-01-01' });
  ids.old = await activity(pool, P, { name: 'Old rental', kind: 'rental', schedule: 'f8825', from: '2020-01-01', to: '2025-12-31' });
  await include(pool, P, ids.r25, ids.north25, C.entityId);
  A = { rents: await acct(pool, C, 'Rents Received', 'income'), childBank: await acct(pool, C, 'Checking'), services: await acct(pool, P, 'Services'),
    draw: await acct(pool, P, 'Owner’s Draw'), k1: await acct(pool, P, 'Other Income') };
  await je(pool, C, '2025-04-01', [[A.childBank, 120000], [A.rents, -120000]]);
  await je(pool, C, '2026-04-01', [[A.childBank, 130000], [A.rents, -130000]]);
  ids.owner = await party(pool, orgId, 'Quinn Sample Owner');
  ids.payer = await party(pool, orgId, 'Outside Sample Partnership', 'entity_outside');
  const save = o => saveBindings(pool, { ...P, returnId: ids.r25, actor: 'tester', makeDefault: true, measurement: 'activity', ...o });
  await save({ sourceEntityId: C.entityId, accountId: A.rents, rows: [{ treatment: 'input', destination: 'f8825.main.2a' }] });
  await save({ sourceEntityId: P.entityId, accountId: A.services, rows: [{ treatment: 'input', destination: 'f8825.main.2b', activityId: ids.old }] });
  await save({ sourceEntityId: P.entityId, accountId: A.draw, rows: [{ treatment: 'equity_event', destination: 'distribution_cash', interestPartyId: ids.owner }] });
  await save({ sourceEntityId: P.entityId, accountId: A.k1, rows: [{ treatment: 'k1_booked', k1IssuerPartyId: ids.payer }] });
});
after(async () => { await t.db.drop(); });
const of = async (returnId, accountId) => (await listBindings(pool, { ...P, returnId })).filter(b => b.account_id === accountId);

test('defaults keep stable references: the inclusion rule, a fixed activity, the owner and the K-1 payer as parties', async () => {
  const defs = [...await listDefaults(pool, C), ...await listDefaults(pool, P)];
  const by = id => defs.find(d => d.account_id === id);
  assert.deepEqual([by(A.rents).activity_rule, by(A.rents).activity_id], ['inclusion', null]);
  assert.deepEqual([by(A.services).activity_rule, by(A.services).activity_id], ['fixed', ids.old]);
  assert.equal(by(A.draw).interest_party_id, ids.owner);
  assert.equal(by(A.k1).k1_issuer_party_id, ids.payer);
});

test('opening a period copies the defaults forward and re-resolves what is period-specific', async () => {
  ids.r26 = Number(await openPeriod(pool, { ...P, year: 2026, actor: 'tester' }));
  const [services] = await of(ids.r26, A.services);
  assert.equal(services.source, 'default');
  assert.equal(services.activity_id, null, 'the 2025-only activity is not carried into 2026');
  assert.match(services.pending.map(p => p.reason).join(' '), /Old rental is not in effect in this period/);
  assert.equal(services.slot_key, null);
  assert.equal(services.catalog_edition, 2025, '2026 binds provisionally against the 2025 catalog');
  const [draw] = await of(ids.r26, A.draw);
  assert.deepEqual([draw.interest_party_id, draw.interest_id], [ids.owner, null]);
  assert.equal((await of(ids.r26, A.rents)).length, 0, 'the child’s books are not in 2026 until an inclusion says so');
  // Including the child for 2026 copies its defaults with THIS period's inclusion activity.
  ids.c26 = await period(pool, C, 2026, 'disregarded', { activityKind: 'rental' });
  await include(pool, P, ids.r26, ids.north26, C.entityId);
  const [rents26] = await of(ids.r26, A.rents);
  const [rents25] = await of(ids.r25, A.rents);
  assert.equal(rents25.activity_id, ids.north25);
  assert.equal(rents26.activity_id, ids.north26);
  assert.equal(rents26.slot_key, `f8825.main.2a|activity=act:${ids.north26}|activity`);
  assert.notEqual(rents26.source_version, rents25.source_version, 'each period measures its own activity');
});

test('owner and K-1 references resolve to each period’s own interest and K-1 record', async () => {
  // The owner's interest for each year is on file (ownership_interest, history kept: the 2025 row closed, a 2026 row added); the K-1
  // resolver is injected T4-style (lib/tax/references.js contract).
  const row = async (from, to, num) => Number((await pool.query(`INSERT INTO ownership_interest (org_id, entity_id, party_id, role, effective_from, effective_to, profit_num, profit_den,
      loss_num, loss_den, capital_num, capital_den, created_by) VALUES ($1,$2,$3,'general_partner',$4,$5,$6,2,$6,2,$6,2,'tester') RETURNING interest_id`, [orgId, P.entityId, ids.owner, from, to, num])).rows[0].interest_id);
  ids.i25 = await row('2025-01-01', '2025-12-31', 1);
  ids.i26 = await row('2026-01-01', null, 2);
  const resolvers = { ...T2_RESOLVERS, k1: async ({ periodStart }) => ({ status: 'selected', id: periodStart.startsWith('2025') ? 301 : 302, version: 'k1@1' }) };
  assert.equal((await resolveReferences(pool, { ...P, returnId: ids.r25, resolvers })).updated, 2);
  assert.equal((await resolveReferences(pool, { ...P, returnId: ids.r26, resolvers })).updated, 2);
  const [d25] = await of(ids.r25, A.draw), [d26] = await of(ids.r26, A.draw), [k25] = await of(ids.r25, A.k1), [k26] = await of(ids.r26, A.k1);
  assert.deepEqual([d25.interest_id, d26.interest_id, k25.k1_source_id, k26.k1_source_id], [ids.i25, ids.i26, 301, 302]);
  assert.deepEqual(d26.pending, []);
  const [s26] = await of(ids.r26, A.services);
  assert.match(s26.pending.map(p => p.reason).join(' '), /not in effect/, 'resolving owners leaves the activity question open');
});

test('a resolved reference is refreshed when its record is corrected, and cleared when it is no longer eligible (B5)', async () => {
  // The 2026 K-1 is corrected (a new version of record 302), then the payer's record is found ineligible (wrong payer period).
  const corrected = { interest: T2_RESOLVERS.interest, k1: async () => ({ status: 'selected', id: 302, version: 'k1@2-corrected' }) };
  assert.equal((await resolveReferences(pool, { ...P, returnId: ids.r26, resolvers: corrected })).updated, 1);
  assert.equal((await of(ids.r26, A.k1))[0].k1_source_version, 'k1@2-corrected');
  const ineligible = { interest: T2_RESOLVERS.interest, k1: async () => ({ status: 'ineligible', reason: 'The payer’s period does not end in this year.' }) };
  assert.equal((await resolveReferences(pool, { ...P, returnId: ids.r26, resolvers: ineligible })).updated, 1);
  const [k26] = await of(ids.r26, A.k1);
  assert.deepEqual([k26.k1_source_id, k26.k1_source_version], [null, null]);
  assert.match(k26.pending.map(p => p.reason).join(' '), /payer’s period/);
  // The owner's 2026 interest is corrected (another profit share): its version changes, and the binding is refreshed to it.
  const before = (await of(ids.r26, A.draw))[0].interest_version;
  await pool.query('UPDATE ownership_interest SET profit_num = 1, profit_den = 3 WHERE interest_id = $1', [ids.i26]);
  assert.equal((await resolveReferences(pool, { ...P, returnId: ids.r26, resolvers: ineligible })).updated, 1);
  assert.notEqual((await of(ids.r26, A.draw))[0].interest_version, before);
  // A resolver that answers nonsense selects nothing.
  const broken = { interest: async () => ({ id: 5 }), k1: async () => 'yes' };
  await resolveReferences(pool, { ...P, returnId: ids.r26, resolvers: broken });
  assert.equal((await of(ids.r26, A.draw))[0].interest_id, null);
});

test('edits are period-local, and copying forward again never overwrites them', async () => {
  await saveBindings(pool, { ...P, returnId: ids.r26, sourceEntityId: C.entityId, accountId: A.rents, measurement: 'activity', rows: [{ treatment: 'input', destination: 'f8825.main.2b' }], actor: 'tester' });
  const [r26] = await of(ids.r26, A.rents);
  assert.deepEqual([r26.destination, r26.override], ['f8825.main.2b', true]);
  assert.equal((await of(ids.r25, A.rents))[0].destination, 'f8825.main.2a', '2025 is untouched');
  assert.equal((await listDefaults(pool, C))[0].destination, 'f8825.main.2a', 'the default is untouched');
  assert.equal((await copyForward(pool, { ...P, returnId: ids.r26, actor: 'tester' })).copied, 0);
  assert.equal((await of(ids.r26, A.rents))[0].destination, 'f8825.main.2b');
});

test('a default the period’s catalog refuses is reported and skipped, never copied blind', async () => {
  const wages = await acct(pool, P, 'Wages');
  await pool.query(`INSERT INTO tax_binding_default (org_id, entity_id, account_id, return_type, measurement, treatment, destination, target_key, catalog_edition)
    VALUES ($1,$2,$3,'form_1065','activity','input','f1065.p1.10','input|f1065.p1.10|a=-|o=-|k=-',2025)`, [orgId, P.entityId, wages]);
  const r = await copyForward(pool, { ...P, returnId: ids.r26, actor: 'tester' });
  assert.deepEqual([r.copied, r.skipped.length], [0, 1]);
  assert.match(r.skipped[0].reason, /guaranteed payments/);
  assert.equal((await of(ids.r26, wages)).length, 0);
});

test('a new edge brings its whole subtree’s defaults, into every open return above it (Codex r2 B4)', async () => {
  // Root R includes M for 2027; M already includes L on its own disregarded period. L's default reaches R when M is included.
  const R = { orgId, entityId: await company(pool, orgId, 'Spruce Partners') };
  const M = { orgId, entityId: await company(pool, orgId, 'Spruce Middle LLC') }, L = { orgId, entityId: await company(pool, orgId, 'Spruce Leaf LLC') };
  const r27 = await period(pool, R, 2027, 'form_1065'), m27 = await period(pool, M, 2027, 'disregarded');
  await period(pool, L, 2027, 'disregarded');
  const lRent = await acct(pool, L, 'Rents Received', 'income');
  await je(pool, L, '2027-03-01', [[await acct(pool, L, 'Checking'), 5000], [lRent, -5000]]);
  // L's default for a partnership return, as an earlier period mapped it.
  await pool.query(`INSERT INTO tax_binding_default (org_id, entity_id, account_id, return_type, measurement, treatment, destination, activity_rule, target_key, catalog_edition, source, created_by)
    VALUES ($1,$2,$3,'form_1065','activity','input','f1065.p1.1a','inclusion','input|f1065.p1.1a|a=inclusion|o=-|k=-',2025,'person','tester')`, [orgId, L.entityId, lRent]);
  await include(pool, M, m27, await activity(pool, M, { name: 'Spruce middle trade' }), L.entityId);
  assert.equal((await listBindings(pool, { ...R, returnId: r27 })).length, 0, 'not yet reachable from the root');
  await include(pool, R, r27, await activity(pool, R, { name: 'Spruce trade' }), M.entityId);
  const got = (await listBindings(pool, { ...R, returnId: r27 })).filter(b => b.account_id === lRent);
  assert.deepEqual(got.map(b => [b.source_entity_id, b.inclusion_path.length, b.destination]), [[L.entityId, 2, 'f1065.p1.1a']]);
  // And an edge added below an already-included company reaches the root as well.
  const L2 = { orgId, entityId: await company(pool, orgId, 'Spruce Second Leaf LLC') };
  await period(pool, L2, 2027, 'disregarded');
  const l2Rent = await acct(pool, L2, 'Rents Received', 'income');
  await je(pool, L2, '2027-03-01', [[await acct(pool, L2, 'Checking'), 700], [l2Rent, -700]]);
  await pool.query(`INSERT INTO tax_binding_default (org_id, entity_id, account_id, return_type, measurement, treatment, destination, activity_rule, target_key, catalog_edition, source, created_by)
    VALUES ($1,$2,$3,'form_1065','activity','input','f1065.p1.1a','inclusion','input|f1065.p1.1a|a=inclusion|o=-|k=-',2025,'person','tester')`, [orgId, L2.entityId, l2Rent]);
  await include(pool, M, m27, (await pool.query('SELECT activity_id FROM tax_activity WHERE org_id = $1 AND return_entity_id = $2', [orgId, M.entityId])).rows[0].activity_id, L2.entityId);
  assert.equal((await listBindings(pool, { ...R, returnId: r27 })).filter(b => b.account_id === l2Rent).length, 1);
});

test('a new edge copies forward only into returns the person may open and edit; the others are reported, not written (Codex r3 R3-N2)', async () => {
  const mk = async (name, year, type) => { const S = { orgId, entityId: await company(pool, orgId, name) }; return { S, ret: await period(pool, S, year, type) }; };
  const R = await mk('Larch Partners', 2028, 'form_1065'), M = await mk('Larch Middle LLC', 2028, 'disregarded'), L = await mk('Larch Leaf LLC', 2028, 'disregarded');
  await include(pool, R.S, R.ret, await activity(pool, R.S, { name: 'Larch trade' }), M.S.entityId);
  const lRent = await acct(pool, L.S, 'Rents Received', 'income');
  await je(pool, L.S, '2028-03-01', [[await acct(pool, L.S, 'Checking'), 900], [lRent, -900]]);
  await pool.query(`INSERT INTO tax_binding_default (org_id, entity_id, account_id, return_type, measurement, treatment, destination, activity_rule, target_key, catalog_edition, source, created_by)
    VALUES ($1,$2,$3,'form_1065','activity','input','f1065.p1.1a','inclusion','input|f1065.p1.1a|a=inclusion|o=-|k=-',2025,'person','tester')`, [orgId, L.S.entityId, lRent]);
  const mAct = await activity(pool, M.S, { name: 'Larch middle trade' });
  // This person may open the middle and the leaf, not the root.
  const report = {};
  await includeBooks(pool, { ...M.S, returnId: M.ret, activityId: mAct, sourceEntityId: L.S.entityId, approvedBy: 'tester', canOpen: id => id !== R.S.entityId, report });
  assert.equal((await listBindings(pool, { ...R.S, returnId: R.ret })).length, 0, 'nothing written on a return this person cannot open');
  assert.deepEqual(report.pendingReturns, [{ entityId: R.S.entityId, returnId: R.ret }]);
  // A person who may open the root but not edit it (an accountant where the company does not allow it): reported, not written.
  await pool.query('DELETE FROM activity_inclusion WHERE org_id = $1 AND source_entity_id = $2', [orgId, L.S.entityId]);
  const r2 = {};
  await includeBooks(pool, { ...M.S, returnId: M.ret, activityId: mAct, sourceEntityId: L.S.entityId, approvedBy: 'tester', canEdit: async id => id !== R.S.entityId, report: r2 });
  assert.equal((await listBindings(pool, { ...R.S, returnId: R.ret })).length, 0);
  assert.equal(r2.pendingReturns.length, 1);
  // Someone who may edit the root copies the defaults later from its mapping page.
  assert.equal((await copyForward(pool, { ...R.S, returnId: R.ret, actor: 'root admin' })).copied, 1);
});

test('mapping and copy-forward authorize the path as it is under the graph lock, not as a page saw it (Codex r3 R3-N3)', async () => {
  const mk = async (name, type) => { const S = { orgId, entityId: await company(pool, orgId, name) }; return { S, ret: await period(pool, S, 2029, type) }; };
  const R = await mk('Hazel Partners', 'form_1065'), L = await mk('Hazel Leaf LLC', 'disregarded'), M = await mk('Hazel Hidden Middle LLC', 'disregarded');
  const rAct = await activity(pool, R.S, { name: 'Hazel trade' });
  const direct = await include(pool, R.S, R.ret, rAct, L.S.entityId);
  const lRent = await acct(pool, L.S, 'Rents Received', 'income');
  await je(pool, L.S, '2029-03-01', [[await acct(pool, L.S, 'Checking'), 800], [lRent, -800]]);
  await pool.query(`INSERT INTO tax_binding_default (org_id, entity_id, account_id, return_type, measurement, treatment, destination, activity_rule, target_key, catalog_edition, source, created_by)
    VALUES ($1,$2,$3,'form_1065','activity','input','f1065.p1.1a','inclusion','input|f1065.p1.1a|a=inclusion|o=-|k=-',2025,'person','tester')`, [orgId, L.S.entityId, lRent]);
  await pool.query('DELETE FROM tax_binding WHERE org_id = $1 AND return_id = $2', [orgId, R.ret]);
  // The page was shown for R → L (visible). Then the graph changes to R → M (hidden from this person) → L.
  await pool.query('DELETE FROM activity_inclusion WHERE org_id = $1 AND inclusion_id = $2', [orgId, direct]);
  await include(pool, M.S, M.ret, await activity(pool, M.S, { name: 'Hazel middle trade' }), L.S.entityId);
  await include(pool, R.S, R.ret, rAct, M.S.entityId);
  await pool.query('DELETE FROM tax_binding WHERE org_id = $1 AND return_id = $2', [orgId, R.ret]);
  const canOpen = id => id !== M.S.entityId;
  await assert.rejects(saveBindings(pool, { ...R.S, returnId: R.ret, sourceEntityId: L.S.entityId, accountId: lRent, measurement: 'activity', rows: [{ treatment: 'input', destination: 'f1065.p1.1a' }], canOpen, actor: 'tester' }),
    /through a company you cannot open/);
  assert.equal((await copyForward(pool, { ...R.S, returnId: R.ret, canOpen, actor: 'tester' })).copied, 0, 'copy-forward skips books behind the hidden company');
  assert.equal((await listBindings(pool, { ...R.S, returnId: R.ret })).length, 0);
});
