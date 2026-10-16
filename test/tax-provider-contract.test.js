// test/tax-provider-contract.test.js — the provider interface as declarative fixtures (spec §4.7, Codex t1-r1 B2/B3). No database, no engines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSlot, collectionKey, aggregate, slotKey, parseSlotKey, canonicalSlotKey, centsToJson, validateRequest, validateResult } from '../lib/tax/providers.js';
import { catalogFor } from '../lib/tax/catalog/index.js';

const H = { returnType: 'household_1040', edition: 2025 }, P = { returnType: 'form_1065', edition: 2025 }, S = { returnType: 'form_1120s', edition: 2025 };
// Declarative envelope fixtures (spec §4.7) ----------------------------------------------------------------------------------------
const request = (slots, o = {}) => ({ returnId: 7, revisionContext: 'working', slots, period: { start: '2025-01-01', end: '2025-12-31' }, method: 'cash', bookBasis: 'accrual', ...o });
const packet = (values, o = {}) => ({ providerKind: 'books', schemaVersion: 1, sourceVersion: 'books@v1', sourceRefs: [{ kind: 'ledger', id: '1', version: 'v1' }],
  values, relatedOutputs: [], consumedSlices: [], completeness: 'complete', reasons: [], review: { state: 'reviewed', by: 'tester' }, ...o });
const WAGES = 'f1065.p1.9|activity', RENT = 'f1065.p1.13|activity';
const slot = (key, ctx) => { const [fieldId, ...rest] = key.split('|'); const measurement = rest.pop(); return checkSlot({ fieldId, dims: Object.fromEntries(rest.map(p => p.split('='))), measurement }, ctx.returnType, ctx.edition); };

test('a slot takes its required instance dimensions and at most one allowed source dimension (Codex t1-r1 B2)', () => {
  // Own amount (no source dimension) and K-1 members (k1_source) on the same mixed-source destinations; the review reproduced
  // "has no dimension k1_source" on each of these.
  for (const [ctx, id] of [[H, 'f1040.b.1'], [H, 'f1040.b.5'], [H, 'f4797.main.2'], [S, 'f1120s.p1.5']]) {
    assert.ok(slot(`${id}|activity`, ctx), `${id}: the own (books or manual) member`);
    assert.ok(slot(`${id}|k1_source=k1:1|activity`, ctx), `${id}: a K-1 member`);
  }
  // A member names one source, never two at once.
  assert.throws(() => slot('f4797.main.2|asset=a:1|k1_source=k1:1|activity', H), /names at most one source dimension/);
  // A line that exists only for K-1 amounts refuses a member without its K-1.
  assert.throws(() => slot('f1065.p1.4|activity', P), /f1065\.p1\.4 needs a source dimension \(k1_source\)/);
  assert.throws(() => slot('f1040.d.5|activity', H), /needs a source dimension/);
  // An undeclared dimension is still refused, and a required instance dimension is still required.
  assert.throws(() => slot('f1065.p1.9|k1_source=k1:1|activity', P), /f1065\.p1\.9 has no dimension k1_source/);
  assert.throws(() => slot('f1040.c.1|activity', H), /f1040\.c\.1 needs dimension activity/);
  // A coded K-1 box takes one instance per code, from its explicit code list (reserved codes refused).
  assert.ok(slot('k1_1065.box.11|code=A|interest=i:1|activity', P));
  assert.throws(() => slot('k1_1065.box.11|code=G|interest=i:1|activity', P), /code G is not one of/);
  assert.throws(() => slot('k1_1065.box.11|interest=i:1|activity', P), /needs dimension code/);
});

