// lib/tax/engine/revision.js
// Working revisions, the dependency manifest and drift (spec §4.3 tax_return_revision, §5.9). A working revision is the engine's result taken
// under the graph and company locks (the books cannot change while it is computed: ledger writes lock their company) and stored whole, with
// everything the computation CONSUMED frozen beside it (Codex t3-plan-r1 B12) — so an old revision still explains its old result:
//   inputs              every decision and mapping the computation read, with its content: the return's header and its activities;
//                       bindings (targets, slots, shares or dollars, statement-row labels) and line attributions; assignments; typed items
//                       (amounts, rows, workpaper text); adjustment groups whole (purpose, memo, support, status, reason, lines) with the
//                       deltas applied and the proposals' answers; every timing decision read — this period's, the earlier periods' whose
//                       advances are consumed now, the next period's receipt dates — with its kind, decision, destination, cents, date,
//                       transaction and event versions; closing classifications with their lines; COGS workpapers and every movement class;
//                       the opening facts (each by id) and bridges;
//   results             the T5 printing slice's input: catalog field ids, exact semantic cents as strings (sign facts applied once), status
//                       and reasons, statement rows, checks, the M-1 bridge, the COGS workpapers;
//   source_detail       every posting line measured (date, number, memo, type, cents, transaction version), every earlier line a balance
//                       account's beginning is derived from, every document posting the cash layer shared (an older invoice a payment of
//                       this period settles, whatever its date), every application read for cumulative sharing (its endpoints and amount —
//                       earlier periods' too), and every transaction consumed with its version AND its context (type, date, number, memo,
//                       customer or vendor, total, voided) — values, not only hashes (Codex t3-plan-r2 R2-8);
//   dependency_manifest one hash per group of that same dependency set: drift compares them.
// Drift compares the live manifest and results with the latest revision's: amount drift (a field's cents changed), provenance drift (the same
// amounts from different rows or decisions — a payment re-applied between invoices, an older invoice edited, a re-posted transaction, a
// decision of an earlier period made again), structure drift (mappings, labels, assignments, the header, the activities), engine or catalog
// drift. Revisions are never changed (migration 066); T3 takes working revisions only.
import { createHash } from 'node:crypto';
import { withTransaction } from '../../db.js';
import { ValidationError } from '../../data/writes.js';
import { openTaxReturn, personOf } from '../open-return.js';
import { measureLines } from '../measure.js';
import { PL_TYPES } from '../../reports/statements.js';
import { computeIn, computeReturn } from './compute.js';

const fail = message => { throw new ValidationError(message); };
const md5 = text => createHash('md5').update(text).digest('hex');
// JSON with BigInt as digit strings (never through Number).
export const toJson = v => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x instanceof Map ? Object.fromEntries(x) : x instanceof Set ? [...x] : x)));
const sortedKeys = v => (Array.isArray(v) ? v.map(sortedKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortedKeys(v[k])])) : v);
// Key order is not meaning (jsonb reorders keys): every hash is of the sorted form.
const hash = v => md5(JSON.stringify(sortedKeys(toJson(v))));

