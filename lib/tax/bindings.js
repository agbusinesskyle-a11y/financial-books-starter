// lib/tax/bindings.js
// Source bindings (spec §4.5, §13 T2, §13.1 T2): company defaults, per-return routings of one measurement of one account (whole, by exact
// shares, or by dollars tied to the partition version), line attributions, copy-forward when a period opens, and the per-period
// re-resolution of activity, owner-interest and K-1 references. A binding is routing, never provider authority (lib/tax/authority.js).
// Tax Books never writes to the ledger: this module reads posting and txn and writes only migration 065's tables.
// Locking (Codex t2-plan-r1 B5, r2 B5): every write takes, in this order, the organization's inclusion-graph lock (lockTaxGraph — the
// advisory lock T1's includeBooks and the inclusion triggers take; migration 065's binding and edge triggers take it too, so the database
// serializes a binding write with an edge change even if a caller forgot), then the return's company, then every company on the source's
// inclusion path in ascending id order, and reads the graph and the measurement under those locks. Ledger writes lock only their own
// company, so a measurement read here is the one the save is checked against. Every Tax Books transaction that takes the graph lock takes
// it first (openPeriod, includeBooks, removeInclusion, these writes), so no two of them wait on each other in opposite orders.
// Every decision a person saw carries the version it was shown at (measurement + attribution set, transaction, binding
// set, account) and a changed one is refused, never saved over.
import { createHash } from 'node:crypto';
import { withTransaction } from '../db.js';
import { ValidationError, lockEntity } from '../data/writes.js';
import { catalogFor } from './catalog/index.js';
import { measureAccounts, measureLines, dollars } from './measure.js';
import { catalogContext, checkTarget, targetKey, slotFor, activityFits, effectiveIn, isPl, BINDABLE_RETURN_TYPES, MEASUREMENTS, MEASUREMENT_LABELS } from './destinations.js';
import { parseShare, parseCentsBig, sumFractions, baseVersion, lineKey } from './partition.js';
import { T2_RESOLVERS, resolveRefs } from './references.js';

export { T2_RESOLVERS };
const fail = message => { throw new ValidationError(message); };
const md5 = text => createHash('md5').update(text).digest('hex');
// An id from a form or a caller: a positive safe integer or nothing (Codex non-blocking 1: never an arbitrary digit string).
const idOf = v => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return /^\d{1,16}$/.test(String(v)) && Number.isSafeInteger(n) && n > 0 ? n : fail('One of the choices isn’t valid. Reload the page and try again.');
};
const text = (v, max) => String(v ?? '').trim().slice(0, max) || null;

const RETURN_COLS = 'return_id, entity_id, status, return_type, form_edition, period_start::text AS period_start, period_end::text AS period_end, tax_method, book_basis';
const BINDING_COLS = `b.binding_id, b.return_id, b.source_entity_id, b.inclusion_path, b.account_id, b.measurement, b.treatment, b.destination, b.activity_id, b.interest_party_id,
  b.interest_id, b.interest_version, b.k1_issuer_party_id, b.k1_source_id, b.k1_source_version, b.slot_key, b.target_key, b.row_label, b.share_num::text AS share_num_text,
  b.share_den::text AS share_den_text, b.amount_cents::text AS amount_text, b.override, b.copied_from_default_id, b.source_version, b.catalog_edition, b.pending, b.memo,
  b.source, b.source_detail, b.confidence, b.created_by`;
const LINE_COLS = `l.binding_line_id, l.return_id, l.source_entity_id, l.inclusion_path, l.account_id, l.txn_id, l.line_no, l.treatment, l.destination, l.activity_id,
  l.interest_party_id, l.interest_id, l.interest_version, l.k1_issuer_party_id, l.k1_source_id, l.k1_source_version, l.slot_key, l.target_key, l.row_label,
  l.amount_cents::text AS amount_text, l.txn_version, l.catalog_edition, l.pending, l.memo`;

// The effective inclusion graph of a return (migration 065 tax_inclusion_sources, Codex B4): every included company, nested ones too,
// with its path, the companies on the way, the activity of the return it joins, its own book basis and whether the path covers the
// return's whole period.
export async function inclusionSources(db, { orgId, returnId }) {
  const { rows } = await db.query(`SELECT s.source_entity_id, s.path, s.entities, s.top_activity_id, s.source_book_basis, s.period_matches, e.name AS source_name, a.name AS activity_name
      FROM tax_inclusion_sources($1, $2) s JOIN entity e ON e.org_id = $1 AND e.entity_id = s.source_entity_id JOIN tax_activity a ON a.org_id = $1 AND a.activity_id = s.top_activity_id
     ORDER BY cardinality(s.path), s.path`, [orgId, returnId]);
  return rows.map(r => ({ entityId: Number(r.source_entity_id), path: r.path.map(Number), entities: r.entities.map(Number), topActivityId: Number(r.top_activity_id),
    bookBasis: r.source_book_basis, periodMatches: r.period_matches, name: r.source_name, activityName: r.activity_name }));
}
// The fingerprint of a binding set as stored: a decision made against one set refuses to replace another (B7). Every field a person
// decides is in it (Codex r2 B5): the target (treatment, destination, activity, owner, K-1 payer), share, amount, statement-row label, memo.
export const setFingerprint = rows => md5(rows.map(r => JSON.stringify([r.target_key, r.share_num_text ?? null, r.share_den_text ?? null, r.amount_text ?? null,
  r.row_label ?? null, r.memo ?? null])).sort().join(','));
export const EMPTY_SET = setFingerprint([]);

