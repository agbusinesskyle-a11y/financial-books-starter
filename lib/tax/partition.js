// lib/tax/partition.js
// The canonical source partition of one measurement of one account on one return (spec §4.5, §13.1 T2; Codex t2-plan-r1 B2), pure and
// exact (BigInt). The contract:
//   source      { entity, account, measurement, domain: 'posting', version, cents, lineGroups } — the measurement as measured
//               (lib/tax/measure.js); T3's cash layer adds partitions of domain 'cash' keyed by cash events.
//   attributed  the line attributions, each one posting line { txn, line, cents } of THIS source, consumed first, at its current amount.
//   residuals   [] with no account-level binding, else exactly one { excludes: [the attributed line keys], cents, lineCount }: the exact
//               complement of the attributed lines — every other line, its cents and its count.
//   allocations one per attributed line (its cents) and one per account-level binding row (the residual split whole, by exact shares
//               — largest remainder, ties to the lowest id, negatives symmetric — or by dollars tied to `base`).
//   base        the residual's version: the measurement's normalization (T2: 'as_posted'), its version, and the attribution set with each
//               line's transaction version — what a dollar split is valid for (Codex r2 B3: T3's normalized measurement, closings removed,
//               has another normalization identity whenever it removes anything, so a raw-basis dollar split turns stale and is saved again).
//   version     the allocation manifest version (Codex r2 B2): base plus every allocation (kind, id, target, routing, cents) and the approved
//               row and attribution ids. Packets carry it; packets of one source built from different manifests never combine. routing
//               (Codex t2-r1 B1) is what the stable target resolved to for the period — the slot key and the selected owner interest and K-1
//               record with their versions (routingOf) — so re-resolving a reference changes the manifest even though the target does not.
// "Once" is per measurement: a beginning and an ending snapshot may describe the same history; an activity amount is never consumed by a
// line attribution and its account residual, nor by two providers (toPacketParts gives every portion its own T1 slice).
import { createHash } from 'node:crypto';

const md5 = text => createHash('md5').update(text).digest('hex');
const gcd = (a, b) => { let x = a < 0n ? -a : a, y = b < 0n ? -b : b; while (y) [x, y] = [y, x % y]; return x; };
export const lineKey = (txn, line) => `${txn}/${line}`;

