// lib/tax/engine/formulas.js
// The catalog formula graph (spec §5.4, §6) and the four sign facts (§5.1), pure and exact. A computed line names one formula over other
// lines: ['sum', ...ids], ['minus', a, b], ['sumMinus', [adds], [subs]]. Before anything is evaluated the graph is validated (the gate the
// T1 reviews set for T3): known operator, arity, operands that exist and carry amounts, operands measured as the line is (a balance line
// from balance lines, an activity line from activity lines), and no cycle. Values are BigInt cents or null (unknown): any unknown operand
// makes the result unknown with every reason carried, never zero.
// A value is keyed by its collection key (lib/tax/providers.js collectionKey): the field, its REQUIRED instance dimensions and the
// measurement. A computed line keeps its own instance dimensions (one result per instance) and sums its declared aggregates away.
import { parseSlotKey } from '../providers.js';

export const OPERATORS = ['sum', 'minus', 'sumMinus'];
const AMOUNT_TYPES = ['amount', 'statement', 'code'];
export const measurementsOf = line => (line.cls === 'balance' ? ['begin', 'end'] : ['activity']);

// The ids a formula names, or null when it is malformed.
export function operandsOf(f) {
  if (!Array.isArray(f) || !OPERATORS.includes(f[0])) return null;
  const ids = x => typeof x === 'string' && x.length > 0;
  if (f[0] === 'sum') return f.length >= 2 && f.slice(1).every(ids) ? f.slice(1) : null;
  if (f[0] === 'minus') return f.length === 3 && ids(f[1]) && ids(f[2]) ? [f[1], f[2]] : null;
  return f.length === 3 && Array.isArray(f[1]) && Array.isArray(f[2]) && f[1].length >= 1 && f[1].every(ids) && f[2].every(ids) ? [...f[1], ...f[2]] : null;
}
// Each operand's sign in the formula (+1 or -1); an id named twice adds its signs.
function signsOf(f) {
  const out = new Map(), add = (id, s) => out.set(id, (out.get(id) ?? 0) + s);
  if (f[0] === 'sum') f.slice(1).forEach(id => add(id, 1));
  else if (f[0] === 'minus') { add(f[1], 1); add(f[2], -1); }
  else { f[1].forEach(id => add(id, 1)); f[2].forEach(id => add(id, -1)); }
  return out;
}

// Every problem of a catalog's formula graph, as text; [] when it is sound.
export function formulaProblems(catalog) {
  const problems = [];
  const computed = catalog.lines.filter(l => l.kind === 'computed');
  for (const l of computed) {
    const ops = operandsOf(l.formula);
    if (!ops) { problems.push(`${l.id}: formula ${JSON.stringify(l.formula)} is not sum, minus or sumMinus with its operands`); continue; }
    if (!AMOUNT_TYPES.includes(l.type)) problems.push(`${l.id}: a computed line carries an amount, not ${l.type}`);
    for (const id of ops) {
      const o = catalog.byId.get(id);
      if (!o) { problems.push(`${l.id} names unknown line ${id}`); continue; }
      if (!AMOUNT_TYPES.includes(o.type)) problems.push(`${l.id}: operand ${id} is an answer (${o.type}), not an amount`);
      if (measurementsOf(o).join() !== measurementsOf(l).join()) problems.push(`${l.id} (${measurementsOf(l).join('/')}) adds ${id} (${measurementsOf(o).join('/')}): measured differently`);
    }
  }
  // Cycles: depth-first over computed operands.
  const state = new Map();
  const visit = (id, path) => {
    const l = catalog.byId.get(id);
    if (!l || l.kind !== 'computed' || !operandsOf(l.formula)) return;
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'open') { problems.push(`formula cycle: ${[...path, id].join(' -> ')}`); return; }
    state.set(id, 'open');
    for (const o of operandsOf(l.formula)) visit(o, [...path, id]);
    state.set(id, 'done');
  };
  for (const l of computed) visit(l.id, []);
  return problems;
}
// The computed lines in dependency order (operands first). Throws when the graph is unsound.
const orders = new WeakMap();
export function formulaOrder(catalog) {
  if (orders.has(catalog)) return orders.get(catalog);
  const problems = formulaProblems(catalog);
  if (problems.length) throw new Error(`catalog ${catalog.returnType}:${catalog.edition} formulas are unsound: ${problems.join('; ')}`);
  const out = [], seen = new Set();
  const visit = id => {
    if (seen.has(id)) return;
    seen.add(id);
    const l = catalog.byId.get(id);
    if (l.kind !== 'computed') return;
    for (const o of operandsOf(l.formula)) visit(o);
    out.push(l);
  };
  for (const l of catalog.lines) if (l.kind === 'computed') visit(l.id);
  orders.set(catalog, out);
  return out;
}

