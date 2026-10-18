import { withTransaction } from '../db.js';
import { ValidationError, lockEntity } from '../data/writes.js';
import { catalogFor, MEASUREMENTS } from './catalog/index.js';

// The provider interface (spec §4.7, rule 0.4): every input slot of a return has exactly one provider; computed fields are never slots; a
// field that takes several contributions is a collection whose members differ by a source dimension. A provider answers a REQUEST with a
// versioned RESULT PACKET (Codex t1-r1 B3); T7 and every later provider implement this contract. T1 defines and validates it with declarative
// fixtures; no provider engine runs here.
const fail = message => { throw new ValidationError(message); };
export const PROVIDER_KINDS = ['books', 'manual', 'asset_register', 'k1_record', 'cogs_workpaper', 'cash_layer'];
// The packet schema versions this code understands. A packet of any other version is refused, never read as "some version".
export const SUPPORTED_SCHEMA_VERSIONS = [1];
export const ENVELOPE_VERSION = 1;
export const COMPLETENESS = ['complete', 'partial', 'unresolved'];
export const REVIEW_STATES = ['unreviewed', 'reviewed'];
// What a packet may carry besides slot values: the facts that must move with them (spec §4.7: book-to-tax differences, recapture, dispositions,
// statements, reconciliation facts; §4 carryforward facts), so one packet supplies related outputs without consuming its source slices twice.
// Each kind is a typed contract (Codex t1-r2 B3): every output has a plain-identifier key unique within its kind and amountCents as string cents
// (null only while the output is 'unresolved', with reasons, in an incomplete packet), plus the fields its kind requires. Unknown fields are refused.
//   book_tax_difference  item (what differs), nature temporary|permanent, optional slotKey (the tax line it adjusts)
//   recapture            asset, section (the recapture rule), optional slotKey
//   disposition          asset, disposedOn (date), proceedsCents, basisCents; amountCents = proceedsCents - basisCents (the gain or loss)
//   carryforward         item (what carries), originYear (the tax year it arose)
//   statement            slotKey (the line it supports), rows [{ label, amountCents }]; amountCents = the sum of the rows
//   reconciliation       subject, oldCents, newCents; amountCents = newCents - oldCents
export const RECAPTURE_SECTIONS = ['1245', '1250', '179', '280F', '1252', '1254', '1255'];
export const CARRYFORWARD_ITEMS = ['section_179', 'charitable', 'capital_loss', 'net_operating_loss', 'business_interest', 'passive_loss', 'at_risk', 'credit'];
export const RELATED_OUTPUT_SCHEMAS = {
  book_tax_difference: { required: { item: 'text', nature: ['temporary', 'permanent'] }, optional: { slotKey: 'slot' } },
  recapture: { required: { asset: 'id', section: RECAPTURE_SECTIONS }, optional: { slotKey: 'slot' } },
  disposition: { required: { asset: 'id', disposedOn: 'date', proceedsCents: 'cents', basisCents: 'cents' }, optional: {},
    amount: o => BigInt(o.proceedsCents) - BigInt(o.basisCents), amountIs: 'proceedsCents less basisCents' },
  carryforward: { required: { item: CARRYFORWARD_ITEMS, originYear: 'year' }, optional: {} },
  statement: { required: { slotKey: 'slot', rows: 'rows' }, optional: {}, amount: o => o.rows.reduce((t, x) => t + BigInt(x.amountCents), 0n), amountIs: 'the sum of its rows' },
  reconciliation: { required: { subject: 'text', oldCents: 'cents', newCents: 'cents' }, optional: {}, amount: o => BigInt(o.newCents) - BigInt(o.oldCents), amountIs: 'newCents less oldCents' },
};
export const RELATED_OUTPUT_KINDS = Object.keys(RELATED_OUTPUT_SCHEMAS);
const COMMON_OUTPUT_FIELDS = ['kind', 'key', 'amountCents', 'completeness', 'reasons'];
const METHODS = ['cash', 'accrual'];
const DIGITS = /^-?\d+$/;
const nonEmpty = v => typeof v === 'string' && v.trim().length > 0;
const shown = v => (typeof v === 'string' ? JSON.stringify(v) : String(v));

// Exact cents in JSON: a string of digits (optionally negative). A bigint or a digit string is exact; a Number is accepted only while it is a
// safe integer, since 9007199254740993 as a Number is already 9007199254740992 and serializing it would change a cent without any error.
export function centsToJson(cents) {
  if (typeof cents === 'bigint') return cents.toString();
  if (typeof cents === 'string' && DIGITS.test(cents)) return BigInt(cents).toString();
  if (typeof cents === 'number' && Number.isSafeInteger(cents)) return String(cents);
  if (typeof cents === 'number' && Number.isInteger(cents)) throw new Error(`cents ${cents} is not a safe integer: pass a bigint or a digit string (a Number this large has already lost cents)`);
  throw new Error(`cents must be a bigint, a digit string or a safe integer, got ${shown(cents)}`);
}
export function centsFromJson(text) {
  if (typeof text !== 'string' || !DIGITS.test(text)) throw new Error('amountCents must be a string of digits');
  return BigInt(text);
}

// The measurements a catalog line takes: balance lines begin and end; everything else activity.
const measurementsOf = line => (line.cls === 'balance' ? ['begin', 'end'] : ['activity']);

// A slot against its return's catalog: the field exists and is not computed (rule 0.4), every REQUIRED instance dimension is named, any
// other dimension is one of the line's ALLOWED source dimensions and a member names at most one of them (none for the line's own books or
// manual amount, exactly one where the line exists only for K-1 amounts), a code is one the coded box lists, and the measurement is one the
// line takes (Codex t1-r1 B2). Throws a plain Error with the reason.
export function checkSlot({ fieldId, dims = {}, measurement }, returnType, edition) {
  if (!MEASUREMENTS.includes(measurement)) throw new Error(`unknown measurement ${measurement}`);
  const line = catalogFor(returnType, edition).byId.get(fieldId) ?? (() => { throw new Error(`unknown field ${fieldId}`); })();
  if (line.kind === 'computed') throw new Error(`computed field ${fieldId} is not a slot`);
  for (const d of line.instanceDims) if (!dims[d]) throw new Error(`${fieldId} needs dimension ${d}`);
  const sources = Object.keys(dims).filter(d => !line.instanceDims.includes(d));
  for (const d of sources) if (!line.sourceDims.includes(d)) throw new Error(`${fieldId} has no dimension ${d}`);
  if (sources.length > 1) throw new Error(`${fieldId}: a member names at most one source dimension, got ${sources.join(' and ')}`);
  if (line.sourceRequired && !sources.length) throw new Error(`${fieldId} needs a source dimension (${line.sourceDims.join(' or ')}): it exists only for those members`);
  if (line.codes && !line.codes.includes(dims.code)) throw new Error(`${fieldId}: code ${dims.code} is not one of ${line.codes.join(' ')}`);
  const takes = measurementsOf(line);
  if (!takes.includes(measurement)) throw new Error(`${fieldId} takes ${takes.join(' or ')}, not ${measurement}`);
  return line;
}

