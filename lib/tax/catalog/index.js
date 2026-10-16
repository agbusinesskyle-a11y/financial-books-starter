// lib/tax/catalog/index.js
// Loads an edition's catalogs, validates them once, and resolves (returnType, edition) → the lines a return uses.
import { RETURN_TYPES, MEASUREMENTS, applicabilityRules, deadlineDates, FEDERAL_HOLIDAYS, conditionNames } from './2025/shared.js';
import { FILING_MANIFEST, MANIFEST_COVERAGE, LINE_ATTACHMENTS, validateManifest as validateManifestRules, evaluateManifest } from './2025/manifest.js';
import * as f1065 from './2025/form1065.js';
import * as f1120s from './2025/form1120s.js';
import * as f1040 from './2025/f1040.js';
import * as k1065 from './2025/k1_1065.js';
import * as k1120s from './2025/k1_1120s.js';
import * as f1125a from './2025/f1125a.js';
import * as f8825 from './2025/f8825.js';

export { RETURN_TYPES, MEASUREMENTS, MANIFEST_COVERAGE, LINE_ATTACHMENTS, conditionNames };
export const EDITIONS = [2025];

const BY_EDITION = {
  2025: {
    form_1065: [...f1065.LINES, ...f1125a.LINES, ...f8825.LINES, ...k1065.LINES],
    form_1120s: [...f1120s.LINES, ...f1125a.LINES, ...f8825.LINES, ...k1120s.LINES],
    // The 1040-shaped catalogs carry no Form 1125-A or Form 8825: those are 1065/1120-S attachments, and Schedule C Part III,
    // Schedule F Part III and Schedule E Part I are the 1040's own COGS and rental schedules (spec §4.10). A 1125-A slot here
    // would be one no 1040 formula reads (f1040.c.4 sums f1040.c.42), so a binding to it would drop COGS from Schedule C.
    // A disregarded child included in a 1065/1120-S binds into the owner's catalog, not its own (spec §4.5, §5.7).
    disregarded: [...f1040.SCHEDULE_C, ...f1040.SCHEDULE_E1, ...f1040.SCHEDULE_F, ...f1040.PORTFOLIO],
    household_1040: [...f1040.SCHEDULE_C, ...f1040.SCHEDULE_E1, ...f1040.SCHEDULE_E2, ...f1040.SCHEDULE_F, ...f1040.PORTFOLIO, ...f1040.SCHEDULE_1, ...f1040.INFO_8995],
  },
};

// Every problem in a list of lines, as text; [] when it is sound.
export function validateCatalog(lines) {
  const problems = [], ids = new Set();
  for (const l of lines) {
    if (ids.has(l.id)) problems.push(`duplicate id ${l.id}`);
    ids.add(l.id);
    if (l.kind === 'computed' && !l.formula) problems.push(`${l.id} is computed but has no formula`);
    if (l.kind !== 'computed' && l.formula) problems.push(`${l.id} has a formula but is not computed`);
  }
  const named = f => (Array.isArray(f) ? f.slice(1).flatMap(x => (Array.isArray(x) ? x : [x])) : []);
  for (const l of lines) for (const ref of named(l.formula)) if (!ids.has(ref)) problems.push(`${l.id} names unknown id ${ref}`);
  for (const l of lines) for (const ref of l.requires ?? []) if (!ids.has(ref)) problems.push(`${l.id} requires unknown id ${ref}`);
  // Dimensions through formulas (Codex t1-r1 B2): a computed line keeps its instanceDims (one result per instance) and sums away its aggregates.
  // Every operand dimension is one or the other, every kept dimension is on every operand, and a declared aggregate is on some operand, so a
  // per-property line (8825 line 19) is never silently a return-wide total and a return-wide total (line 20a) never silently per property.
  const byId = new Map(lines.map(l => [l.id, l]));
  for (const l of lines.filter(x => x.kind === 'computed' && x.formula)) {
    const ops = named(l.formula).map(ref => byId.get(ref)).filter(Boolean);
    const keeps = l.instanceDims ?? [], sums = l.aggregates ?? [];
    for (const o of ops) {
      for (const d of o.instanceDims ?? []) if (!keeps.includes(d) && !sums.includes(d)) problems.push(`${l.id} drops dimension ${d} of ${o.id} without declaring it aggregated`);
      for (const d of keeps) if (!(o.instanceDims ?? []).includes(d)) problems.push(`${l.id} keeps dimension ${d} that ${o.id} does not have`);
    }
    for (const d of sums) if (!ops.some(o => (o.instanceDims ?? []).includes(d))) problems.push(`${l.id} aggregates ${d}, which no operand has`);
    for (const d of keeps) if (sums.includes(d)) problems.push(`${l.id} both keeps and aggregates ${d}`);
  }
  return problems;
}