test('fixture: an own amount and two K-1 contributions to one destination are three members of one collection, each with its own provider (Codex t1-r1 B2)', () => {
  // Three packets, three providers: the household's own dispositions (manual) and two K-1 records.
  const own = packet([{ slotKey: 'f4797.main.2|activity', amountCents: '50000' }], { providerKind: 'manual', sourceVersion: 'manual:1@v1' });
  const k1a = packet([{ slotKey: 'f4797.main.2|k1_source=k1:11|activity', amountCents: '120000' }], { providerKind: 'k1_record', sourceVersion: 'k1:11@v1' });
  const k1b = packet([{ slotKey: 'f4797.main.2|k1_source=k1:12|activity', amountCents: '-20000' }], { providerKind: 'k1_record', sourceVersion: 'k1:12@v1' });
  for (const p of [own, k1a, k1b]) assert.equal(collectionKey(p.values[0].slotKey, H), 'f4797.main.2|activity');
  const agg = aggregate([own, k1a, k1b], H);
  assert.deepEqual(agg.get('f4797.main.2|activity'), { cents: 150000n, members: 3, status: 'complete', review: 'reviewed' });
  assert.equal(agg.size, 1, 'one collection, summed once');
  // The S corporation's other income: its own statement rows plus a K-1 payer's ordinary income, one collection.
  const s = aggregate([packet([{ slotKey: 'f1120s.p1.5|activity', statementRows: [{ label: 'Interest on trade receivables', amountCents: '1000' }] }]),
    packet([{ slotKey: 'f1120s.p1.5|k1_source=k1:3|activity', statementRows: [{ label: 'Ordinary income from a partnership', amountCents: '2500' }] }], { providerKind: 'k1_record', sourceVersion: 'k1:3@v1' })], S);
  assert.deepEqual(s.get('f1120s.p1.5|activity'), { cents: 3500n, members: 2, status: 'complete', review: 'reviewed' });
});

test('fixture: two activities keep separate Schedule C results; the total across them is an explicit line that aggregates the activity (Codex t1-r1 B2)', () => {
  // The review reproduced collectionKey stripping every dimension: activities A and B merged into one 30,000-cent figure. Instance dimensions
  // are part of the collection key; only source dimensions are summed away.
  const agg = aggregate([packet([{ slotKey: 'f1040.c.1|activity=act:A|activity', amountCents: '10000' }, { slotKey: 'f1040.c.1|activity=act:B|activity', amountCents: '20000' }])], H);
  assert.deepEqual([...agg.keys()].sort(), ['f1040.c.1|activity=act:A|activity', 'f1040.c.1|activity=act:B|activity']);
  assert.deepEqual([agg.get('f1040.c.1|activity=act:A|activity').cents, agg.get('f1040.c.1|activity=act:B|activity').cents], [10000n, 20000n]);
  // The catalog says which formulas keep the activity (line 31 per activity) and which total it (Schedule 1 line 3), so T3 evaluates each per
  // instance and the total once; the T1 contract is the declaration, not the arithmetic.
  const c = catalogFor('household_1040', 2025);
  assert.deepEqual(c.byId.get('f1040.c.31').instanceDims, ['activity']);
  assert.deepEqual([c.byId.get('f1040.s1.3').formula, c.byId.get('f1040.s1.3').aggregates], [['sum', 'f1040.c.31'], ['activity']]);
  // Per-property Form 8825 lines stay per property; 20a and 20b total them.
  const p = catalogFor('form_1065', 2025);
  assert.deepEqual(['f8825.main.19', 'f8825.main.20a'].map(id => [p.byId.get(id).instanceDims, p.byId.get(id).aggregates]), [[['activity'], []], [[], ['activity']]]);
  const r = aggregate([packet([{ slotKey: 'f8825.main.2a|activity=prop:1|activity', amountCents: '900000' }, { slotKey: 'f8825.main.2a|activity=prop:2|activity', amountCents: '400000' }])], P);
  assert.equal(r.size, 2, 'two properties, two collections');
});


test('slot keys are canonical: sorted, unrepeated dimensions with delimiter-free values; anything else is refused before uniqueness (Codex t1-r1 B3)', () => {
  assert.equal(slotKey({ fieldId: 'k1_1065.box.11', dims: { interest: 'i:1', code: 'A' } }), 'k1_1065.box.11|code=A|interest=i:1|activity');
  assert.equal(canonicalSlotKey('k1_1065.box.11|code=A|interest=i:1|activity'), 'k1_1065.box.11|code=A|interest=i:1|activity');
  // The review's pair: a repeated dimension parsed to the same slot as the plain key and both were stored.
  assert.throws(() => parseSlotKey('f1065.p1.4|k1_source=discarded|k1_source=k1:1|activity'), /repeated dimension k1_source/);
  assert.throws(() => canonicalSlotKey('k1_1065.box.11|interest=i:1|code=A|activity'), /not canonical: dimensions must be sorted/);
  // Delimiter injection through a value, empty values, whitespace and unknown measurements.
  assert.throws(() => slotKey({ fieldId: 'f1065.p1.4', dims: { k1_source: 'k1:1|activity' } }), /k1_source value/);
  assert.throws(() => slotKey({ fieldId: 'f1065.p1.4', dims: { k1_source: 'a=b' } }), /k1_source value/);
  assert.throws(() => parseSlotKey('f1065.p1.4|k1_source=|activity'), /k1_source value/);
  assert.throws(() => parseSlotKey('f1065.p1.4| k1_source=k1:1|activity'), /dimension/);
  assert.throws(() => parseSlotKey('f1065.p1.9|activity|'), /unknown measurement/);
  assert.throws(() => parseSlotKey('f1065.p1.9'), /unknown measurement/);
  // Aggregation refuses a non-canonical member instead of treating it as a second, different member.
  assert.throws(() => aggregate([packet([{ slotKey: 'k1_1065.box.11|interest=i:1|code=A|activity', amountCents: '1' }])], P), /not canonical/);
});

