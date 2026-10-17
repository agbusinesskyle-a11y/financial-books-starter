// test/tax-partition.test.js — pure: exact fractions and cents, the largest-remainder split, the canonical source partition, its proof against
// independently expected sources and adverse certificates, and T1-compatible packet parts across providers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitByShares, sumFractions, parseShare, parseCentsBig, buildPartition, provePartition, baseVersion, manifestVersion, toPacketParts, sameBase } from '../lib/tax/partition.js';
import { validatePacket, aggregate } from '../lib/tax/providers.js';

const third = { num: 1n, den: 3n };
test('largest-remainder split: thirds of a dollar, 2 cents at 1/2, 1/3, 1/6, ties to the earlier share, negatives symmetric, beyond 2^53', () => {
  assert.deepEqual(splitByShares(100n, [third, third, third]), [34n, 33n, 33n]);
  assert.deepEqual(splitByShares(2n, [{ num: 1n, den: 2n }, third, { num: 1n, den: 6n }]), [1n, 1n, 0n]);
  assert.deepEqual(splitByShares(-100n, [third, third, third]), [-34n, -33n, -33n]);
  assert.deepEqual(splitByShares(-9007199254740993n, [{ num: 1n, den: 2n }, { num: 1n, den: 2n }]), [-4503599627370497n, -4503599627370496n]);
  assert.throws(() => splitByShares(100n, [third, third]), /not 1/);
  assert.deepEqual(sumFractions([third, third, third]), { num: 1n, den: 1n });
});

test('shares are exact fractions or percentages; dollar amounts become exact BigInt cents of any size, never through Number', () => {
  assert.deepEqual(parseShare('1/3'), { num: 1n, den: 3n });
  assert.deepEqual(parseShare('25%'), { num: 1n, den: 4n });
  assert.deepEqual(parseShare('12.5%'), { num: 1n, den: 8n });
  for (const bad of ['0/3', '4/3', '1/0', '0.33', 'a third', '', '-1/3']) assert.equal(parseShare(bad), null, bad);
  assert.equal(parseCentsBig('1250'), 125000n);
  assert.equal(parseCentsBig('-40.5'), -4050n);
  assert.equal(parseCentsBig('$1,234.56'), 123456n);
  assert.equal(parseCentsBig('100000000.00'), 10000000000n, 'beyond the $99,999,999.99 the Number-based parser allows');
  assert.equal(parseCentsBig('90071992547409.93'), 9007199254740993n);
  for (const bad of ['1.234', '12a', '', '--1', '1,23']) assert.equal(parseCentsBig(bad), null, bad);
});

// One account's activity: three lines measured independently (as measureAccounts / measureLines would give them).
const lines = [{ txnId: 1, lineNo: 1, cents: 30000n, txnVersion: 'a' }, { txnId: 2, lineNo: 1, cents: 20000n, txnVersion: 'b' }, { txnId: 3, lineNo: 2, cents: -5000n, txnVersion: 'c' }];
const measured = { cents: 45000n, version: 'v1', lineGroups: 3 };
const base = { entityId: 7, accountId: 70, measurement: 'activity', measured };
const att = (id, txnId, lineNo, cents, txnVersion) => ({ id, txnId, lineNo, cents, txnVersion, targetKey: `line ${id}` });

