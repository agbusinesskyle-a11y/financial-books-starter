// lib/tax/engine/compare.js
// A computed return beside a filed one (spec §12 golden returns; the T3 stage-close comparison and the T5 printing slice's side-by-side),
// pure. Each baseline fact is matched by its COMPLETE identity — field, measurement and every key (activity, owner interest, statement row,
// party, loan, asset) — at the grain it declares:
//   - an activity or owner key is resolved through the explicit map the caller gives (resolve.activity / resolve.interest: baseline key →
//     'act:<id>' / 'i:<id>'); an unmapped key, or a key the line does not take, is 'unmatched' — never compared with something else;
//   - statement-row facts: a line whose filed total is in the baseline is compared at its total and its rows are 'not_compared'; a line
//     filed only as rows is compared as one explicit aggregate (grain 'rows_total', every row known) — never row against total;
//   - a party, loan or asset key is a grain T3 does not compute: 'not_compared';
//   - a fact whose computed field is absent or unresolved is 'not_computed' — a missing result is never zero; only a known zero the engine
//     emitted compares as zero.
// Filed returns are in whole dollars, so each difference is also judged after rounding the computed cents to dollars (half away from zero,
// as the form rounds). The baseline must be the return's own form and period (checkBaseline). The figures never leave the caller (the CLI
// writes them to a path outside the repository).
import { resolve, relative, isAbsolute, sep, dirname } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { catalogFor } from '../catalog/index.js';

const KINDS = ['form_line', 'schedule_l_end'];
export const dollarsRounded = c => { const neg = c < 0n, a = neg ? -c : c, r = (a + 50n) / 100n * 100n; return neg ? -r : r; };
// The baseline has to be the filed return of this return's form and period; anything else is refused before a row is compared.
export function checkBaseline(ret, baseline) {
  if (baseline.return_type !== ret.return_type) throw new Error(`The baseline is a ${baseline.return_type} return, this period is ${ret.return_type}.`);
  if (String(baseline.source_period_start) !== String(ret.period_start) || String(baseline.source_period_end) !== String(ret.period_end)) {
    throw new Error(`The baseline is for ${baseline.source_period_start} – ${baseline.source_period_end}, this period is ${ret.period_start} – ${ret.period_end}.`);
  }
}
const statusOf = (computed, filed) => (filed === null ? 'unknown_filed' : computed === null ? 'not_computed' : computed === filed ? 'same' : dollarsRounded(computed) === filed ? 'rounding' : 'differs');
// results: resultsJson(...) of a computed return; facts: baseline_fact rows ({ fact_kind, field_id, measurement, state, amount_cents,
// activity_key, interest_key, party_key, loan_key, asset_key, row_key }); resolve: { activity: { key: 'act:<id>' }, interest: { key: 'i:<id>' } }.
// → { rows: [{ key, fieldId, measurement, grain, computed, filed, difference, status, reasons }], counts }
export function compareWithBaseline(results, facts, { resolve: map = {}, returnType = results.return?.returnType, edition = results.return?.edition } = {}) {
  const fields = new Map(results.fields.map(f => [f.key, f]));
  const catalog = returnType && edition ? catalogFor(returnType, edition) : null;
  const rows = [];
  const push = (key, f, grain, filed, extra = {}) => {
    const mine = key ? fields.get(key) : null, computed = mine && mine.cents !== null ? BigInt(mine.cents) : null;
    const status = extra.status ?? statusOf(computed, filed);
    rows.push({ key, fieldId: f.field_id, measurement: f.measurement, grain, computed: computed === null ? null : computed.toString(), filed: filed === null ? null : filed.toString(),
      difference: computed !== null && filed !== null && !extra.status ? (computed - filed).toString() : null, status, reasons: extra.reasons ?? mine?.reasons ?? [] });
  };
  const usable = facts.filter(f => KINDS.includes(f.fact_kind) && f.field_id && !f.field_id.startsWith('hist.'));
  // Identity → computed key, or the reason it has none.
  const keyOf = f => {
    if (f.party_key || f.loan_key || f.asset_key) return { why: `kept per ${f.party_key ? 'party' : f.loan_key ? 'loan' : 'asset'}: not a grain this stage computes` };
    const line = catalog?.byId.get(f.field_id);
    const dims = {};
    for (const [dim, k] of [['activity', f.activity_key], ['interest', f.interest_key]]) {
      if (!k) continue;
      const to = map[dim]?.[k];
      if (!to) return { unmatched: `its ${dim} (${k}) is not resolved to one of this return’s ${dim === 'activity' ? 'activities' : 'owner interests'}` };
      dims[dim] = to;
    }
    if (line) {
      const need = line.instanceDims.filter(d => d !== 'code');
      if (need.some(d => !dims[d])) return { why: `the line is kept per ${need.join(' and ')}; the filed amount is a total` };
      if (Object.keys(dims).some(d => !need.includes(d))) return { unmatched: `the line is not kept per ${Object.keys(dims).join(' and ')}` };
    }
    return { key: [f.field_id, ...Object.keys(dims).sort().map(d => `${d}=${dims[d]}`), f.measurement].join('|') };
  };
  const groups = new Map();
  for (const f of usable) {
    const id = keyOf(f);
    const filed = f.state === 'known' ? BigInt(f.amount_cents) : null;
    if (id.why) { push(null, f, 'other', filed, { status: 'not_compared', reasons: [id.why] }); continue; }
    if (id.unmatched) { push(null, f, 'other', filed, { status: 'unmatched', reasons: [id.unmatched] }); continue; }
    if (!groups.has(id.key)) groups.set(id.key, { total: null, rows: [] });
    const g = groups.get(id.key);
    if (f.row_key === null || f.row_key === undefined) g.total = f; else g.rows.push(f);
  }
  for (const [key, g] of groups) {
    if (g.total) {
      push(key, g.total, 'total', g.total.state === 'known' ? BigInt(g.total.amount_cents) : null);
      for (const f of g.rows) push(null, f, 'row', f.state === 'known' ? BigInt(f.amount_cents) : null, { status: 'not_compared', reasons: ['The filed line total is compared; its rows are not compared one by one.'] });
    } else {
      const known = g.rows.every(f => f.state === 'known');
      push(key, g.rows[0], 'rows_total', known ? g.rows.reduce((t, f) => t + BigInt(f.amount_cents), 0n) : null);
      rows.at(-1).rowCount = g.rows.length;
    }
  }
  rows.sort((a, b) => ((a.key ?? `~${a.fieldId}`) < (b.key ?? `~${b.fieldId}`) ? -1 : 1));
  const counts = { same: 0, rounding: 0, differs: 0, not_computed: 0, unknown_filed: 0, unmatched: 0, not_compared: 0 };
  for (const r of rows) counts[r.status] += 1;
  return { rows, counts };
}
// Whether a path lies outside a directory (the repository): a comparison of real figures is never written inside it. Both are resolved
// to real paths (a link into the repository is inside it) — the path's nearest existing ancestor when it does not exist yet — and compared
// by path segments: '..comparison.json' is a file name inside, '../x' is outside.
const real = p => {
  const abs = resolve(p);
  let at = abs;
  while (!existsSync(at)) { const up = dirname(at); if (up === at) return abs; at = up; }
  return resolve(realpathSync.native(at), relative(at, abs));
};
export const outsideOf = (dir, path) => {
  const rel = relative(real(dir), real(path));
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
};