// Canonical slot keys (Codex t1-r1 B3): "<fieldId>|<dim=value>|...|<measurement>", dimensions sorted by name and never repeated, each value
// a plain identifier (letters, digits, ':', '.', '_', '-'), so no value can carry the '|' or '=' delimiters. One semantic slot has exactly one
// spelling: a key that parses to the same slot as another but is spelled differently is refused, never stored as a second assignment.
const FIELD_ID = /^[a-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;
const DIM_NAME = /^[a-z][a-z0-9_]*$/;
const DIM_VALUE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,99}$/;
const checkDim = (name, value) => {
  if (!DIM_NAME.test(name)) throw new Error(`not a dimension: ${JSON.stringify(name)}`);
  if (typeof value !== 'string' || !DIM_VALUE.test(value)) throw new Error(`${name} value ${shown(value)} is not a plain identifier (letters, digits, : . _ -)`);
};
export function slotKey({ fieldId, dims = {}, measurement = 'activity', returnType = null, edition = null }) {
  if (!MEASUREMENTS.includes(measurement)) throw new Error(`unknown measurement ${measurement}`);
  if (!FIELD_ID.test(fieldId)) throw new Error(`not a field id: ${fieldId}`);
  for (const [k, v] of Object.entries(dims)) checkDim(k, v);
  if (returnType && edition) checkSlot({ fieldId, dims, measurement }, returnType, edition);
  return [fieldId, ...Object.keys(dims).sort().map(k => `${k}=${dims[k]}`), measurement].join('|');
}
// Strict: a key that is not in canonical form throws (repeated or unsorted dimensions, a delimiter in a value, an unknown measurement).
export function parseSlotKey(key) {
  if (typeof key !== 'string') throw new Error('a slot key is a string');
  const parts = key.split('|');
  const measurement = parts.at(-1);
  if (parts.length < 2 || !MEASUREMENTS.includes(measurement)) throw new Error(`unknown measurement ${measurement}`);
  const fieldId = parts[0];
  if (!FIELD_ID.test(fieldId)) throw new Error(`not a field id: ${fieldId}`);
  const dims = {}, names = [];
  for (const p of parts.slice(1, -1)) {
    const i = p.indexOf('=');
    const name = i < 0 ? p : p.slice(0, i), value = i < 0 ? '' : p.slice(i + 1);
    if (!DIM_NAME.test(name)) throw new Error(`not a dimension: ${JSON.stringify(p)}`);
    if (Object.hasOwn(dims, name)) throw new Error(`repeated dimension ${name} in ${key}`);
    checkDim(name, value);
    dims[name] = value; names.push(name);
  }
  for (let j = 1; j < names.length; j += 1) if (names[j - 1] >= names[j]) throw new Error(`${key} is not canonical: dimensions must be sorted`);
  return { fieldId, dims, measurement };
}
// The key itself when it is canonical; throws otherwise.
export function canonicalSlotKey(key) {
  const p = parseSlotKey(key), again = slotKey(p);
  if (again !== key) throw new Error(`${key} is not canonical (expected ${again})`);
  return key;
}

// The collection key of a member: the field, its REQUIRED instance dimensions and the measurement, without the source dimension that tells
// members apart (Codex t1-r1 B2). Two K-1s on Schedule D line 5 are one collection; Schedule C line 1 of two activities is two collections,
// never one merged figure. Needs the catalog, since only it knows which dimensions are instances.
export function collectionKey(key, { returnType, edition }) {
  const { fieldId, dims, measurement } = parseSlotKey(key);
  const line = catalogFor(returnType, edition).byId.get(fieldId) ?? (() => { throw new Error(`unknown field ${fieldId}`); })();
  const kept = Object.keys(dims).filter(d => line.instanceDims.includes(d)).sort().map(d => `${d}=${dims[d]}`);
  return [fieldId, ...kept, measurement].join('|');
}

// Every slot a return type offers, with its value type, dimensions and the measurements it takes.
export function slotsFor(returnType, edition) {
  return catalogFor(returnType, edition).slots.map(l => ({ fieldId: l.id, kind: l.kind, type: l.type, valueField: VALUE_FIELD[l.type], dims: l.instanceDims,
    sourceDims: l.sourceDims, sourceRequired: l.sourceRequired, codes: l.codes, measurements: measurementsOf(l) }));
}

// The value schema per catalog line type (spec §4.7: amount_cents | code | statement_rows). A coded K-1 box carries its code in the slot's
// required `code` dimension (checked against the box's code list) and its amount as amountCents; a statement line carries named rows; an info
// line its checkbox or text answer. Exactly one value field per value; 'code' is never a value field, so a code sent where an amount belongs is refused.
const VALUE_FIELD = { amount: 'amountCents', code: 'amountCents', statement: 'statementRows', checkbox: 'checked', text: 'text' };
const VALUE_FIELDS = ['amountCents', 'statementRows', 'checked', 'text', 'code'];
const ARTICLE = { amount: 'an amount', code: 'a coded', statement: 'a statement', checkbox: 'a checkbox', text: 'a text' };
function valueProblems(v, line, key) {
  const problems = [], field = VALUE_FIELD[line.type], status = v.completeness ?? 'complete';
  if (!COMPLETENESS.includes(status)) problems.push(`${key}: completeness must be one of ${COMPLETENESS.join(', ')}`);
  const wrong = VALUE_FIELDS.filter(f => f !== field && v[f] !== undefined);
  if (wrong.length) problems.push(`${key}: ${ARTICLE[line.type]} line takes ${field}, not ${wrong.join(', ')}`);
  if (status === 'unresolved' && (v[field] === null || v[field] === undefined)) return problems; // unknown is unresolved, never zero
  const x = v[field];
  if (field === 'amountCents' && (typeof x !== 'string' || !DIGITS.test(x))) problems.push(`${key}: amountCents must be a string of digits`);
  if (field === 'statementRows') {
    if (!Array.isArray(x) || !x.length) problems.push(`${key}: a statement line takes statementRows (named rows with amountCents)`);
    else {
      const labels = new Set();
      x.forEach((row, i) => {
        if (!nonEmpty(row?.label)) problems.push(`${key}: statementRows[${i}].label is required`);
        else if (labels.has(row.label)) problems.push(`${key}: statementRows repeats label ${row.label}`);
        else labels.add(row.label);
        if (typeof row?.amountCents !== 'string' || !DIGITS.test(row.amountCents)) problems.push(`${key}: statementRows[${i}].amountCents must be a string of digits`);
      });
    }
  }
  if (field === 'checked' && typeof x !== 'boolean') problems.push(`${key}: a checkbox line takes checked (true or false)`);
  if (field === 'text' && !nonEmpty(x)) problems.push(`${key}: a text line takes text`);
  return problems;
}