test('line attributions first, the residual is the exact complement, the account set splits it; the proof holds against the independent source', () => {
  const p = buildPartition({ ...base, lines, attributions: [att(1, 1, 1, 30000n, 'a')], rows: [{ id: 10, targetKey: 'x', shareNum: '1', shareDen: '2' }, { id: 11, targetKey: 'y', shareNum: '1', shareDen: '2' }] });
  assert.equal(p.status, 'complete');
  assert.deepEqual(p.residuals, [{ excludes: ['1/1'], cents: 15000n, lineCount: 2 }]);
  assert.deepEqual(p.allocations.map(a => [a.kind, a.id, a.cents]), [['line', 1, 30000n], ['binding', 10, 7500n], ['binding', 11, 7500n]]);
  assert.equal(provePartition(p, { measured, lines }), true);
  // Account-only: no lines needed; the residual is the whole measurement with its line count.
  const whole = buildPartition({ ...base, rows: [{ id: 12, targetKey: 'z' }] });
  assert.deepEqual(whole.residuals, [{ excludes: [], cents: 45000n, lineCount: 3 }]);
  assert.equal(provePartition(whole, { measured }), true);
  // Line-only: every line attributed, no residual.
  const lineOnly = buildPartition({ ...base, lines, attributions: [att(1, 1, 1, 30000n, 'a'), att(2, 2, 1, 20000n, 'b'), att(3, 3, 2, -5000n, 'c')] });
  assert.deepEqual([lineOnly.status, lineOnly.residuals.length], ['complete', 0]);
  assert.equal(provePartition(lineOnly, { measured, lines }), true);
});

test('adverse certificates are refused: foreign, duplicate or missing line; duplicate or missing residual; a wrong complement; offsetting omitted lines', () => {
  const good = buildPartition({ ...base, lines, attributions: [att(1, 1, 1, 30000n, 'a')], rows: [{ id: 10, targetKey: 'x' }] });
  const bad = changes => () => provePartition({ ...good, ...changes }, { measured, lines });
  assert.throws(bad({ attributed: [...good.attributed, { id: 9, txn: '99', line: '1', cents: 0n }] }), /not a line of this source|exactly one allocation/);
  assert.throws(bad({ attributed: [...good.attributed, good.attributed[0]] }), /attributed twice/);
  assert.throws(bad({ residuals: [...good.residuals, good.residuals[0]] }), /exactly one residual/);
  assert.throws(bad({ residuals: [] }), /exactly one residual/);
  assert.throws(bad({ residuals: [{ ...good.residuals[0], excludes: [] }] }), /exclude exactly/);
  assert.throws(bad({ residuals: [{ ...good.residuals[0], cents: 15001n }] }), /residual is/);
  assert.throws(bad({ allocations: [...good.allocations, { kind: 'binding', id: 99, cents: 1n }] }), /manifest|add up/);
  // An enumeration that omits two offsetting lines still sums to the measurement: the line count catches it.
  const offset = [...lines, { txnId: 4, lineNo: 1, cents: 700n, txnVersion: 'd' }, { txnId: 5, lineNo: 1, cents: -700n, txnVersion: 'e' }];
  assert.throws(() => provePartition(good, { measured: { ...measured, lineGroups: 5 }, lines }), /lines given are 3, the measurement has 5/);
  const full = buildPartition({ ...base, measured: { ...measured, lineGroups: 5 }, lines: offset, attributions: [att(1, 1, 1, 30000n, 'a')], rows: [{ id: 10, targetKey: 'x' }] });
  assert.equal(provePartition(full, { measured: { ...measured, lineGroups: 5 }, lines: offset }), true);
  // A partition read from another version of the source.
  assert.throws(() => provePartition(good, { measured: { ...measured, version: 'v2' }, lines }), /another version/);
});