// The collection key of a value: field, kept dimensions (sorted), measurement.
export const valueKey = (fieldId, dims, measurement) => [fieldId, ...Object.keys(dims).sort().map(k => `${k}=${dims[k]}`), measurement].join('|');
const project = (dims, keep) => Object.fromEntries(Object.entries(dims).filter(([k]) => keep.includes(k)));

// Evaluate every computed line. values: Map collectionKey → { cents: bigint | null, reasons: [] } for the input collections (from the
// providers, after adjustments). Returns a new Map with the computed values added. An input collection with no entry has no members: it
// contributes nothing (its sources are complete and route nothing there) — the caller enters every collection that is unknown as null.
// taint: Map leaf value key → reasons — an input whose own amount is known but whose completeness is not (Codex t3-r2 R2-4: an unmapped
// account could still be routed there). The leaf keeps its amount; every computed line that depends on it, through any number of formulas,
// is unknown with those reasons — and nothing else is: a computed line none of whose operands is tainted (net income per books from the
// engine's measured input, a reviewed workpaper's total from its typed lines) keeps its value.
export function evaluate(catalog, values, taint = new Map()) {
  const out = new Map(values);
  const tainted = new Map(taint);
  const byField = new Map();
  const index = (key, v) => {
    const p = parseSlotKey(key);
    if (!byField.has(p.fieldId)) byField.set(p.fieldId, []);
    byField.get(p.fieldId).push({ key, dims: p.dims, measurement: p.measurement, v });
  };
  for (const [k, v] of out) index(k, v);
  for (const l of formulaOrder(catalog)) {
    const signs = signsOf(l.formula), keep = l.instanceDims;
    for (const m of measurementsOf(l)) {
      // The instances of the result: every projection onto the kept dimensions of an operand value (none kept: one instance).
      const instances = new Map();
      if (!keep.length) instances.set('[]', {});
      for (const id of signs.keys()) for (const e of byField.get(id) ?? []) {
        if (e.measurement !== m) continue;
        const d = project(e.dims, keep);
        if (Object.keys(d).length === keep.length) instances.set(JSON.stringify(Object.entries(d).sort()), d);
      }
      for (const d of instances.values()) {
        let cents = 0n, unknown = false, dependsOnTaint = false;
        const reasons = [];
        for (const [id, sign] of signs) for (const e of byField.get(id) ?? []) {
          if (e.measurement !== m || keep.some(k => e.dims[k] !== d[k])) continue;
          const t = tainted.get(e.key);
          if (t) { dependsOnTaint = true; reasons.push(...t); }
          if (e.v.cents === null) { unknown = true; reasons.push(...(e.v.reasons ?? [])); continue; }
          cents += BigInt(sign) * e.v.cents;
        }
        const v = unknown || dependsOnTaint ? { cents: null, reasons: [...new Set(reasons)] } : { cents, reasons: [] };
        const key = valueKey(l.id, d, m);
        if (dependsOnTaint) tainted.set(key, [...new Set(reasons)]);
        out.set(key, v);
        index(key, v);
      }
    }
  }
  return out;
}

// How much one input field moves a computed endpoint: the coefficient (an integer, usually +1, -1 or 0) of field in target's formula,
// through every computed line in between. The M-1 bridge (spec §5.5) uses it to say what each book amount does to the return's income.
export function coefficient(catalog, target, field, memo = new Map()) {
  const key = `${target}\u0000${field}`;
  if (memo.has(key)) return memo.get(key);
  const l = catalog.byId.get(target);
  let c = 0;
  if (target === field) c = 1;
  else if (l && l.kind === 'computed') for (const [id, s] of signsOf(l.formula)) c += s * coefficient(catalog, id, field, memo);
  memo.set(key, c);
  return c;
}

// The four sign facts (spec §5.1). ledger_polarity says which side the source balance normally sits on; a line marked 'either' reads as an
// income line (credit) unless it is a deduction. The stored semantic amount is the ledger amount on that side: a credit-normal line (income,
// a liability, a contra asset such as accumulated depreciation) stores minus the signed ledger cents (debits positive); a debit-normal line
// (a deduction, an asset, returns and allowances) stores them as they are. A reversed balance therefore stays negative — never abs().
export const polarityOf = line => (line.ledgerPolarity === 'either' ? (line.cls === 'deduction' ? 'debit' : 'credit') : line.ledgerPolarity);
export const semanticOf = (line, ledgerCents) => (polarityOf(line) === 'debit' ? ledgerCents : -ledgerCents);