// Each edition folder owns the federal holiday tables its due dates can fall on (TY2025: 2025-2027). A period bound to an
// edition this index does not know gets no deadlines, never the prior edition's tables (spec §4.3).
const HOLIDAYS_BY_EDITION = { 2025: FEDERAL_HOLIDAYS };

const knownEdition = edition => { if (!BY_EDITION[edition]) throw new Error(`no catalog for edition ${edition}`); };
const knownReturnType = returnType => { if (!RETURN_TYPES.includes(returnType)) throw new Error(`unknown return type ${returnType}`); };

const cache = new Map();
export function catalogFor(returnType, edition) {
  knownEdition(edition);
  knownReturnType(returnType);
  const key = `${returnType}:${edition}`;
  if (!cache.has(key)) {
    const lines = BY_EDITION[edition][returnType];
    const problems = validateCatalog(lines);
    if (problems.length) throw new Error(`catalog ${key} is unsound: ${problems.join('; ')}`);
    cache.set(key, { edition, returnType, lines, byId: new Map(lines.map(l => [l.id, l])),
      slots: lines.filter(l => l.kind === 'input' || l.kind === 'statement' || l.kind === 'manual') });
  }
  return cache.get(key);
}
export const lineExists = (returnType, edition, id) => catalogFor(returnType, edition).byId.has(id);

// Applicability, filing manifest and deadlines (spec §6, §9.1, §10). The edition and the key are checked so a period bound to a
// year this folder does not know, or a misspelled return type, fails here and never with an empty answer: an empty manifest or
// deadline list reads as "nothing required" to a completeness check. Deadlines take any DEADLINES key (information_returns and
// disregarded included) and use the edition's own holiday tables.
export function applicability(returnType, edition, facts) { knownEdition(edition); knownReturnType(returnType); return applicabilityRules(returnType, facts); }
// The manifest RULES (each a condition, requiredness and supported/unsupported status), validated once: a rule naming an unknown fact or question
// throws here instead of reading as unknown forever. filingManifestFor evaluates them for a period's facts and answers (spec §6, §9.1).
const checkedManifests = new Set();
export function filingManifest(returnType, edition) {
  knownEdition(edition); knownReturnType(returnType);
  const entries = FILING_MANIFEST[returnType];
  if (!checkedManifests.has(returnType)) {
    const problems = validateManifest(returnType, entries, edition);
    if (problems.length) throw new Error(`filing manifest ${returnType}:${edition} is unsound: ${problems.join('; ')}`);
    checkedManifests.add(returnType);
  }
  return entries;
}
// A manifest's problems with its amount conditions checked against the return type's own catalog lines (an 'amount' condition naming a line the
// return does not have would read as unknown forever).
export function validateManifest(returnType, entries, edition = 2025) {
  knownEdition(edition); knownReturnType(returnType);
  return validateManifestRules(returnType, entries, { lineIds: new Set(catalogFor(returnType, edition).lines.map(l => l.id)) });
}
export function filingManifestFor(returnType, edition, facts = {}) { return evaluateManifest(returnType, filingManifest(returnType, edition), facts); }
export function deadlinesFor(returnType, edition, period) { knownEdition(edition); return deadlineDates(returnType, period, HOLIDAYS_BY_EDITION[edition]); }
