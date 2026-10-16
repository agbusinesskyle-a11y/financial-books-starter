// test/tax-providers.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './harness.js';
import { generateSample } from '../lib/seed/generate.js';
import { writeSample } from '../lib/data/seed.js';
import { saveProfile, openPeriod } from '../lib/tax/periods.js';
import { slotKey, parseSlotKey, slotsFor, slotStatus, validateResult, aggregate, assignProvider, assignPacket, listAssignments, substituteProvider, centsToJson, centsFromJson } from '../lib/tax/providers.js';

let db, pool, S, returnId;
const C1065 = { returnType: 'form_1065', edition: 2025 };
// Declarative envelope fixtures (spec §4.7): the request a provider answers and the packet it returns.
const request = slots => ({ returnId, revisionContext: 'working', slots, period: { start: '2025-01-01', end: '2025-12-31' }, method: 'cash', bookBasis: 'accrual' });
const packet = (values, o = {}) => ({ providerKind: 'books', schemaVersion: 1, sourceVersion: 'books@v1', sourceRefs: [{ kind: 'ledger', id: '1', version: 'v1' }],
  values, relatedOutputs: [], consumedSlices: [], completeness: 'complete', reasons: [], review: { state: 'reviewed', by: 'tester' }, ...o });
const slice = txn => ({ entity: 'e:1', account: 'a:6100', txn, line: 'l:1', measurement: 'activity' });
before(async () => {
  db = await freshDb(); pool = db.pool;
  const ids = await writeSample(pool, generateSample({ asOf: '2026-10-12' }));
  S = { orgId: ids.orgId, entityId: ids.entityId };
  await saveProfile(pool, { ...S, fields: { returnType: 'form_1065', taxMethodDefault: 'cash', bookBasisDefault: 'accrual', yearEndMonth: 12 }, reason: 'setup', actor: 'tester' });
  returnId = await openPeriod(pool, { ...S, year: 2025, actor: 'tester' });
});
after(async () => { await db.drop(); });

test('slot keys name the field, its instance dimensions and the measurement; computed fields are never slots', () => {
  const k = slotKey({ fieldId: 'f1065.p1.4', dims: { k1_source: 'k1:77' }, measurement: 'activity' });
  assert.equal(k, 'f1065.p1.4|k1_source=k1:77|activity');
  assert.deepEqual(parseSlotKey(k), { fieldId: 'f1065.p1.4', dims: { k1_source: 'k1:77' }, measurement: 'activity' });
  assert.throws(() => slotKey({ fieldId: 'f1065.p1.23', dims: {}, measurement: 'activity', returnType: 'form_1065', edition: 2025 }), /computed field f1065\.p1\.23 is not a slot/);
  assert.throws(() => slotKey({ fieldId: 'f1065.p1.10', dims: {}, measurement: 'activity', returnType: 'form_1065', edition: 2025 }), /needs dimension interest/);
  const slots = slotsFor('form_1065', 2025);
  assert.ok(slots.some(s => s.fieldId === 'f1065.L.1' && s.measurements.includes('begin') && s.measurements.includes('end')), 'balance lines take begin and end');
  assert.ok(slots.find(s => s.fieldId === 'f1065.p1.9').measurements.join() === 'activity');
});

