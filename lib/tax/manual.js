// lib/tax/manual.js
// The manual provider (spec §4.7 tax_manual_item, §0 rule 2): typed amounts for the lines the books never supply (depreciation before the
// asset register, Form 4797 gains, credits, AMT items) and for any slot a reviewed T1 assignment gave the manual provider. Each needed item
// is entered (a semantic amount — spec §5.1 — or named statement rows), marked not applicable by a person, or unresolved: no row is
// unresolved, never zero. Which items a return needs is derived from the catalog: every manual line the T3 schedules (page 1, Schedule K,
// Schedule L, M-1, Form 1125-A, the Analysis of Net Income) read, directly or through a formula, one per instance (a rental property's
// depreciation per Form 8825 property). Engine lines (net income per books, the M-1 classes, the T4 workpapers) are never typed.
// One more item is an answer, not a line: 'answer:k1_inflows' — whether this return receives K-1s. T3 takes only "none" (not applicable);
// a return that receives K-1s waits for stage T4's K-1 records.
// The classified components of another line (T2 Contracts 6, lib/tax/destinations.js SUBSET_LINES: qualified dividends within ordinary
// dividends, the investment-income part of other income) are typed items too — the books cannot bind them, and a missing one is never zero:
// the engine reads it as unresolved while its parent has an amount, zero when the parent is a known zero, and refuses an entered amount
// beyond the parent (lib/tax/engine/compute.js). They are subsets: no formula adds them to income a second time.
import { withTransaction } from '../db.js';
import { ValidationError } from '../data/writes.js';
import { catalogFor } from './catalog/index.js';
import { parseSlotKey, listAssignments } from './providers.js';
import { parseCentsBig } from './partition.js';
import { operandsOf } from './engine/formulas.js';
import { effectiveIn, SUBSET_LINES } from './destinations.js';
import { openTaxReturn, personOf, checkSlotScope, slotScopeProblem, MAX_STATEMENT_ROWS } from './open-return.js';

const fail = message => { throw new ValidationError(message); };
export const K1_ANSWER = 'answer:k1_inflows';
export { MAX_STATEMENT_ROWS };
// Lines the engine fills (never typed): net income per books, the M-1 bridge, and the T4 workpapers (guaranteed payments, self-employment,
// capital) — those stay unresolved until their stage.
export const isEngineLine = id => /^(books|bridge)\./.test(id) || /^(gp|se|cap)\.wp\./.test(id) || /^f(1065|1120s)\.m1\./.test(id);
// The sections the T3 result types cover.
export const T3_SECTIONS = { form_1065: ['f1065.p1.', 'f1065.k.', 'f1065.L.', 'f1065.m1.', 'f1065.anal.', 'f1125a.main.'], form_1120s: ['f1120s.p1.', 'f1120s.k.', 'f1120s.L.', 'f1120s.m1.', 'f1125a.main.'] };
// Every line the T3 schedules read: their own lines and every operand of their formulas, transitively.
export function t3Lines(catalog) {
  const seen = new Set(), stack = catalog.lines.filter(l => T3_SECTIONS[catalog.returnType].some(p => l.id.startsWith(p))).map(l => l.id);
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const l = catalog.byId.get(id);
    if (l?.kind === 'computed') stack.push(...operandsOf(l.formula));
  }
  return seen;
}
const ACTIVITY_SCHEDULE = { 'f8825.main': 'f8825' };