test('unresolved and stale: an unattributed rest with no binding (also netting to zero), a changed line or transaction, a dollar split of another base', () => {
  assert.equal(buildPartition({ ...base, lines, attributions: [att(1, 1, 1, 30000n, 'a')] }).status, 'unresolved');
  const zero = [{ txnId: 1, lineNo: 1, cents: 30000n, txnVersion: 'a' }, { txnId: 2, lineNo: 1, cents: 20000n, txnVersion: 'b' }, { txnId: 3, lineNo: 1, cents: -20000n, txnVersion: 'c' }];
  const netZero = buildPartition({ ...base, measured: { cents: 30000n, version: 'v1', lineGroups: 3 }, lines: zero, attributions: [att(1, 1, 1, 30000n, 'a')] });
  assert.deepEqual([netZero.status, netZero.allocations.length], ['unresolved', 1], 'a zero rest made of unconsumed lines is not complete');
  assert.equal(buildPartition({ ...base, lines, rows: [{ id: 10, targetKey: 'x' }], attributions: [att(1, 1, 1, 29999n, 'a')] }).status, 'stale');
  assert.equal(buildPartition({ ...base, lines, rows: [{ id: 10, targetKey: 'x' }], attributions: [att(1, 1, 1, 30000n, 'old')] }).status, 'stale', 'same cents, changed transaction');
  assert.equal(buildPartition({ ...base, lines, rows: [{ id: 10, targetKey: 'x' }], attributions: [att(1, 9, 1, 100n, 'z')] }).status, 'stale', 'the line left the account');
  const b = baseVersion('v1', []);
  const dollars = [{ id: 10, targetKey: 'x', amountCents: '40000', sourceVersion: b }, { id: 11, targetKey: 'y', amountCents: '5000', sourceVersion: b }];
  assert.equal(buildPartition({ ...base, rows: dollars }).status, 'complete');
  assert.equal(buildPartition({ ...base, measured: { ...measured, version: 'v2' }, rows: dollars }).status, 'stale');
  // The same dollars after a line attribution (the base changes with the attribution set): stale, even where the cents would still fit.
  assert.equal(buildPartition({ ...base, lines, attributions: [att(1, 3, 2, -5000n, 'c')], rows: [{ ...dollars[0], amountCents: '50000' }, { ...dollars[1], amountCents: '0' }] }).status, 'stale');
  assert.throws(() => buildPartition({ ...base, attributions: [att(1, 1, 1, 30000n, 'a'), att(2, 1, 1, 30000n, 'a')], lines }), /attributed twice/);
  assert.throws(() => buildPartition({ ...base, measurement: 'end', lines, attributions: [att(1, 1, 1, 30000n, 'a')] }), /activity measurement only/);
  assert.equal(buildPartition({ ...base }).status, 'uncovered');
  const pending = buildPartition({ ...base, rows: [{ id: 10, targetKey: 'x', problems: ['The owner’s interest for this period is not on file yet.'] }] });
  assert.deepEqual([pending.status, pending.allocations[0].cents], ['unresolved', 45000n]);
  assert.throws(() => provePartition(pending, { measured }), /not complete/);
});

test('packet parts are T1-valid; a split between providers gives each its own portions; a portion consumed twice, or two partition versions, is refused', () => {
  const approved = { attributions: [att(1, 1, 1, 30000n, 'a')], rows: [{ id: 10, targetKey: 'x', shareNum: '1', shareDen: '2' }, { id: 11, targetKey: 'y', shareNum: '1', shareDen: '2' }] };
  const p = buildPartition({ ...base, lines, ...approved });
  // Line 1 and binding 10 go to the books; binding 11 to the cash layer.
  const ownerOf = a => (a.kind === 'binding' && a.id === 11 ? 'cash_layer' : 'books');
  const books = toPacketParts(p, { provider: 'books', ownerOf, measured, lines, approved }), cash = toPacketParts(p, { provider: 'cash_layer', ownerOf, measured, lines, approved });
  assert.deepEqual([books.cents, cash.cents, books.cents + cash.cents], [37500n, 7500n, 45000n]);
  const ctx = { returnType: 'form_1065', edition: 2025 };
  const packet = (kind, parts, slot, cents) => ({ providerKind: kind, schemaVersion: 1, sourceVersion: `${kind}@1`, sourceRefs: parts.sourceRefs, completeness: 'complete', review: { state: 'unreviewed' },
    values: [{ slotKey: slot, amountCents: String(cents) }], relatedOutputs: [], consumedSlices: parts.consumedSlices });
  const pb = packet('books', books, 'f1065.p1.9|activity', books.cents), pc = packet('cash_layer', cash, 'f1065.p1.13|activity', cash.cents);
  assert.deepEqual(validatePacket(pb, ctx), []);
  assert.deepEqual(validatePacket(pc, ctx), []);
  assert.deepEqual(sameBase([pb, pc]), []);
  const agg = aggregate([pb, pc], ctx);
  assert.deepEqual([agg.get('f1065.p1.9|activity').status, agg.get('f1065.p1.13|activity').status], ['complete', 'complete']);
  // The same residual portion in a second packet is a T1 conflict, never a second addend.
  const twice = packet('cash_layer', { ...cash, consumedSlices: [...cash.consumedSlices, books.consumedSlices.find(s => s.txn === 'rest')] }, 'f1065.p1.13|activity', cash.cents);
  assert.equal(aggregate([pb, twice], ctx).get('f1065.p1.13|activity').status, 'conflict');
  // Packets from partitions of different attribution sets cannot be combined.
  const otherRows = { rows: [{ id: 12, targetKey: 'z' }], attributions: [] };
  const other = buildPartition({ ...base, ...otherRows });
  assert.match(sameBase([pb, packet('cash_layer', toPacketParts(other, { provider: 'cash_layer', ownerOf: () => 'cash_layer', measured, approved: otherRows }), 'f1065.p1.13|activity', 45000n)])[0], /different partitions/);
});