test('a result envelope carries string cents and completeness; an incomplete result propagates unresolved, never zero', () => {
  const K = n => `f1065.p1.4|k1_source=k1:${n}|activity`;
  const k1 = (n, cents, o = {}) => packet([{ slotKey: K(n), statementRows: [{ label: `K-1 ${n}`, amountCents: cents }] }], { providerKind: 'k1_record', sourceVersion: `k1:${n}@v3`, sourceRefs: [{ kind: 'k1_record', id: String(n), version: 'v3' }], ...o });
  assert.deepEqual(validateResult(k1(77, '10268800'), request([K(77)]), C1065), []);
  assert.match(validateResult(packet([{ slotKey: 'f1065.p1.9|activity', amountCents: 102688 }]), request(['f1065.p1.9|activity']), C1065).join(' '), /amountCents must be a string of digits/);
  assert.match(validateResult(packet([], { providerKind: 'nope' }), request([]), C1065).join(' '), /providerKind/);
  // Two K-1 contributions to one computed line: two members of a collection slot, summed once by the formula.
  assert.deepEqual(aggregate([k1(77, '10268800'), k1(78, '-3860900')], C1065).get('f1065.p1.4|activity'), { cents: 6407900n, members: 2, status: 'complete', review: 'reviewed' });
  const partial = aggregate([k1(77, '10268800'), packet([{ slotKey: K(79), statementRows: null, completeness: 'unresolved', reasons: ['K-1 not received'] }], { providerKind: 'k1_record', sourceVersion: 'k1:79@v1', completeness: 'partial', reasons: ['K-1 not received'] })], C1065);
  assert.deepEqual(partial.get('f1065.p1.4|activity'), { cents: null, members: 2, status: 'unresolved', review: 'reviewed' });
  // The same member twice is never added twice: a repeated slot is a conflict, not a sum (one provider owns each member).
  assert.equal(aggregate([k1(77, '100'), k1(77, '100', { sourceVersion: 'k1:77@v4' })], C1065).get('f1065.p1.4|activity').status, 'conflict');
  // bigint survives JSON exactly.
  assert.equal(centsToJson(9007199254740993n), '9007199254740993');
  assert.equal(centsFromJson('9007199254740993'), 9007199254740993n);
  assert.throws(() => centsFromJson(9007199254740993), /string/);
});