export function sumFractions(list) {
  let num = 0n, den = 1n;
  for (const f of list) { num = num * f.den + f.num * den; den *= f.den; const g = gcd(num, den) || 1n; num /= g; den /= g; }
  return { num, den };
}
// "1/3", "25%", "12.5%" → an exact reduced fraction in (0, 1]; null for anything else (a decimal like 0.33 is never exact).
export function parseShare(text) {
  const s = String(text ?? '').trim();
  let m = /^(\d{1,12})\s*\/\s*(\d{1,12})$/.exec(s), num, den;
  if (m) { num = BigInt(m[1]); den = BigInt(m[2]); }
  else if ((m = /^(\d{1,3})(?:\.(\d{1,6}))?\s*%$/.exec(s))) { const frac = m[2] ?? ''; num = BigInt(m[1] + frac); den = 100n * 10n ** BigInt(frac.length); }
  else return null;
  if (den === 0n || num <= 0n || num > den) return null;
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}
// A typed dollar amount → exact BigInt cents, any size (Codex non-blocking 1: never through Number): "1250", "-40.5", "$1,234.56".
// null for anything else.
export function parseCentsBig(text) {
  const m = /^(-)?\$?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const cents = BigInt(m[2].replaceAll(',', '')) * 100n + BigInt((m[3] ?? '').padEnd(2, '0') || '0');
  return m[1] ? -cents : cents;
}
// Largest-remainder split of whole cents by exact shares totalling 1 (the §5.7 residual rule): each part is the floor of cents × share;
// the cents left over go one each to the largest fractional remainders, ties to the earlier share (callers order by binding id). A
// negative amount splits as its absolute value, negated, so signs are symmetric.
export function splitByShares(cents, shares) {
  const total = sumFractions(shares);
  if (total.num !== total.den) throw new Error(`shares total ${total.num}/${total.den}, not 1`);
  const neg = cents < 0n, c = neg ? -cents : cents;
  const parts = shares.map((s, i) => ({ i, part: (c * s.num) / s.den, rem: (c * s.num) % s.den, den: s.den }));
  let left = c - parts.reduce((t, p) => t + p.part, 0n);
  const order = [...parts].sort((a, b) => { const x = a.rem * b.den, y = b.rem * a.den; return x === y ? a.i - b.i : x > y ? -1 : 1; });
  for (const p of order) { if (left === 0n) break; if (p.rem === 0n) continue; p.part += 1n; left -= 1n; }
  if (left !== 0n) throw new Error('the split did not add up');
  return parts.map(p => (neg ? -p.part : p.part));
}
// The partition base version: the measurement version, plus each attributed line with the transaction version it was attributed at.
// A dollar split records it; any change to the measurement or to the attribution set makes the split stale (B5).
export function baseVersion(measurementVersion, attributions = [], normalization = 'as_posted') {
  const keys = attributions.map(a => `${lineKey(a.txnId, a.lineNo)}@${a.txnVersion ?? ''}`).sort();
  return md5(`${normalization}|${measurementVersion}|${keys.join(',')}`);
}
// The resolved routing of one saved binding or line attribution (a tax_binding / tax_binding_line row, snake_case): the slot it feeds and
// the per-period references it depends on, ids and versions (Codex t2-r1 B1). The stable party references stay in the target key.
const idText = v => (v === null || v === undefined ? null : String(v));
export const routingOf = r => JSON.stringify([idText(r.slot_key), idText(r.interest_id), idText(r.interest_version), idText(r.k1_source_id), idText(r.k1_source_version)]);
// The allocation manifest version of a built partition (Codex r2 B2; routing, Codex t2-r1 B1).
export const manifestVersion = p => md5(JSON.stringify([p.base, p.rowIds, p.attributionIds,
  p.allocations.map(x => [x.kind, x.id, x.targetKey, x.routing ?? null, x.cents === null ? null : x.cents.toString()])]));