export function resultsJson(r) {
  return toJson({ schema: 'tax-books.results.v1', engineVersion: r.engineVersion, catalogHash: r.catalogHash,
    return: { returnId: r.ret.return_id, entityId: r.ret.entity_id, returnType: r.ret.return_type, edition: r.ret.form_edition, periodStart: r.ret.period_start, periodEnd: r.ret.period_end,
      taxMethod: r.ret.tax_method, bookBasis: r.ret.book_basis, openingState: r.ret.opening_state },
    fields: r.fields, checks: r.checks, bridge: r.bridge, applicability: r.applicability,
    cogs: [...r.cogs.values()].map(e => ({ activityId: e.activityId, name: e.name, path: e.workpaper?.path ?? null, treatment: e.workpaper?.treatment ?? null, method: e.workpaper?.method ?? null,
      values: e.values, tieout: e.tieout.known ? e.tieout.cents : null, reasons: e.reasons })) });
}
// The decisions read, every group of them, with their content.
const decisionsOf = r => [...(r.deps.cash ? r.deps.cash.reviews.values() : []), ...(r.deps.timing ? r.deps.timing.reviews.values() : [])].sort((a, b) => a.id - b.id);
export function inputsJson(r) {
  const own = r.cov.sources[0];
  return toJson({
    header: r.deps.header, activities: r.deps.activities,
    bindings: (own.accounts ?? []).flatMap(a => a.bindings.map(b => ({ binding_id: b.binding_id, account_id: b.account_id, measurement: b.measurement, treatment: b.treatment, destination: b.destination, target: b.target_key,
      slot_key: b.slot_key, row_label: b.row_label, memo: b.memo, share: b.share_num_text ? `${b.share_num_text}/${b.share_den_text}` : null, amount: b.amount_text, source_version: b.source_version }))),
    attributions: (own.accounts ?? []).flatMap(a => a.attributions.map(x => ({ id: x.binding_line_id, account_id: x.account_id, txn_id: x.txn_id, line_no: x.line_no, slot_key: x.slot_key, row_label: x.row_label, txn_version: x.txn_version }))),
    assignments: [...r.cov.assignments].map(([slot, kind]) => ({ slot, kind })),
    manual: r.items.map(i => ({ key: i.item_key, status: i.status, amount: i.amount, rows: i.rows, workpaper: i.workpaper, entered_by: i.entered_by })),
    adjustments: { groups: r.deps.groups, applied: r.deltas, proposals: r.proposals.map(p => ({ key: p.key, version: p.version, why: p.why, lines: p.lines, answer: p.answer ? { group: p.answer.group_id, status: p.answer.status, fresh: p.answer.fresh } : null })),
      orphans: (r.orphanAnswers ?? []).map(g => g.group_id) },
    decisions: decisionsOf(r),
    timing: [...(r.cash?.candidates ?? []), ...(r.timing?.candidates ?? [])].map(c => ({ txnId: c.txnId, kinds: c.kinds, state: c.state, cents: c.cents, eventVersion: c.eventVersion, review: c.review?.review_id ?? null })),
    // Each candidate's raw legs as they are now (line, account, type, cents — Codex t3-r1 note 2): a confirmed closing's legs are removed from
    // every normalized measurement, so this is the only place the revision keeps the exact amounts a mixed closing took out of each account.
    classifications: r.candidates.map(c => ({ txnId: c.txnId, txnVersion: c.txnVersion, state: c.state, date: c.date, docNumber: c.docNumber,
      legs: c.lines.map(l => ({ lineNo: l.lineNo, accountId: l.accountId, accountName: l.accountName, type: l.type, cents: l.cents })),
      decision: c.decision ? { id: Number(c.decision.classification_id), class: c.decision.class, lines: c.decision.lines,
        accounts: (c.decision.accounts ?? []).map(Number), domains: c.decision.account_domains ?? [], reason: c.decision.reason, by: c.decision.reviewed_by, txnVersion: c.decision.txn_version } : null })),
    cogs: [...r.cogs.values()].map(e => ({ activityId: e.activityId, workpaper: e.workpaper, movements: e.movements.map(m => ({ txnId: m.txnId, lineNo: m.lineNo, accountId: m.accountId, cents: m.cents, cls: m.cls, overridden: m.overridden, stale: m.stale, gone: m.gone, txnVersion: m.txnVersion, saved: m.saved })) })),
    openings: { state: r.openings.state, baselineId: r.openings.baselineId, facts: [...r.openings.byId.values()], bridges: r.openings.bridges },
    cogsClasses: r.cogsClasses ?? [], holds: r.holds ?? [],
  });
}
// Everything consumed, as VALUES (Codex t3-plan-r2 R2-8): every posting line of the measured accounts in the period (date, number, memo,
// type, cents, transaction version); for the balance accounts, every earlier posting line their beginning balance is derived from; the cash
// layer's documents, applications and transactions (any date); the accrual gate's transactions; and each consumed transaction's context as
// it was — type, date, number, memo, customer or vendor, total, voided — so an old revision renders its explanation after the source is
// edited, deleted or posted again.
export async function sourceDetailOf(db, r) {
  const own = r.cov.sources[0];
  const ids = (own.accounts ?? []).map(a => a.accountId);
  const lines = ids.length ? await measureLines(db, { orgId: r.orgId, sourceEntityId: own.entityId, accountIds: ids, periodStart: r.ret.period_start, periodEnd: r.ret.period_end, returnId: r.ret.return_id }) : new Map();
  const balanceIds = (own.accounts ?? []).filter(a => !a.pl).map(a => a.accountId);
  const { rows: earlier } = balanceIds.length ? await db.query(`SELECT p.account_id, p.txn_id, p.line_no, p.txn_date::text AS date, p.amount_cents::text AS cents, txn_version(p.txn_id) AS v FROM posting p
     WHERE p.org_id = $1 AND p.entity_id = $2 AND p.account_id = ANY($3::bigint[]) AND p.txn_date < $4::date ORDER BY p.account_id, p.txn_date, p.txn_id, p.line_no NULLS FIRST, p.posting_id`,
  [r.orgId, own.entityId, balanceIds, r.ret.period_start]) : { rows: [] };
  // Every earlier income and expense line of the company: the books close them into retained earnings, so the beginning of retained earnings
  // is derived from them — whether or not their accounts are covered now (an invoice long paid, its receivable at zero) (R3-4).
  const { rows: earlierPl } = await db.query(`SELECT p.account_id, p.txn_id, p.line_no, p.txn_date::text AS date, p.amount_cents::text AS cents, txn_version(p.txn_id) AS v FROM posting p
       JOIN account a ON a.org_id = p.org_id AND a.account_id = p.account_id
     WHERE p.org_id = $1 AND p.entity_id = $2 AND a.type = ANY($3::text[]) AND p.txn_date < $4::date ORDER BY p.account_id, p.txn_date, p.txn_id, p.line_no NULLS FIRST, p.posting_id`,
  [r.orgId, own.entityId, PL_TYPES, r.ret.period_start]);
  const consumed = new Map();
  for (const ls of lines.values()) for (const l of ls) consumed.set(l.txnId, l.txnVersion);
  for (const p of [...earlier, ...earlierPl]) consumed.set(Number(p.txn_id), p.v);
  for (const d of [r.deps.cash, r.deps.timing]) if (d) for (const [id, v] of d.txns) consumed.set(id, v);
  for (const c of r.candidates) if (c.txnVersion) consumed.set(c.txnId, c.txnVersion);
  for (const e of r.cogs.values()) for (const m of e.movements) if (m.txnVersion) consumed.set(m.txnId, m.txnVersion);
  const { rows: ctx } = consumed.size ? await db.query(`SELECT t.txn_id, t.type, t.txn_date::text AS date, t.doc_number, t.memo, t.total_cents::text AS total, t.voided_at IS NOT NULL AS voided,
      c.display_name AS customer, v.display_name AS vendor FROM txn t LEFT JOIN customer c ON c.org_id = t.org_id AND c.customer_id = t.customer_id LEFT JOIN vendor v ON v.org_id = t.org_id AND v.vendor_id = t.vendor_id
     WHERE t.org_id = $1 AND t.txn_id = ANY($2::bigint[]) ORDER BY t.txn_id`, [r.orgId, [...consumed.keys()]]) : { rows: [] };
  // A consumed transaction with no context now (voided or deleted): its absence is frozen explicitly, never silently dropped.
  const absent = [...consumed.keys()].filter(id => !ctx.some(t => Number(t.txn_id) === id)).sort((a, b) => a - b);
  return toJson({
    absent,
    postings: Object.fromEntries([...lines].map(([a, ls]) => [a, ls.map(l => [l.txnId, l.lineNo, l.cents, l.txnVersion, l.date, l.docNumber, l.memo, l.type])])),
    history: Object.fromEntries(balanceIds.map(a => [a, earlier.filter(p => Number(p.account_id) === a).map(p => [Number(p.txn_id), p.line_no === null ? null : Number(p.line_no), p.date, p.cents, p.v])])),
    historyIncome: earlierPl.map(p => [Number(p.account_id), Number(p.txn_id), p.line_no === null ? null : Number(p.line_no), p.date, p.cents, p.v]),
    balances: Object.fromEntries((own.accounts ?? []).map(a => [a.accountId, { begin: a.begin, end: a.end, normalization: a.normalization, versions: a.versions }])),
    transactions: [...consumed].sort((a, b) => a[0] - b[0]),
    contexts: ctx.map(t => ({ id: Number(t.txn_id), type: t.type, date: t.date, number: t.doc_number, memo: t.memo, customer: t.customer, vendor: t.vendor, total: t.total, voided: t.voided })),
    documents: r.deps.cash ? [...r.deps.cash.postings].sort((a, b) => a[0] - b[0]) : [],
    applications: r.deps.cash ? r.deps.cash.applications : [],
    cash: r.cash ? { events: r.cash.events, unresolved: r.cash.unresolved } : null,
    timing: r.deps.timing ? { postings: [...r.deps.timing.postings].sort((a, b) => a[0] - b[0]) } : null,
  });
}
export function manifestOf(r, detail) {
  const own = r.cov.sources[0], inputs = inputsJson(r);
  return toJson({
    engine: r.engineVersion, catalog: r.catalogHash,
    return: hash(r.deps.header), activities: hash(r.deps.activities),
    partitions: Object.fromEntries((own.accounts ?? []).flatMap(a => Object.entries(a.results).map(([m, p]) => [`${a.entityId}/${a.accountId}/${m}`, p.version]))),
    transactions: hash([detail.transactions, detail.contexts, detail.absent]), history: hash([detail.history, detail.historyIncome]), documents: hash(detail.documents), applications: hash(detail.applications),
    cash: r.cash?.version ?? null, timing: r.timing?.version ?? null, decisions: hash(inputs.decisions),
    structure: hash([inputs.bindings, inputs.attributions, inputs.assignments]),
    manual: hash(inputs.manual), adjustments: hash(inputs.adjustments), classifications: hash(inputs.classifications), cogs: hash([inputs.cogs, inputs.cogsClasses]), openings: hash(inputs.openings), holds: hash(inputs.holds),
  });
}