// The organization's inclusion-graph lock (T1 migration 064's key), held to commit; taken FIRST by every Tax Books transaction that takes it.
export const lockTaxGraph = (tx, orgId) => tx.query('SELECT pg_advisory_xact_lock(74120062, hashint8($1::bigint))', [orgId]);
// The open period a binding write belongs to, under the graph lock and the return company's lock, with its catalog context.
async function openReturn(tx, { orgId, entityId, returnId }) {
  await lockTaxGraph(tx, orgId);
  await lockEntity(tx, orgId, entityId);
  const { rows: [r] } = await tx.query(`SELECT ${RETURN_COLS} FROM tax_return WHERE org_id = $1 AND entity_id = $2 AND return_id = $3 FOR UPDATE`, [orgId, entityId, idOf(returnId)]);
  if (!r) fail('Period not found.');
  if (r.status !== 'open') fail(`This period is ${r.status}: its bindings no longer change.`);
  return { ...r, entity_id: Number(r.entity_id), return_id: Number(r.return_id), ctx: catalogContext(r) };
}
// Whose books: the return's own company, or a company reached through THIS return's inclusion path (direct or nested), on the return's
// whole period. Read under the graph lock the caller holds, and authorized HERE, on the path actually used (Codex r3 R3-N3): canOpen must
// allow every company on it — a route's earlier check of an older path is never enough. Locks every company on the path, ascending.
async function sourceOf(tx, orgId, ret, sourceEntityId, canOpen = () => true) {
  const id = idOf(sourceEntityId) ?? fail('Choose whose books these are.');
  if (id === ret.entity_id) return { entityId: id, own: true, path: [], entities: [], topActivityId: null, bookBasis: ret.book_basis };
  const s = (await inclusionSources(tx, { orgId, returnId: ret.return_id })).find(x => x.entityId === id)
    ?? fail('That company’s books are not included in this return: add the inclusion on the tax setup page first.');
  if (!s.entities.every(x => canOpen(x))) fail('These books now reach this return through a company you cannot open: nothing was saved.');
  if (!s.periodMatches) fail(`${s.name}’s books reach this return through a period that does not cover the whole year: Tax Books cannot combine part-year books yet.`);
  for (const e of [...new Set(s.entities)].sort((a, b) => a - b)) await lockEntity(tx, orgId, e);
  return { ...s, own: false };
}
// Whether a person may act on a source of this return (spec §11): the return's own books, or included books whose every company on the
// CURRENT inclusion path the person may open. The one check for the routes and the optional AI actions (Codex r2 N3).
export async function sourceAllowed(db, { orgId, ret, sourceEntityId, canOpen }) {
  const id = Number(sourceEntityId);
  if (id === Number(ret.entity_id)) return true;
  const s = (await inclusionSources(db, { orgId, returnId: ret.return_id })).find(x => x.entityId === id);
  return Boolean(s && s.entities.every(x => canOpen(x)));
}
export const cashSensitive = (ret, src) => ret.tax_method === 'cash' || src.bookBasis === 'cash';
async function accountOf(tx, orgId, src, accountId) {
  const { rows: [a] } = await tx.query('SELECT account_id, name, type, system_key FROM account WHERE org_id = $1 AND entity_id = $2 AND account_id = $3', [orgId, src.entityId, idOf(accountId)]);
  return a ? { ...a, account_id: Number(a.account_id) } : fail('Account not found in that company’s books.');
}
export const activitiesOf = async (db, orgId, entityId) => (await db.query(
  'SELECT activity_id, name, schedule, effective_from, effective_to, disposed_on FROM tax_activity WHERE org_id = $1 AND return_entity_id = $2', [orgId, entityId])).rows
  .map(a => ({ ...a, activity_id: Number(a.activity_id) }));
async function partyOf(tx, orgId, partyId, what, kinds = null) {
  const { rows: [p] } = await tx.query('SELECT kind FROM tax_party WHERE org_id = $1 AND party_id = $2', [orgId, partyId]);
  if (!p) fail(`${what} not found.`);
  if (kinds && !kinds.includes(p.kind)) fail(`${what} must be a partnership or S corporation (one of our companies or an outside one).`);
}

// The activity a new binding carries (spec §4.4, §13.1 T2, Codex B5/B6). Included books join the top activity of their inclusion path,
// which must be in effect for the period. The return's own books may name an activity for any treatment (source-activity provenance,
// which T3 and T4 read for routing, deductible schedule and capitalization); a per-activity line requires one. An activity named must
// be in effect for the period and, for a per-activity line, reported on that line's schedule.
function activityForSave({ needs, src, activityId, activities, ret }) {
  if (!src.own) {
    if (activityId && activityId !== src.topActivityId) fail('Included books join the activity named on their inclusion edge: choose that activity, or change the inclusion.');
    const a = activities.find(x => x.activity_id === src.topActivityId);
    if (!a || !effectiveIn(a, ret)) fail(`${a?.name ?? 'The inclusion’s activity'} is not in effect in this period: fix the inclusion on the tax setup page.`);
    if (needs.activity && !activityFits(needs.line, a)) fail(`${a.name} (the included books’ activity) is not reported on this form.`);
    return a.activity_id;
  }
  if (!activityId) { if (needs.activity) fail('Choose the activity this amount belongs to.'); return null; }
  const a = activities.find(x => x.activity_id === activityId) ?? fail('Activity not found on this return.');
  if (!effectiveIn(a, ret)) fail(`${a.name} is not in effect in this period.`);
  if (needs.activity && !activityFits(needs.line, a)) fail(`${a.name} is not reported on this form.`);
  return a.activity_id;
}