const RANK = { complete: 0, unresolved: 1, stale: 2 };
// Build the partition of one measurement.
//   measured      { cents, version, lineGroups, normalization? } of the measurement (lineGroups: the period's posting lines, activity only)
//   lines         the period's posting lines [{ txnId, lineNo, cents, txnVersion }] — required whenever there are attributions; [] is a
//                 known empty set (every attributed line is then gone: stale, never an error — Codex r2 N2)
//   rows          the account-level set, ordered by id: [{ id, targetKey, routing?, shareNum?, shareDen?, amountCents?, sourceVersion?, problems? }]
//   attributions  [{ id, txnId, lineNo, cents (recorded), txnVersion (recorded), targetKey, routing?, problems? }]
// → { status: complete | unresolved | stale | uncovered, reasons, source, attributed, residuals, allocations, base, rowIds, attributionIds, version }
export function buildPartition({ entityId, accountId, measurement, measured, lines = null, rows = [], attributions = [] }) {
  const reasons = [];
  let status = 'complete';
  const worse = s => { if (RANK[s] > RANK[status]) status = s; };
  const source = { entity: String(entityId), account: String(accountId), measurement, domain: 'posting', normalization: measured.normalization ?? 'as_posted', version: measured.version,
    cents: measured.cents, lineGroups: measurement === 'activity' ? measured.lineGroups : null };
  const base = baseVersion(measured.version, attributions, measured.normalization ?? 'as_posted');
  const out = { status, reasons, source, attributed: [], residuals: [], allocations: [], base, rowIds: rows.map(r => r.id), attributionIds: attributions.map(a => a.id) };
  if (!rows.length && !attributions.length) return { ...out, status: 'uncovered', reasons: ['No binding'], version: manifestVersion(out) };
  if (attributions.length && measurement !== 'activity') throw new Error('line attributions apply to the activity measurement only');
  if (attributions.length && !Array.isArray(lines)) throw new Error('a partition with line attributions needs the period’s posting lines');
  // 1. Line attributions take their posting lines first, at the lines' current amounts.
  const live = new Map((lines ?? []).map(l => [lineKey(l.txnId, l.lineNo), l]));
  const taken = new Set();
  let attributed = 0n;
  for (const a of attributions) {
    const k = lineKey(a.txnId, a.lineNo), l = live.get(k);
    if (taken.has(k)) throw new Error(`posting line ${k} attributed twice`);
    taken.add(k);
    for (const p of a.problems ?? []) { worse('unresolved'); reasons.push(p); }
    if (!l) { worse('stale'); reasons.push(`Line ${k} no longer posts to this account in the period.`); out.allocations.push({ kind: 'line', id: a.id, targetKey: a.targetKey, routing: a.routing ?? null, cents: null }); continue; }
    if (l.cents !== a.cents) { worse('stale'); reasons.push(`Line ${k} was ${a.cents} cents when it was attributed and is ${l.cents} now.`); }
    if (a.txnVersion !== undefined && l.txnVersion !== undefined && a.txnVersion !== l.txnVersion) { worse('stale'); reasons.push(`The transaction of line ${k} changed after the line was attributed.`); }
    attributed += l.cents;
    out.attributed.push({ id: a.id, txn: String(a.txnId), line: String(a.lineNo), cents: l.cents });
    out.allocations.push({ kind: 'line', id: a.id, targetKey: a.targetKey, routing: a.routing ?? null, cents: l.cents });
  }
  // 2. The account-level set takes the residual: the exact complement of the attributed lines.
  const loose = (lines ?? []).filter(l => !taken.has(lineKey(l.txnId, l.lineNo)));
  const residualCents = lines ? loose.reduce((t, l) => t + l.cents, 0n) : measured.cents - attributed;
  if (lines && measurement === 'activity' && (lines.length !== measured.lineGroups || lines.reduce((t, l) => t + l.cents, 0n) !== measured.cents)) {
    worse('stale'); reasons.push('The posting lines do not add up to the measured activity: the books changed while this was read. Reload.');
  }
  if (!rows.length) {
    if (loose.length || residualCents !== 0n) {
      worse('unresolved');
      reasons.push(`${loose.length} posting line${loose.length === 1 ? '' : 's'} of this account (${residualCents} cents net) ${loose.length === 1 ? 'is' : 'are'} not attributed, and the account has no binding for the rest.`);
    }
  } else {
    out.residuals.push({ excludes: [...taken].sort(), cents: residualCents, lineCount: lines ? loose.length : measurement === 'activity' ? measured.lineGroups : null });
    let parts;
    if (rows.some(r => r.shareNum != null)) parts = splitByShares(residualCents, rows.map(r => ({ num: BigInt(r.shareNum), den: BigInt(r.shareDen) })));
    else if (rows.some(r => r.amountCents != null)) {
      parts = rows.map(r => BigInt(r.amountCents));
      const sum = parts.reduce((t, x) => t + x, 0n);
      if (rows.some(r => r.sourceVersion !== base) || sum !== residualCents) {
        worse('stale');
        reasons.push(`The dollar split totals ${sum} cents and was made for another version of this account or of its line attributions; ${residualCents} cents are to be split now.`);
      }
    } else parts = [residualCents];
    rows.forEach((r, i) => {
      for (const p of r.problems ?? []) { worse('unresolved'); reasons.push(p); }
      out.allocations.push({ kind: 'binding', id: r.id, targetKey: r.targetKey, routing: r.routing ?? null, cents: parts[i] });
    });
  }
  return { ...out, status, reasons, version: manifestVersion(out) };
}