test('cents in JSON are exact: bigint, digit strings, or a safe-integer Number; an unsafe Number is refused (Codex t1-r1 B3)', () => {
  assert.equal(centsToJson(9007199254740993n), '9007199254740993');
  assert.equal(centsToJson('-12345'), '-12345');
  assert.equal(centsToJson(4200), '4200');
  // 9007199254740993 as a Number is already 9007199254740992: serializing it would silently change a cent.
  assert.throws(() => centsToJson(9007199254740993), /safe integer/);
  for (const bad of [12.5, NaN, Infinity, '1,000', '', null, undefined, '12.00']) assert.throws(() => centsToJson(bad), /cents/, String(bad));
});

test('a result is validated against its request and the catalog: supported schema, every requested slot, typed values, source version (Codex t1-r1 B3)', () => {
  const req = request([WAGES]);
  assert.deepEqual(validateRequest(req, P), []);
  assert.deepEqual(validateResult(packet([{ slotKey: WAGES, amountCents: '1000' }]), req, P), []);
  const problems = (r, q = req) => validateResult(r, q, P).join(' | ');
  // The review's probes: a complete result with no values, and a "complete" wage slot carrying a code instead of an amount.
  assert.match(problems(packet([])), /complete result is missing requested slot f1065\.p1\.9\|activity/);
  assert.match(problems(packet([{ slotKey: WAGES, code: 'not an amount' }])), /f1065\.p1\.9\|activity: an amount line takes amountCents/);
  assert.match(problems(packet([{ slotKey: WAGES, amountCents: 1000 }])), /amountCents must be a string of digits/);
  // Unknown schema versions are refused, not accepted as "some version".
  assert.match(problems(packet([{ slotKey: WAGES, amountCents: '1' }], { schemaVersion: 99 })), /schemaVersion 99 is not supported \(supported: 1\)/);
  assert.match(problems(packet([{ slotKey: WAGES, amountCents: '1' }], { sourceVersion: undefined })), /sourceVersion is required/);
  assert.match(problems(packet([{ slotKey: WAGES, amountCents: '1' }], { sourceRefs: [] })), /sourceRefs/);
  // A value for a slot nobody asked for, a slot twice, a computed field, a non-catalog slot.
  assert.match(problems(packet([{ slotKey: WAGES, amountCents: '1' }, { slotKey: RENT, amountCents: '2' }])), /f1065\.p1\.13\|activity was not requested/);
  assert.match(problems(packet([{ slotKey: WAGES, amountCents: '1' }, { slotKey: WAGES, amountCents: '1' }])), /twice/);
  assert.match(problems(packet([{ slotKey: 'f1065.p1.23|activity', amountCents: '1' }]), request(['f1065.p1.23|activity'])), /computed field/);
  // Value schemas by line type: a statement line carries typed rows; a checkbox a boolean; a coded box an amount for its code.
  const stmt = 'f1065.p1.21|activity';
  assert.deepEqual(validateResult(packet([{ slotKey: stmt, statementRows: [{ label: 'Supplies', amountCents: '500' }, { label: 'Postage', amountCents: '25' }] }]), request([stmt]), P), []);
  assert.match(problems(packet([{ slotKey: stmt, amountCents: '525' }]), request([stmt])), /a statement line takes statementRows/);
  assert.match(problems(packet([{ slotKey: stmt, statementRows: [{ label: 'Supplies', amountCents: 500 }] }]), request([stmt])), /statementRows\[0\]\.amountCents/);
  assert.match(problems(packet([{ slotKey: stmt, statementRows: [{ label: 'A', amountCents: '1' }, { label: 'A', amountCents: '2' }] }]), request([stmt])), /repeats label A/);
  const box = 'k1_1065.item.H1|interest=i:1|activity';
  assert.deepEqual(validateResult(packet([{ slotKey: box, checked: true }]), request([box]), P), []);
  assert.match(problems(packet([{ slotKey: box, checked: 'yes' }]), request([box])), /a checkbox line takes checked/);
  // Review and completeness: reviewed needs a reviewer; an incomplete packet says why; an unknown completeness is refused.
  assert.match(problems(packet([{ slotKey: WAGES, amountCents: '1' }], { review: { state: 'reviewed' } })), /review\.by/);
  assert.match(problems(packet([{ slotKey: WAGES, amountCents: '1' }], { review: undefined })), /review/);
  assert.match(problems(packet([], { completeness: 'partial', reasons: [] })), /says why in reasons/);
  assert.deepEqual(validateResult(packet([], { completeness: 'partial', reasons: ['bank feed not imported'] }), req, P), []);
  // A value the provider could not determine is unresolved with a reason, never a zero.
  assert.deepEqual(validateResult(packet([{ slotKey: WAGES, amountCents: null, completeness: 'unresolved', reasons: ['payroll not closed'] }], { completeness: 'partial', reasons: ['payroll'] }), req, P), []);
  assert.match(problems(packet([{ slotKey: WAGES, amountCents: null }])), /amountCents must be a string of digits/);
  // Related outputs and consumed slices are typed.
  assert.match(problems(packet([{ slotKey: WAGES, amountCents: '1' }], { relatedOutputs: [{ kind: 'guess', key: 'x' }] })), /relatedOutputs\[0\]\.kind/);
  assert.match(problems(packet([{ slotKey: WAGES, amountCents: '1' }], { relatedOutputs: [{ kind: 'book_tax_difference', key: 'dep', amountCents: 5, item: 'Depreciation', nature: 'temporary' }] })), /relatedOutputs\[0\] \(book_tax_difference dep\): amountCents must be a string of digits/);
  const slice = { entity: 'e:1', account: 'a:6100', txn: 't:1', line: 'l:1', measurement: 'activity' };
  assert.match(problems(packet([{ slotKey: WAGES, amountCents: '1' }], { consumedSlices: [slice, { ...slice }] })), /consumes slice .* twice/);
  assert.match(problems(packet([{ slotKey: WAGES, amountCents: '1' }], { consumedSlices: [{ ...slice, measurement: 'yearly' }] })), /consumedSlices\[0\]\.measurement/);
  // A request is itself checked: canonical, catalog slots, and the period's method and basis.
  assert.match(validateRequest(request([WAGES], { method: 'hybrid' }), P).join(' '), /method/);
  assert.match(validateRequest(request(['f1065.p1.9|interest=i:1|activity']), P).join(' '), /has no dimension interest/);
});

