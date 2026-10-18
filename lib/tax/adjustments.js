// lib/tax/adjustments.js
// Adjustments and proposals (spec §4.6, §5.5): a tax change to a destination slot, always a DELTA in the destination's semantic sign (spec
// §5.1: a deduction positive, so a nondeductible half of a deduction is a negative delta on it) with the M-1 class that explains it on the
// bridge. Computed totals and engine lines are never destinations; a reclass moves an amount between lines and nets to zero on the return's
// income; no class balances to a target — every person's adjustment states its support (evidence).
//   proposals   rule proposals computed from the current amounts (lib/tax/engine/compute.js), each moving the nondeductible part to
//               Schedule K's nondeductible-expense line (1065 line 18c, 1120-S line 16c): an account named for meals only at 50 percent
//               (M-1 line 4b); one named for entertainment only at 100 percent (entertainment is not deductible; line 4b); one named for
//               both at 100 percent, saying so — accepting treats the whole account as entertainment, rejecting it says the person enters
//               the split as an adjustment (no meals fraction is ever read from a name); fines and penalties at 100 percent (line 4c).
//               A proposal is answered by a person: accepted (its lines apply) or rejected with a reason. The answer is tied
//               to the version it was shown at (the amount and the mapping behind it): when either changes, the answer is stale, not applied,
//               and the proposal waits again — an unanswered proposal leaves its line unresolved (never silently applied or ignored).
//   person      entered with its support and accepted by the person entering it; withdrawn later with a reason (never edited).
// Answers and entries are revalidated under the graph and company locks against the proposal recomputed in the same transaction.
import { createHash } from 'node:crypto';
import { withTransaction } from '../db.js';
import { ValidationError } from '../data/writes.js';
import { catalogFor } from './catalog/index.js';
import { parseSlotKey } from './providers.js';
import { parseCentsBig } from './partition.js';
import { coefficient } from './engine/formulas.js';
import { isEngineLine } from './manual.js';
import { openTaxReturn, idOf, personOf, checkSlotScope } from './open-return.js';

const fail = message => { throw new ValidationError(message); };
const md5 = text => createHash('md5').update(text).digest('hex');
export const PURPOSES = [['meals_50', 'Meals and entertainment (50% limit)'], ['penalties', 'Fines and penalties'], ['officer_life', 'Officer life insurance'], ['tax_exempt_interest', 'Tax-exempt interest'],
  ['method_timing', 'Method or timing difference'], ['book_tax_depreciation', 'Book and tax depreciation'], ['reclass', 'Reclassification between lines'], ['other', 'Other']];
export const M1_CLASSES = [['meals_50', 'Meals and entertainment limit'], ['nondeductible', 'Nondeductible expense'], ['tax_exempt', 'Tax-exempt income'], ['method_timing', 'Method or timing'],
  ['book_tax_depreciation', 'Depreciation, book vs tax'], ['book_tax_gain', 'Gain or loss, book vs tax'], ['inventory', 'Inventory, book vs tax'], ['reclass', 'Reclassification (not an M-1 difference)'], ['other', 'Other']];