// The proof (spec §13.1 T2, B2), against INDEPENDENTLY obtained inputs — the measurement from measureAccounts and, when there are line
// attributions, the period's lines from measureLines — never against the partition's own numbers. It establishes identity coverage (each
// attributed line is a line of this source, attributed once; the residual is exactly the complement, one residual or none) and amount
// conservation (attributed lines at their cents, the residual at the complement's cents, binding allocations summing to the residual,
// everything summing to the measurement). Throws with the first violation; returns true.
// Two assurance levels (Codex r4): without approved, the proof is structural and arithmetic only — identity coverage, conservation, the
// manifest, the bijection; it does NOT say the allocation is the approved one. With approved — as toPacketParts always requires — it does.
// approved (Codex r3 B2): { rows, attributions } as SAVED (lib/tax/manifest.js approvedOf), the independent allocation input: the partition
// is rebuilt from them over the same measurement, and its manifest must be that one — conserved amounts with other shares or targets fail.
export function provePartition(p, { measured, lines = null, approved = null }) {
  const no = msg => { throw new Error(msg); };
  if (approved) {
    const again = buildPartition({ entityId: p.source.entity, accountId: p.source.account, measurement: p.source.measurement, measured, lines, rows: approved.rows, attributions: approved.attributions });
    if (again.version !== p.version) no('the allocations are not the approved mapping');
  }
  if (p.status !== 'complete') no(`not complete: ${p.status}`);
  if (p.source.version !== measured.version || p.source.cents !== measured.cents) no('the partition was built from another version of the measurement');
  const attributedKeys = p.attributed.map(a => lineKey(a.txn, a.line));
  if (new Set(attributedKeys).size !== attributedKeys.length) no('a posting line is attributed twice');
  if (attributedKeys.length && !Array.isArray(lines)) no('line attributions cannot be proved without the period’s lines');
  if (Array.isArray(lines)) {
    if (lines.length !== measured.lineGroups) no(`the lines given are ${lines.length}, the measurement has ${measured.lineGroups}`);
    if (lines.reduce((t, l) => t + l.cents, 0n) !== measured.cents) no('the lines given do not add up to the measurement');
  }
  const byKey = new Map((lines ?? []).map(l => [lineKey(l.txnId, l.lineNo), l]));
  for (const a of p.attributed) {
    const l = byKey.get(lineKey(a.txn, a.line)) ?? no(`line ${lineKey(a.txn, a.line)} is not a line of this source`);
    if (l.cents !== a.cents) no(`line ${lineKey(a.txn, a.line)} is attributed at ${a.cents}, not its ${l.cents}`);
  }
  // Exactly one allocation per approved row and per attributed line, and nothing else (a bijection, Codex r2 B2); the manifest is the one
  // the partition was built with (a tampered id, target or amount changes it).
  if (p.version !== manifestVersion(p)) no('the allocations are not the partition’s manifest');
  const bindingAllocations = p.allocations.filter(x => x.kind === 'binding'), lineAllocations = p.allocations.filter(x => x.kind === 'line');
  const same = (xs, ys) => JSON.stringify([...xs].map(String).sort()) === JSON.stringify([...ys].map(String).sort());
  if (new Set(lineAllocations.map(x => x.id)).size !== lineAllocations.length || !same(lineAllocations.map(x => x.id), p.attributionIds)
      || !same(p.attributed.map(a => a.id), p.attributionIds)) no('every attributed line has exactly one allocation, and every allocation one line');
  if (new Set(bindingAllocations.map(x => x.id)).size !== bindingAllocations.length || !same(bindingAllocations.map(x => x.id), p.rowIds)) no('every approved row has exactly one allocation');
  for (const x of lineAllocations) if (p.attributed.find(a => a.id === x.id).cents !== x.cents) no(`line allocation ${x.id} is not its line’s amount`);
  if (bindingAllocations.length === 0) {
    if (p.residuals.length !== 0) no('a residual without an account binding');
    const all = Array.isArray(lines) ? lines.length : measured.lineGroups ?? 0;
    if (p.attributed.length !== all) no('with no account binding every posting line must be attributed');
  } else {
    if (p.residuals.length !== 1) no(`exactly one residual, not ${p.residuals.length}`);
    const r = p.residuals[0];
    if (JSON.stringify([...r.excludes].sort()) !== JSON.stringify([...attributedKeys].sort())) no('the residual does not exclude exactly the attributed lines');
    const rest = Array.isArray(lines) ? lines.filter(l => !attributedKeys.includes(lineKey(l.txnId, l.lineNo))) : null;
    const want = rest ? rest.reduce((t, l) => t + l.cents, 0n) : measured.cents;
    if (r.cents !== want) no(`the residual is ${r.cents}, its lines are ${want}`);
    if (p.source.measurement === 'activity' && r.lineCount !== (rest ? rest.length : measured.lineGroups)) no('the residual does not count every remaining line');
    if (bindingAllocations.reduce((t, x) => t + x.cents, 0n) !== r.cents) no('the account binding allocations do not add up to the residual');
  }
  if (p.allocations.reduce((t, x) => t + x.cents, 0n) !== measured.cents) no(`allocations total ${p.allocations.reduce((t, x) => t + x.cents, 0n)}, measured ${measured.cents}`);
  return true;
}