// A provider request (spec §4.7): { returnId, revisionContext, slots: [canonical slot keys], period: { start, end }, method, bookBasis }.
export function validateRequest(q, { returnType, edition }) {
  const problems = [];
  if (!q || typeof q !== 'object') return ['a request is an object'];
  if (q.returnId === undefined || q.returnId === null || q.returnId === '') problems.push('returnId is required');
  if (!nonEmpty(q.revisionContext)) problems.push('revisionContext is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(q.period?.start ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(q.period?.end ?? '')) problems.push('period needs start and end dates');
  if (!METHODS.includes(q.method)) problems.push('method must be cash or accrual');
  if (!METHODS.includes(q.bookBasis)) problems.push('bookBasis must be cash or accrual');
  if (!Array.isArray(q.slots)) problems.push('slots must be an array of slot keys');
  else {
    const seen = new Set();
    for (const k of q.slots) {
      try { canonicalSlotKey(k); checkSlot(parseSlotKey(k), returnType, edition); } catch (e) { problems.push(`${shown(k)}: ${e.message}`); continue; }
      if (seen.has(k)) problems.push(`${k} is requested twice`);
      seen.add(k);
    }
  }
  return problems;
}

const sliceId = s => [s.entity, s.account ?? '', s.txn ?? '', s.line ?? '', s.measurement].join('/');
const SLICE_KEYS = ['entity', 'account', 'txn', 'line', 'measurement'];

// One related output against its kind's contract (RELATED_OUTPUT_SCHEMAS). `at` names the output in every problem.
const isYear = v => Number.isInteger(v) && v >= 1900 && v <= 2100;
const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const isCents = v => typeof v === 'string' && DIGITS.test(v);
function outputProblems(o, at, { returnType, edition }) {
  const problems = [], schema = RELATED_OUTPUT_SCHEMAS[o.kind], fields = { ...schema.required, ...schema.optional };
  for (const k of Object.keys(o)) if (!COMMON_OUTPUT_FIELDS.includes(k) && !Object.hasOwn(fields, k)) problems.push(`${at}: ${k} is not a ${o.kind} field`);
  const status = o.completeness ?? 'complete';
  if (!['complete', 'unresolved'].includes(status)) problems.push(`${at}: completeness must be complete or unresolved`);
  const unresolved = status === 'unresolved';
  if (unresolved && !(Array.isArray(o.reasons) && o.reasons.length)) problems.push(`${at}: an unresolved related output says why in reasons`);
  if (!(unresolved && o.amountCents === null) && !isCents(o.amountCents)) problems.push(`${at}: amountCents must be a string of digits`);
  let typed = true;
  for (const [k, type] of Object.entries(fields)) {
    const v = o[k];
    if (v === undefined || v === null) {
      // An unresolved output may lack the cents it could not determine, never its identity (asset, item, slot).
      if (Object.hasOwn(schema.required, k) && !(unresolved && type === 'cents')) problems.push(`${at}: ${k} is required`);
      typed = false;
      continue;
    }
    const bad = msg => { problems.push(`${at}: ${k} ${msg}`); typed = false; };
    if (Array.isArray(type)) { if (!type.includes(v)) bad(`must be one of ${type.join(', ')}`); }
    else if (type === 'text') { if (!nonEmpty(v)) bad('must be text'); }
    else if (type === 'id') { if (typeof v !== 'string' || !DIM_VALUE.test(v)) bad('must be a plain identifier'); }
    else if (type === 'date') { if (!isDate(v)) bad('must be a date (YYYY-MM-DD)'); }
    else if (type === 'year') { if (!isYear(v)) bad('must be a year (a whole number such as 2025)'); }
    else if (type === 'cents') { if (!isCents(v)) bad('must be a string of digits'); }
    else if (type === 'slot') { try { canonicalSlotKey(v); checkSlot(parseSlotKey(v), returnType, edition); } catch (e) { problems.push(`${at}: slotKey: ${e.message}`); typed = false; } }
    else if (type === 'rows') {
      if (!Array.isArray(v) || !v.length) { bad('must be named rows with amountCents'); continue; }
      const labels = new Set();
      v.forEach((row, j) => {
        if (!nonEmpty(row?.label) || labels.has(row.label)) bad(`[${j}].label must be present and unique`); else labels.add(row.label);
        if (!isCents(row?.amountCents)) bad(`[${j}].amountCents must be a string of digits`);
      });
    }
  }
  // The amount a kind derives from its parts must agree with the amount it states.
  if (schema.amount && typed && isCents(o.amountCents)) {
    const want = schema.amount(o);
    if (BigInt(o.amountCents) !== want) problems.push(`${at}: amountCents ${o.amountCents} is not ${schema.amountIs} (${want})`);
  }
  return problems;
}

// The packet on its own against the catalog (no request): kind, supported schema, immutable source version and refs, review state,
// completeness with reasons, canonical catalog slots with typed values, typed related outputs and consumed slices.
export function validatePacket(r, { returnType, edition }) {
  const problems = [];
  if (!r || typeof r !== 'object') return ['a result is an object'];
  if (!PROVIDER_KINDS.includes(r.providerKind)) problems.push(`providerKind must be one of ${PROVIDER_KINDS.join(', ')}`);
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(r.schemaVersion)) problems.push(`schemaVersion ${shown(r.schemaVersion)} is not supported (supported: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')})`);
  if (!nonEmpty(r.sourceVersion)) problems.push('sourceVersion is required (the immutable version of the source the packet was built from)');
  if (!Array.isArray(r.sourceRefs) || !r.sourceRefs.length || r.sourceRefs.some(s => !nonEmpty(s?.kind) || !nonEmpty(String(s?.id ?? '')) || !nonEmpty(s?.version))) {
    problems.push('sourceRefs: at least one, each with kind, id and version');
  }
  if (!COMPLETENESS.includes(r.completeness)) problems.push(`completeness must be one of ${COMPLETENESS.join(', ')}`);
  if (r.completeness !== 'complete' && !(Array.isArray(r.reasons) && r.reasons.length)) problems.push('an incomplete result says why in reasons');
  if (!r.review || !REVIEW_STATES.includes(r.review.state)) problems.push('review.state must be unreviewed or reviewed');
  else if (r.review.state === 'reviewed' && !nonEmpty(r.review.by)) problems.push('a reviewed packet names its reviewer in review.by');
  if (!Array.isArray(r.values)) problems.push('values must be an array');
  else {
    const seen = new Set();
    for (const v of r.values) {
      let key, line;
      try { key = canonicalSlotKey(v?.slotKey); line = checkSlot(parseSlotKey(key), returnType, edition); } catch (e) { problems.push(`${shown(v?.slotKey)}: ${e.message}`); continue; }
      if (seen.has(key)) { problems.push(`${key} appears twice in one packet`); continue; }
      seen.add(key);
      problems.push(...valueProblems(v, line, key));
    }
  }
  if (!Array.isArray(r.relatedOutputs)) problems.push('relatedOutputs must be an array');
  else {
    const keys = new Set();
    r.relatedOutputs.forEach((o, i) => {
      if (!o || typeof o !== 'object') { problems.push(`relatedOutputs[${i}] is an object`); return; }
      if (!RELATED_OUTPUT_KINDS.includes(o.kind)) { problems.push(`relatedOutputs[${i}].kind must be one of ${RELATED_OUTPUT_KINDS.join(', ')}`); return; }
      const at = `relatedOutputs[${i}] (${o.kind} ${o.key ?? '?'})`;
      if (typeof o.key !== 'string' || !DIM_VALUE.test(o.key)) problems.push(`${at}: key ${shown(o.key)} is not a plain identifier (letters, digits, : . _ -)`);
      else if (keys.has(`${o.kind}:${o.key}`)) problems.push(`relatedOutputs repeats ${o.kind} ${o.key}`);
      else keys.add(`${o.kind}:${o.key}`);
      problems.push(...outputProblems(o, at, { returnType, edition }));
    });
  }
  if (!Array.isArray(r.consumedSlices)) problems.push('consumedSlices must be an array');
  else {
    const ids = new Set();
    r.consumedSlices.forEach((s, i) => {
      if (!s || typeof s !== 'object') { problems.push(`consumedSlices[${i}] is an object`); return; }
      for (const k of Object.keys(s)) if (!SLICE_KEYS.includes(k)) problems.push(`consumedSlices[${i}].${k} is not a slice field (${SLICE_KEYS.join(', ')})`);
      if (!nonEmpty(String(s.entity ?? ''))) problems.push(`consumedSlices[${i}].entity is required`);
      if (!MEASUREMENTS.includes(s.measurement)) problems.push(`consumedSlices[${i}].measurement must be one of ${MEASUREMENTS.join(', ')}`);
      const id = sliceId(s);
      if (ids.has(id)) problems.push(`the packet consumes slice ${id} twice`);
      ids.add(id);
    });
  }
  return problems;
}