// The income reconciliation each return type's M-1 ends at (spec §5.5), and its nondeductible-expense line.
export const ENDPOINT = { form_1065: 'f1065.anal.1', form_1120s: 'f1120s.k.18' };
export const NONDEDUCTIBLE = { form_1065: 'f1065.k.18c', form_1120s: 'f1120s.k.16c' };
// Tax-exempt interest and other tax-exempt income are different M-1 lines (6a / 5a and the other-income statement): one tax_exempt group
// moves book income to one of them, never both (Codex t3-plan-r3 R3-5) — the offset of a mixed group could not say how much is interest.
export const EXEMPT = { form_1065: { interest: 'f1065.k.18a', other: 'f1065.k.18b' }, form_1120s: { interest: 'f1120s.k.16a', other: 'f1120s.k.16b' } };
export function mixedExemptGroup(returnType, lines) {
  const e = EXEMPT[returnType], ids = lines.map(l => parseSlotKey(l.slotKey).fieldId);
  return lines.some(l => l.m1Class === 'tax_exempt') && ids.includes(e.interest) && ids.includes(e.other);
}
const MEALS = /\bmeals?\b/i, ENTERTAINMENT = /\bentertain(ment|ing)?\b/i;
// The first rule an account name matches proposes; the 50 percent rule takes an account named for meals ONLY.
export const RULES = [
  { id: 'meals_and_entertainment@1', purpose: 'meals_50', test: n => MEALS.test(n) && ENTERTAINMENT.test(n), num: 1n, den: 1n, cls: 'meals_50',
    why: 'Meals and entertainment are booked together: entertainment is not deductible, meals half. Accept to treat the whole account as entertainment, or reject this and enter the meals part (half deductible) as your own adjustment.' },
  { id: 'entertainment@1', purpose: 'meals_50', test: n => ENTERTAINMENT.test(n), num: 1n, den: 1n, cls: 'meals_50', why: 'Entertainment is not deductible.' },
  { id: 'meals@1', purpose: 'meals_50', test: n => MEALS.test(n), num: 1n, den: 2n, cls: 'meals_50', why: 'Meals are 50 percent deductible.' },
  { id: 'penalties@1', purpose: 'penalties', test: n => /\b(penalt(y|ies)|fines?)\b/i.test(n), num: 1n, den: 1n, cls: 'nondeductible', why: 'Fines and penalties paid to a government are not deductible.' },
];

// A slot an adjustment may change: canonical, a non-computed slot of the period's catalog with every dimension this return's
// (lib/tax/open-return.js slotScopeProblem: an activity, an owner interest), not an engine line.
export async function checkAdjustmentSlot(db, { orgId, ret, key }) {
  const line = await checkSlotScope(db, { orgId, ret, key });
  if (isEngineLine(line.id)) fail(`${line.label} is computed by the engine from its sources: adjust the line the difference comes from instead.`);
  if (!['amount', 'statement'].includes(line.type)) fail(`${line.label} is an answer, not an amount.`);
  return line;
}

// The proposals of one computed return. members: [{ slotKey, accountId, accountName, cents (the tax amount the slot takes from the account, semantic),
// version }] of deduction slots. → [{ key, purpose, cls, why, accountName, version, lines: [{ slotKey, cents, m1Class }] }]
export function proposalsFor(ret, members) {
  const out = [];
  const catalog = catalogFor(ret.return_type, Number(ret.form_edition));
  for (const m of members) {
    const line = catalog.byId.get(parseSlotKey(m.slotKey).fieldId);
    if (!line || line.cls !== 'deduction' || m.cents === null || m.cents <= 0n) continue;
    for (const r of RULES) {
      if (!r.test(m.accountName)) continue;
      const part = (m.cents * r.num) / r.den;
      if (!part) continue;
      const key = `${r.purpose}:${m.accountId}:${m.slotKey}`;
      const lines = [{ slotKey: m.slotKey, cents: -part, m1Class: r.cls }, { slotKey: `${NONDEDUCTIBLE[ret.return_type]}|activity`, cents: part, m1Class: r.cls }];
      // The version is the whole decision shown (Codex t3-plan-r2 R2-5): the account as named, the rule and its explanation, the eligible
      // basis with what it was computed from, and the proposed lines — renaming Meals to Entertainment, or a changed rule or basis, is a
      // new proposal, and an old answer or an old page is stale.
      const version = md5(JSON.stringify([m.version, m.cents.toString(), m.accountId, m.accountName, r.id, r.why, lines.map(l => [l.slotKey, l.cents.toString(), l.m1Class])]));
      out.push({ key, rule: r.id, purpose: r.purpose, cls: r.cls, why: r.why, accountName: m.accountName, slotKey: m.slotKey, base: m.cents, version, lines });
      break;
    }
  }
  return out;
}