// One row of a set, fully checked and resolved for this period.
async function prepareRow(tx, { orgId, ret, src, account, measurement, row, activities, resolvers }) {
  const t = { treatment: row.treatment, destination: row.destination || null, measurement, accountType: account.type,
    interestPartyId: idOf(row.interestPartyId), k1IssuerPartyId: idOf(row.k1IssuerPartyId), memo: row.memo };
  const needs = checkTarget(ret.ctx, t);
  if (!needs.interest && t.interestPartyId) fail('This destination is not kept per owner: leave the owner empty.');
  if (!needs.k1 && t.k1IssuerPartyId) fail('Only K-1 income booked here names a K-1 payer.');
  if (t.interestPartyId) await partyOf(tx, orgId, t.interestPartyId, 'Owner');
  if (t.k1IssuerPartyId) await partyOf(tx, orgId, t.k1IssuerPartyId, 'K-1 payer', ['entity_in_org', 'entity_outside']);
  const activityId = activityForSave({ needs, src, activityId: idOf(row.activityId), activities, ret });
  const refs = await resolveRefs(tx, { orgId, ret, interestPartyId: t.interestPartyId, k1IssuerPartyId: t.k1IssuerPartyId, resolvers });
  const slot = slotFor(ret.ctx, { treatment: t.treatment, line: needs.line, measurement, activityId, interestId: refs.interestId });
  return { ...t, activityId, ...refs, slot, targetKey: targetKey({ ...t, activityId }),
    rowLabel: t.treatment === 'statement_row' ? text(row.rowLabel, 200) ?? account.name : null, memo: text(t.memo, 500), share: null, amount: null };
}