// A provider's result against the request it answers. Returns [] when sound, else the problems. Every value is for a requested slot; a
// 'complete' result answers every requested slot with a complete value; an incomplete one says why (spec §4.7).
export function validateResult(r, request, ctx) {
  const problems = [...validatePacket(r, ctx), ...validateRequest(request, ctx).map(p => `request: ${p}`)];
  if (!Array.isArray(request?.slots) || !Array.isArray(r?.values)) return problems;
  const asked = new Set(request.slots), valued = new Set();
  for (const v of r.values) {
    if (typeof v?.slotKey !== 'string') continue;
    valued.add(v.slotKey);
    if (!asked.has(v.slotKey)) problems.push(`${v.slotKey} was not requested`);
    if (r.completeness === 'complete' && (v.completeness ?? 'complete') !== 'complete') problems.push(`${v.slotKey}: a complete result carries only complete values`);
  }
  if (r.completeness === 'complete') for (const k of asked) if (!valued.has(k)) problems.push(`a complete result is missing requested slot ${k}`);
  if (r.completeness === 'complete' && Array.isArray(r.relatedOutputs)) {
    for (const o of r.relatedOutputs) if ((o?.completeness ?? 'complete') !== 'complete') problems.push(`${o?.kind} ${o?.key}: a complete result carries only complete related outputs`);
  }
  return problems;
}

// Sum collection members once per collection, from whole packets (Codex t1-r1 B3): a packet's completeness and review state reach every value
// it carries, so a 'partial' packet's values are unresolved and an unreviewed packet's collection is unreviewed, even when the values repeat no
// state. Each member (canonical slot key) is owned by one packet and counted once: the same member from two packets is a conflict, never a
// second addend, and so is a source slice consumed by two packets (nothing is added outside the exclusivity rule). Unknown is never zero.
const RANK = { complete: 0, partial: 1, unresolved: 2 };
export function aggregate(packets, ctx) {
  const out = new Map(), owner = new Map(), sliceOwner = new Map();
  const catalog = catalogFor(ctx.returnType, ctx.edition);
  packets.forEach((p, i) => {
    const problems = validatePacket(p, ctx);
    if (problems.length) throw new Error(`packet ${p?.sourceVersion ?? i} is not a sound result: ${problems.join('; ')}`);
    let slicesClash = false;
    for (const s of p.consumedSlices) { const id = sliceId(s); if (sliceOwner.has(id) && sliceOwner.get(id) !== i) slicesClash = true; else sliceOwner.set(id, i); }
    for (const v of p.values) {
      const key = v.slotKey, line = catalog.byId.get(parseSlotKey(key).fieldId);
      if (!['amount', 'code', 'statement'].includes(line.type)) throw new Error(`${key} is not an amount line (${line.type}): answers are not added`);
      const ck = collectionKey(key, ctx);
      const cur = out.get(ck) ?? { cents: 0n, members: 0, status: 'complete', review: 'reviewed' };
      out.set(ck, cur);
      if (owner.has(key)) { cur.status = 'conflict'; cur.cents = null; continue; }
      owner.set(key, i);
      cur.members += 1;
      if (p.review.state !== 'reviewed') cur.review = 'unreviewed';
      if (cur.status === 'conflict') continue;
      if (slicesClash) { cur.status = 'conflict'; cur.cents = null; continue; }
      const state = RANK[v.completeness ?? 'complete'] > RANK[p.completeness] ? v.completeness : p.completeness;
      if (state !== 'complete') { cur.status = 'unresolved'; cur.cents = null; continue; }
      if (cur.status !== 'complete') continue;
      cur.cents += line.type === 'statement' ? v.statementRows.reduce((t, row) => t + centsFromJson(row.amountCents), 0n) : centsFromJson(v.amountCents);
    }
  });
  return out;
}

// Scoped to the period's company through tax_return (spec §11: reads stay within the companies the person may open), so a
// return id of another company in the same org lists nothing, the same way the writes refuse it.
export async function listAssignments(db, { orgId, entityId, returnId }) {
  const { rows } = await db.query(
    `SELECT a.* FROM tax_provider_assignment a JOIN tax_return r USING (org_id, return_id)
     WHERE a.org_id = $1 AND r.entity_id = $2 AND a.return_id = $3 ORDER BY a.slot_key`, [orgId, entityId, returnId]);
  return rows;
}
export const slotStatus = (assignments, key) => ({ status: assignments.some(a => a.slot_key === key) ? 'assigned' : 'unresolved' });