// T1-compatible packet parts (lib/tax/providers.js validatePacket) for the allocations one provider owns: each attributed line is its own
// slice { entity, account, txn, line, measurement }; each account-binding portion of the residual is its own slice with txn 'rest' and
// line 'b<binding id>', so two packets can never consume one portion (T1 refuses a slice consumed twice) and a split between providers
// gives each its own portions. sourceRefs carry the allocation manifest version: T1's assignPacket and substituteProvider refuse a packet
// whose manifest differs from a live packet's for the same source (Codex r2 B2), and sameBase checks a set of packets before that.
// Only a proved partition exports: the proof runs here against the independent measured/lines AND the saved approved rows the caller passes
// (lib/tax/manifest.js currentPartition gives all three; T1's boundary checks the same again when the packet goes live).
// ownerOf(allocation) → the provider kind that consumes it (coverage.js allocationOwners); only the given provider's portions are returned.
export function toPacketParts(p, { provider, ownerOf, measured, lines = null, approved }) {
  if (!approved) throw new Error('a packet is built against the approved mapping: pass approved (lib/tax/manifest.js approvedOf)');
  provePartition(p, { measured, lines, approved });
  const mine = p.allocations.filter(x => ownerOf(x) === provider);
  const slices = mine.map(x => (x.kind === 'line'
    ? (() => { const a = p.attributed.find(y => y.id === x.id); return { entity: p.source.entity, account: p.source.account, txn: a.txn, line: a.line, measurement: p.source.measurement }; })()
    : { entity: p.source.entity, account: p.source.account, txn: 'rest', line: `b${x.id}`, measurement: p.source.measurement }));
  return { consumedSlices: slices, sourceRefs: [{ kind: 'books_partition', id: `${p.source.entity}/${p.source.account}/${p.source.measurement}`, version: p.version, normalization: p.source.normalization ?? 'as_posted' }], cents: mine.reduce((t, x) => t + x.cents, 0n) };
}
// Packets built from partitions of one source must name one partition version (a residual portion of one attribution set and a line of
// another could otherwise overlap). Returns the problems, [] when they agree.
export function sameBase(packets) {
  const seen = new Map(), problems = [];
  for (const pk of packets) for (const r of pk.sourceRefs ?? []) {
    if (r.kind !== 'books_partition') continue;
    if (seen.has(r.id) && seen.get(r.id) !== r.version) problems.push(`${r.id}: packets were built from different partitions (${seen.get(r.id)} and ${r.version})`);
    else seen.set(r.id, r.version);
  }
  return problems;
}
