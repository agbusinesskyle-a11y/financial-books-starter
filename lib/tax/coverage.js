// lib/tax/coverage.js
// Coverage (spec §4.5 coverage rule, §13.1 T2): every account of the return's own books and of every included company's books — nested
// inclusions too (Codex t2-plan-r1 B4) — with a nonzero beginning or ending balance or ANY activity in the period (gross: an account whose
// postings net to zero still counts), and, on a cash-sensitive source, any account a linked settlement touches (B3), has a binding for each
// measurement it needs, and each bound measurement's partition is complete (lib/tax/partition.js). Before calling anything complete it
// rechecks what can change after a save (B5): each attributed transaction's version, each activity's eligibility for the period and the
// path, each owner or K-1 selection against the resolvers. Unknown is never zero: an uncovered, unresolved, stale, hidden or blocked source
// blocks, and a slot receiving anything incomplete has no total. "Mapped" is a mapping status only — not reviewed openings, reconciled
// cash or a reviewed tax treatment (Codex non-blocking 3). Reads only, from one consistent snapshot (Codex r2 B5): given a pool, coverage
// reads inside one REPEATABLE READ, READ ONLY transaction, so every query sees the same committed state; given a transaction's client it
// reads in that transaction (an acceptance recomputes under its locks). Stored bindings or attributions whose source is no longer reached
// through the live graph are reported as a blocked source of their own, never dropped (Codex r2 B5).
import { listBindings, listAttributions, inclusionSources, activitiesOf, setFingerprint, cashSensitive } from './bindings.js';
import { measureAccounts, measureLines, txnVersions } from './measure.js';
import { buildPartition, routingOf } from './partition.js';
import { catalogContext, isPl, effectiveIn, activityFits, checkTarget, SLOT_TREATMENTS } from './destinations.js';
import { ValidationError } from '../data/writes.js';
import { slotAuthority, roleOf, needsCash } from './authority.js';
import { listAssignments } from './providers.js';
import { catalogFor } from './catalog/index.js';
import { T2_RESOLVERS, referenceDrift } from './references.js';

export const STATUS_LABELS = { complete: 'Mapped', uncovered: 'Needs mapping', unresolved: 'Waiting on something', stale: 'Changed since mapped', hidden: 'You cannot open this company',
  blocked: 'Cannot be combined yet' };
const RANK = { complete: 0, unresolved: 1, stale: 2, uncovered: 3 };

// The measurements one measured account needs bound ([] when it is out of scope).
export function needsOf(m, { cashSensitive: cash }) {
  const inScope = m.postings > 0 || m.begin !== 0n || m.end !== 0n || (cash && m.cashTouched);
  if (!inScope) return [];
  if (isPl(m.type)) return ['activity'];
  const needs = [];
  if (m.begin !== 0n) needs.push('begin');
  if (m.end !== 0n) needs.push('end');
  // An equity account that moved: its activity becomes capital events (T4). A balance account at zero at both ends that moved (a
  // clearing account): its activity needs a disposition of its own — "not on the return" with the reason, or line attributions — since
  // a zero balance says nothing about what passed through it (B3).
  if (m.postings > 0 && (m.type === 'equity' || !needs.length)) needs.push('activity');
  // A cash-touched settlement candidate (Contracts 3) with nothing raw in the period — a December payment of a January document, say —
  // keeps its place too (Codex t2-r1 B4): its activity needs an explicit routing or disposition, which T3's cash layer applies to the cash
  // it recognizes; dropping it would let the return look completely mapped without it.
  if (!needs.length && cash && m.cashTouched) needs.push('activity');
  return needs;
}

// Stored pending reasons, except the owner and K-1 ones: those are asked again live (referenceDrift), so the reason shown is the current one.
const storedPending = x => (x.pending ?? []).filter(p => !['interest', 'k1'].includes(p.kind)).map(p => p.reason);
const rowOf = (b, problems) => ({ id: b.binding_id, targetKey: b.target_key, routing: routingOf(b), shareNum: b.share_num_text, shareDen: b.share_den_text, amountCents: b.amount_text, sourceVersion: b.source_version,
  problems: [...storedPending(b), ...problems] });