// The manual items one return needs: [{ key, line, activity?, subsetOf? }] — the manual lines the T3 schedules read (instances expanded),
// the subset classifications, the slots T1 assigned to the manual provider, and the K-1 answer.
export async function manualNeeds(db, { orgId, ret }) {
  const catalog = catalogFor(ret.return_type, Number(ret.form_edition));
  const reach = t3Lines(catalog);
  const { rows: acts } = await db.query('SELECT activity_id, name, schedule, effective_from::text AS effective_from, effective_to::text AS effective_to, disposed_on::text AS disposed_on FROM tax_activity WHERE org_id = $1 AND return_entity_id = $2 ORDER BY activity_id',
    [orgId, ret.entity_id]);
  const needs = [];
  for (const id of [...reach].sort()) {
    const l = catalog.byId.get(id);
    if (!l || l.kind !== 'manual' || isEngineLine(id) || !['amount', 'statement'].includes(l.type)) continue;
    if (!l.instanceDims.length) { needs.push({ key: `${id}|activity`, line: l }); continue; }
    if (l.instanceDims.join() !== 'activity') continue;
    const schedule = ACTIVITY_SCHEDULE[id.split('.').slice(0, 2).join('.')];
    for (const a of acts) if ((!schedule || a.schedule === schedule) && effectiveIn(a, ret)) needs.push({ key: `${id}|activity=act:${a.activity_id}|activity`, line: l, activity: a.name });
  }
  for (const [subset, parent] of Object.entries(SUBSET_LINES)) {
    const l = catalog.byId.get(subset);
    if (l && reach.has(subset) && !needs.some(n => n.key === `${subset}|activity`)) needs.push({ key: `${subset}|activity`, line: l, subsetOf: `${parent}|activity`, parentLabel: catalog.byId.get(parent)?.label ?? parent });
  }
  const assigned = (await listAssignments(db, { orgId, entityId: ret.entity_id, returnId: ret.return_id })).filter(a => a.provider_kind === 'manual');
  for (const a of assigned) if (!needs.some(n => n.key === a.slot_key)) {
    const p = parseSlotKey(a.slot_key);
    // An engine line is never typed, whatever a T1 assignment says (the engine's own amount stands).
    if (isEngineLine(p.fieldId) || !catalog.byId.get(p.fieldId)) continue;
    needs.push({ key: a.slot_key, line: catalog.byId.get(p.fieldId), assigned: true });
  }
  needs.push({ key: K1_ANSWER, line: null });
  return needs;
}
export async function listManualItems(db, { orgId, returnId }) {
  const { rows } = await db.query(`SELECT item_id, item_key, status, amount_cents::text AS amount_cents, rows, detail, workpaper, entered_by, reviewed_by, updated_at FROM tax_manual_item
     WHERE org_id = $1 AND return_id = $2 ORDER BY item_key`, [orgId, returnId]);
  return rows.map(r => ({ ...r, item_id: Number(r.item_id), amount: r.amount_cents === null ? null : BigInt(r.amount_cents),
    rows: r.rows ? r.rows.map(x => ({ label: x.label, cents: BigInt(x.cents) })) : null }));
}