// Take a working revision of one return (admins and permitted accountants, under the locks). Returns { revisionId, revisionNo }.
export async function takeWorkingRevision(pool, { orgId, entityId, returnId, takenBy, canOpen = () => true }) {
  const who = personOf(takenBy);
  return withTransaction(pool, async tx => {
    const ret = await openTaxReturn(tx, { orgId, entityId, returnId });
    const r = await computeIn(tx, { orgId, entityId, returnId: ret.return_id, canOpen });
    if (r.refused) fail(r.refused);
    const detail = await sourceDetailOf(tx, r);
    const { rows: [n] } = await tx.query('SELECT coalesce(max(revision_no), 0) + 1 AS n FROM tax_return_revision WHERE org_id = $1 AND return_id = $2', [orgId, ret.return_id]);
    const { rows: [row] } = await tx.query(`INSERT INTO tax_return_revision (org_id, return_id, revision_no, kind, taken_by, catalog_hash, engine_version, inputs, results, source_detail, dependency_manifest)
      VALUES ($1,$2,$3,'working',$4,$5,$6,$7,$8,$9,$10) RETURNING revision_id`, [orgId, ret.return_id, n.n, who, r.catalogHash, r.engineVersion, inputsJson(r), resultsJson(r), detail, manifestOf(r, detail)]);
    return { revisionId: Number(row.revision_id), revisionNo: Number(n.n) };
  });
}
export async function listRevisions(db, { orgId, entityId, returnId }) {
  const { rows } = await db.query(`SELECT v.revision_id, v.revision_no, v.kind, v.taken_at, v.taken_by, v.engine_version, v.catalog_hash FROM tax_return_revision v JOIN tax_return r ON r.org_id = v.org_id AND r.return_id = v.return_id
     WHERE v.org_id = $1 AND r.entity_id = $2 AND v.return_id = $3 ORDER BY v.revision_no DESC`, [orgId, entityId, returnId]);
  return rows.map(v => ({ ...v, revision_id: Number(v.revision_id), revision_no: Number(v.revision_no) }));
}
export async function getRevision(db, { orgId, entityId, returnId, revisionNo }) {
  const { rows: [v] } = await db.query(`SELECT v.* FROM tax_return_revision v JOIN tax_return r ON r.org_id = v.org_id AND r.return_id = v.return_id
     WHERE v.org_id = $1 AND r.entity_id = $2 AND v.return_id = $3 AND v.revision_no = $4`, [orgId, entityId, returnId, revisionNo]);
  return v ?? null;
}