const attributionOf = (a, problems) => ({ id: a.binding_line_id, txnId: a.txn_id, lineNo: a.line_no, cents: BigInt(a.amount_text), txnVersion: a.txn_version, targetKey: a.target_key, routing: routingOf(a),
  problems: [...storedPending(a), ...problems] });
// Which treatments name a catalog line in their destination (Codex r2 N1): an equity event names an event kind, a guaranteed payment its
// kind, K-1 income and "not on the return" nothing.
const CATALOG_TREATMENTS = [...SLOT_TREATMENTS, 'cogs_tieout'];

// What may have changed under a saved row since it was saved (B5): the treatment against the account as it is NOW (its type, the
// measurement and the catalog — Codex t2-r1 B3: a whole binding follows new postings, so an account retyped after an earlier mapping must
// not keep feeding a line that a fresh save would refuse), its activity's eligibility and fit, the source's top activity, its owner and K-1
// selections.
async function liveProblems(db, { orgId, ret, ctx, src, row, accountType, activities, resolvers }) {
  const problems = [];
  try {
    checkTarget(ctx, { treatment: row.treatment, destination: row.destination ?? null, measurement: row.measurement ?? 'activity', accountType,
      interestPartyId: row.interest_party_id ?? null, k1IssuerPartyId: row.k1_issuer_party_id ?? null, memo: row.memo });
  } catch (e) {
    if (!(e instanceof ValidationError)) throw e;
    problems.push(`This mapping is no longer valid for the account as it is now: ${e.message} Map the account again.`);
  }
  const catalogBacked = CATALOG_TREATMENTS.includes(row.treatment);
  const line = catalogBacked && row.destination ? catalogFor(ctx.returnType, ctx.edition).byId.get(row.destination) ?? null : null;
  if (catalogBacked && row.destination && !line) problems.push(`${row.destination} is not a line of the ${ctx.edition} forms any more.`);
  if (row.activity_id !== null && row.activity_id !== undefined) {
    const a = activities.find(x => x.activity_id === Number(row.activity_id));
    if (!a || !effectiveIn(a, ret)) problems.push(`${a?.name ?? 'Its activity'} is not in effect in this period any more.`);
    else if (line && line.instanceDims.includes('activity') && !activityFits(line, a)) problems.push(`${a.name} is no longer reported on this form.`);
    if (!src.own && Number(row.activity_id) !== src.topActivityId) problems.push('The inclusion now joins another activity: map these books again.');
  }
  problems.push(...await referenceDrift(db, { orgId, ret, row, resolvers }));
  return problems;
}