test('a provider switch replaces the whole related packet atomically, refuses a partial replacement, and never consumes a slice twice (Codex t1-r1 B3)', async () => {
  const dep = 'f1065.p1.16a|activity', s179 = 'f1065.k.12|activity';
  const a1 = 'f1065.p1.16a|asset=a:1|activity', a2 = 'f1065.p1.16a|asset=a:2|activity';
  // The manual provider's packet: a typed depreciation total and the section 179 deduction that goes with it, one source slice.
  const manual = packet([{ slotKey: dep, amountCents: '10000' }, { slotKey: s179, amountCents: '5000' }], { providerKind: 'manual', sourceVersion: 'manual:dep@v1',
    sourceRefs: [{ kind: 'manual_item', id: '1', version: 'v1' }], consumedSlices: [slice('t:1')] });
  await assignPacket(pool, { ...S, returnId, request: request([dep, s179]), packet: manual });
  await assert.rejects(assignProvider(pool, { ...S, returnId, slotKey: dep, providerKind: 'asset_register', schemaVersion: 1, sourceVersion: 'a1' }), /already has a provider/);
  // The asset register's packet: one member per asset, the 179 output, and the related outputs that move with them (book-to-tax difference, recapture).
  const assets = packet([{ slotKey: a1, amountCents: '6000' }, { slotKey: a2, amountCents: '4000' }, { slotKey: s179, amountCents: '5000' }], { providerKind: 'asset_register', sourceVersion: 'register@v1',
    sourceRefs: [{ kind: 'asset_register', id: 'r1', version: 'v1' }], consumedSlices: [slice('t:1')],
    relatedOutputs: [{ kind: 'book_tax_difference', key: 'depreciation', amountCents: '1200', item: 'Depreciation', nature: 'temporary' }, { kind: 'recapture', key: 'a:2', amountCents: '0', asset: 'a:2', section: '1245' }] });
  const reconciliation = { collections: [{ collectionKey: 'f1065.p1.16a|activity', oldCents: '10000', newCents: '10000' }, { collectionKey: 'f1065.k.12|activity', oldCents: '5000', newCents: '5000' }] };
  const switchTo = o => substituteProvider(pool, { ...S, returnId, from: { providerKind: 'manual', sourceVersion: 'manual:dep@v1' }, retire: [dep, s179],
    request: request([a1, a2, s179]), packet: assets, reviewedBy: 'tester', reconciliation, ...o });
  // Partial: retiring the depreciation but leaving the same packet's 179 output live is refused.
  await assert.rejects(switchTo({ retire: [dep] }), /Partial replacement refused: f1065\.k\.12\|activity also comes from that packet/);
  await assert.rejects(switchTo({ retire: [dep, s179, 'f1065.p1.9|activity'] }), /f1065\.p1\.9\|activity is not provided by that packet/);
  // The replacement packet must be a supported, complete, reviewed packet with a source version, and every touched collection reconciled.
  await assert.rejects(switchTo({ packet: { ...assets, schemaVersion: 99 } }), /schemaVersion 99 is not supported/);
  await assert.rejects(switchTo({ packet: { ...assets, sourceVersion: undefined } }), /sourceVersion is required/);
  await assert.rejects(switchTo({ packet: { ...assets, completeness: 'partial', reasons: ['asset 3 missing'] } }), /complete/);
  await assert.rejects(switchTo({ packet: { ...assets, review: { state: 'unreviewed' } } }), /reviewed/);
  await assert.rejects(switchTo({ reconciliation: { collections: reconciliation.collections.slice(0, 1) } }), /reconcile f1065\.k\.12\|activity/);
  await assert.rejects(switchTo({ reviewedBy: '' }), /say who reviewed it/);
  // Codex t1-r3 B3: a replacement with no value rows would keep nothing (its snapshot, carried related outputs and reconciliation live on
  // value rows), so it is refused before anything is deleted, and a first assignment with no values is refused too.
  const empty = { ...assets, values: [] };
  await assert.rejects(switchTo({ request: request([]), packet: empty, reconciliation: { collections: [{ collectionKey: 'f1065.p1.16a|activity', oldCents: '10000', newCents: '0', reason: 'retired' }, { collectionKey: 'f1065.k.12|activity', oldCents: '5000', newCents: '0', reason: 'retired' }] } }), /at least one slot/);
  await assert.rejects(assignPacket(pool, { ...S, returnId, request: request([]), packet: { ...empty, sourceVersion: 'register@empty', consumedSlices: [slice('t:empty')] } }), /at least one slot/);
  // Nothing changed by any refusal.
  assert.deepEqual((await listAssignments(pool, { ...S, returnId })).filter(r => r.slot_key.startsWith('f1065.p1.16a') || r.slot_key === s179).map(r => [r.slot_key, r.provider_kind]).sort(),
    [[s179, 'manual'], [dep, 'manual']].sort());
  await switchTo({});
  const rows = (await listAssignments(pool, { ...S, returnId })).filter(r => r.slot_key.startsWith('f1065.p1.16a') || r.slot_key === s179);
  assert.deepEqual(rows.map(r => [r.slot_key, r.provider_kind, r.source_version]).sort(), [[a1, 'asset_register', 'register@v1'], [a2, 'asset_register', 'register@v1'], [s179, 'asset_register', 'register@v1']].sort());
  // The snapshot keeps the packet, what it retired and the reconciliation; the retired manual member is gone, so $100 is never added to a replaced $100.
  const snap = rows.find(r => r.slot_key === a1).source_ref;
  assert.deepEqual([snap.packet.relatedOutputs.length, snap.substituted.retired, snap.substituted.reviewedBy], [2, [dep, s179].sort(), 'tester']);
  assert.equal(slotStatus(rows, dep).status, 'unresolved');
  // The old packet is gone, so switching from it again finds nothing.
  await assert.rejects(switchTo({}), /no packet from manual/);
  // A source slice still consumed by another live packet cannot be consumed again by a replacement.
  const interest = 'f1065.p1.15|activity';
  await assignPacket(pool, { ...S, returnId, request: request([interest]), packet: packet([{ slotKey: interest, amountCents: '700' }], { sourceVersion: 'books@int', consumedSlices: [slice('t:5')] }) });
  await assert.rejects(substituteProvider(pool, { ...S, returnId, from: { providerKind: 'asset_register', sourceVersion: 'register@v1' }, retire: [a1, a2, s179], request: request([a1, a2, s179]),
    packet: { ...assets, sourceVersion: 'register@v2', consumedSlices: [slice('t:1'), slice('t:5')] }, reviewedBy: 'tester', reconciliation }), /slice .*t:5.* is already consumed/);
});