// The open period a write belongs to, under the entity lock (return type and edition live on tax_return). Every write goes through here so a
// filed period and another company's return id refuse the same way.
async function openReturn(tx, { orgId, entityId, returnId }) {
  // Tax Books T2 (Codex t2-plan-r4 R4-N1): the organization's inclusion-graph lock first — the one lock order of every Tax Books write —
  // so a packet's books check below reads the graph and the books it names under the same locks as the binding writes.
  await tx.query('SELECT pg_advisory_xact_lock(74120062, hashint8($1::bigint))', [orgId]);
  await lockEntity(tx, orgId, entityId);
  // The period's own resolved facts (spec §4.2: dates, tax method and book basis live on tax_return), which every request must match.
  const { rows: [r] } = await tx.query(`SELECT status, return_type, form_edition, period_start::text AS period_start, period_end::text AS period_end, tax_method, book_basis
    FROM tax_return WHERE org_id = $1 AND return_id = $2 AND entity_id = $3`, [orgId, returnId, entityId]);
  if (!r) fail('Period not found.');
  if (r.status !== 'open') fail('This period is not open.');
  return { ...r, ctx: { returnType: r.return_type, edition: Number(r.form_edition) } };
}
// A key checked against the period's catalog and refused unless canonical, before any uniqueness check could see two spellings of one slot.
function keyFor(r, key) {
  try { canonicalSlotKey(key); checkSlot(parseSlotKey(key), r.ctx.returnType, r.ctx.edition); } catch (e) { fail(`Not a slot of this return: ${e.message}.`); }
  return key;
}
// The source slices live assignments consume, from their packet snapshots, except the slots being retired.
async function liveSlices(tx, orgId, returnId, except) {
  const { rows } = await tx.query('SELECT slot_key, source_ref FROM tax_provider_assignment WHERE org_id = $1 AND return_id = $2', [orgId, returnId]);
  const live = new Map();
  for (const row of rows) if (!except.has(row.slot_key)) for (const s of row.source_ref?.packet?.consumedSlices ?? []) live.set(sliceId(s), row.slot_key);
  return live;
}
// Tax Books T2 (Codex t2-plan-r2 B2, r3 B2, r4 R4-N1/R4-N4, t2-r1 B1/B2, t2-r2 R2-B1): a packet built from the books' source partitions
// names each partition's allocation manifest and measurement basis (sourceRefs kind 'books_partition', id 'entity/account/measurement',
// lib/tax/partition.js). Run AFTER the incoming packets are written, inside the publishing transaction (a refusal rolls everything back), so
// ownership is judged under the authority the incoming assignments create (Codex t2-r2 R2-B1) — the same for a first assignment as for a
// replacement. Every source named by an incoming OR a retired packet, consumed by an incoming packet, or routed to a slot an incoming packet
// publishes is checked on that final live set: each live packet that names it must name its CURRENT manifest, and that partition must be
// complete under coverage's own rules (activity eligibility, path, owner and K-1 references — lib/tax/coverage.js), read after locking every
// company of the return's inclusion graph, so the books it depends on cannot change until this transaction ends. A current manifest is not
// enough (Codex t2-r1 B2): what each packet CONSUMES is checked against the approved portions of the rebuilt partitions — every books slice
// is one of their allocations (an attributed line, or a residual portion 'rest'/'b<binding id>'; never a line inside a residual, never an
// invented portion), consumed by the provider coverage gives it to (allocationOwners), through a packet that names the partition and
// publishes the slot that allocation is routed to (B1: the destination is the current routing); and every packet consumes EVERY approved
// portion its provider owns on each slot it publishes, from any source, whatever it claims about itself — so no portion is left out of a
// published slot. T2 publishes as-posted partitions only; a normalized one (T3's closings removal) is refused here until T3 supplies its
// authoritative normalization (Contracts 3). resolvers: the owner/K-1 resolvers to judge references with (lib/tax/references.js).
// Which slices are books claims is decided below (Codex t2-r2 B2b): a provider's own records are only slices of another provider whose
// company is not written as a number.
// incoming: the packets just written; retiredRows: the stored rows they replaced.
async function checkPartitionSet(tx, { orgId, entityId, returnId, incoming, retiredRows = [], resolvers }) {
  const ids = new Set();
  const refsOf = p => (p?.sourceRefs ?? []).filter(r => r?.kind === 'books_partition');
  const keyOf = p => `${p.providerKind}\u0000${p.sourceVersion}`;
  const incomingKeys = new Set(incoming.map(keyOf));
  // The books companies of this return: its own and every included one (any depth).
  const { rows: graph } = await tx.query('SELECT source_entity_id, entities FROM tax_inclusion_sources($1, $2)', [orgId, returnId]);
  const booksEntities = new Set([String(entityId), ...graph.map(g => String(g.source_entity_id))]);
  // Which slices are books claims (Codex t2-r2 B2b) — decided by the provider and the slice's shape, never by whether its spelling happens
  // to match: every slice of a books packet, and any slice whose company is written as a number (however padded or signed), claims the
  // books and must be canonical (positive integers, no padding), name a company whose books this return includes (its own or an included
  // one, any depth) and an account of THAT company. A refused claim is refused, never reclassified. Only a slice of another provider whose
  // company is not a number at all ('wp:count', 'reg:7') is that provider's own record.
  const NUMERIC = /^[\s+-]*\d[\d\s.,]*$/, CANONICAL = /^[1-9]\d{0,15}$/;
  const isClaim = (s, providerKind) => providerKind === 'books' || NUMERIC.test(String(s?.entity ?? ''));
  const booksId = s => (CANONICAL.test(String(s?.entity ?? '')) && CANONICAL.test(String(s?.account ?? '')) && booksEntities.has(String(s.entity)) && ['activity', 'begin', 'end'].includes(s?.measurement)
    ? `${s.entity}/${s.account}/${s.measurement}` : null);
  const claims = [];
  for (const p of incoming) for (const s of p.consumedSlices ?? []) {
    if (!isClaim(s, p.providerKind)) continue;
    if (!NUMERIC.test(String(s?.entity ?? ''))) fail(`A books packet consumes only books slices (a company and an account of this return's books): ${sliceId(s)} is not one.`);
    if (!CANONICAL.test(String(s.entity)) || !CANONICAL.test(String(s?.account ?? ''))) fail(`The slice ${sliceId(s)} is not a canonical books identity: a company and an account are written as their ids, with no padding or spaces.`);
    if (!booksEntities.has(String(s.entity))) fail(`The slice ${sliceId(s)} names company ${s.entity}, which is not a company whose books this return includes.`);
    claims.push(s);
  }
  if (claims.length) {
    const { rows: accts } = await tx.query('SELECT account_id::text AS a, entity_id::text AS e FROM account WHERE org_id = $1 AND account_id = ANY($2::bigint[])', [orgId, [...new Set(claims.map(s => s.account))]]);
    const ownerOf = new Map(accts.map(x => [x.a, x.e]));
    for (const s of claims) if (ownerOf.get(String(s.account)) !== String(s.entity)) fail(`The slice ${sliceId(s)} names account ${s.account}, which is not an account of company ${s.entity}.`);
  }
  // Every books partition an incoming packet NAMES (Codex t2-r3 R3-B1), before the scope checks and the early return: a named dependency
  // is checked against the current manifest and the return's inclusion scope even when the packet consumes nothing of it.
  const PARTITION_ID = /^[1-9]\d{0,15}\/[1-9]\d{0,15}\/(activity|begin|end)$/;
  for (const p of incoming) for (const r of refsOf(p)) {
    if (!PARTITION_ID.test(String(r.id))) fail(`${String(r.id)} is not a books partition id (company/account/measurement, written as their ids).`);
    ids.add(String(r.id));
  }
  for (const p of incoming) for (const s of p.consumedSlices ?? []) { const id = booksId(s); if (id) ids.add(id); }
  for (const row of retiredRows) for (const r of refsOf(row.source_ref?.packet)) ids.add(String(r.id));
  for (const id of ids) {
    const src = Number(String(id).split('/')[0]);
    if (src !== Number(entityId) && !graph.some(x => Number(x.source_entity_id) === src)) fail(`The books partition ${id} names books this return does not include.`);
  }
  // Nothing of the books is involved when no packet names or consumes them and the return routes nothing: T1's own packets stop here.
  if (!ids.size) {
    const { rows: [b] } = await tx.query(`SELECT EXISTS (SELECT 1 FROM tax_binding WHERE org_id = $1 AND return_id = $2) OR EXISTS (SELECT 1 FROM tax_binding_line WHERE org_id = $1 AND return_id = $2) AS any`,
      [orgId, returnId]);
    if (!b.any) return;
  }
  // Lock the books the check reads: every company of the return's inclusion graph (ascending; the return company is locked already) — the
  // whole graph, since a published slot may be fed by sources no packet names.
  const lockIds = new Set(graph.flatMap(g => g.entities.map(Number)));
  lockIds.delete(Number(entityId));
  for (const x of [...lockIds].sort((a, b) => a - b)) await lockEntity(tx, orgId, x);
  const { coverage, routeAllocations } = await import('./coverage.js');
  const cov = await coverage(tx, { orgId, entityId, returnId, ...(resolvers ? { resolvers } : {}) });
  // Every packet live now, from the stored snapshots (the incoming ones were written above).
  const { rows } = await tx.query('SELECT source_ref FROM tax_provider_assignment WHERE org_id = $1 AND return_id = $2', [orgId, returnId]);
  const live = new Map();
  for (const row of rows) {
    const p = row.source_ref?.packet;
    if (p && !live.has(`${keyOf(p)}|${JSON.stringify(p.slots ?? [])}`)) live.set(`${keyOf(p)}|${JSON.stringify(p.slots ?? [])}`, { incoming: incomingKeys.has(keyOf(p)), providerKind: p.providerKind, sourceRefs: p.sourceRefs, consumedSlices: p.consumedSlices ?? [], slots: p.slots ?? [] });
  }
  const finalSet = [...live.values()];
  // The approved portions as T1 slices: slice id → { id (the partition), slot, provider (null: comparison only, no slot, or a slot problem) }.
  const routeOf = new Map(), portions = new Map();
  for (const r of routeAllocations(cov)) { const m = r.member; if (m.kind !== 'unread') routeOf.set(`${m.sourceEntityId}/${m.accountId}/${m.measurement}/${m.kind}:${m.id}`, r); }
  for (const s of cov.sources) for (const a of s.accounts ?? []) for (const [ms, p] of Object.entries(a.results)) {
    const id = `${s.entityId}/${a.accountId}/${ms}`;
    for (const al of p.allocations) {
      const at = al.kind === 'line' ? p.attributed.find(x => x.id === al.id) : null;
      if (al.kind === 'line' && !at) continue;
      const slice = { entity: String(s.entityId), account: String(a.accountId), txn: at ? at.txn : 'rest', line: at ? at.line : `b${al.id}`, measurement: ms };
      const r = routeOf.get(`${id}/${al.kind}:${al.id}`) ?? null;
      portions.set(sliceId(slice), { id, slot: r?.key ?? null, provider: r && r.role !== 'comparison' && !r.problem ? r.provider : null });
    }
  }
  // The sources routed to a slot an incoming packet publishes are checked too.
  for (const p of finalSet) if (p.incoming) for (const portion of portions.values()) if (portion.provider === p.providerKind && p.slots.includes(portion.slot)) ids.add(portion.id);
  const named = finalSet.flatMap(refsOf);
  for (const id of ids) {
    const [entity, account, measurement] = String(id).split('/');
    const src = cov.sources.find(s => s.entityId === Number(entity) && s.status === 'measured');
    const cur = src?.accounts.find(a => a.accountId === Number(account))?.results?.[measurement];
    const naming = named.filter(r => String(r.id) === id);
    if (!naming.length) continue;
    if (!cur || cur.status !== 'complete') fail(`The books partition ${id} is not a complete, permitted mapping of this return now (${cur ? cur.reasons.join(' ') || cur.status : 'not measured'}): map it again before publishing a packet from it.`);
    // Tax Books T3 (the prerequisite named in the T2 plan, Contracts 3): the authoritative normalization of the source is the one coverage
    // measures now (lib/tax/measure.js closingExclusions: confirmed closings removed); a packet built on any other basis is refused.
    for (const r of naming) if ((r.normalization ?? 'as_posted') !== cur.source.normalization) {
      fail(`The books partition ${id} was built on the measurement basis ${r.normalization ?? 'as_posted'}, but this return measures it now as ${cur.source.normalization}: rebuild it from the current measurement.`);
    }
    for (const r of naming) if (r.version !== cur.version) {
      fail(`A packet for the books partition ${id} was built from an earlier mapping than the current one: rebuild it, and replace every live packet of that source together (substituteProviders).`);
    }
  }
  // Each packet is checked when it is incoming or touches a source checked here (names it, consumes from it, or publishes a slot it feeds).
  for (const p of finalSet) {
    const refs = new Set(refsOf(p).map(r => String(r.id))), slots = new Set(p.slots), mine = new Set(p.consumedSlices.map(sliceId));
    if (!p.incoming && ![...refs].some(id => ids.has(id)) && !p.consumedSlices.some(s => ids.has(booksId(s)))
        && ![...portions.values()].some(x => ids.has(x.id) && slots.has(x.slot))) continue;
    for (const s of p.consumedSlices) {
      const id = booksId(s);
      if (!id || !ids.has(id)) continue;
      if (!refs.has(id)) fail(`A packet of ${p.providerKind} consumes books slice ${sliceId(s)} without naming its books partition ${id}: books are consumed only through their current partition.`);
      const portion = portions.get(sliceId(s));
      if (!portion || portion.id !== id) fail(`The books slice ${sliceId(s)} is not an approved portion of the current mapping of ${id}: a packet consumes only the partition’s attributed lines and residual portions.`);
      if (portion.provider !== p.providerKind) fail(`The books slice ${sliceId(s)} belongs to ${portion.provider ?? 'no provider (comparison only, or its slot has a problem)'}, not ${p.providerKind}.`);
      if (!slots.has(portion.slot)) fail(`The books slice ${sliceId(s)} is routed to ${portion.slot}, which this packet does not publish.`);
    }
    // On each slot it publishes, every approved portion its provider owns there, from any source — whatever the packet says about itself.
    for (const [sid, portion] of portions) {
      if (portion.provider === p.providerKind && slots.has(portion.slot) && !mine.has(sid)) {
        fail(`The packet of ${p.providerKind} publishes ${portion.slot} but does not consume every approved portion routed there (${sid} of ${portion.id}): build it from the current mapping.`);
      }
    }
  }
}
const snapshot = (p, request) => ({ packet: { providerKind: p.providerKind, schemaVersion: p.schemaVersion, sourceVersion: p.sourceVersion, sourceRefs: p.sourceRefs,
  review: p.review, completeness: p.completeness, reasons: p.reasons ?? [], relatedOutputs: p.relatedOutputs, consumedSlices: p.consumedSlices, slots: p.values.map(v => v.slotKey) },
  request: { revisionContext: request.revisionContext, period: request.period, method: request.method, bookBasis: request.bookBasis } });