// Enter one item (status 'entered' with amount or rows) or mark it not applicable. amount: typed dollars in the line's semantic sign (a
// deduction or a gain positive, a loss negative); rows: [{ label, amount }] for a statement line.
// workpaper: the item's support. Left out (undefined), a save keeps the support already stored — editing an amount never erases it; given,
// it replaces it, and '' clears it: clearing is always an explicit choice (Codex t3-plan-r3 R3-6).
export async function saveManualItem(pool, { orgId, entityId, returnId, itemKey, status, amount = null, rows = null, workpaper = undefined, enteredBy }) {
  if (!['entered', 'not_applicable'].includes(status)) fail('Enter the amount or mark the item not applicable.');
  const who = personOf(enteredBy);
  return withTransaction(pool, async tx => {
    const ret = await openTaxReturn(tx, { orgId, entityId, returnId });
    const need = (await manualNeeds(tx, { orgId, ret })).find(n => n.key === itemKey) ?? fail('That is not a typed item of this return.');
    let cents = null, list = null;
    if (need.key === K1_ANSWER) {
      if (status !== 'not_applicable') fail('A return that receives K-1s waits for the K-1 records (stage T4): only "receives none" can be recorded now.');
      const { rows: [held] } = await tx.query(`SELECT count(*)::int AS n FROM ownership_interest o JOIN tax_party p ON p.org_id = o.org_id AND p.party_id = o.party_id
         WHERE o.org_id = $1 AND p.kind = 'entity_in_org' AND p.entity_id = $2 AND o.effective_from <= $4::date AND (o.effective_to IS NULL OR o.effective_to >= $3::date)`,
      [orgId, ret.entity_id, ret.period_start, ret.period_end]);
      if (held.n) fail('This company holds an interest in another of our companies for this period, so it receives a K-1: that waits for stage T4.');
    } else {
      // Every dimension of the slot this return's (lib/tax/open-return.js): an assigned slot naming another company's owner, a nonexistent
      // or out-of-period activity is refused, whatever the assignment says.
      await checkSlotScope(tx, { orgId, ret, key: need.key });
      if (status === 'entered') {
        if (need.line.type === 'statement') {
          const typed = (rows ?? []).filter(x => String(x?.label ?? '').trim() || String(x?.amount ?? '').trim());
          if (!typed.length) fail('Enter at least one named row.');
          if (typed.length > MAX_STATEMENT_ROWS) fail(`A statement holds at most ${MAX_STATEMENT_ROWS} rows; this one has ${typed.length}.`);
          list = typed.map((x, i) => { const c = parseCentsBig(x.amount); if (c === null || !String(x.label ?? '').trim()) fail(`Row ${i + 1}: give it a name and an amount.`); return { label: String(x.label).trim().slice(0, 200), cents: c.toString() }; });
          if (new Set(list.map(x => x.label)).size !== list.length) fail('Each row has its own name.');
        } else {
          cents = parseCentsBig(amount);
          if (cents === null) fail('Enter an amount like 1250.00 (0.00 is an entered zero; "not applicable" says the line does not apply).');
          if (cents > 9223372036854775807n || cents < -9223372036854775808n) fail('That amount is too large to store.');
        }
      }
    }
    await tx.query(`INSERT INTO tax_manual_item (org_id, return_id, item_key, status, amount_cents, rows, workpaper, entered_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (org_id, return_id, item_key) DO UPDATE SET status = EXCLUDED.status, amount_cents = EXCLUDED.amount_cents, rows = EXCLUDED.rows,
        workpaper = CASE WHEN $9 THEN EXCLUDED.workpaper ELSE tax_manual_item.workpaper END, entered_by = EXCLUDED.entered_by, reviewed_by = NULL, updated_at = now()`,
    [orgId, ret.return_id, need.key, status, cents === null ? null : cents.toString(), list ? JSON.stringify(list) : null, String(workpaper ?? '').trim().slice(0, 2000) || null, who,
      workpaper !== undefined]);
  });
}
// Mark every item shown on the page and still unanswered as not applicable (one person's explicit act; the keys are what the page showed).
export async function markRemainingNotApplicable(pool, { orgId, entityId, returnId, keys, enteredBy }) {
  const who = personOf(enteredBy);
  return withTransaction(pool, async tx => {
    const ret = await openTaxReturn(tx, { orgId, entityId, returnId });
    const needs = new Set((await manualNeeds(tx, { orgId, ret })).map(n => n.key));
    const have = new Set((await listManualItems(tx, { orgId, returnId: ret.return_id })).map(i => i.item_key));
    let n = 0;
    for (const k of new Set(keys ?? [])) {
      if (!needs.has(k) || have.has(k) || k === K1_ANSWER) continue;
      if ((await slotScopeProblem(tx, { orgId, ret, key: k })).problem) continue; // a slot naming a reference not this return's is never answered
      await tx.query('INSERT INTO tax_manual_item (org_id, return_id, item_key, status, entered_by) VALUES ($1,$2,$3,$4,$5)', [orgId, ret.return_id, k, 'not_applicable', who]);
      n += 1;
    }
    return n;
  });
}
export async function clearManualItem(pool, { orgId, entityId, returnId, itemKey }) {
  return withTransaction(pool, async tx => {
    const ret = await openTaxReturn(tx, { orgId, entityId, returnId });
    const { rowCount } = await tx.query('DELETE FROM tax_manual_item WHERE org_id = $1 AND return_id = $2 AND item_key = $3', [orgId, ret.return_id, String(itemKey ?? '')]);
    if (!rowCount) fail('Nothing was entered there.');
  });
}