test('a slot key is checked against the return’s catalog on write: computed, unknown, missing dimension, wrong measurement, non-canonical', async () => {
  const bad = (key, re, o = {}) => assert.rejects(assignProvider(pool, { ...S, returnId, slotKey: key, providerKind: 'manual', schemaVersion: 1, sourceVersion: 'v1', ...o }), re);
  await bad('f1065.p1.23|activity', /computed field f1065\.p1\.23 is not a slot/);
  await bad('not.a.field|activity', /unknown field not\.a\.field/);
  await bad('f1065.p1.10|activity', /needs dimension interest/);
  await bad('f1065.L.1|activity', /f1065\.L\.1 takes begin or end, not activity/);
  await bad('f1065.p1.9|end', /f1065\.p1\.9 takes activity, not end/);
  await bad('f1065.p1.9|activity|', /unknown measurement/);
  await bad('f1065.p1.9|interest=i:1|activity', /f1065\.p1\.9 has no dimension interest/);
  // An assignment names a supported schema and an immutable source version.
  await bad('f1065.p1.12|activity', /schemaVersion 99 is not supported/, { schemaVersion: 99 });
  await bad('f1065.p1.12|activity', /sourceVersion is required/, { sourceVersion: null });
  // A balance line takes begin and end; a dimensioned line takes its dimension.
  await assignProvider(pool, { ...S, returnId, slotKey: 'f1065.L.1|begin', providerKind: 'books', schemaVersion: 1, sourceVersion: 'b1' });
  await assignProvider(pool, { ...S, returnId, slotKey: 'f1065.p1.10|interest=i:1|activity', providerKind: 'books', schemaVersion: 1, sourceVersion: 'b1' });
  // The review's pair: a repeated dimension is the same semantic slot, so it is refused before the uniqueness check could see two strings.
  await assignProvider(pool, { ...S, returnId, slotKey: 'f1065.p1.4|k1_source=k1:1|activity', providerKind: 'k1_record', schemaVersion: 1, sourceVersion: 'k1:1@v1' });
  await bad('f1065.p1.4|k1_source=discarded|k1_source=k1:1|activity', /repeated dimension k1_source/, { providerKind: 'k1_record' });
  await bad('k1_1065.box.11|interest=i:1|code=A|activity', /not canonical/);
  // The same check guards substitution.
  await assert.rejects(substituteProvider(pool, { ...S, returnId, from: { providerKind: 'manual', sourceVersion: 'v1' }, retire: ['f1065.p1.23|activity'], request: request(['f1065.p1.9|activity']),
    packet: packet([{ slotKey: 'f1065.p1.9|activity', amountCents: '1' }]), reviewedBy: 'tester', reconciliation: { collections: [] } }), /is not a slot/);
});

test('substitution is scoped to the period’s entity and refused once the period is no longer open', async () => {
  const key = 'f1065.p1.11|activity';
  await assignPacket(pool, { ...S, returnId, request: request([key]), packet: packet([{ slotKey: key, amountCents: '300' }], { sourceVersion: 'books@repairs' }) });
  const args = o => ({ ...S, returnId, from: { providerKind: 'books', sourceVersion: 'books@repairs' }, retire: [key], request: request([key]),
    packet: packet([{ slotKey: key, amountCents: '300' }], { providerKind: 'manual', sourceVersion: 'manual:repairs@v1' }), reviewedBy: 'tester',
    reconciliation: { collections: [{ collectionKey: key, oldCents: '300', newCents: '300' }] }, ...o });
  // Another company in the same org: the return is not its period, so nothing is switched (and its lock is not what serializes this return).
  const { rows: [other] } = await pool.query(`INSERT INTO entity (org_id, name, time_zone) VALUES ($1, 'Second Sample Co', 'America/Chicago') RETURNING entity_id`, [S.orgId]);
  await assert.rejects(substituteProvider(pool, args({ entityId: other.entity_id })), /Period not found/);
  // Nor does it read them: the list is scoped to the period's company, so another company's return id shows nothing.
  assert.deepEqual(await listAssignments(pool, { ...S, entityId: other.entity_id, returnId }), []);
  await pool.query('UPDATE tax_return SET status = $3 WHERE org_id = $1 AND return_id = $2', [S.orgId, returnId, 'filed']);
  try {
    await assert.rejects(substituteProvider(pool, args({})), /This period is not open/);
    await assert.rejects(assignProvider(pool, { ...S, returnId, slotKey: 'f1065.p1.17|activity', providerKind: 'books', schemaVersion: 1, sourceVersion: 'b1' }), /This period is not open/);
    await assert.rejects(assignPacket(pool, { ...S, returnId, request: request(['f1065.p1.17|activity']), packet: packet([{ slotKey: 'f1065.p1.17|activity', amountCents: '1' }], { sourceVersion: 'b9' }) }), /This period is not open/);
  } finally { await pool.query('UPDATE tax_return SET status = $3 WHERE org_id = $1 AND return_id = $2', [S.orgId, returnId, 'open']); }
  const rows = await listAssignments(pool, { ...S, returnId });
  assert.equal(rows.find(r => r.slot_key === key).provider_kind, 'books');
});