async function insertPacketRows(tx, { orgId, returnId, packet, request, extra = {} }) {
  // A packet is stored on its value rows (one per slot, each carrying the whole snapshot and related outputs); with no value rows
  // nothing would persist. Callers refuse such a packet before they change anything (Codex t1-r3 B3).
  if (!packet.values.length) fail('A provider packet supplies at least one slot; with none, nothing of it (or its related outputs) would be kept.');
  const base = snapshot(packet, request);
  for (const v of packet.values) {
    await tx.query('INSERT INTO tax_provider_assignment (org_id, return_id, slot_key, provider_kind, provider_schema_version, source_ref, source_version) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [orgId, returnId, v.slotKey, packet.providerKind, packet.schemaVersion, { ...base, value: v, ...extra }, packet.sourceVersion]);
  }
}
const checkPacket = (r, request, packet, returnId) => {
  const problems = validateResult(packet, request, r.ctx);
  if (problems.length) fail(`The provider packet is not sound: ${problems.join('; ')}.`);
  if (String(request.returnId) !== String(returnId)) fail('The request names another return.');
  // A packet answers the period it was asked about (Codex t1-r2 B3): a request for another year, method or basis is never snapshotted here.
  if (request.period.start !== r.period_start || request.period.end !== r.period_end) {
    fail(`The request’s period ${request.period.start} to ${request.period.end} is not this return’s ${r.period_start} to ${r.period_end}.`);
  }
  if (request.method !== r.tax_method) fail(`The request’s tax method ${request.method} is not this return’s ${r.tax_method}.`);
  if (request.bookBasis !== r.book_basis) fail(`The request’s book basis ${request.bookBasis} is not this return’s ${r.book_basis}.`);
};

// What a packet contributes to each collection it touches, in exact cents: { collectionKey: bigint | null } where null is unknown (an
// unresolved value, or a packet that is not complete), never zero. Answer lines (checkbox, text) contribute their answers, by slot key.
function contributions(values, packetCompleteness, ctx) {
  const catalog = catalogFor(ctx.returnType, ctx.edition), out = new Map();
  for (const v of values) {
    const ck = collectionKey(v.slotKey, ctx), line = catalog.byId.get(parseSlotKey(v.slotKey).fieldId);
    if (!['amount', 'code', 'statement'].includes(line.type)) {
      const cur = out.get(ck) ?? { answers: {} };
      cur.answers[v.slotKey] = v[VALUE_FIELD[line.type]] ?? null;
      out.set(ck, cur);
      continue;
    }
    const cur = out.get(ck) ?? { cents: 0n };
    out.set(ck, cur);
    const known = v && packetCompleteness === 'complete' && (v.completeness ?? 'complete') === 'complete' && (line.type === 'statement' ? Array.isArray(v.statementRows) : isCents(v.amountCents));
    if (!known) { cur.cents = null; continue; }
    if (cur.cents !== null) cur.cents += line.type === 'statement' ? v.statementRows.reduce((t, x) => t + BigInt(x.amountCents), 0n) : BigInt(v.amountCents);
  }
  return out;
}
const centsText = c => (c === null || c === undefined ? null : c.toString());
// Key order is not meaning: a snapshot read back from jsonb has its keys reordered.
const sorted = v => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])])) : v);
const sameJson = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const canonicalAnswers = a => Object.fromEntries(Object.entries(a ?? {}).sort(([x], [y]) => (x < y ? -1 : 1)));