test('completeness and review propagate from the packet to every value it carries; a slice consumed twice is a conflict (Codex t1-r1 B3)', () => {
  const K = n => `f1065.p1.4|k1_source=k1:${n}|activity`;
  const k1 = (n, cents, o = {}) => packet([{ slotKey: K(n), statementRows: [{ label: `K-1 ${n}`, amountCents: cents }] }], { providerKind: 'k1_record', sourceVersion: `k1:${n}@v1`, ...o });
  const ok = aggregate([k1(1, '10268800'), k1(2, '-3860900')], P);
  assert.deepEqual(ok.get('f1065.p1.4|activity'), { cents: 6407900n, members: 2, status: 'complete', review: 'reviewed' });
  // The review's probe: a packet-level 'partial' must reach its values even when the value repeats no state.
  const partial = aggregate([k1(1, '10268800'), k1(2, '100', { completeness: 'partial', reasons: ['box 1 statement missing'] })], P);
  assert.deepEqual(partial.get('f1065.p1.4|activity'), { cents: null, members: 2, status: 'unresolved', review: 'reviewed' });
  // An unreviewed packet makes its collection unreviewed.
  assert.equal(aggregate([k1(1, '1'), k1(2, '1', { review: { state: 'unreviewed' } })], P).get('f1065.p1.4|activity').review, 'unreviewed');
  // One provider per member: the same member from two packets is a conflict, never a second addend.
  assert.equal(aggregate([k1(1, '100'), k1(1, '100', { sourceVersion: 'k1:1@v2' })], P).get('f1065.p1.4|activity').status, 'conflict');
  // The same source slice consumed by two packets is a conflict on what the second packet feeds (nothing is added twice).
  const slice = { entity: 'e:1', account: 'a:6100', txn: 't:9', line: 'l:1', measurement: 'activity' };
  const twice = aggregate([packet([{ slotKey: WAGES, amountCents: '100' }], { consumedSlices: [slice] }), packet([{ slotKey: RENT, amountCents: '100' }], { sourceVersion: 'books@v2', consumedSlices: [slice] })], P);
  assert.equal(twice.get(RENT).status, 'conflict');
  // Amount-free values (checkbox, text) are answers, not addends.
  assert.throws(() => aggregate([packet([{ slotKey: 'k1_1065.item.H1|interest=i:1|activity', checked: true }])], P), /not an amount/);
});