// Drift of the live return against its latest working revision (or a given one). → null without a revision; else { revisionNo, takenAt,
// amount: [{ key, was, now }], provenance: [group], structure: [group], engine: boolean }.
export const PROVENANCE = ['partitions', 'transactions', 'history', 'documents', 'applications', 'cash', 'timing', 'decisions', 'manual', 'adjustments', 'classifications', 'cogs', 'openings', 'holds'];
export const STRUCTURE = ['structure', 'return', 'activities'];
export function driftBetween(saved, live) {
  const was = new Map(saved.results.fields.map(f => [f.key, f.cents])), now = new Map(live.results.fields.map(f => [f.key, f.cents]));
  const amount = [];
  for (const k of [...new Set([...was.keys(), ...now.keys()])].sort()) if ((was.get(k) ?? null) !== (now.get(k) ?? null)) amount.push({ key: k, was: was.get(k) ?? null, now: now.get(k) ?? null });
  const m0 = saved.manifest, m1 = live.manifest, changed = k => JSON.stringify(sortedKeys(m0[k] ?? null)) !== JSON.stringify(sortedKeys(m1[k] ?? null));
  return { amount, provenance: PROVENANCE.filter(changed), structure: STRUCTURE.filter(changed), engine: m0.engine !== m1.engine || m0.catalog !== m1.catalog };
}
export async function driftOf(pool, { orgId, entityId, returnId, canOpen = () => true }) {
  const [latest] = await listRevisions(pool, { orgId, entityId, returnId });
  if (!latest) return null;
  const saved = await getRevision(pool, { orgId, entityId, returnId, revisionNo: latest.revision_no });
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const r = await computeIn(c, { orgId, entityId, returnId, canOpen });
    if (r.refused) { await c.query('COMMIT'); return { revisionNo: latest.revision_no, takenAt: latest.taken_at, refused: r.refused, amount: [], provenance: [], structure: [], engine: false }; }
    const detail = await sourceDetailOf(c, r);
    await c.query('COMMIT');
    return { revisionNo: latest.revision_no, takenAt: latest.taken_at, ...driftBetween({ results: saved.results, manifest: saved.dependency_manifest }, { results: resultsJson(r), manifest: manifestOf(r, detail) }) };
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
export { computeReturn };