// canOpen(entityId): whether the person may open a company (spec §11); every company on an inclusion path must be openable.
export async function coverage(db, args) {
  if (typeof db.release === 'function' || typeof db.connect !== 'function') return coverageIn(db, args);
  const c = await db.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const out = await coverageIn(c, args);
    await c.query('COMMIT');
    return out;
  } catch (error) { await c.query('ROLLBACK').catch(() => {}); throw error; } finally { c.release(); }
}
async function coverageIn(db, { orgId, entityId, returnId, canOpen = () => true, resolvers = T2_RESOLVERS }) {
  const { rows: [r] } = await db.query(`SELECT return_id, entity_id, status, return_type, form_edition, period_start::text AS period_start, period_end::text AS period_end, tax_method, book_basis
    FROM tax_return WHERE org_id = $1 AND entity_id = $2 AND return_id = $3`, [orgId, entityId, returnId]);
  if (!r) return null;
  const ret = { ...r, return_id: Number(r.return_id), entity_id: Number(r.entity_id) };
  const ctx = catalogContext(ret);
  const scope = { orgId, entityId, returnId };
  // Sequential on purpose: one client, one snapshot.
  const bindings = await listBindings(db, scope), attributions = await listAttributions(db, scope), graph = await inclusionSources(db, { orgId, returnId });
  const assignmentRows = await listAssignments(db, scope), activities = await activitiesOf(db, orgId, ret.entity_id);
  const { rows: [own] } = await db.query('SELECT name FROM entity WHERE org_id = $1 AND entity_id = $2', [orgId, entityId]);
  const assignments = new Map(assignmentRows.map(a => [a.slot_key, a.provider_kind]));
  const sources = [{ entityId: ret.entity_id, name: own.name, own: true, path: [], entities: [], topActivityId: null, activityName: null, bookBasis: ret.book_basis, periodMatches: true },
    ...graph.map(s => ({ ...s, own: false }))];
  // Stored rows whose source (with its stored path) the live graph no longer reaches: one blocked source each, never dropped (B5). The
  // graph lock keeps this from happening through T2's own writes; it is reported if the graph changed some other way (a disregarded period
  // of a company in the middle of a chain re-typed, for instance).
  const reached = new Set(sources.map(s => `${s.entityId}|${s.path.join(',')}`));
  const stranded = new Map();
  for (const x of [...bindings, ...attributions]) {
    const k = `${x.source_entity_id}|${x.inclusion_path.join(',')}`;
    if (!reached.has(k) && !stranded.has(k)) stranded.set(k, { entityId: x.source_entity_id, path: x.inclusion_path });
  }
  for (const x of stranded.values()) {
    const { rows: [n] } = await db.query('SELECT name FROM entity WHERE org_id = $1 AND entity_id = $2', [orgId, x.entityId]);
    sources.push({ entityId: x.entityId, name: n?.name ?? 'A company', own: false, path: x.path, entities: [x.entityId], topActivityId: null, activityName: null, bookBasis: null,
      periodMatches: false, stranded: true });
  }
  const totals = { accounts: 0, complete: 0, uncovered: 0, unresolved: 0, stale: 0, hidden: 0, blocked: 0, recognitionPending: 0 };
  for (const s of sources) {
    s.allowed = s.own || s.entities.every(x => canOpen(x));
    s.cashSensitive = cashSensitive(ret, s);
    s.recognition = s.cashSensitive ? 'cash_layer' : 'books';
    s.accounts = [];
    // Spec §11: a child's books are read through the parent return only by someone who may open it — and every company on its path. Not
    // measured at all here; the return stays blocked for this viewer.
    if (!s.allowed) { s.status = 'hidden'; totals.hidden += 1; continue; }
    if (s.stranded) { s.status = 'blocked'; s.reason = 'Mapped here, but its books no longer reach this return through an inclusion. Restore the inclusion on the tax setup page; its mappings can then be cleared or kept from this page.'; totals.blocked += 1; continue; }
    // A path that does not cover the whole period (an initial mid-year child period) cannot be combined yet (B4): blocked, never omitted.
    if (!s.periodMatches) { s.status = 'blocked'; totals.blocked += 1; continue; }
    s.status = 'measured';
    if (s.cashSensitive) totals.recognitionPending += 1;
    const measured = await measureAccounts(db, { orgId, sourceEntityId: s.entityId, periodStart: ret.period_start, periodEnd: ret.period_end, returnId });
    const mine = bindings.filter(b => b.source_entity_id === s.entityId), lines = attributions.filter(a => a.source_entity_id === s.entityId);
    const withLines = [...new Set(lines.map(a => a.account_id))];
    const live = withLines.length ? await measureLines(db, { orgId, sourceEntityId: s.entityId, accountIds: withLines, periodStart: ret.period_start, periodEnd: ret.period_end, returnId }) : new Map();
    const versionsNow = await txnVersions(db, { orgId, txnIds: [...new Set(lines.map(a => a.txn_id))] });
    for (const m of measured.values()) {
      const bound = mine.filter(b => b.account_id === m.accountId), attr = lines.filter(a => a.account_id === m.accountId);
      const needs = needsOf(m, { cashSensitive: s.cashSensitive });
      if (!needs.length && !bound.length && !attr.length) continue;
      const measurements = [...new Set([...needs, ...bound.map(b => b.measurement), ...(attr.length ? ['activity'] : [])])];
      const problemsOf = new Map();
      for (const x of [...bound, ...attr]) problemsOf.set(x, await liveProblems(db, { orgId, ret, ctx, src: s, row: x, accountType: m.type, activities, resolvers }));
      // An account whose lines were asked for and none came back has a known EMPTY line set (its only line deleted or moved): [] — every
      // attribution is then an orphan, stale, and the page still shows it with its Remove button (Codex r2 N2). null means not asked.
      const lineRows = withLines.includes(m.accountId) ? live.get(m.accountId) ?? [] : null;
      const results = {};
      for (const ms of measurements) {
        const atts = ms === 'activity' ? attr.map(a => attributionOf({ ...a, txn_version: a.txn_version }, problemsOf.get(a))) : [];
        // A changed transaction context with the same cents still makes the attribution stale: compare with the version now (B5).
        const linesNow = ms === 'activity' && lineRows !== null ? lineRows.map(l => ({ ...l, txnVersion: versionsNow.get(l.txnId) ?? l.txnVersion })) : null;
        results[ms] = buildPartition({ entityId: s.entityId, accountId: m.accountId, measurement: ms,
          measured: { cents: m[ms], version: m.versions[ms], lineGroups: m.lineGroups, normalization: m.normalization }, lines: atts.length ? linesNow : null,
          rows: bound.filter(b => b.measurement === ms).map(b => rowOf(b, problemsOf.get(b))), attributions: atts });
        results[ms].setFingerprint = setFingerprint(bound.filter(b => b.measurement === ms));
      }
      let status = 'complete';
      const worse = x => { if (RANK[x] > RANK[status]) status = x; };
      for (const n of needs) worse(results[n].status);
      for (const ms of measurements) if (!needs.includes(ms) && results[ms].status !== 'uncovered') worse(results[ms].status);
      totals.accounts += 1;
      totals[status] += 1;
      s.accounts.push({ ...m, needs, bindings: bound, attributions: attr, results, lines: lineRows, status });
    }
  }
  totals.blocking = totals.uncovered + totals.unresolved + totals.stale + totals.hidden + totals.blocked;
  // The stored routings of every source that could not be read (hidden, blocked, stranded): their amounts are unknown, but WHICH slots they
  // feed is known, and those slots must not publish a visible subtotal as their result (Codex r3 B1).
  const unreadKeys = new Set(sources.filter(s => s.status !== 'measured').map(s => `${s.entityId}|${s.path.join(',')}`));
  const unreadRoutings = [...bindings, ...attributions].filter(x => unreadKeys.has(`${x.source_entity_id}|${x.inclusion_path.join(',')}`));
  return { ret, ctx, sources, totals, assignments, unreadRoutings, provisional: ctx.provisional };
}