test('related outputs have a typed contract per kind: amountCents as string cents, a plain key and the fields each kind needs (Codex t1-r2 B3)', () => {
  const req = request([WAGES]);
  const withOutputs = outs => validateResult(packet([{ slotKey: WAGES, amountCents: '1' }], { relatedOutputs: outs }), req, P);
  const good = [
    { kind: 'book_tax_difference', key: 'dep', amountCents: '1200', item: 'Depreciation', nature: 'temporary' },
    { kind: 'recapture', key: 'asset:1', amountCents: '700', asset: 'asset:1', section: '1245' },
    { kind: 'disposition', key: 'asset:2', amountCents: '-300', asset: 'asset:2', disposedOn: '2025-06-30', proceedsCents: '700', basisCents: '1000' },
    { kind: 'carryforward', key: 'sec179', amountCents: '400', item: 'section_179', originYear: 2025 },
    { kind: 'statement', key: 'other-deductions', amountCents: '525', slotKey: 'f1065.p1.21|activity', rows: [{ label: 'Supplies', amountCents: '500' }, { label: 'Postage', amountCents: '25' }] },
    { kind: 'reconciliation', key: 'dep-switch', amountCents: '-200', subject: 'Depreciation total', oldCents: '1000', newCents: '800' },
  ];
  assert.deepEqual(withOutputs(good), []);
  // The review's probe: a recapture output with only its kind and key passed with no problems.
  const bare = withOutputs([{ kind: 'recapture', key: 'asset:1' }]).join(' | ');
  assert.match(bare, /relatedOutputs\[0\] \(recapture asset:1\): amountCents must be a string of digits/);
  assert.match(bare, /recapture asset:1\): asset is required/);
  assert.match(bare, /recapture asset:1\): section is required/);
  // Each kind's own fields, and the arithmetic its parts must agree with.
  assert.match(withOutputs([{ ...good[0], nature: 'sometimes' }]).join(' '), /nature must be one of temporary, permanent/);
  assert.match(withOutputs([{ ...good[2], amountCents: '300' }]).join(' '), /disposition asset:2\): amountCents 300 is not proceedsCents less basisCents \(-300\)/);
  assert.match(withOutputs([{ ...good[2], disposedOn: '2025-13-01' }]).join(' '), /disposedOn must be a date/);
  assert.match(withOutputs([{ ...good[3], originYear: '2025' }]).join(' '), /originYear must be a year/);
  assert.match(withOutputs([{ ...good[4], amountCents: '500' }]).join(' '), /amountCents 500 is not the sum of its rows \(525\)/);
  assert.match(withOutputs([{ ...good[4], slotKey: 'f1065.p1.23|activity' }]).join(' '), /slotKey: computed field/);
  assert.match(withOutputs([{ ...good[5], amountCents: '200' }]).join(' '), /amountCents 200 is not newCents less oldCents \(-200\)/);
  // The key is a plain identifier; unknown fields are refused rather than carried unread.
  assert.match(withOutputs([{ ...good[0], key: 'a|b' }]).join(' '), /key .* is not a plain identifier/);
  assert.match(withOutputs([{ ...good[0], colour: 'red' }]).join(' '), /colour is not a book_tax_difference field/);
  // An output the provider could not determine is unresolved with a reason, never zero, and only in an incomplete packet.
  const unknown = { kind: 'recapture', key: 'asset:3', amountCents: null, asset: 'asset:3', section: '1245', completeness: 'unresolved', reasons: ['disposal not entered'] };
  assert.match(withOutputs([unknown]).join(' '), /a complete result carries only complete related outputs/);
  assert.deepEqual(validateResult(packet([{ slotKey: WAGES, amountCents: '1' }], { completeness: 'partial', reasons: ['asset 3'], relatedOutputs: [unknown] }), req, P), []);
  assert.match(validateResult(packet([], { completeness: 'partial', reasons: ['x'], relatedOutputs: [{ ...unknown, reasons: [] }] }), req, P).join(' '), /unresolved related output says why/);
});