// Stored adjustment groups with their lines.
export async function listAdjustments(db, { orgId, returnId }) {
  const { rows } = await db.query(`SELECT g.group_id, g.purpose, g.source, g.source_ref, g.source_version, g.memo, g.evidence, g.status, g.reason, g.decided_by, g.decided_at, g.superseded_at,
      coalesce(json_agg(json_build_object('slot_key', a.slot_key, 'cents', a.amount_cents::text, 'm1_class', a.m1_class) ORDER BY a.adjustment_id) FILTER (WHERE a.adjustment_id IS NOT NULL), '[]') AS lines
     FROM tax_adjustment_group g LEFT JOIN tax_adjustment a ON a.org_id = g.org_id AND a.group_id = g.group_id WHERE g.org_id = $1 AND g.return_id = $2 GROUP BY g.group_id ORDER BY g.group_id`, [orgId, returnId]);
  return rows.map(g => ({ ...g, group_id: Number(g.group_id), lines: g.lines.map(l => ({ slotKey: l.slot_key, cents: BigInt(l.cents), m1Class: l.m1_class })) }));
}
async function insertGroup(tx, { orgId, returnId, purpose, source, sourceRef = null, sourceVersion = null, memo, evidence = null, status, reason = null, decidedBy, lines }) {
  // A new answer to a logical proposal supersedes every earlier answer of its key (Codex t3-r3 R3-2): they stay as history, with their lines,
  // and decide nothing — whatever version they named, even when that version is computed again.
  if (source === 'proposal') await tx.query(`UPDATE tax_adjustment_group SET superseded_at = now() WHERE org_id = $1 AND return_id = $2 AND source = 'proposal' AND source_ref = $3 AND superseded_at IS NULL`, [orgId, returnId, sourceRef]);
  const { rows: [g] } = await tx.query(`INSERT INTO tax_adjustment_group (org_id, return_id, purpose, source, source_ref, source_version, memo, evidence, status, reason, decided_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING group_id`, [orgId, returnId, purpose, source, sourceRef, sourceVersion, memo, evidence, status, reason, decidedBy]);
  for (const l of lines) {
    await tx.query('INSERT INTO tax_adjustment (org_id, group_id, return_id, slot_key, amount_cents, m1_class) VALUES ($1,$2,$3,$4,$5,$6)', [orgId, g.group_id, returnId, l.slotKey, l.cents.toString(), l.m1Class]);
  }
  return Number(g.group_id);
}