test('a switch’s reconciliation is derived from the stored old packet and the new one: false totals are refused, a real change needs a reason (Codex t1-r2 B3)', async () => {
  const rent = 'f1065.p1.13|activity', ret = 'f1065.p1.18|activity';
  await assignPacket(pool, { ...S, returnId, request: request([rent, ret]), packet: packet([{ slotKey: rent, amountCents: '10000' }, { slotKey: ret, amountCents: '5000' }], { providerKind: 'manual', sourceVersion: 'manual:rent@v1' }) });
  const next = packet([{ slotKey: rent, amountCents: '90000' }, { slotKey: ret, amountCents: '5000' }], { providerKind: 'books', sourceVersion: 'books@rent' });
  const switchTo = collections => substituteProvider(pool, { ...S, returnId, from: { providerKind: 'manual', sourceVersion: 'manual:rent@v1' }, retire: [rent, ret],
    request: request([rent, ret]), packet: next, reviewedBy: 'tester', reconciliation: { collections } });
  // The review's probe: 10000 replaced by 90000 while the reconciliation claimed 10000 -> 10000.
  await assert.rejects(switchTo([{ collectionKey: rent, oldCents: '10000', newCents: '10000' }, { collectionKey: ret, oldCents: '5000', newCents: '5000' }]),
    /Reconciliation of f1065\.p1\.13\|activity: newCents 10000 is not the replacement packet’s 90000/);
  await assert.rejects(switchTo([{ collectionKey: rent, oldCents: '12000', newCents: '90000', reason: 'rent restated' }, { collectionKey: ret, oldCents: '5000', newCents: '5000' }]),
    /oldCents 12000 is not the replaced packet’s 10000/);
  // A truthful but changed total still needs the reviewed reason for the change.
  await assert.rejects(switchTo([{ collectionKey: rent, oldCents: '10000', newCents: '90000' }, { collectionKey: ret, oldCents: '5000', newCents: '5000' }]),
    /f1065\.p1\.13\|activity changes from 10000 to 90000: give the reason/);
  // A reconciliation of a collection the switch does not touch is refused, not stored.
  await assert.rejects(switchTo([{ collectionKey: rent, oldCents: '10000', newCents: '90000', reason: 'r' }, { collectionKey: ret, oldCents: '5000', newCents: '5000' }, { collectionKey: 'f1065.p1.19|activity', oldCents: '0', newCents: '0' }]),
    /f1065\.p1\.19\|activity is not touched by this switch/);
  assert.deepEqual((await listAssignments(pool, { ...S, returnId })).filter(r => [rent, ret].includes(r.slot_key)).map(r => r.provider_kind), ['manual', 'manual']);
  await switchTo([{ collectionKey: rent, oldCents: '10000', newCents: '90000', reason: 'rent restated from the lease' }, { collectionKey: ret, oldCents: '5000', newCents: '5000' }]);
  const rows = (await listAssignments(pool, { ...S, returnId })).filter(r => [rent, ret].includes(r.slot_key));
  assert.deepEqual(rows.map(r => [r.provider_kind, r.source_ref.value.amountCents]).sort(), [['books', '5000'], ['books', '90000']]);
  assert.equal(rows.find(r => r.slot_key === rent).source_ref.substituted.reconciliation.collections[0].reason, 'rent restated from the lease');
});

