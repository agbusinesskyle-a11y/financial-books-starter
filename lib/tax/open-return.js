// lib/tax/open-return.js
// The one way a Tax Books T3 write opens its period (spec §4.6 "revalidated under the company lock", T2 Contracts 5): the organization's
// inclusion-graph lock first (the order every Tax Books write keeps), then the return's company, then the period row itself; refused unless
// the period is an open Form 1065 or Form 1120-S period of that company. Ledger writes lock their own company, so what a decision is checked
// against here cannot change until the transaction ends. And the one scope check of a slot key a T3 write names (slotScopeProblem).
import { ValidationError, lockEntity } from '../data/writes.js';
import { lockTaxGraph } from './bindings.js';
import { canonicalSlotKey, checkSlot, parseSlotKey } from './providers.js';
import { effectiveIn, activityFits } from './destinations.js';
import { T2_RESOLVERS, normalizeAnswer } from './references.js';

const fail = message => { throw new ValidationError(message); };
export const T3_RETURN_TYPES = ['form_1065', 'form_1120s'];
// The most rows one typed statement (or a reviewed COGS workpaper's other costs) holds: the page, the form parser and the save all refuse
// more, never truncate (Codex t3-plan-r2 R2-9).
export const MAX_STATEMENT_ROWS = 100;
// A positive safe-integer id from a form or a caller, or a refusal.
export const idOf = (v, what = 'One of the choices') => {
  const n = Number(v);
  return /^\d{1,16}$/.test(String(v ?? '')) && Number.isSafeInteger(n) && n > 0 ? n : fail(`${what} isn’t valid. Reload the page and try again.`);
};
// The person's name for a record: trimmed, required, at most 200 characters.
export const personOf = v => { const s = String(v ?? '').trim().slice(0, 200); return s || fail('Say who decided this.'); };

export async function openTaxReturn(tx, { orgId, entityId, returnId }) {
  await lockTaxGraph(tx, orgId);
  await lockEntity(tx, orgId, entityId);
  const { rows: [r] } = await tx.query(`SELECT return_id, entity_id, status, return_type, form_edition, period_start::text AS period_start, period_end::text AS period_end, tax_method, book_basis
    FROM tax_return WHERE org_id = $1 AND entity_id = $2 AND return_id = $3 FOR UPDATE`, [orgId, entityId, idOf(returnId, 'The period')]);
  if (!r) fail('Period not found.');
  if (r.status !== 'open') fail(`This period is ${r.status}: its workpapers no longer change.`);
  if (!T3_RETURN_TYPES.includes(r.return_type)) fail('Tax Books computes Form 1065 and Form 1120-S returns in this stage.');
  return { ...r, return_id: Number(r.return_id), entity_id: Number(r.entity_id), form_edition: Number(r.form_edition) };
}

// The scope of a slot key a T3 write names — a timing review's destination, an adjustment line (Codex t3-plan-r1 B9): canonical, a
// non-computed slot of the period's catalog, and every dimension a reference THIS return may name — an activity of the return's company in
// effect in the period and reported on that form; an owner interest in the return's company that the period's resolver selects (the one
// interest of that owner covering the whole period, T2's lib/tax/references.js); a code the line lists. A K-1 source (stage T4), a fixed
// asset (stage T7) and the T4 placeholder interest are refused. Every query is scoped to the organization and the return's company, so a
// foreign, nonexistent or out-of-period id is refused alike. The engine runs the same check on every saved input it reads, so a reference
// that changed after the save (an activity moved out of the period, an interest ended) leaves that input unresolved.
// → { line, problem } — problem null when the key is sound.
export async function slotScopeProblem(db, { orgId, ret, key }) {
  let p, line;
  try { canonicalSlotKey(key); p = parseSlotKey(key); line = checkSlot(p, ret.return_type, Number(ret.form_edition)); } catch (e) { return { line: null, problem: `Not a line of this return: ${e.message}` }; }
  for (const [dim, value] of Object.entries(p.dims)) {
    if (dim === 'code') continue;
    if (dim === 'activity') {
      const m = /^act:(\d{1,16})$/.exec(value);
      const { rows: [a] } = m ? await db.query(`SELECT activity_id, name, schedule, effective_from::text AS effective_from, effective_to::text AS effective_to, disposed_on::text AS disposed_on
          FROM tax_activity WHERE org_id = $1 AND activity_id = $2 AND return_entity_id = $3`, [orgId, m[1], ret.entity_id]) : { rows: [] };
      if (!a) return { line, problem: `${line.label}: ${value} is not an activity of this company.` };
      if (!effectiveIn(a, ret)) return { line, problem: `${line.label}: ${a.name} is not in effect in this period.` };
      if (!activityFits(line, a)) return { line, problem: `${line.label}: ${a.name} is not reported on this form.` };
    } else if (dim === 'interest') {
      if (value === 'i:t4') return { line, problem: `${line.label}: amounts kept per owner are computed with the owners’ records in stage T4.` };
      const m = /^i:(\d{1,16})$/.exec(value);
      const { rows: [o] } = m ? await db.query('SELECT interest_id, party_id FROM ownership_interest WHERE org_id = $1 AND interest_id = $2 AND entity_id = $3', [orgId, m[1], ret.entity_id]) : { rows: [] };
      if (!o) return { line, problem: `${line.label}: ${value} is not an owner’s interest in this company.` };
      const now = normalizeAnswer('interest', await T2_RESOLVERS.interest({ db, orgId, issuerEntityId: ret.entity_id, partyId: o.party_id, periodStart: ret.period_start, periodEnd: ret.period_end }));
      if (now.id !== Number(o.interest_id)) return { line, problem: `${line.label}: ${now.pending?.reason ?? 'that interest is not the one in effect for this owner in this period.'}` };
    } else {
      return { line, problem: `${line.label}: ${dim === 'k1_source' ? 'a K-1 source (stage T4)' : dim === 'asset' ? 'a fixed asset (stage T7)' : `the dimension ${dim}`} is not named by a reviewed amount in this stage.` };
    }
  }
  return { line, problem: null };
}
export async function checkSlotScope(db, args) {
  const r = await slotScopeProblem(db, args);
  if (r.problem) fail(r.problem);
  return r.line;
}