// A person's adjustment: lines [{ slotKey, amount (typed dollars, semantic sign), m1Class }], with memo and evidence (its support).
export async function saveAdjustment(pool, { orgId, entityId, returnId, purpose, memo, evidence, lines, decidedBy }) {
  if (['k1_replacement', 'elimination'].includes(purpose)) fail('K-1 replacements and eliminations arrive with stage T4.');
  if (!PURPOSES.some(([p]) => p === purpose)) fail('Choose what the adjustment is for.');
  const note = String(memo ?? '').trim().slice(0, 500) || fail('Say what the adjustment does.');
  const support = String(evidence ?? '').trim().slice(0, 1000) || fail('Name the support for the adjustment (the workpaper, document or rule): an adjustment never balances to a target.');
  const who = personOf(decidedBy);
  const typed = (lines ?? []).filter(l => l && (String(l.slotKey ?? '').trim() || String(l.amount ?? '').trim()));
  if (!typed.length) fail('Enter at least one line.');
  return withTransaction(pool, async tx => {
    const ret = await openTaxReturn(tx, { orgId, entityId, returnId });
    const catalog = catalogFor(ret.return_type, Number(ret.form_edition));
    const out = [];
    for (const [i, l] of typed.entries()) {
      await checkAdjustmentSlot(tx, { orgId, ret, key: l.slotKey });
      const c = parseCentsBig(l.amount);
      if (c === null || c === 0n) fail(`Line ${i + 1}: enter a nonzero amount, like -250.00.`);
      if (!M1_CLASSES.some(([k]) => k === l.m1Class)) fail(`Line ${i + 1}: choose how the difference shows on Schedule M-1.`);
      if ((purpose === 'reclass') !== (l.m1Class === 'reclass')) fail('A reclassification group has only reclass lines, and only a reclassification uses that class.');
      out.push({ slotKey: l.slotKey, cents: c, m1Class: l.m1Class });
    }
    if (new Set(out.map(l => l.slotKey)).size !== out.length) fail('Each line appears once in a group.');
    if (mixedExemptGroup(ret.return_type, out)) fail('Tax-exempt interest and other tax-exempt income are separate adjustments: enter one group for each, so each offset lands on its own M-1 line.');
    if (purpose === 'reclass') {
      const net = out.reduce((s, l) => s + BigInt(coefficient(catalog, ENDPOINT[ret.return_type], parseSlotKey(l.slotKey).fieldId)) * l.cents, 0n);
      if (net !== 0n) fail(`A reclassification moves an amount between lines without changing the return’s income; these lines change it by ${net} cents.`);
    }
    return insertGroup(tx, { orgId, returnId: ret.return_id, purpose, source: 'person', memo: note, evidence: support, status: 'accepted', decidedBy: who, lines: out });
  });
}
// Withdraw a person's adjustment, or RETIRE an accepted proposal answer whose proposal is no longer computed (Codex t3-r1 B5, t3-r2 R2-3:
// the orphaned answer holds its lines until this explicit decision). Both become 'withdrawn' with the reason — a retirement is not a
// rejection of the source version: if the identical source returns, its proposal waits for a current answer, which the retired row never
// blocks (migration 066's one-answer index leaves retired rows out). Kept, never edited or deleted.
export async function withdrawAdjustment(pool, { orgId, entityId, returnId, groupId, reason, decidedBy }) {
  const why = String(reason ?? '').trim().slice(0, 500) || fail('Say why the adjustment is withdrawn.');
  personOf(decidedBy);
  return withTransaction(pool, async tx => {
    const ret = await openTaxReturn(tx, { orgId, entityId, returnId });
    const { rowCount } = await tx.query(`UPDATE tax_adjustment_group SET status = 'withdrawn', reason = $4
       WHERE org_id = $1 AND return_id = $2 AND group_id = $3 AND source IN ('person', 'proposal') AND status = 'accepted'`,
    [orgId, ret.return_id, idOf(groupId, 'The adjustment'), why]);
    if (!rowCount) fail('That adjustment is not an accepted adjustment of this period.');
  });
}
// Answer a proposal as it was shown (key and version). The return is computed again inside the transaction, under the locks; only a
// proposal with the same key AND version is answered. compute: lib/tax/engine/compute.js computeIn (passed in to avoid an import cycle).
export async function answerProposal(pool, { orgId, entityId, returnId, key, version, decision, reason = null, decidedBy, compute }) {
  if (!['accept', 'reject'].includes(decision)) fail('Accept or reject the proposal.');
  const who = personOf(decidedBy);
  const why = String(reason ?? '').trim().slice(0, 500);
  if (decision === 'reject' && !why) fail('Say why the proposal is rejected.');
  return withTransaction(pool, async tx => {
    const ret = await openTaxReturn(tx, { orgId, entityId, returnId });
    const result = await compute(tx, { orgId, entityId, returnId: ret.return_id });
    const p = (result.proposals ?? []).find(x => x.key === key) ?? fail('That proposal is not open on this return now. Reload the page.');
    if (p.version !== version) fail('The amount behind this proposal changed since the page was shown. Look at it again.');
    if (p.answer && p.answer.fresh) fail('This proposal is already answered.');
    return insertGroup(tx, { orgId, returnId: ret.return_id, purpose: p.purpose, source: 'proposal', sourceRef: p.key, sourceVersion: p.version, memo: `${p.why} (${p.accountName})`,
      evidence: `Rule proposal: ${p.purpose}`, status: decision === 'accept' ? 'accepted' : 'rejected', reason: decision === 'reject' ? why : null, decidedBy: who, lines: decision === 'accept' ? p.lines : [] });
  });
}