test('every related output of the replaced packet is carried or explicitly retired with a truthful reconciliation; none disappears (Codex t1-r2 B3)', async () => {
  const ben = 'f1065.p1.19|activity';
  const btd = { kind: 'book_tax_difference', key: 'dep', amountCents: '1200', item: 'Depreciation', nature: 'temporary' };
  const rec = { kind: 'recapture', key: 'asset:1', amountCents: '700', asset: 'asset:1', section: '1245' };
  await assignPacket(pool, { ...S, returnId, request: request([ben]), packet: packet([{ slotKey: ben, amountCents: '800' }], { providerKind: 'manual', sourceVersion: 'manual:ben@v1', relatedOutputs: [btd, rec] }) });
  const collections = [{ collectionKey: ben, oldCents: '800', newCents: '800' }];
  const switchTo = (relatedOutputs, outs) => substituteProvider(pool, { ...S, returnId, from: { providerKind: 'manual', sourceVersion: 'manual:ben@v1' }, retire: [ben], request: request([ben]),
    packet: packet([{ slotKey: ben, amountCents: '800' }], { providerKind: 'books', sourceVersion: 'books@ben', relatedOutputs }), reviewedBy: 'tester', reconciliation: { collections, ...(outs ? { relatedOutputs: outs } : {}) } });
  // The review's probe: the new packet carries no related outputs at all.
  await assert.rejects(switchTo([]), /related output book_tax_difference dep of the replaced packet is neither carried nor retired/);
  // Carrying one and silently dropping the other is refused too.
  await assert.rejects(switchTo([btd]), /recapture asset:1 of the replaced packet is neither carried nor retired/);
  // A retirement must be truthful (the old amount) and reasoned; a changed carried output is reconciled the same way.
  await assert.rejects(switchTo([btd], [{ kind: 'recapture', key: 'asset:1', oldCents: '100', newCents: null, reason: 'asset kept' }]), /recapture asset:1: oldCents 100 is not the replaced packet’s 700/);
  await assert.rejects(switchTo([btd], [{ kind: 'recapture', key: 'asset:1', oldCents: '700', newCents: null }]), /recapture asset:1 is retired: give the reason/);
  await assert.rejects(switchTo([{ ...btd, amountCents: '1500' }, rec]), /book_tax_difference dep changes from 1200 to 1500: reconcile it/);
  await assert.rejects(switchTo([btd, rec], [{ kind: 'disposition', key: 'asset:9', oldCents: '1', newCents: null, reason: 'x' }]), /disposition asset:9 is not a related output of the replaced packet/);
  assert.equal((await listAssignments(pool, { ...S, returnId })).find(r => r.slot_key === ben).provider_kind, 'manual');
  await switchTo([{ ...btd, amountCents: '1500' }], [{ kind: 'recapture', key: 'asset:1', oldCents: '700', newCents: null, reason: 'the asset was not disposed of' },
    { kind: 'book_tax_difference', key: 'dep', oldCents: '1200', newCents: '1500', reason: 'book life corrected' }]);
  const row = (await listAssignments(pool, { ...S, returnId })).find(r => r.slot_key === ben);
  assert.deepEqual([row.provider_kind, row.source_ref.packet.relatedOutputs.map(o => o.key), row.source_ref.substituted.reconciliation.relatedOutputs.map(o => o.key)], ['books', ['dep'], ['asset:1', 'dep']]);
});

test('a request’s period, tax method and book basis must be the return’s own, on assignment and on replacement (Codex t1-r2 B3)', async () => {
  const wage = 'f1065.p1.9|activity';
  const wrong = o => ({ ...request([wage]), ...o });
  const p = packet([{ slotKey: wage, amountCents: '123' }], { sourceVersion: 'wrong-period:v1' });
  // The review's probe: a calendar-2024, accrual-method, cash-basis request was snapshotted on a calendar-2025 cash-method, accrual-basis return.
  await assert.rejects(assignPacket(pool, { ...S, returnId, request: wrong({ period: { start: '2024-01-01', end: '2024-12-31' }, method: 'accrual', bookBasis: 'cash' }), packet: p }),
    /The request’s period 2024-01-01 to 2024-12-31 is not this return’s 2025-01-01 to 2025-12-31/);
  await assert.rejects(assignPacket(pool, { ...S, returnId, request: wrong({ method: 'accrual' }), packet: p }), /The request’s tax method accrual is not this return’s cash/);
  await assert.rejects(assignPacket(pool, { ...S, returnId, request: wrong({ bookBasis: 'cash' }), packet: p }), /The request’s book basis cash is not this return’s accrual/);
  await assert.rejects(assignPacket(pool, { ...S, returnId, request: wrong({ period: { start: '2025-01-01', end: '2025-06-30' } }), packet: p }), /period/);
  assert.equal((await listAssignments(pool, { ...S, returnId })).some(r => r.slot_key === wage), false);
  await assignPacket(pool, { ...S, returnId, request: request([wage]), packet: p });
  await assert.rejects(substituteProvider(pool, { ...S, returnId, from: { providerKind: 'books', sourceVersion: 'wrong-period:v1' }, retire: [wage], request: wrong({ method: 'accrual' }),
    packet: packet([{ slotKey: wage, amountCents: '123' }], { providerKind: 'manual', sourceVersion: 'manual:wage@v1' }), reviewedBy: 'tester',
    reconciliation: { collections: [{ collectionKey: wage, oldCents: '123', newCents: '123' }] } }), /The request’s tax method accrual is not this return’s cash/);
});