// Every routed allocation with its slot and its ONE owner (Codex r2 B1). A slot's owner is T1's assignment, else the default authority —
// except that a books-owned slot any of whose contributions needs cash conversion (a cash-basis source, or an income or expense line of a
// cash-method return) is the cash layer's as a whole: then every contribution, the accrual ones too, is the cash layer's input and the cash
// layer publishes the one result. An assignment to the books with such a contribution is a mismatch: the slot has no total until the cash
// layer is assigned. A COGS comparison is keyed by its activity (Codex r2 hardening 2).
// → [{ key, provider, role, member, complete, problem }] where member = { kind, id, cents, rowLabel, sourceEntityId, accountId, measurement, activityId }.
export function routeAllocations(cov) {
  const catalog = catalogFor(cov.ctx.returnType, cov.ctx.edition), routed = [];
  for (const s of cov.sources) for (const a of s.accounts ?? []) for (const [ms, p] of Object.entries(a.results)) {
    const byKey = new Map([...a.bindings.map(b => [`binding:${b.binding_id}`, b]), ...a.attributions.map(x => [`line:${x.binding_line_id}`, x])]);
    for (const al of p.allocations) {
      const b = byKey.get(`${al.kind}:${al.id}`);
      if (!b || !CATALOG_TREATMENTS.includes(b.treatment)) continue;
      const line = b.destination ? catalog.byId.get(b.destination) : null;
      if (!line || (b.treatment !== 'cogs_tieout' && !b.slot_key)) continue;
      const activityId = b.activity_id === null || b.activity_id === undefined ? null : Number(b.activity_id);
      routed.push({ key: b.treatment === 'cogs_tieout' ? `${b.destination}|tieout|act:${activityId ?? '-'}` : b.slot_key, line, treatment: b.treatment,
        cash: needsCash(line, { taxMethod: cov.ret.tax_method, sourceBookBasis: s.bookBasis }), complete: p.status === 'complete',
        member: { kind: al.kind, id: al.id, cents: al.cents, rowLabel: b.row_label ?? null, sourceEntityId: s.entityId, accountId: a.accountId, measurement: ms, activityId } });
    }
  }
  // A routing of a source that could not be read is an unknown member of its slot (Codex r3 B1): the slot then has no owner to publish
  // for and no total — its visible contributions are never exported as the slot's result, and its owner never changes because a
  // contributor (a cash-basis child, say) is out of view.
  for (const b of cov.unreadRoutings ?? []) {
    if (!CATALOG_TREATMENTS.includes(b.treatment) || !b.destination || (b.treatment !== 'cogs_tieout' && !b.slot_key)) continue;
    const line = catalog.byId.get(b.destination);
    if (!line) continue;
    const activityId = b.activity_id === null || b.activity_id === undefined ? null : Number(b.activity_id);
    routed.push({ key: b.treatment === 'cogs_tieout' ? `${b.destination}|tieout|act:${activityId ?? '-'}` : b.slot_key, line, treatment: b.treatment, cash: false, complete: false, unread: true,
      // Nothing of the unread books is exposed: no amount, no account.
      member: { kind: 'unread', id: null, cents: null, rowLabel: null, sourceEntityId: b.source_entity_id, accountId: null, measurement: null, activityId: null } });
  }
  const bySlot = new Map();
  for (const r of routed) { if (!bySlot.has(r.key)) bySlot.set(r.key, []); bySlot.get(r.key).push(r); }
  for (const [key, list] of bySlot) {
    const { authority, problem } = slotAuthority(list[0].line, { taxMethod: cov.ret.tax_method, assignment: cov.assignments.get(key) ?? null, anyCash: list.some(r => r.cash && SLOT_TREATMENTS.includes(r.treatment)) });
    const unread = list.some(r => r.unread) ? 'Books this slot is mapped from cannot be read here (a company you cannot open, or books that cannot be combined yet): it has no owner or total until they can.' : null;
    // A slot with a problem has no owner (Codex r4): its provider is null here too, not only in allocationOwners.
    for (const r of list) Object.assign(r, roleOf({ treatment: r.treatment, authority }), { problem: unread ?? problem }, unread ?? problem ? { provider: null } : {});
  }
  return routed;
}
// Who consumes each allocation: Map `${sourceEntityId}/${accountId}/${measurement}/${kind}:${id}` → provider (null for comparisons and for
// allocations that feed no slot). T3 passes ownerOf = a => owners.get(key) to toPacketParts.
export function allocationOwners(cov) {
  const out = new Map();
  for (const r of routeAllocations(cov)) {
    const m = r.member;
    out.set(`${m.sourceEntityId}/${m.accountId}/${m.measurement}/${m.kind}:${m.id}`, r.role === 'comparison' || r.problem ? null : r.provider);
  }
  return out;
}