// The reconciliation a switch carries, checked against what the packets actually say (Codex t1-r2 B3). Every touched collection has one entry
// whose oldCents is the replaced packet's contribution (from its stored snapshot) and whose newCents is the replacement's (null when unknown);
// answer lines carry oldAnswers/newAnswers instead. A change needs a reason. Every related output of the replaced packet is carried unchanged
// by the replacement or has an entry { kind, key, oldCents, newCents (null when retired), reason } that states the change truthfully; nothing
// disappears silently, and an entry about anything else is refused rather than stored as if it reconciled something.
function checkReconciliation({ reconciliation, oldRows, packet, ctx }) {
  if (!reconciliation || typeof reconciliation !== 'object') fail('The switch carries its reconciliation (old and new values of every collection it touches).');
  const oldValues = oldRows.map(row => ({ slotKey: row.slot_key, value: row.source_ref?.value, completeness: row.source_ref?.packet?.completeness }));
  const oldBy = new Map();
  for (const o of oldValues) {
    const c = contributions([o.value ?? { slotKey: o.slotKey, completeness: 'unresolved' }], o.completeness ?? 'unresolved', ctx);
    for (const [ck, x] of c) {
      const cur = oldBy.get(ck);
      if (!cur) oldBy.set(ck, x);
      else if (x.answers) cur.answers = { ...cur.answers, ...x.answers };
      else cur.cents = cur.cents === null || x.cents === null ? null : cur.cents + x.cents;
    }
  }
  const newBy = contributions(packet.values, packet.completeness, ctx);
  const touched = [...new Set([...oldBy.keys(), ...newBy.keys()])].sort();
  const entries = Array.isArray(reconciliation.collections) ? reconciliation.collections : [];
  const rec = new Map();
  for (const c of entries) {
    if (!c || typeof c.collectionKey !== 'string') fail('Each reconciliation entry names its collectionKey.');
    if (rec.has(c.collectionKey)) fail(`${c.collectionKey} is reconciled twice.`);
    if (!touched.includes(c.collectionKey)) fail(`${c.collectionKey} is not touched by this switch: a reconciliation entry names a collection the switch retires or supplies.`);
    rec.set(c.collectionKey, c);
  }
  for (const ck of touched) {
    const c = rec.get(ck);
    if (!c) fail(`The switch must reconcile ${ck} (old and new cents) before it applies.`);
    const was = oldBy.get(ck), now = newBy.get(ck);
    if ((was ?? now).answers) {
      const a = canonicalAnswers(was?.answers), b = canonicalAnswers(now?.answers);
      if (!sameJson(canonicalAnswers(c.oldAnswers), a)) fail(`Reconciliation of ${ck}: oldAnswers ${JSON.stringify(c.oldAnswers ?? null)} are not the replaced packet’s ${JSON.stringify(a)}.`);
      if (!sameJson(canonicalAnswers(c.newAnswers), b)) fail(`Reconciliation of ${ck}: newAnswers ${JSON.stringify(c.newAnswers ?? null)} are not the replacement packet’s ${JSON.stringify(b)}.`);
      if (!sameJson(a, b) && !nonEmpty(c.reason)) fail(`${ck} changes its answers: give the reason for the change.`);
      continue;
    }
    // A collection the replacement does not supply at all receives nothing from it: its new contribution is zero cents, stated as '0'.
    const oldCents = centsText(was ? was.cents : 0n), newCents = centsText(now ? now.cents : 0n);
    for (const [f, want] of [['oldCents', oldCents], ['newCents', newCents]]) {
      const got = c[f] ?? null;
      if (got !== null && !isCents(got)) fail(`Reconciliation of ${ck}: ${f} must be a string of digits (or null when unknown).`);
      const norm = got === null ? null : BigInt(got).toString();
      if (norm !== want) fail(`Reconciliation of ${ck}: ${f} ${got ?? 'null (unknown)'} is not the ${f === 'oldCents' ? 'replaced' : 'replacement'} packet’s ${want ?? 'null (unknown)'}.`);
    }
    if (oldCents !== newCents && !nonEmpty(c.reason)) fail(`${ck} changes from ${oldCents ?? 'unknown'} to ${newCents}: give the reason for the change.`);
  }
  // Related outputs: the union of the replaced packet's snapshots (every row of one packet carries the same list).
  const oldOutputs = new Map();
  for (const row of oldRows) for (const o of row.source_ref?.packet?.relatedOutputs ?? []) if (!oldOutputs.has(`${o.kind}:${o.key}`)) oldOutputs.set(`${o.kind}:${o.key}`, o);
  const newOutputs = new Map(packet.relatedOutputs.map(o => [`${o.kind}:${o.key}`, o]));
  const outEntries = Array.isArray(reconciliation.relatedOutputs) ? reconciliation.relatedOutputs : [];
  const outRec = new Map();
  for (const e of outEntries) {
    const id = `${e?.kind}:${e?.key}`;
    if (!oldOutputs.has(id)) fail(`${e?.kind} ${e?.key} is not a related output of the replaced packet: reconcile only what it carried.`);
    if (outRec.has(id)) fail(`${e.kind} ${e.key} is reconciled twice.`);
    outRec.set(id, e);
  }
  for (const [id, was] of [...oldOutputs].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const now = newOutputs.get(id), e = outRec.get(id), name = `${was.kind} ${was.key}`;
    if (!e) {
      if (!now) fail(`The related output ${name} of the replaced packet is neither carried nor retired: carry it in the replacement or retire it in reconciliation.relatedOutputs with the reason.`);
      if (!sameJson(now, was)) fail(`The related output ${name} changes from ${was.amountCents} to ${now.amountCents}: reconcile it in reconciliation.relatedOutputs with the reason.`);
      continue;
    }
    for (const [f, want] of [['oldCents', was.amountCents ?? null], ['newCents', now ? now.amountCents ?? null : null]]) {
      const got = e[f] ?? null;
      if (got !== want) fail(`Reconciliation of ${name}: ${f} ${got ?? 'null'} is not the ${f === 'oldCents' ? 'replaced' : 'replacement'} packet’s ${want ?? 'null'}${f === 'newCents' && !now ? ' (retired)' : ''}.`);
    }
    if (!nonEmpty(e.reason)) fail(now ? `The related output ${name} changes: give the reason.` : `The related output ${name} is retired: give the reason.`);
  }
}

// One slot assigned to a provider. The assignment names a supported schema version and the immutable source version it was made from.
export async function assignProvider(pool, { orgId, entityId, returnId, slotKey: key, providerKind, schemaVersion, sourceRef = {}, sourceVersion = null }) {
  if (!PROVIDER_KINDS.includes(providerKind)) fail('Unknown provider.');
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(schemaVersion)) fail(`schemaVersion ${shown(schemaVersion)} is not supported (supported: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}).`);
  if (!nonEmpty(sourceVersion)) fail('sourceVersion is required: an assignment names the immutable source version it was made from.');
  // Authority only (Codex t2-r2 B2a): a result — a packet snapshot, a value, the request it answers — is published through assignPacket or
  // substituteProviders, whose boundary checks what it consumes; here it could otherwise become a live result unchecked.
  if (!sourceRef || typeof sourceRef !== 'object' || Array.isArray(sourceRef)) fail('sourceRef is an object describing where the authority comes from.');
  for (const k of ['packet', 'value', 'request', 'substituted']) {
    if (Object.hasOwn(sourceRef, k)) fail(`assignProvider records authority only: a result (${k}) is published as a packet through assignPacket, which checks what it consumes.`);
  }
  return withTransaction(pool, async tx => {
    const r = await openReturn(tx, { orgId, entityId, returnId });
    keyFor(r, key);
    const { rows: has } = await tx.query('SELECT provider_kind FROM tax_provider_assignment WHERE org_id = $1 AND return_id = $2 AND slot_key = $3', [orgId, returnId, key]);
    if (has.length) fail(`${key} already has a provider (${has[0].provider_kind}). Use substitute to change it.`);
    await tx.query('INSERT INTO tax_provider_assignment (org_id, return_id, slot_key, provider_kind, provider_schema_version, source_ref, source_version) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [orgId, returnId, key, providerKind, schemaVersion, sourceRef, sourceVersion]);
  });
}