async function insertBinding(tx, { orgId, ret, src, accountId, measurement, p, override, version, source, sourceDetail, confidence, actor }) {
  const { rows: [b] } = await tx.query(`INSERT INTO tax_binding (org_id, return_id, source_entity_id, inclusion_path, account_id, measurement, treatment, destination, activity_id,
      interest_party_id, interest_id, interest_version, k1_issuer_party_id, k1_source_id, k1_source_version, slot_key, target_key, row_label, share_num, share_den, amount_cents,
      override, copied_from_default_id, source_version, catalog_edition, pending, memo, source, source_detail, confidence, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31) RETURNING binding_id`,
  [orgId, ret.return_id, src.entityId, src.path, accountId, measurement, p.treatment, p.destination, p.activityId, p.interestPartyId, p.interestId, p.interestVersion,
    p.k1IssuerPartyId, p.k1SourceId, p.k1SourceVersion, p.slot, p.targetKey, p.rowLabel, p.share ? p.share.num.toString() : null, p.share ? p.share.den.toString() : null,
    p.amount === null ? null : p.amount.toString(), override, p.defaultId ?? null, version, ret.ctx.edition, JSON.stringify(p.pending), p.memo, source, sourceDetail ?? {}, confidence,
    actor ?? 'system']);
  return Number(b.binding_id);
}
// The partition base of one measurement now (lib/tax/partition.js baseVersion) and, for the activity, the residual the account set splits:
// the period's lines that no attribution takes.
async function partitionNow(tx, { orgId, ret, src, accountId, measurement, measured }) {
  if (measurement !== 'activity') return { base: baseVersion(measured.versions[measurement], [], measured.normalization), residual: measured[measurement] };
  const { rows } = await tx.query('SELECT txn_id, line_no, txn_version FROM tax_binding_line WHERE org_id = $1 AND return_id = $2 AND account_id = $3', [orgId, ret.return_id, accountId]);
  const attributions = rows.map(r => ({ txnId: Number(r.txn_id), lineNo: Number(r.line_no), txnVersion: r.txn_version }));
  if (!attributions.length) return { base: baseVersion(measured.versions.activity, [], measured.normalization), residual: measured.activity };
  const taken = new Set(attributions.map(a => lineKey(a.txnId, a.lineNo)));
  const live = (await measureLines(tx, { orgId, sourceEntityId: src.entityId, accountIds: [accountId], periodStart: ret.period_start, periodEnd: ret.period_end, returnId: ret.return_id })).get(accountId) ?? [];
  return { base: baseVersion(measured.versions.activity, attributions, measured.normalization), residual: live.filter(l => !taken.has(lineKey(l.txnId, l.lineNo))).reduce((t, l) => t + l.cents, 0n) };
}
async function writeDefaults(tx, { orgId, src, accountId, ret, measurement, prepared, source, sourceDetail, confidence, actor }) {
  await tx.query('DELETE FROM tax_binding_default WHERE org_id = $1 AND account_id = $2 AND return_type = $3 AND measurement = $4', [orgId, accountId, ret.ctx.returnType, measurement]);
  for (const p of prepared) {
    const rule = !src.own ? 'inclusion' : p.activityId ? 'fixed' : 'none';
    await tx.query(`INSERT INTO tax_binding_default (org_id, entity_id, account_id, return_type, measurement, treatment, destination, activity_rule, activity_id, interest_party_id,
        k1_issuer_party_id, share_num, share_den, row_label, memo, target_key, catalog_edition, source, source_detail, confidence, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
    [orgId, src.entityId, accountId, ret.ctx.returnType, measurement, p.treatment, p.destination, rule, rule === 'fixed' ? p.activityId : null, p.interestPartyId, p.k1IssuerPartyId,
      p.share ? p.share.num.toString() : null, p.share ? p.share.den.toString() : null, p.rowLabel, p.memo,
      targetKey({ ...p, activityId: rule === 'inclusion' ? 'inclusion' : rule === 'fixed' ? p.activityId : null }), ret.ctx.edition, source, sourceDetail ?? {}, confidence, actor ?? 'system']);
  }
}
const defaultKey = (p, src) => targetKey({ ...p, activityId: !src.own ? 'inclusion' : p.activityId });
const SET_COLS = 'target_key, share_num::text AS share_num_text, share_den::text AS share_den_text, amount_cents::text AS amount_text, row_label, memo';

// Replace the whole binding set of one source measurement (account × measurement) on one return, inside the caller's transaction.
//   split 'whole'   one row: the measurement's residual (what its line attributions leave);
//         'shares'  two or more rows with exact shares ("1/3", "25%") totalling exactly 1;
//         'amounts' two or more rows with dollars totalling exactly the residual, tied to the partition base (stale when it changes); not on
//                   a cash-sensitive source's activity or a cash-basis source's balances, whose base amount is the cash layer's (T3, B3).
//   expectVersion   the partition base the person was shown (measurement + attribution set): a changed one refuses the save;
//   expectSet       the binding set fingerprint the decision was made against (setFingerprint; EMPTY_SET for an unmapped measurement);
//   expectAccount   { name, type } the decision was made for (a suggestion: B7).
//   makeDefault     also store the set as the company default for this account, return type and measurement (whole or shares only).
// rows: [{ treatment, destination, activityId, interestPartyId, k1IssuerPartyId, rowLabel, share, amount, memo }].
export async function saveBindingsIn(tx, { orgId, entityId, returnId, sourceEntityId, accountId, measurement, split = 'whole', rows, makeDefault = false,
  source = 'person', sourceDetail = {}, confidence = null, expectVersion = null, expectSet = null, expectAccount = null, actor, resolvers = T2_RESOLVERS, canOpen = () => true }) {
  if (!['whole', 'shares', 'amounts'].includes(split)) fail('Choose whole, split by share or split by amount.');
  if (!['person', 'rule', 'history', 'ai'].includes(source)) fail('Unknown binding source.');
  if (!MEASUREMENTS.includes(measurement)) fail('Choose the measurement: activity, beginning or ending balance.');
  const list = (rows ?? []).filter(r => r && r.treatment);
  if (!list.length) fail('Choose where this amount goes.');
  if (split === 'whole' && list.length !== 1) fail('A whole binding has one destination; to use several, split by share or by amount.');
  if (split !== 'whole' && list.length < 2) fail('A split has at least two destinations.');
  if (makeDefault && split === 'amounts') fail('A dollar split belongs to this period’s figures and is not a reusable default: split by share to make a default.');
  const ret = await openReturn(tx, { orgId, entityId, returnId });
  const src = await sourceOf(tx, orgId, ret, sourceEntityId, canOpen);
  const account = await accountOf(tx, orgId, src, accountId);
  if (expectAccount && (expectAccount.name !== account.name || expectAccount.type !== account.type)) fail('This account was renamed or changed type since the page was shown. Look at it again.');
  const measured = (await measureAccounts(tx, { orgId, sourceEntityId: src.entityId, periodStart: ret.period_start, periodEnd: ret.period_end, returnId: ret.return_id })).get(account.account_id);
  const { base, residual } = await partitionNow(tx, { orgId, ret, src, accountId: account.account_id, measurement, measured });
  if (expectVersion && expectVersion !== base) fail('This account changed since the page was shown: its postings or its line attributions moved. Look at the amounts again before saving.');
  const { rows: current } = await tx.query(`SELECT ${SET_COLS} FROM tax_binding WHERE org_id = $1 AND return_id = $2 AND account_id = $3 AND measurement = $4`, [orgId, ret.return_id, account.account_id, measurement]);
  if (expectSet && expectSet !== setFingerprint(current)) fail('Someone changed this mapping since the page was shown. Look at it again.');
  const activities = await activitiesOf(tx, orgId, ret.entity_id);
  const prepared = [];
  for (const r of list) prepared.push(await prepareRow(tx, { orgId, ret, src, account, measurement, row: r, activities, resolvers }));
  if (new Set(prepared.map(p => p.targetKey)).size !== prepared.length) fail('Each destination appears once in a split.');
  if (split === 'shares') {
    list.forEach((r, i) => { prepared[i].share = parseShare(r.share) ?? fail(`Row ${i + 1}: a share looks like 1/3 or 25%.`); });
    const total = sumFractions(prepared.map(p => p.share));
    if (total.num !== total.den) fail(`The shares total ${total.num}/${total.den}; they must total exactly 1.`);
  }
  if (split === 'amounts') {
    if (cashSensitive(ret, src) && (measurement === 'activity' || src.bookBasis === 'cash')) fail('A dollar split here needs the amount the cash layer recognizes (next stage): split by share instead.');
    list.forEach((r, i) => {
      const c = parseCentsBig(r.amount);
      if (c === null || c === 0n) fail(`Row ${i + 1}: enter a nonzero amount, like 1250.00 or -40.00.`);
      // Parsed at any size, stored as a signed 64-bit cent count (Codex r3 hardening).
      if (c > 9223372036854775807n || c < -9223372036854775808n) fail(`Row ${i + 1}: that amount is too large to store.`);
      prepared[i].amount = c;
    });
    const sum = prepared.reduce((t, p) => t + p.amount, 0n);
    if (sum !== residual) fail(`The amounts total ${dollars(sum)}; the ${measurement === 'activity' ? 'activity left after line attributions' : MEASUREMENT_LABELS[measurement].toLowerCase()} is ${dollars(residual)}.`);
  }
  // A period-local change departs from the company default (spec §4.5 "edits are period-local"): marked, never pushed back.
  const { rows: defaults } = await tx.query('SELECT target_key, share_num::text AS n, share_den::text AS d FROM tax_binding_default WHERE org_id = $1 AND account_id = $2 AND return_type = $3 AND measurement = $4',
    [orgId, account.account_id, ret.ctx.returnType, measurement]);
  const shape = xs => xs.map(x => `${x.key}#${x.share ?? ''}`).sort().join(',');
  const override = !makeDefault && defaults.length > 0 && (split === 'amounts'
    || shape(defaults.map(d => ({ key: d.target_key, share: d.n ? `${d.n}/${d.d}` : null }))) !== shape(prepared.map(p => ({ key: defaultKey(p, src), share: p.share ? `${p.share.num}/${p.share.den}` : null }))));
  await tx.query('DELETE FROM tax_binding WHERE org_id = $1 AND return_id = $2 AND account_id = $3 AND measurement = $4', [orgId, ret.return_id, account.account_id, measurement]);
  const bindingIds = [];
  for (const p of prepared) bindingIds.push(await insertBinding(tx, { orgId, ret, src, accountId: account.account_id, measurement, p, override, version: base, source, sourceDetail, confidence, actor }));
  if (makeDefault) await writeDefaults(tx, { orgId, src, accountId: account.account_id, ret, measurement, prepared, source, sourceDetail, confidence, actor });
  return { bindingIds, version: base, override };
}
export const saveBindings = (pool, args) => withTransaction(pool, tx => saveBindingsIn(tx, args));

export async function clearBindings(pool, { orgId, entityId, returnId, sourceEntityId, accountId, measurement, expectSet = null, canOpen = () => true }) {
  return withTransaction(pool, async tx => {
    const ret = await openReturn(tx, { orgId, entityId, returnId });
    const src = await sourceOf(tx, orgId, ret, sourceEntityId, canOpen);
    const { rows: current } = await tx.query(`SELECT ${SET_COLS} FROM tax_binding WHERE org_id = $1 AND return_id = $2 AND source_entity_id = $3 AND account_id = $4 AND measurement = $5`,
      [orgId, ret.return_id, src.entityId, idOf(accountId), measurement]);
    if (!current.length) fail('Nothing was bound there.');
    if (expectSet && expectSet !== setFingerprint(current)) fail('Someone changed this mapping since the page was shown. Look at it again.');
    await tx.query('DELETE FROM tax_binding WHERE org_id = $1 AND return_id = $2 AND source_entity_id = $3 AND account_id = $4 AND measurement = $5', [orgId, ret.return_id, src.entityId, idOf(accountId), measurement]);
  });
}

// Reads are scoped to the period's company through tax_return (spec §11), like T1's listAssignments: a return id of another company
// lists nothing. Money comes back as text (amount_text), never through the Number parser.
export async function listBindings(db, { orgId, entityId, returnId }) {
  const { rows } = await db.query(`SELECT ${BINDING_COLS} FROM tax_binding b JOIN tax_return r ON r.org_id = b.org_id AND r.return_id = b.return_id AND r.entity_id = $2
    WHERE b.org_id = $1 AND b.return_id = $3 ORDER BY b.source_entity_id, b.account_id, b.measurement, b.binding_id`, [orgId, entityId, returnId]);
  return rows.map(b => ({ ...b, binding_id: Number(b.binding_id), source_entity_id: Number(b.source_entity_id), account_id: Number(b.account_id), inclusion_path: b.inclusion_path.map(Number) }));
}
export async function listAttributions(db, { orgId, entityId, returnId }) {
  const { rows } = await db.query(`SELECT ${LINE_COLS} FROM tax_binding_line l JOIN tax_return r ON r.org_id = l.org_id AND r.return_id = l.return_id AND r.entity_id = $2
    WHERE l.org_id = $1 AND l.return_id = $3 ORDER BY l.source_entity_id, l.account_id, l.txn_id, l.line_no`, [orgId, entityId, returnId]);
  return rows.map(l => ({ ...l, binding_line_id: Number(l.binding_line_id), source_entity_id: Number(l.source_entity_id), account_id: Number(l.account_id), txn_id: Number(l.txn_id),
    line_no: Number(l.line_no), inclusion_path: l.inclusion_path.map(Number) }));
}
// The defaults of one company's accounts (for every return type they serve).
export async function listDefaults(db, { orgId, entityId }) {
  const { rows } = await db.query(`SELECT default_id, entity_id, account_id, return_type, measurement, treatment, destination, activity_rule, activity_id, interest_party_id, k1_issuer_party_id,
      share_num::text AS share_num_text, share_den::text AS share_den_text, row_label, memo, target_key, catalog_edition, source, source_detail, confidence
    FROM tax_binding_default WHERE org_id = $1 AND entity_id = $2 ORDER BY account_id, return_type, measurement, default_id`, [orgId, entityId]);
  return rows.map(d => ({ ...d, default_id: Number(d.default_id), account_id: Number(d.account_id) }));
}
// ---- part 2: line attribution (Task 6) ----

// Line attribution (spec §4.5 tax_binding_line): one posting line of an account's period activity routed to its own target. The line is
// consumed before the account's set (lib/tax/partition.js); a line is attributed at most once on a return; a system leg (no line number)
// stays with the account. expectTxnVersion is the transaction version the page showed (measureLines txnVersion): a changed transaction is
// refused (B5). Attributing a line changes the partition base, so a dollar split of the account turns stale until it is saved again.
export async function attributeLine(pool, { orgId, entityId, returnId, sourceEntityId, accountId, txnId, lineNo, expectTxnVersion, target, actor, resolvers = T2_RESOLVERS, canOpen = () => true }) {
  const ln = Number(lineNo), tid = idOf(txnId);
  if (!Number.isSafeInteger(ln) || ln < 1) fail('Only a numbered transaction line can be attributed; a system line stays with the account.');
  if (!expectTxnVersion) fail('Reload the page: it did not say which version of the line it showed.');
  return withTransaction(pool, async tx => {
    const ret = await openReturn(tx, { orgId, entityId, returnId });
    const src = await sourceOf(tx, orgId, ret, sourceEntityId, canOpen);
    const account = await accountOf(tx, orgId, src, accountId);
    // On a cash-sensitive source the amount a line routes is the cash the cash layer recognizes for it, possibly from a document of
    // another year (Codex r2 B3): T2 does not route single lines there; the account's whole or share binding routes its cash (Contracts 3).
    if (cashSensitive(ret, src)) fail('On a cash-method return or cash-basis books, single lines are routed by the cash layer (next stage): bind the account whole or by shares.');
    const lines = (await measureLines(tx, { orgId, sourceEntityId: src.entityId, accountIds: [account.account_id], periodStart: ret.period_start, periodEnd: ret.period_end, returnId: ret.return_id })).get(account.account_id) ?? [];
    const line = lines.find(l => l.txnId === tid && l.lineNo === ln) ?? fail('That line does not post to this account in this period.');
    if (line.txnVersion !== expectTxnVersion) fail('This transaction changed since the page was shown. Look at the line again.');
    if (line.cents === 0n) fail('That line nets to zero on this account: there is nothing to attribute.');
    const { rows: dup } = await tx.query('SELECT 1 FROM tax_binding_line WHERE org_id = $1 AND return_id = $2 AND account_id = $3 AND txn_id = $4 AND line_no = $5', [orgId, ret.return_id, account.account_id, tid, ln]);
    if (dup.length) fail('That line is already attributed: remove that attribution first.');
    const p = await prepareRow(tx, { orgId, ret, src, account, measurement: 'activity', row: target ?? {}, activities: await activitiesOf(tx, orgId, ret.entity_id), resolvers });
    const { rows: [b] } = await tx.query(`INSERT INTO tax_binding_line (org_id, return_id, source_entity_id, inclusion_path, account_id, txn_id, line_no, treatment, destination, activity_id,
        interest_party_id, interest_id, interest_version, k1_issuer_party_id, k1_source_id, k1_source_version, slot_key, target_key, row_label, amount_cents, txn_version,
        catalog_edition, pending, memo, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) RETURNING binding_line_id`,
    [orgId, ret.return_id, src.entityId, src.path, account.account_id, tid, ln, p.treatment, p.destination, p.activityId, p.interestPartyId, p.interestId, p.interestVersion,
      p.k1IssuerPartyId, p.k1SourceId, p.k1SourceVersion, p.slot, p.targetKey, p.rowLabel, line.cents.toString(), line.txnVersion, ret.ctx.edition, JSON.stringify(p.pending), p.memo,
      actor ?? 'system']);
    return Number(b.binding_line_id);
  });
}
// Removing works for any attribution of this return's source, live, stale or orphaned (its line deleted or moved): the page lists the
// stored attributions themselves, not only the current lines (B8).
export async function removeAttribution(pool, { orgId, entityId, returnId, sourceEntityId, bindingLineId, canOpen = () => true }) {
  return withTransaction(pool, async tx => {
    const ret = await openReturn(tx, { orgId, entityId, returnId });
    const src = await sourceOf(tx, orgId, ret, sourceEntityId, canOpen);
    const { rowCount } = await tx.query('DELETE FROM tax_binding_line WHERE org_id = $1 AND return_id = $2 AND source_entity_id = $3 AND binding_line_id = $4',
      [orgId, ret.return_id, src.entityId, idOf(bindingLineId)]);
    if (!rowCount) fail('That attribution is not on this period.');
  });
}
// ---- part 3: copy-forward and re-resolution (Task 7) ----

// A default reused for one period (§13.1 T2: re-resolve, never copy period-specific references). The destination is checked against THIS
// period's catalog (a refusal skips the default); included books take this period's top inclusion activity, which must be in effect; a
// fixed activity must still be in effect (and on the schedule of a per-activity line), or the binding is copied with its activity pending
// (blocking); owner and K-1 parties are resolved for this period.
async function reuseDefault(tx, { orgId, ret, src, d, activities, resolvers }) {
  const t = { treatment: d.treatment, destination: d.destination, measurement: d.measurement, accountType: d.account_type,
    interestPartyId: d.interest_party_id === null ? null : Number(d.interest_party_id), k1IssuerPartyId: d.k1_issuer_party_id === null ? null : Number(d.k1_issuer_party_id), memo: d.memo };
  const needs = checkTarget(ret.ctx, t);
  const pending = [];
  let activityId = null;
  const want = !src.own ? src.topActivityId : d.activity_id === null ? null : Number(d.activity_id);
  if (want !== null) {
    const a = activities.find(x => x.activity_id === want);
    if (a && effectiveIn(a, ret) && (!needs.activity || activityFits(needs.line, a))) activityId = a.activity_id;
    else pending.push({ kind: 'activity', reason: `${a ? a.name : 'The default’s activity'} is not in effect in this period, or not on this form: choose this period’s activity.` });
  } else if (needs.activity) pending.push({ kind: 'activity', reason: 'Choose this period’s activity.' });
  const refs = await resolveRefs(tx, { orgId, ret, interestPartyId: t.interestPartyId, k1IssuerPartyId: t.k1IssuerPartyId, resolvers });
  const slot = slotFor(ret.ctx, { treatment: t.treatment, line: needs.line, measurement: t.measurement, activityId, interestId: refs.interestId });
  return { ...t, activityId, ...refs, pending: [...pending, ...refs.pending], slot,
    targetKey: targetKey({ ...t, activityId: activityId ?? (want !== null || needs.activity ? `pending-${d.default_id}` : null) }), rowLabel: d.row_label, memo: d.memo,
    share: d.share_num === null ? null : { num: BigInt(d.share_num), den: BigInt(d.share_den) }, amount: null, defaultId: Number(d.default_id) };
}

// Copy-forward (spec §4.5, §13.1 T2), inside the caller's transaction (the caller holds the return company's lock; this locks the source
// companies on each inclusion path, ascending): every company default of the return's catalog for an account of the return's own books, or of
// an included company's books (direct or nested), becomes a binding of this period wherever that account and measurement have none yet.
// sourceEntityIds limits the companies copied (copyForwardEdge passes the companies a new edge brings in); canOpen, applied to the paths as
// read here under the graph lock (Codex r3 R3-N3), skips books that pass through a company the person may not open.
// maxSets (the public demo only, lib/domain/demo.js DEMO_BATCH_MAX; null everywhere else): at most this many whole account/measurement sets
// are copied, in the stable order below (the return's own books first, then each included company; by account, then measurement), never
// part of a split; the rest stay unmapped (coverage shows them) and are counted in `left`, for the next copy.
// Returns { copied, sets, left, skipped: [{ reason, … }] }.
export async function copyForwardIn(tx, { orgId, entityId, returnId, sourceEntityIds = null, canOpen = () => true, actor, resolvers = T2_RESOLVERS, maxSets = null }) {
  const none = { copied: 0, sets: 0, left: 0, skipped: [] };
  const { rows: [r] } = await tx.query(`SELECT ${RETURN_COLS} FROM tax_return WHERE org_id = $1 AND entity_id = $2 AND return_id = $3`, [orgId, entityId, idOf(returnId)]);
  if (!r || r.status !== 'open' || !BINDABLE_RETURN_TYPES.includes(r.return_type)) return none;
  let ctx;
  try { ctx = catalogContext(r); } catch (e) { if (e instanceof ValidationError) return none; throw e; }
  const ret = { ...r, entity_id: Number(r.entity_id), return_id: Number(r.return_id), ctx };
  const only = sourceEntityIds ? new Set(sourceEntityIds.map(Number)) : null;
  const sources = [{ entityId: ret.entity_id, own: true, path: [], entities: [], topActivityId: null, bookBasis: ret.book_basis, periodMatches: true, name: null },
    ...(await inclusionSources(tx, { orgId, returnId: ret.return_id })).map(s => ({ ...s, own: false }))].filter(s => (!only || only.has(s.entityId)) && s.entities.every(x => canOpen(x)));
  for (const e of [...new Set(sources.flatMap(s => s.entities))].sort((a, b) => a - b)) await lockEntity(tx, orgId, e);
  const activities = await activitiesOf(tx, orgId, ret.entity_id);
  let copied = 0, done = 0, left = 0;
  const skipped = [];
  for (const src of sources) {
    const { rows: defs } = await tx.query(`SELECT d.default_id, d.account_id, d.measurement, d.treatment, d.destination, d.activity_rule, d.activity_id, d.interest_party_id, d.k1_issuer_party_id,
        d.share_num::text AS share_num, d.share_den::text AS share_den, d.row_label, d.memo, a.type AS account_type, a.name AS account_name
      FROM tax_binding_default d JOIN account a ON a.org_id = d.org_id AND a.account_id = d.account_id
      WHERE d.org_id = $1 AND d.entity_id = $2 AND d.return_type = $3 ORDER BY d.account_id, d.measurement, d.default_id`, [orgId, src.entityId, ctx.returnType]);
    if (!defs.length) continue;
    if (!src.periodMatches) { skipped.push({ sourceEntityId: src.entityId, accountId: null, accountName: src.name, measurement: null, reason: `${src.name}’s books reach this return through a part-year period; nothing was copied.` }); continue; }
    const { rows: have } = await tx.query('SELECT DISTINCT account_id, measurement FROM tax_binding WHERE org_id = $1 AND return_id = $2 AND source_entity_id = $3', [orgId, ret.return_id, src.entityId]);
    const bound = new Set(have.map(h => `${Number(h.account_id)}/${h.measurement}`));
    const measured = await measureAccounts(tx, { orgId, sourceEntityId: src.entityId, periodStart: ret.period_start, periodEnd: ret.period_end, returnId: ret.return_id });
    const sets = new Map();
    for (const d of defs) { const k = `${Number(d.account_id)}/${d.measurement}`; if (!sets.has(k)) sets.set(k, []); sets.get(k).push(d); }
    for (const [k, set] of sets) {
      if (bound.has(k)) continue;
      // The demo's limit, counted in whole sets under the locks above: a set past it is left for the next copy, untouched.
      if (maxSets !== null && done >= maxSets) { left += 1; continue; }
      const accountId = Number(set[0].account_id), measurement = set[0].measurement, prepared = [];
      try { for (const d of set) prepared.push(await reuseDefault(tx, { orgId, ret, src, d, activities, resolvers })); }
      catch (e) { if (!(e instanceof ValidationError)) throw e; skipped.push({ sourceEntityId: src.entityId, accountId, accountName: set[0].account_name, measurement, reason: e.message }); continue; }
      const version = baseVersion(measured.get(accountId).versions[measurement], [], measured.get(accountId).normalization);
      for (const p of prepared) await insertBinding(tx, { orgId, ret, src, accountId, measurement, p, override: false, version, source: 'default', sourceDetail: { defaultId: p.defaultId }, confidence: null, actor });
      copied += prepared.length;
      done += 1;
    }
  }
  return { copied, sets: done, left, skipped };
}
export const copyForward = (pool, args) => withTransaction(pool, async tx => {
  await lockTaxGraph(tx, args.orgId);
  await lockEntity(tx, args.orgId, args.entityId);
  return copyForwardIn(tx, args);
});

// A new inclusion edge (T1 includeBooks, inside its transaction, under the graph lock): the defaults of every company it brings in — the
// included company and its own included companies — join every open return whose graph now reaches them, the root of a nested chain
// too (Codex r2 B4) — only books whose every company on the path the person including them may open (canOpen), and only into returns
// that person may edit (canEdit(entityId), async: may open the return's company and write its tax mapping — Codex r3 R3-N2). A return
// skipped for that reason is listed in pendingReturns and is not read; someone who may edit it copies its defaults later from its
// mapping page. Each written return's company is locked here, ascending.
// maxSets (the public demo only): one limit shared by every return this edge copies into, as in copyForwardIn.
export async function copyForwardEdge(tx, { orgId, inclusionId, canOpen = () => true, canEdit = async () => true, actor, maxSets = null }) {
  const { rows } = await tx.query(`SELECT r.entity_id, r.return_id, s.source_entity_id, s.entities
      FROM tax_return r CROSS JOIN LATERAL tax_inclusion_sources(r.org_id, r.return_id) s
     WHERE r.org_id = $1 AND r.status = 'open' AND r.return_type = ANY($2) AND $3::bigint = ANY (s.path)
     ORDER BY r.entity_id, r.return_id, s.source_entity_id`, [orgId, BINDABLE_RETURN_TYPES, inclusionId]);
  const roots = new Map();
  for (const x of rows) {
    if (!x.entities.every(id => canOpen(Number(id)))) continue;
    const k = `${x.entity_id}/${x.return_id}`;
    if (!roots.has(k)) roots.set(k, { entityId: Number(x.entity_id), returnId: Number(x.return_id), sources: [] });
    roots.get(k).sources.push(Number(x.source_entity_id));
  }
  let copied = 0, sets = 0, left = 0;
  const skipped = [], pendingReturns = [];
  for (const r of roots.values()) {
    if (!canOpen(r.entityId) || !(await canEdit(r.entityId))) { pendingReturns.push({ entityId: r.entityId, returnId: r.returnId }); continue; }
    await lockEntity(tx, orgId, r.entityId);
    const out = await copyForwardIn(tx, { orgId, entityId: r.entityId, returnId: r.returnId, sourceEntityIds: r.sources, canOpen, actor,
      maxSets: maxSets === null ? null : maxSets - sets });
    copied += out.copied; sets += out.sets; left += out.left;
    skipped.push(...out.skipped);
  }
  return { copied, sets, left, skipped, pendingReturns };
}

// Re-resolve the owner and K-1 references of an open period (after T4 files the interests and K-1 records, or a record is corrected,
// superseded or made ineligible; tests inject resolvers). Every row naming a party is asked again (B5): a newly selected record fills its
// id and version; a changed selection replaces them; a selection that no longer holds is cleared and becomes pending. The slot key and
// pending follow; a destination, measurement or split never changes. Returns { updated }: rows whose references changed.
export async function resolveReferences(pool, { orgId, entityId, returnId, resolvers = T2_RESOLVERS }) {
  return withTransaction(pool, async tx => {
    const ret = await openReturn(tx, { orgId, entityId, returnId });
    let updated = 0;
    for (const [table, idCol, measurementCol] of [['tax_binding', 'binding_id', 'measurement'], ['tax_binding_line', 'binding_line_id', `'activity'::text AS measurement`]]) {
      const { rows } = await tx.query(`SELECT ${idCol} AS id, treatment, destination, ${measurementCol}, activity_id, interest_party_id, interest_id, interest_version, k1_issuer_party_id,
          k1_source_id, k1_source_version, pending FROM ${table} WHERE org_id = $1 AND return_id = $2 AND (interest_party_id IS NOT NULL OR k1_issuer_party_id IS NOT NULL)`, [orgId, ret.return_id]);
      for (const b of rows) {
        const refs = await resolveRefs(tx, { orgId, ret, interestPartyId: b.interest_party_id === null ? null : Number(b.interest_party_id),
          k1IssuerPartyId: b.k1_issuer_party_id === null ? null : Number(b.k1_issuer_party_id), resolvers });
        // The explanation too (Codex r2 hardening 3): pending → conflict or ineligible keeps no stale reason.
        const reasons = xs => JSON.stringify((xs ?? []).filter(p => ['interest', 'k1'].includes(p.kind)));
        const same = refs.interestId === (b.interest_id === null ? null : Number(b.interest_id)) && refs.interestVersion === b.interest_version
          && refs.k1SourceId === (b.k1_source_id === null ? null : Number(b.k1_source_id)) && refs.k1SourceVersion === b.k1_source_version
          && reasons(b.pending) === reasons(refs.pending);
        if (same) continue;
        const line = b.destination ? catalogFor(ret.ctx.returnType, ret.ctx.edition).byId.get(b.destination) ?? null : null;
        const slot = slotFor(ret.ctx, { treatment: b.treatment, line, measurement: b.measurement, activityId: b.activity_id === null ? null : Number(b.activity_id), interestId: refs.interestId });
        const pending = [...(b.pending ?? []).filter(p => !['interest', 'k1'].includes(p.kind)), ...refs.pending];
        await tx.query(`UPDATE ${table} SET interest_id = $3, interest_version = $4, k1_source_id = $5, k1_source_version = $6, slot_key = $7, pending = $8 WHERE org_id = $1 AND ${idCol} = $2`,
          [orgId, b.id, refs.interestId, refs.interestVersion, refs.k1SourceId, refs.k1SourceVersion, slot, JSON.stringify(pending)]);
        updated += 1;
      }
    }
    return { updated };
  });
}