// What the books send to each slot, by role (B1), in exact cents, with each member's provenance (binding or line, statement-row label, source,
// activity):
//   authoritative  Map slot → { cents, members } — the books' measurement IS the tax amount (books authority, no cash conversion needed);
//   inputs         Map provider → Map slot → { cents, members } — what the cash layer or the COGS workpaper consumes;
//   comparisons    Map slot → { cents, members } — shown beside another provider's result, never the tax amount;
//   problems       Map slot → reason — a slot whose owner cannot take its contributions (no cents anywhere for it).
// A slot receiving anything from a partition that is not complete has cents null — never a partial sum. complete: the whole return is
// covered (no uncovered, unresolved, stale, hidden or blocked source, no slot problem); an independent slot keeps its total while another is
// blocked, so a pending owner item blocks only what depends on it.
export function destinationTotals(cov) {
  const authoritative = new Map(), inputs = new Map(), comparisons = new Map(), problems = new Map();
  const add = (map, key, member, ok) => {
    const cur = map.get(key) ?? { cents: 0n, members: [] };
    cur.members.push(member);
    cur.cents = ok && cur.cents !== null && member.cents !== null ? cur.cents + member.cents : null;
    map.set(key, cur);
  };
  for (const r of routeAllocations(cov)) {
    if (r.problem) { problems.set(r.key, r.problem); add(authoritative, r.key, r.member, false); continue; }
    if (r.role === 'authoritative') add(authoritative, r.key, r.member, r.complete);
    else if (r.role === 'input') { if (!inputs.has(r.provider)) inputs.set(r.provider, new Map()); add(inputs.get(r.provider), r.key, r.member, r.complete); }
    else if (r.role === 'comparison') add(comparisons, r.key, r.member, r.complete);
  }
  return { authoritative, inputs, comparisons, problems, complete: cov.totals.blocking === 0 && problems.size === 0 };
}