// A whole packet assigned at once: validated against its request, every slot unowned, no source slice already consumed by a live packet, and
// the packet snapshotted with each row (its source refs, related outputs, consumed slices, review and completeness).
export async function assignPacket(pool, { orgId, entityId, returnId, request, packet, resolvers }) {
  return withTransaction(pool, async tx => {
    const r = await openReturn(tx, { orgId, entityId, returnId });
    checkPacket(r, request, packet, returnId);
    if (!packet.values.length) fail('A provider packet supplies at least one slot.');
    const keys = packet.values.map(v => v.slotKey);
    const { rows: has } = await tx.query('SELECT slot_key, provider_kind FROM tax_provider_assignment WHERE org_id = $1 AND return_id = $2 AND slot_key = ANY($3)', [orgId, returnId, keys]);
    if (has.length) fail(`${has[0].slot_key} already has a provider (${has[0].provider_kind}). Use substitute to change it.`);
    const live = await liveSlices(tx, orgId, returnId, new Set());
    for (const s of packet.consumedSlices) if (live.has(sliceId(s))) fail(`The source slice ${sliceId(s)} is already consumed by ${live.get(sliceId(s))}.`);
    // Written first, then checked on the final state (Codex t2-r2 R2-B1); a refusal rolls the rows back with the transaction.
    await insertPacketRows(tx, { orgId, returnId, packet, request });
    await checkPartitionSet(tx, { orgId, entityId, returnId, incoming: [packet], resolvers });
  });
}

// A reviewed provider switch (spec §4.7, §13.1 T7): the replacement is a complete, reviewed packet; it retires EVERY slot of the packet it
// replaces (identified by provider and source version) or nothing happens, so depreciation never moves without the 179, disposition and
// statement outputs that came with it; it never consumes a source slice another live packet still consumes; every collection it touches is
// reconciled old against new from the stored snapshot and the new packet (checkReconciliation: false totals refused, changes reasoned, every
// related output carried or retired); the request matches the return's period, method and basis; and the retirement and the new rows apply in
// one transaction. Nothing is ever added on top of a replaced amount.
export const substituteProvider = (pool, { orgId, entityId, returnId, from, retire, request, packet, reviewedBy, reconciliation, resolvers }) =>
  substituteProviders(pool, { orgId, entityId, returnId, reviewedBy, resolvers, replacements: [{ from, retire, request, packet, reconciliation }] });
// Several packets replaced in ONE transaction (T2, Codex t2-plan-r3 R3-N1, r4 R4-N2). Every switch is validated first, with nothing
// written: each retires its whole packet, is complete and reviewed, and reconciles from its stored snapshot. Then the batch is checked
// against its FINAL state: no slot retired twice; each new slot supplied once and owned by no live packet outside the retiring set; each
// consumed slice consumed once across the new packets and by no live packet outside the retiring set. Only then is anything retired and
// inserted, and the books partitions named by the incoming and the retired packets are checked on the final live set. Any refusal changes
// nothing. Two providers can therefore exchange attributed lines, which no order of single switches could.
export async function substituteProviders(pool, { orgId, entityId, returnId, replacements, reviewedBy, resolvers }) {
  if (!nonEmpty(reviewedBy)) fail('A provider change is reviewed: say who reviewed it.');
  if (!Array.isArray(replacements) || !replacements.length) fail('Name the packets being replaced.');
  for (const { from, retire } of replacements) {
    if (!from || !PROVIDER_KINDS.includes(from.providerKind) || !nonEmpty(from.sourceVersion)) fail('Name the packet being replaced: its provider and source version.');
    if (!Array.isArray(retire) || !retire.length) fail('List the slots the replacement retires.');
  }
  return withTransaction(pool, async tx => {
    const r = await openReturn(tx, { orgId, entityId, returnId });
    const prepared = [];
    for (const x of replacements) prepared.push(await prepareSwitch(tx, r, { orgId, returnId, ...x }));
    const retiring = new Set();
    for (const p of prepared) for (const k of p.retired) { if (retiring.has(k)) fail(`${k} is retired by two replacements.`); retiring.add(k); }
    const supplied = new Set();
    for (const p of prepared) for (const v of p.packet.values) { if (supplied.has(v.slotKey)) fail(`${v.slotKey} is supplied by two replacement packets.`); supplied.add(v.slotKey); }
    const fresh = [...supplied].filter(k => !retiring.has(k));
    if (fresh.length) {
      const { rows: has } = await tx.query('SELECT slot_key, provider_kind FROM tax_provider_assignment WHERE org_id = $1 AND return_id = $2 AND slot_key = ANY($3)', [orgId, returnId, fresh]);
      if (has.length) fail(`${has[0].slot_key} already has a provider (${has[0].provider_kind}).`);
    }
    const live = await liveSlices(tx, orgId, returnId, retiring), taken = new Map();
    for (const p of prepared) for (const s of p.packet.consumedSlices) {
      const id = sliceId(s);
      if (live.has(id)) fail(`The source slice ${id} is already consumed by ${live.get(id)}; a replacement never consumes it twice.`);
      if (taken.has(id)) fail(`The source slice ${id} is consumed by two replacement packets.`);
      taken.set(id, p.packet.providerKind);
    }
    for (const p of prepared) await tx.query('DELETE FROM tax_provider_assignment WHERE org_id = $1 AND return_id = $2 AND slot_key = ANY($3)', [orgId, returnId, p.retired]);
    for (const p of prepared) {
      await insertPacketRows(tx, { orgId, returnId, packet: p.packet, request: p.request, extra: { substituted: { from: p.from, retired: p.retired, reviewedBy, reconciliation: p.reconciliation } } });
    }
    await checkPartitionSet(tx, { orgId, entityId, returnId, incoming: prepared.map(p => p.packet), retiredRows: prepared.flatMap(p => p.old), resolvers });
  });
}
// One switch, validated against the stored state with nothing written (the batch checks slots and slices on its final state).
async function prepareSwitch(tx, r, { orgId, returnId, from, retire, request, packet, reconciliation }) {
  const retired = [...new Set(retire.map(k => keyFor(r, k)))].sort();
  checkPacket(r, request, packet, returnId);
  if (packet.completeness !== 'complete') fail('A replacement packet is complete: an incomplete packet cannot replace a provider.');
  if (packet.review.state !== 'reviewed') fail('A replacement packet is reviewed before it replaces anything.');
  // Checked before anything is deleted: a replacement with no value rows could not keep its snapshot, its carried related outputs or
  // its reconciliation (Codex t1-r3 B3). Retiring a provider without a successor is not a T1 operation.
  if (!packet.values.length) fail('A replacement packet supplies at least one slot; it cannot carry related outputs or its reconciliation without one.');
  const { rows: old } = await tx.query(`SELECT slot_key, source_ref FROM tax_provider_assignment WHERE org_id = $1 AND return_id = $2 AND provider_kind = $3 AND source_version = $4 FOR UPDATE`,
    [orgId, returnId, from.providerKind, from.sourceVersion]);
  if (!old.length) fail(`There is no packet from ${from.providerKind} at ${from.sourceVersion} on this return.`);
  const oldKeys = new Set(old.map(x => x.slot_key)), retiring = new Set(retired);
  for (const k of retired) if (!oldKeys.has(k)) fail(`${k} is not provided by that packet.`);
  const missing = [...oldKeys].filter(k => !retiring.has(k)).sort();
  if (missing.length) fail(`Partial replacement refused: ${missing.join(', ')} also ${missing.length === 1 ? 'comes' : 'come'} from that packet; retire the whole packet.`);
  checkReconciliation({ reconciliation, oldRows: old, packet, ctx: r.ctx });
  return { from, retired, request, packet, reconciliation, old };
}