test('the allocation manifest (Codex r2 B2): a remapped residual, changed shares or targets, a tampered or duplicated allocation never pass as the same partition', () => {
  // The same 45,000 cents, unchanged postings: routed through binding 1 to one target, then re-saved as binding 2 to another.
  const ra = { rows: [{ id: 1, targetKey: 'input|f1065.p1.9' }], attributions: [] }, rb = { rows: [{ id: 2, targetKey: 'input|f1065.p1.11' }], attributions: [] };
  const a = buildPartition({ ...base, ...ra }), b = buildPartition({ ...base, ...rb });
  assert.equal(a.base, b.base, 'the residual base is the same: postings and attributions did not move');
  assert.notEqual(a.version, b.version, 'the manifests differ');
  const ctx = { returnType: 'form_1065', edition: 2025 };
  const pk = (parts, slot) => ({ providerKind: 'books', schemaVersion: 1, sourceVersion: 'books@1', sourceRefs: parts.sourceRefs, completeness: 'complete', review: { state: 'unreviewed' },
    values: [{ slotKey: slot, amountCents: String(parts.cents) }], relatedOutputs: [], consumedSlices: parts.consumedSlices });
  const pa = pk(toPacketParts(a, { provider: 'books', ownerOf: () => 'books', measured, approved: ra }), 'f1065.p1.9|activity');
  const pb = pk(toPacketParts(b, { provider: 'books', ownerOf: () => 'books', measured, approved: rb }), 'f1065.p1.11|activity');
  // Against the mapping now saved, the earlier partition is not the approved one (Codex r3 B2).
  assert.throws(() => toPacketParts(a, { provider: 'books', ownerOf: () => 'books', measured, approved: rb }), /not the approved mapping/);
  assert.deepEqual([validatePacket(pa, ctx), validatePacket(pb, ctx)], [[], []], 'each alone is a valid T1 packet');
  assert.match(sameBase([pa, pb])[0], /different partitions/, 'together they are refused, though their slice ids differ');
  // Changed shares with the same rows: another manifest.
  const s1 = buildPartition({ ...base, rows: [{ id: 1, targetKey: 'x', shareNum: '1', shareDen: '2' }, { id: 2, targetKey: 'y', shareNum: '1', shareDen: '2' }] });
  const s2 = buildPartition({ ...base, rows: [{ id: 1, targetKey: 'x', shareNum: '1', shareDen: '3' }, { id: 2, targetKey: 'y', shareNum: '2', shareDen: '3' }] });
  assert.notEqual(s1.version, s2.version);
  // Two distinct 100-cent lines: a duplicated allocation of the first in place of the second is refused (a bijection, not a count).
  const two = [{ txnId: 1, lineNo: 1, cents: 100n, txnVersion: 'a' }, { txnId: 2, lineNo: 1, cents: 100n, txnVersion: 'b' }];
  const m2 = { cents: 200n, version: 'w', lineGroups: 2 };
  const ok = buildPartition({ ...base, measured: m2, lines: two, attributions: [att(1, 1, 1, 100n, 'a'), att(2, 2, 1, 100n, 'b')] });
  assert.equal(provePartition(ok, { measured: m2, lines: two }), true);
  const dup = { ...ok, allocations: [ok.allocations[0], { ...ok.allocations[0] }] };
  assert.throws(() => provePartition(dup, { measured: m2, lines: two }), /manifest|exactly one allocation/);
  const resealed = { ...dup, version: manifestVersion(dup) };
  assert.throws(() => provePartition(resealed, { measured: m2, lines: two }), /exactly one allocation/, 'even re-sealed, the duplicate is refused');
  // A tampered amount or id, even with a recomputed-looking total, is not the manifest.
  const w = buildPartition({ ...base, rows: [{ id: 1, targetKey: 'x', shareNum: '1', shareDen: '2' }, { id: 2, targetKey: 'y', shareNum: '1', shareDen: '2' }] });
  assert.throws(() => provePartition({ ...w, allocations: [{ ...w.allocations[0], cents: 22501n }, { ...w.allocations[1], cents: 22499n }] }, { measured }), /manifest/);
  assert.throws(() => provePartition({ ...w, allocations: [w.allocations[0], { ...w.allocations[1], id: 3 }] }, { measured }), /manifest/);
  // Conserved but unapproved (Codex r3 B2): 6,000/4,000 of a 10,000-cent source approved as equal shares, re-sealed — self-consistent, yet
  // the saved rows say halves.
  const m10 = { cents: 10000n, version: 'h', lineGroups: 1 }, halves = { rows: [{ id: 1, targetKey: 'x', shareNum: '1', shareDen: '2' }, { id: 2, targetKey: 'y', shareNum: '1', shareDen: '2' }], attributions: [] };
  const eq = buildPartition({ ...base, measured: m10, ...halves });
  const skew = { ...eq, allocations: [{ ...eq.allocations[0], cents: 6000n }, { ...eq.allocations[1], cents: 4000n }] };
  skew.version = manifestVersion(skew);
  assert.equal(provePartition(skew, { measured: m10 }), true, 'self-consistent on its own terms');
  assert.throws(() => provePartition(skew, { measured: m10, approved: halves }), /not the approved mapping/);
  assert.throws(() => toPacketParts(eq, { provider: 'books', ownerOf: () => 'books', measured: m10 }), /approved mapping/, 'no export without the saved rows');
  // An unproved partition never exports.
  const pending = buildPartition({ ...base, rows: [{ id: 1, targetKey: 'x', problems: ['waiting'] }] });
  assert.throws(() => toPacketParts(pending, { provider: 'books', ownerOf: () => 'books', measured, approved: { rows: [{ id: 1, targetKey: 'x', problems: ['waiting'] }], attributions: [] } }), /not complete/);
});

test('the residual base names its normalization (Codex r2 B3), and an emptied line set is stale, not an error (N2)', () => {
  const raw = baseVersion('v1', []), normalized = baseVersion('v1', [], 'closings_removed:abc');
  assert.notEqual(raw, normalized, 'the same raw rows under another normalization are another base');
  const dollars = [{ id: 10, targetKey: 'x', amountCents: '40000', sourceVersion: raw }, { id: 11, targetKey: 'y', amountCents: '5000', sourceVersion: raw }];
  assert.equal(buildPartition({ ...base, rows: dollars }).status, 'complete');
  assert.equal(buildPartition({ ...base, measured: { ...measured, normalization: 'closings_removed:abc' }, rows: dollars }).status, 'stale', 'a raw-basis dollar split is stale once T3 normalizes');
  // The account's only line was deleted (or moved): the measurement is empty, the attribution an orphan.
  const empty = buildPartition({ ...base, measured: { cents: 0n, version: 'gone', lineGroups: 0 }, lines: [], attributions: [att(1, 1, 1, 30000n, 'a')] });
  assert.equal(empty.status, 'stale');
  assert.deepEqual(empty.allocations.map(x => [x.kind, x.id, x.cents]), [['line', 1, null]]);
});
