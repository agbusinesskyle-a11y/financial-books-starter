// lib/tax/engine/compute.js
// The T3 engine (spec §5.2-§5.8, §13 T3): one standalone Form 1065 or Form 1120-S return computed as a DRAFT from its live sources, in one
// consistent snapshot. Order (spec §5.4): each destination slot takes the amount of its ONE provider (T2 Contracts 1: T1's assignment, else
// the default authority; lib/tax/coverage.js routeAllocations) — the books (bound measurements with the four sign facts applied once), the
// cash layer (lib/tax/cash.js), the COGS workpaper (lib/tax/cogs.js), a typed manual item (lib/tax/manual.js); every provider's result is a
// T1 packet (lib/tax/providers.js validatePacket) whose book-derived portions come from T2's PROVED adapter (lib/tax/partition.js
// toPacketParts: each partition rebuilt from the saved rows over an independent measurement, carrying its manifest version and
// normalization; packets of one source built from different manifests are refused, sameBase), and collections are summed once by T1's
// aggregate(), so two providers never add on top of each other — then accepted delta adjustments apply (lib/tax/adjustments.js, and engine
// timing adjustments on an accrual return, only on slots the books own), then the catalog formulas compute every total
// (lib/tax/engine/formulas.js), then the M-1 bridge (bridge.js) fills Schedule M-1 and is checked against the return's own income
// reconciliation, then the checks (spec §5.8).
// Unknown is never zero: an unmapped account leaves every total it could reach unresolved; a slot whose sources are incomplete, stale,
// unread, blocked by an undecided closing candidate, waiting on a proposal, a typed item, a stale decision or a later stage has no amount,
// and neither has anything computed from it; a line nothing routes to is a KNOWN zero only while the return's books are completely mapped.
// Saved decisions are reconciled with the sources as they are now under one invariant: a closing classification, a timing review (the next
// and earlier periods' included, found by the transaction and owning return SAVED with it) or a COGS movement class (lib/tax/cogs.js) that
// no longer matches its source stays listed, is frozen into the revision, and holds what it decided unknown until a person clears it,
// whatever happened to the source (redated, renumbered, removed, out of coverage, its account retyped). Remembered accounts are held by
// hold (below); a stale decision's current legs by the same authority rule (a comparison route is never a tax destination).
// Independent schedules keep their amounts (T2 "Stage after T2"). Nothing here writes; finalization is stage T4.
// Books on the cash basis (a period's book_basis 'cash'): Schedule L, net income per books and every book amount the M-1 compares are the
// books' own cash basis (cashbasis.js); the slots they feed belong to the cash layer as a whole (T2 Contracts 1), balance lines taking the
// cash-basis balances and income and expense lines the tax recognition.
// Refused (with the reason, computing nothing): a return type other than 1065/1120-S, an edition with no catalog (spec §4.3: a 2026 period
// computes nothing until the 2026 catalog ships — never the 2025 one), an accrual-method return on cash-basis books, and a return that
// includes other companies' books (combined returns and their eliminations are stage T4).
import { createHash } from 'node:crypto';
import { catalogFor, EDITIONS, applicability } from '../catalog/index.js';
import { coverage, routeAllocations, allocationOwners } from '../coverage.js';
import { listAssignments, validatePacket, aggregate, collectionKey, parseSlotKey } from '../providers.js';
import { splitByShares, toPacketParts, sameBase } from '../partition.js';
import { measureAccounts, measureLines } from '../measure.js';
import { approvedAllOf } from '../manifest.js';
import { slotScopeProblem } from '../open-return.js';
import { SLOT_TREATMENTS, effectiveIn } from '../destinations.js';
import { closingCandidates, blockedByCandidates, blockedDomains } from '../classify.js';
import { cashRecognition, accrualTiming, REVIEW_KINDS } from '../cash.js';
import { cogsResults, listWorkpapers } from '../cogs.js';
import { manualNeeds, listManualItems, K1_ANSWER, t3Lines, isEngineLine } from '../manual.js';
import { listAdjustments, proposalsFor, mixedExemptGroup } from '../adjustments.js';
import { evaluate, formulaOrder, semanticOf, polarityOf, measurementsOf } from './formulas.js';
import { bookNetIncome, openingsOf } from './books.js';
import { cashBasisMeasure } from './cashbasis.js';
import { bridgeRows, M1, M1_ENGINE } from './bridge.js';

export const ENGINE_VERSION = 'tax-t3-1';
const md5 = text => createHash('md5').update(text).digest('hex');
const s = c => (c === null || c === undefined ? null : c.toString());
const json = v => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x));
// The catalog a revision is computed with, as a hash of its lines (spec §4.3 catalog_hash).
export const catalogHash = catalog => md5(JSON.stringify(catalog.lines));

// The proved book portions one provider takes from one partition for one slot (Codex t3-plan-r1 B11): toPacketParts rebuilds the
// partition from the SAVED rows over the independent measurement and refuses anything else (other shares or targets, another
// normalization, a residual that overlaps an attributed line) even when the totals conserve; only the allocations of this slot that
// allocationOwners gives this provider are taken. → { consumedSlices, sourceRefs, cents }; throws with the reason.
export function bookParts({ partition, provider, memberIds, owners, measured, lines, approved }) {
  const key = al => `${partition.source.entity}/${partition.source.account}/${partition.source.measurement}/${al.kind}:${al.id}`;
  return toPacketParts(partition, { provider, ownerOf: al => (memberIds.has(`${al.kind}:${al.id}`) && owners.get(key(al)) === provider ? provider : null), measured, lines, approved });
}
// The packets of one computation, checked as a set before they are summed: packets of one source must name one partition manifest
// (sameBase). → the problems, each with the partition ids it names.
export function packetSetProblems(packets) {
  return sameBase(packets).map(p => ({ problem: p, id: p.slice(0, p.indexOf(':')) }));
}

// computeReturn(pool or client, { orgId, entityId, returnId, canOpen }) → the draft result (see computeIn). Given a pool it reads in one
// REPEATABLE READ, READ ONLY transaction; given a client, in the caller's transaction (a write that recomputes under its locks).
export async function computeReturn(db, args) {
  if (typeof db.release === 'function' || typeof db.connect !== 'function') return computeIn(db, args);
  const c = await db.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const out = await computeIn(c, args);
    await c.query('COMMIT');
    return out;
  } catch (error) { await c.query('ROLLBACK').catch(() => {}); throw error; } finally { c.release(); }
}

export async function computeIn(db, { orgId, entityId, returnId, canOpen = () => true }) {
  const { rows: [r] } = await db.query(`SELECT r.return_id, r.entity_id, r.status, r.return_type, r.form_edition, r.period_start::text AS period_start, r.period_end::text AS period_end, r.tax_method,
      r.book_basis, r.opening_state, r.initial, r.predecessor_baseline_id, e.name AS entity_name FROM tax_return r JOIN entity e ON e.org_id = r.org_id AND e.entity_id = r.entity_id
     WHERE r.org_id = $1 AND r.entity_id = $2 AND r.return_id = $3`, [orgId, entityId, returnId]);
  if (!r) return null;
  const ret = { ...r, return_id: Number(r.return_id), entity_id: Number(r.entity_id), form_edition: Number(r.form_edition) };
  const refuse = refusal => ({ ret, refused: refusal, engineVersion: ENGINE_VERSION });
  if (!['form_1065', 'form_1120s'].includes(ret.return_type)) return refuse(ret.return_type === 'disregarded'
    ? 'A disregarded company’s books are computed on the return that includes them.' : 'Tax Books computes Form 1065 and Form 1120-S returns in this stage; the household return is a later stage.');
  if (!EDITIONS.includes(ret.form_edition)) return refuse(`The ${ret.form_edition} forms are not in the app yet: this period computes nothing until the ${ret.form_edition} catalog ships (its mappings stay provisional and are checked again then).`);
  if (ret.book_basis === 'cash' && ret.tax_method === 'accrual') return refuse('An accrual-method return on cash-basis books is not computed in this stage.');
  const { rows: [inc] } = await db.query('SELECT count(*)::int AS n FROM activity_inclusion WHERE org_id = $1 AND return_id = $2', [orgId, ret.return_id]);
  if (inc.n) return refuse('This return includes other companies’ books: a combined return and its eliminations are computed in stage T4.');

  const catalog = catalogFor(ret.return_type, ret.form_edition), ctx = { returnType: ret.return_type, edition: ret.form_edition };
  formulaOrder(catalog);
  const reach = t3Lines(catalog);
  const safeCk = key => { try { return collectionKey(key, ctx); } catch { return null; } };
  const cov = await coverage(db, { orgId, entityId, returnId: ret.return_id, canOpen });
  const own = cov.sources[0];
  const accounts = new Map((own.accounts ?? []).map(a => [a.accountId, a]));
  const { rows: names } = await db.query('SELECT account_id, name FROM account WHERE org_id = $1 AND entity_id = $2', [orgId, entityId]);
  const accountName = id => accounts.get(id)?.name ?? names.find(n => Number(n.account_id) === id)?.name ?? `Account ${id}`;
  const routed = routeAllocations(cov);
  // Whether a slot's provider CONSUMES a routed book amount (Codex t3-plan-r7 R7-2): the books where they are the authority; the cash layer's
  // inputs; a COGS workpaper's inputs only while that activity's workpaper is reconstructed from them (a reviewed workpaper types its lines).
  // A comparison (a book amount beside a typed or assigned line, book COGS by line 8) is never consumed: its incompleteness or staleness is
  // the book side's — the bridge's — and never the independent tax amount's. Used alike by the slot initialization, hold and the packets.
  const paperPaths = new Map((await listWorkpapers(db, { orgId, returnId: ret.return_id })).map(w => [w.activity_id, w.path]));
  const consumes = (role, provider, activityId) => role === 'authoritative' || (role === 'input' && (provider !== 'cogs_workpaper' || paperPaths.get(Number(activityId)) !== 'reviewed'));
  const consumesRoute = x => consumes(x.role, x.provider, x.member.activityId);
  const candidates = await closingCandidates(db, { orgId, ret });
  const blocked = blockedByCandidates(candidates);
  const assignments = await listAssignments(db, { orgId, entityId, returnId: ret.return_id });
  // The book amount of one routed allocation: the books as posted (accrual books), or the account's cash-basis measurement split as its
  // bindings route it (cash-basis books: whole or by share — T2 refuses dollar splits and single lines there).
  const cb = ret.book_basis === 'cash' ? await cashBasisMeasure(db, { orgId, ret }) : null;
  const shares = new Map();
  const bookLedger = (accountId, measurement, kind, id, asPosted) => {
    if (!cb) return asPosted;
    if (kind !== 'binding') return null;
    const key = `${accountId}/${measurement}`;
    if (!shares.has(key)) {
      const a = accounts.get(accountId), cents = cb.get(accountId)?.[measurement] ?? 0n;
      const rows = a ? a.bindings.filter(b => b.measurement === measurement).sort((x, y) => x.binding_id - y.binding_id) : [];
      const parts = rows.some(b => b.amount_text) ? rows.map(() => null) : rows.some(b => b.share_num_text) ? splitByShares(cents, rows.map(b => ({ num: BigInt(b.share_num_text), den: BigInt(b.share_den_text) }))) : [cents];
      shares.set(key, new Map(rows.map((b, i) => [b.binding_id, parts[i]])));
    }
    return shares.get(key).get(id) ?? null;
  };
  const taint = { activity: [], balance: [] };
  const forced = new Map(); // collection key → reason: unknown whatever the providers say
  const force = (key, reason) => { if (!key) { taint.activity.push(reason); return; } if (!forced.has(key)) forced.set(key, []); forced.get(key).push(reason); };
  const problems = []; // { code, message } errors found while computing
  const bridgeWhy = [];
  // Holding a saved decision's account (Codex t3-plan-r4, t3-plan-r5 R5-2, R5-3): in each domain SAVED with the decision (income: the
  // account's activity; balance: its beginning and ending balances — never the account's type as it is now), measurement by measurement:
  //   a tax destination (a route the books or the cash layer own, or a COGS workpaper input) → that slot is unknown;
  //   a comparison only (a book amount beside a typed or assigned line, book COGS beside line 8, "not on the return") → only the book side
  //     and the income reconciliation are unknown — the independent tax amount keeps its value;
  //   neither (the account left coverage, the measurement is not mapped, the account is uncovered) → the whole domain: every income total,
  //     or every balance total — unknown, never a complete zero.
  // Only clearing the decision releases it. Every hold is listed (holds) and frozen with the revision.
  const holds = [];
  const MEASURES = { income: ['activity'], balance: ['begin', 'end'] };
  const BESIDE = ['not_tax', 'cogs_tieout'];
  const hold = (id, reason, domains, source) => {
    const a = accounts.get(id), ds = domains?.length ? [...new Set(domains)] : ['income', 'balance'];
    holds.push({ source, accountId: id, domains: ds, reason });
    for (const d of ds) for (const m of MEASURES[d]) {
      const routes = routed.filter(x => x.member.kind !== 'unread' && x.member.accountId === id && x.member.measurement === m);
      const tax = routes.filter(consumesRoute);
      const beside = routes.some(x => !consumesRoute(x)) || (a?.bindings ?? []).some(b => b.measurement === m && BESIDE.includes(b.treatment));
      for (const x of tax) force(safeCk(x.key), reason);
      if (beside) bridgeWhy.push(reason);
      if ((!tax.length && !beside) || a?.status === 'uncovered') (d === 'income' ? taint.activity : taint.balance).push(reason);
    }
  };

  // ---- 1. Slots and their members (every routed allocation), with the income and expense booked into each (for the bridge). A routing of
  //         books that cannot be read here (stored, but its source no longer reaches this return) leaves its slot unknown, never absent.
  const slots = new Map();
  const slotOf = key => {
    if (!slots.has(key)) {
      const fieldId = parseSlotKey(key).fieldId;
      slots.set(key, { key, fieldId, line: catalog.byId.get(fieldId), provider: null, members: [], value: null, rows: null, reasons: [], plCents: 0n, plKnown: true, known: true, activityId: null });
    }
    return slots.get(key);
  };
  const tieouts = new Map(), notTax = [], t4 = new Set();
  for (const x of routed) {
    if (x.treatment === 'cogs_tieout') continue;
    const sl = slotOf(x.key);
    if (x.member.kind === 'unread') { sl.known = false; sl.plKnown = false; sl.reasons.push(x.problem ?? 'Books this slot is mapped from cannot be read here.'); continue; }
    const a = accounts.get(x.member.accountId);
    if (x.problem) { sl.known = false; sl.reasons.push(x.problem); }
    else sl.provider = x.provider;
    const book = x.member.cents === null ? null : bookLedger(x.member.accountId, x.member.measurement, x.member.kind, x.member.id, x.member.cents);
    sl.members.push({ ...x.member, book, role: x.role, treatment: x.treatment, complete: x.complete, accountName: a?.name ?? null, pl: Boolean(a?.pl) });
    if (a?.pl) { if (book === null || !x.complete) sl.plKnown = false; else sl.plCents += book; }
    // A closing candidate's account (undecided or stale): its book amount is unknown; the slot's TAX amount only where its provider CONSUMES
    // this book amount (consumesRoute, Codex t3-r1 B4: a reviewed COGS workpaper's old input keeps role 'input' but is not consumed, so the
    // entered purchases stand) — a comparison route beside a typed or assigned line leaves that line's own amount alone (hold sends the book
    // side to the bridge).
    if (blocked.has(x.member.accountId)) { sl.plKnown = false; if (consumesRoute(x)) { sl.known = false; sl.reasons.push(blocked.get(x.member.accountId)); } }
    // An incomplete or stale routing (a dollar split the activity moved away from, a changed normalization): the slot's own amount is unknown
    // only where its provider consumes this book amount; otherwise the book side alone waits (the mapping problem stays a coverage error).
    if (!x.complete) {
      const why = `${a?.name ?? 'An account'}: ${(a?.results?.[x.member.measurement]?.reasons ?? []).join(' ') || 'its mapping is not complete'}`;
      sl.plKnown = false;
      if (consumesRoute(x)) { sl.known = false; sl.reasons.push(why); } else bridgeWhy.push(why);
    }
  }
  // Allocations that name no slot: book COGS beside line 8 (tie-out), "not on the return", and the T4 treatments.
  for (const a of own.accounts ?? []) for (const [ms, p] of Object.entries(a.results)) {
    const byKey = new Map([...a.bindings.map(b => [`binding:${b.binding_id}`, b]), ...a.attributions.map(x => [`line:${x.binding_line_id}`, x])]);
    for (const al of p.allocations) {
      const b = byKey.get(`${al.kind}:${al.id}`);
      if (!b) continue;
      const book = al.cents === null ? null : bookLedger(a.accountId, ms, al.kind, al.id, al.cents);
      if (b.treatment === 'cogs_tieout' && a.pl) {
        const id = b.activity_id === null || b.activity_id === undefined ? null : Number(b.activity_id);
        const t = tieouts.get(id) ?? { cents: 0n, known: true, members: [] };
        if (book === null || p.status !== 'complete' || blocked.has(a.accountId)) t.known = false; else t.cents += book;
        t.members.push({ accountId: a.accountId, accountName: a.name, cents: book });
        tieouts.set(id, t);
      }
      if (b.treatment === 'not_tax' && a.pl && ms === 'activity') {
        // Not on the return: its book amount is the bridge's (never a tax amount), so its uncertainty is the bridge's too.
        if (book === null || p.status !== 'complete' || blocked.has(a.accountId)) bridgeWhy.push(`${a.name} is not on the return, and its book amount is not known yet.`);
        else notTax.push({ label: `Not on the return: ${a.name}${b.memo ? ` (${b.memo})` : ''}`, cents: book, accountId: a.accountId });
      }
      if (['guaranteed_payment', 'equity_event', 'k1_booked'].includes(b.treatment)) t4.add(b.treatment);
    }
  }
  // A catalog routing whose reference is not selected (Codex t3-r1 B1): an owner with no interest on file for the period, a selected owner
  // made ineligible and re-resolved, an activity left pending by copy-forward. T2 keeps the mapping with no slot (slot_key null), so
  // routeAllocations cannot name its instance — but the amount IS routed to that line, and the line, its totals and its balance sheet must not
  // publish complete without it. It is an unresolved member on a placeholder instance of the destination (interest i:pending, activity
  // act:pending), unknown, so every total that aggregates the line is unknown too; a comparison routing waits on the book side only.
  // Nothing here selects an interest or allocates anything: a person resolves the reference, and the placeholder gives way to the real member.
  for (const a of own.accounts ?? []) for (const b of [...a.bindings, ...a.attributions.map(x => ({ ...x, measurement: 'activity' }))]) {
    if (!SLOT_TREATMENTS.includes(b.treatment) || !b.destination || b.slot_key) continue;
    const line = catalog.byId.get(b.destination);
    if (!line) continue;
    const why = `${a.name}: its mapping to ${line.label} names a reference that is not selected for this period (${(b.pending ?? []).map(x => x.reason).join(' ') || (a.results?.[b.measurement]?.reasons ?? []).join(' ') || 'the owner or activity is not on file'}). Until it is, that line is not known.`;
    problems.push({ code: 'reference_pending', message: why });
    if (b.treatment === 'manual_feed') { bridgeWhy.push(why); continue; }
    const dims = line.instanceDims.map(d => `${d}=${d === 'activity' ? (b.activity_id === null || b.activity_id === undefined ? 'act:pending' : `act:${Number(b.activity_id)}`) : d === 'interest' ? 'i:pending' : `${d}:pending`}`).sort();
    force(safeCk([line.id, ...dims, b.measurement].join('|')), why);
  }
  // Source completeness is read from the PARTITION (Codex t3-r5 R5-1): an activity has a disposition only when every portion of it has one —
  // a binding for the residual (whole, by share or by dollars; its own freshness is the slot logic's concern), or every posting line attributed.
  // Lines attributed with the rest left loose (T2 reports the partition unresolved with an unassigned residual, nonzero or net zero) leave the
  // rest undisposed: it could still reach any destination the account's activity can feed.
  const undisposedActivity = a => {
    const p = a.results?.activity;
    if (!p) return false;
    if (p.status === 'uncovered') return true;
    if (p.allocations.some(al => al.kind === 'binding')) return false;
    const taken = new Set((p.attributed ?? []).map(x => `${x.txn}:${x.line}`));
    return (a.lines ?? []).some(l => !taken.has(`${l.txnId}:${l.lineNo}`)) || a.activity - (p.attributed ?? []).reduce((t, x) => t + x.cents, 0n) !== 0n;
  };
  // Accounts whose destination is unknown: every total they could reach is unknown (never zero).
  for (const a of own.accounts ?? []) {
    const missing = a.needs.filter(n => a.results[n]?.status === 'uncovered');
    if (a.pl && missing.includes('activity')) taint.activity.push(`${a.name} is not mapped yet.`);
    else if (a.pl && undisposedActivity(a)) taint.activity.push(`${a.name}: part of its activity has no destination yet (postings not attributed, and no binding for the rest).`);
    if (!a.pl && (missing.includes('begin') || missing.includes('end'))) taint.balance.push(`${a.name}’s balance is not mapped yet.`);
  }
  // Cost of goods sold completeness (Codex t3-r3 R3-4, t3-r4 R4-1): an inventory account whose activity has gross movements (purchases in,
  // relief to book COGS out) and no disposition — whatever its balances, mapped or not — could still be a reconstructed workpaper's purchases.
  // A balance-sheet account's activity reaches a tax amount only as a COGS workpaper input, offered to inventory accounts (lib/tax/destinations.js
  // checkTarget, pickerOptions), so this is COGS uncertainty, never the return's income (a prepaid's use or an equity account's capital events
  // stay coverage items without holding page 1), and a balance mapping is never a purchases decision. It is an error of its own
  // (inventory_activity) until the activity is routed or disposed of (not on the return included).
  const inventoryWhy = [];
  for (const a of own.accounts ?? []) {
    if (a.pl || a.type !== 'inventory' || !(a.postings > 0)) continue;
    if (a.results?.activity && !undisposedActivity(a)) continue; // every portion of its activity has a current disposition
    const m = `${a.name}: its inventory movements have no disposition — route its activity to a COGS workpaper (purchases) or mark it not on the return; until then the reconstructed cost of goods sold is not known.`;
    inventoryWhy.push(m);
    problems.push({ code: 'inventory_activity', message: m });
  }
  // An undecided or stale closing candidate holds every account it touches or touched (in coverage or not), in the domains saved with it.
  const blockedIn = blockedDomains(candidates);
  for (const [id, why] of blocked) hold(id, why, blockedIn.get(id), 'closing');
  // Cash-basis books: an account the books as posted leave out of scope can still carry a cash-basis amount; unmapped, it is unknown too.
  if (cb) for (const [id, m] of cb) if (!accounts.has(id) && (m.begin || m.activity || m.end)) (m.pl ? taint.activity : taint.balance).push(`An account with a cash-basis amount (${id}) is not mapped yet.`);

  // ---- 2. Openings, account by account, and the retained-earnings roll (books provider members that are not postings).
  const openings = await openingsOf(db, { orgId, ret });
  const bookNI = cb ? -[...cb.values()].filter(m => m.pl).reduce((t, m) => t + m.activity, 0n) : bookNetIncome(cov);
  // Net income per books carries its knownness (Codex t3-r1 B3): an undecided or stale closing candidate held in the INCOME domain — by its
  // current legs or the domains saved with the decision — leaves the normalized book income unknown (a stale closing's legs are back in the
  // raw measurement; an undecided one's may or may not belong), and with it M-1 line 1, the bridge and the retained-earnings roll. Only the
  // closings decide this: an unmapped account or an open tax decision never makes the books unknown (known books beside unresolved tax
  // treatment), and the independent tax amounts keep their values.
  const bookNIWhy = [...new Set([...blockedIn].filter(([, ds]) => ds.includes('income')).map(([id]) => blocked.get(id)).filter(Boolean))];
  const bookNIKnown = bookNIWhy.length === 0;
  bridgeWhy.push(...bookNIWhy);
  const extraMembers = []; // { slotKey, ledger, label }
  const splitByRows = (a, measurement, ledger, label) => {
    const rows = a.bindings.filter(b => b.measurement === measurement).sort((x, y) => x.binding_id - y.binding_id);
    if (!rows.length) return false;
    if (rows.some(b => b.amount_text)) { for (const b of rows) if (b.slot_key) force(collectionKey(b.slot_key, ctx), `${a.name}: a dollar split cannot carry ${label.toLowerCase()}; split it by share.`); return true; }
    const parts = rows.some(b => b.share_num_text) ? splitByShares(ledger, rows.map(b => ({ num: BigInt(b.share_num_text), den: BigInt(b.share_den_text) }))) : [ledger];
    rows.forEach((b, i) => { if (b.slot_key && parts[i]) extraMembers.push({ slotKey: b.slot_key, ledger: parts[i], label, accountId: a.accountId }); });
    return true;
  };
  const retained = (own.accounts ?? []).find(a => a.systemKey === 'retained');
  if (!bookNIKnown) {
    // The period's income closes into retained earnings: not known, so neither is the ending balance it closes into — where the books provide
    // that ending (Codex t3-r5 R5-4: by provider consumption, as every other hold). A typed (assigned) retained-earnings ending the route only
    // stands beside keeps its entered amount and its own opening validation; with no destination at all for the ending, every balance total waits.
    const routes = retained ? routed.filter(x => x.member.kind !== 'unread' && x.member.accountId === retained.accountId && x.member.measurement === 'end') : [];
    // No route is not the same as no disposition (Codex t3-r6 R6-3): an ending explicitly disposed of (not on the return: the reviewed ending is
    // typed, the books' roll-forward reaches no line) consumes nothing and holds no total; only an ending with no binding at all — the
    // roll-forward could land on any balance line — holds every balance total.
    const endDisposed = (retained?.bindings ?? []).some(b => b.measurement === 'end');
    if (!routes.length && !endDisposed) taint.balance.push(...bookNIWhy);
    for (const x of routes) if (consumesRoute(x)) force(safeCk(x.key), `Net income per books is not known yet (${bookNIWhy.join(' ')}), so neither is the retained earnings it closes into.`);
  } else if (bookNI !== 0n) {
    // The ledger amount closed in at the year end: the period's income and expense activity (a credit for a profit).
    if (!retained || !splitByRows(retained, 'end', -bookNI, 'Net income for the period, closed to retained earnings')) {
      taint.balance.push('The period’s net income has no Schedule L destination: map Retained Earnings’ ending balance.');
    }
  }
  // The accounts whose beginning balance is mapped to each Schedule L line.
  const beginAccounts = new Map();
  for (const a of own.accounts ?? []) for (const b of a.bindings) if (b.measurement === 'begin' && b.slot_key) {
    const id = parseSlotKey(b.slot_key).fieldId;
    if (!beginAccounts.has(id)) beginAccounts.set(id, new Set());
    beginAccounts.get(id).add(a.accountId);
  }
  const booksBeginOf = id => (cb ? cb.get(id)?.begin ?? 0n : accounts.get(id)?.begin ?? 0n);
  // A failed bridge check is recorded now and HELD in section 7, through the one instance-aware helper (Codex t3-r2 R2-1): the line's actual
  // instances are known only once every provider has placed its collection, and a per-owner line is never held on an unscoped key.
  const openingDeferred = []; // [{ code, message, fieldIds, accountId }]
  // The account the check was about travels with the failure (Codex t3-r3 R3-1): its reviewed difference was NOT applied, so every collection
  // its beginning and ending balances route to NOW — a replacement line, another owner's instance, a share of a split — is held with the
  // predecessor's line; the raw book amount never publishes complete where the difference should have landed.
  const unresolvedLine = (code, message, fieldIds, accountId = null) => { problems.push({ code, message }); openingDeferred.push({ code, message, fieldIds, accountId }); };
  if (openings.state === 'baseline') {
    for (const [accountId, e] of openings.accounts) {
      const facts = e.rows.map(b => openings.byId.get(b.fact_id));
      const lineIds = [...new Set(facts.filter(Boolean).map(f => f.fieldId))];
      const label = lineIds.map(id => catalog.byId.get(id)?.label ?? id).join(', ');
      const name = accountName(accountId);
      if (facts.some(f => !f || !catalog.byId.get(f.fieldId))) { unresolvedLine('openings_unmapped', `${name}: a reviewed opening names a fact that is not a Schedule L line of the predecessor baseline.`, lineIds, accountId); continue; }
      // Both destinations proved BEFORE anything is applied (even an allocation equal to the books beginning): every beginning and every
      // ending binding row of the account routes to the line(s) its allocation belongs to — a row with no slot, or one routed to another
      // line, would carry its share of the reviewed opening somewhere else, or nowhere.
      const a = accounts.get(accountId);
      const where = ms => (a?.bindings ?? []).filter(b => b.measurement === ms);
      const wrong = ms => { const rows = where(ms); return !rows.length || rows.some(b => !b.slot_key || !lineIds.includes(parseSlotKey(b.slot_key).fieldId)); };
      // On a per-owner line the beginning and ending rows must name the SAME instances (Codex t3-r3 R3-1): a difference reviewed for one owner's
      // loan is never carried into another owner's ending.
      const instancesOfRows = ms => new Set(where(ms).map(b => { const ck = safeCk(b.slot_key); return ck ? ck.slice(0, ck.lastIndexOf('|')) : null; }));
      const sameInstances = () => { const bs = instancesOfRows('begin'), es = instancesOfRows('end'); return [...bs].every(x => es.has(x)) && [...es].every(x => bs.has(x)); };
      const named = ms => { const ids = where(ms).map(b => (b.slot_key ? catalog.byId.get(parseSlotKey(b.slot_key).fieldId)?.label ?? b.slot_key : 'no line')); return ids.length ? `mapped to ${[...new Set(ids)].join(', ')}` : 'not mapped'; };
      if (!a || wrong('begin') || wrong('end') || !sameInstances()) {
        const bad = !a || wrong('begin') ? 'begin' : 'end';
        unresolvedLine('openings_unmapped', `${name}: the reviewed opening gives it part of ${label}, but its ${bad === 'begin' ? 'beginning' : 'ending'} balance is ${a ? named(bad) : 'not mapped'}: map its beginning and ending balances to that line.`, lineIds, accountId);
        continue;
      }
      // The reviewed opening, in ledger sign: each approved row's allocation is a share of a filed fact, stated as the fact's line shows it.
      let ledger = 0n;
      for (const [i, b] of e.rows.entries()) ledger += polarityOf(catalog.byId.get(facts[i].fieldId)) === 'credit' ? -b.allocated : b.allocated;
      const booksBegin = booksBeginOf(accountId), delta = ledger - booksBegin;
      if (delta === 0n) continue;
      if (e.rows.some(b => b.books === null || b.books !== booksBegin)) {
        unresolvedLine('openings_stale', `${a.name}: its reviewed opening differs from the books beginning, and the books amount it was reviewed against is ${e.rows.some(b => b.books === null) ? 'not recorded' : 'not the beginning now'}.`, lineIds, accountId);
        continue;
      }
      for (const ms of ['begin', 'end']) splitByRows(a, ms, delta, 'Reviewed opening (opening bridge)');
    }
  }

  // ---- 3. Providers. Timing decisions first: an accrual return's exclusions (and its stale decisions) reach only the slots whose owner
  //         takes the excluded book amount — an engine adjustment where the books own the slot, less the workpaper's input where the COGS
  //         workpaper does — never a slot the account only stands beside (a typed line's comparison: its provider decides the tax amount, and
  //         the book amount stays the bridge's book side).
  const rec = ret.tax_method === 'cash' ? await cashRecognition(db, { orgId, ret }) : null;
  const timing = ret.tax_method === 'accrual' ? await accrualTiming(db, { orgId, ret }) : null;
  const engineDeltas = [], cogsExclusions = new Map();
  const targetsOf = (a, leg) => {
    const attributed = a.attributions.find(t => t.txn_id === leg.txnId && t.line_no === leg.lineNo);
    if (attributed) return [{ slot: attributed.slot_key, part: leg.cents }];
    const rows = a.bindings.filter(b => b.measurement === 'activity').sort((p, q) => p.binding_id - q.binding_id);
    if (!rows.length || rows.some(b => b.amount_text)) return null;
    const parts = rows.some(b => b.share_num_text) ? splitByShares(leg.cents, rows.map(b => ({ num: BigInt(b.share_num_text), den: BigInt(b.share_den_text) }))) : [leg.cents];
    return rows.map((b, i) => ({ slot: b.slot_key, part: parts[i] }));
  };
  if (timing) for (const [list, stale] of [[timing.exclusions, false], [timing.stale, true]]) for (const x of list) for (const leg of x.legs) {
    const a = accounts.get(leg.accountId);
    if (!a) continue;
    const targets = targetsOf(a, { ...leg, txnId: x.txnId });
    if (!targets) { taint.activity.push(`${a.name}: a reviewed accrual cannot be taken out of a dollar split; split the account by share.`); continue; }
    for (const t of targets) {
      if (!t.slot || !t.part) continue;
      const route = routed.find(y => y.key === t.slot && y.member.accountId === a.accountId && y.member.measurement === 'activity');
      if (route?.role === 'comparison' && stale) bridgeWhy.push(x.reason ?? `${a.name}: ${REVIEW_KINDS[x.kind]}.`); // the book side only
      if (!route || route.problem || route.role === 'comparison') continue;
      const reason = x.reason ?? `${a.name}: ${REVIEW_KINDS[x.kind]}.`;
      if (route.provider === 'cogs_workpaper') {
        const k = `${t.slot}|${a.accountId}`, cur = cogsExclusions.get(k) ?? { cents: 0n, stale: false, reason };
        cogsExclusions.set(k, stale ? { ...cur, stale: true, reason } : { ...cur, cents: cur.cents + t.part });
      } else if (route.provider === 'books') {
        if (stale) force(collectionKey(t.slot, ctx), reason);
        else engineDeltas.push({ slotKey: t.slot, accountId: a.accountId, txnId: x.txnId, cents: -semanticOf(catalog.byId.get(parseSlotKey(t.slot).fieldId), t.part), m1Class: 'method_timing', label: `Accrual not deductible yet: ${a.name} (${REVIEW_LABEL[x.kind] ?? x.kind})`, source: 'engine' });
      }
    }
  }
  // The accounts a stale accrual decision decided that its source no longer posts to (a leg moved, the source gone): held, so the old
  // expense is never deducted by default.
  if (timing) for (const x of timing.stale) {
    for (const id of (x.accounts ?? []).filter(id => !x.legs.some(l => l.accountId === Number(id)))) hold(Number(id), x.reason, x.domains, 'timing');
    problems.push({ code: 'timing_stale', message: x.reason });
  }
  // A cash-layer decision that went stale: what it decided is unresolved — its destination, and the accounts it recognized amounts on.
  if (rec) for (const u of rec.unresolved) {
    if (u.wide) taint.activity.push(u.reason);
    for (const k of u.slotKeys) force(safeCk(k), u.reason);
    for (const id of u.accountIds) hold(id, u.reason, u.domains, 'timing');
    problems.push({ code: 'timing_stale', message: u.reason });
  }
  const cogs = await cogsResults(db, { orgId, ret, cov, routed, exclusions: cogsExclusions });
  const needs = await manualNeeds(db, { orgId, ret });
  // Every typed item's slot checked as it is now (an assigned slot naming an owner or activity that is not this return's, or no longer in
  // effect): its saved amount is never read then (Codex t3-plan-r2 R2-7).
  const needScope = new Map();
  for (const n of needs) if (n.key !== K1_ANSWER) { const sp = await slotScopeProblem(db, { orgId, ret, key: n.key }); if (sp.problem) needScope.set(n.key, sp.problem); }
  const items = await listManualItems(db, { orgId, returnId: ret.return_id });
  const itemOf = k => items.find(i => i.item_key === k) ?? null;
  // Recognized cash of each account, split as its activity is routed (whole or by share: T2 refuses dollar splits and single lines there).
  const cashShare = new Map();
  if (rec) {
    for (const [accountId, cents] of rec.byAccount) {
      const a = accounts.get(accountId);
      const rows = a ? a.bindings.filter(b => b.measurement === 'activity').sort((x, y) => x.binding_id - y.binding_id) : [];
      if (!rows.length) { taint.activity.push(`${a?.name ?? accountName(accountId)}: cash is recognized on it but its activity is not mapped.`); continue; }
      const parts = rows.some(b => b.share_num_text) ? splitByShares(cents, rows.map(b => ({ num: BigInt(b.share_num_text), den: BigInt(b.share_den_text) }))) : [cents];
      rows.forEach((b, i) => cashShare.set(b.binding_id, parts[i]));
    }
  }
  for (const m of extraMembers) { const sl = slotOf(m.slotKey); if (!sl.provider && sl.known) sl.provider = 'books'; sl.extras = [...(sl.extras ?? []), m]; }
  // A reviewed destination is checked again as it is now (its activity or owner may have moved since the review was saved).
  if (rec) for (const it of rec.slotItems) {
    const scope = await slotScopeProblem(db, { orgId, ret, key: it.slotKey });
    if (scope.problem) { force(safeCk(it.slotKey), scope.problem); problems.push({ code: 'timing_scope', message: `${it.label}: ${scope.problem}` }); continue; }
    const sl = slotOf(it.slotKey); if (!sl.provider && sl.known) sl.provider = 'cash_layer'; sl.cashItems = [...(sl.cashItems ?? []), it];
  }
  for (const [activityId, e] of cogs) {
    // The workpaper's activity as it is now (ended, moved to another schedule): checked again, like every saved reference.
    const scope = await slotScopeProblem(db, { orgId, ret, key: `f1125a.main.2|activity=act:${activityId}|activity` });
    if (scope.problem) e.reasons.push(scope.problem);
    for (const n of ['1', '2', '3', '4', '5', '7']) {
      const sl = slotOf(`f1125a.main.${n}|activity=act:${activityId}|activity`);
      sl.provider = sl.provider ?? 'cogs_workpaper'; sl.activityId = activityId; sl.cogs = e;
      if (scope.problem) { sl.known = false; sl.reasons.push(scope.problem); }
    }
  }
  for (const n of needs) if (n.key !== K1_ANSWER) { const sl = slotOf(n.key); sl.provider = sl.provider ?? 'manual'; sl.need = n; }
  // A saved typed item this return no longer needs (its activity ended or moved to another schedule, its assignment gone): never dropped —
  // its line is unresolved, with the reason, until it is cleared or its reference is eligible again (Codex t3-plan-r3 R3-3).
  const orphanItems = [];
  for (const it of items) {
    if (it.item_key === K1_ANSWER || needs.some(n => n.key === it.item_key)) continue;
    const sp = await slotScopeProblem(db, { orgId, ret, key: it.item_key });
    const why = `A typed item for ${sp.line?.label ?? it.item_key} is saved but no longer applies to this return${sp.problem ? ` (${sp.problem})` : ''}: clear it on the typed items page, or make its reference eligible again.`;
    orphanItems.push({ ...it, reason: why });
    problems.push({ code: 'manual_scope', message: why, itemKey: it.item_key });
    if (!sp.line) { taint.activity.push(why); continue; }
    const sl = slotOf(it.item_key);
    sl.provider = null; sl.known = false; sl.reasons.push(why);
  }
  const assignedTo = new Map(assignments.map(a => [a.slot_key, a.provider_kind]));
  for (const [key, kind] of assignedTo) if (['asset_register', 'k1_record'].includes(kind)) { const sl = slotOf(key); sl.provider = kind; }

  for (const sl of slots.values()) {
    const line = sl.line, statement = line?.type === 'statement';
    if (!line) { sl.known = false; sl.reasons.push(`${sl.fieldId} is not a line of the ${ret.form_edition} forms.`); continue; }
    if (sl.need?.subsetOf) continue; // a classified component: evaluated against its parent below
    const assigned = assignedTo.get(sl.key);
    if (assigned && assigned !== sl.provider && sl.provider) { sl.known = false; sl.reasons.push(`Assigned to ${assigned}, but computed by ${sl.provider}.`); }
    const rows = new Map();
    const addRow = (label, cents) => rows.set(label, (rows.get(label) ?? 0n) + cents);
    let value = 0n;
    if (sl.provider === 'books') {
      for (const m of sl.members.filter(x => x.role === 'authoritative')) {
        if (m.book === null) { sl.known = false; continue; }
        const v = semanticOf(line, m.book); value += v; addRow(m.rowLabel ?? m.accountName ?? 'Books', v);
      }
      for (const m of sl.extras ?? []) { const v = semanticOf(line, m.ledger); value += v; addRow(m.label, v); }
    } else if (sl.provider === 'cash_layer') {
      for (const m of sl.members.filter(x => x.role === 'input')) {
        if (m.kind !== 'binding') { sl.known = false; sl.reasons.push('A single line is routed on a cash-method return: the cash layer takes whole or shared account routings only.'); continue; }
        // Income and expense: what the return recognizes; a balance (cash-basis books): the books' cash-basis balance.
        const ledger = m.measurement === 'activity' && m.pl ? cashShare.get(m.id) ?? 0n : m.book;
        if (ledger === null) { sl.known = false; sl.reasons.push(`${m.accountName}: a dollar split cannot be measured on cash-basis books; split it by share.`); continue; }
        const v = semanticOf(line, ledger); value += v; addRow(m.rowLabel ?? m.accountName ?? 'Cash', v);
      }
      for (const it of sl.cashItems ?? []) { const v = semanticOf(line, it.cents); value += v; addRow(it.label, v); }
      // On cash-basis books the balance lines are the cash layer's: the year's income closed into retained earnings, reviewed openings.
      for (const m of sl.extras ?? []) { const v = semanticOf(line, m.ledger); value += v; addRow(m.label, v); }
    } else if (sl.provider === 'cogs_workpaper') {
      const n = sl.fieldId.split('.').at(-1), v = sl.cogs?.values?.[n];
      if (!sl.cogs || v === null || v === undefined) { sl.known = false; sl.reasons.push(...(sl.cogs?.reasons ?? ['The cost of goods sold workpaper is not complete.'])); }
      else if (Array.isArray(v)) { for (const x of v) { value += x.cents; addRow(x.label, x.cents); } }
      else value = v;
    } else if (sl.provider === 'manual') {
      const it = itemOf(sl.key);
      if (needScope.has(sl.key)) { sl.known = false; sl.reasons.push(needScope.get(sl.key)); problems.push({ code: 'manual_scope', message: needScope.get(sl.key) }); }
      else if (!it) { sl.known = false; sl.reasons.push(`${line.label}: enter it, or mark it not applicable, on the typed items page.`); }
      else if (it.status === 'entered') { if (it.rows) for (const x of it.rows) { value += x.cents; addRow(x.label, x.cents); } else value = it.amount; }
    } else if (sl.provider === 'asset_register' || sl.provider === 'k1_record') { sl.known = false; sl.reasons.push(`${line.label} comes from ${sl.provider === 'asset_register' ? 'the asset register (stage T7)' : 'K-1 records (stage T4)'}.`); }
    else { sl.known = false; if (!sl.reasons.length) sl.reasons.push(`${line.label} has no provider.`); }
    sl.value = sl.known ? value : null;
    sl.rows = statement && sl.known ? [...rows].map(([label, cents]) => ({ label, cents })) : null;
  }

  // ---- 4. K-1s received and the stage-T4 dependencies.
  const k1Answer = itemOf(K1_ANSWER);
  const { rows: [held] } = await db.query(`SELECT count(*)::int AS n FROM ownership_interest o JOIN tax_party p ON p.org_id = o.org_id AND p.party_id = o.party_id
     WHERE o.org_id = $1 AND p.kind = 'entity_in_org' AND p.entity_id = $2 AND o.effective_from <= $4::date AND (o.effective_to IS NULL OR o.effective_to >= $3::date)`, [orgId, entityId, ret.period_start, ret.period_end]);
  const k1Why = held.n || t4.has('k1_booked') ? 'This return receives K-1s (or books K-1 income): their amounts arrive with the K-1 records of stage T4.'
    : k1Answer?.status === 'not_applicable' ? null : 'Say whether this return receives K-1s (typed items page).';
  if (k1Why) for (const id of reach) { const l = catalog.byId.get(id); if (l && l.kind !== 'computed' && l.sourceDims.includes('k1_source')) force(`${id}|activity`, k1Why); }
  const gpWhy = 'Guaranteed payments are computed with the partners’ records in stage T4.';
  if (ret.return_type === 'form_1065') {
    if (t4.has('guaranteed_payment')) for (const id of ['f1065.p1.10', 'f1065.k.4a', 'f1065.k.4b']) force(`${id}|interest=i:t4|activity`, gpWhy);
    if (t4.has('equity_event')) for (const id of ['f1065.k.19a', 'f1065.k.19b']) force(`${id}|interest=i:t4|activity`, 'Capital events are computed in stage T4.');
    force('se.wp.total|activity', 'Self-employment earnings are computed with the partners’ records in stage T4.');
    force('se.wp.gross_nonfarm|activity', 'Gross nonfarm income is the self-employment workpaper’s (stage T4).');
  } else if (t4.has('equity_event')) force('f1120s.k.16d|interest=i:t4|activity', 'Distributions are computed in stage T4.');

  // ---- 5. Adjustments: person groups (each line's slot checked again as it is now), answered proposals, engine timing adjustments.
  const groups = await listAdjustments(db, { orgId, returnId: ret.return_id });
  const deltas = [...engineDeltas];
  for (const g of groups) if (g.source === 'person' && g.status === 'accepted' && mixedExemptGroup(ret.return_type, g.lines)) {
    // Saved before the rule (or written around it): refused again here — every line it touches is unresolved, none applied.
    const m = `${g.memo}: one adjustment moves income to both tax-exempt interest and other tax-exempt income; withdraw it and enter one for each.`;
    problems.push({ code: 'adjustment_mixed', message: m });
    for (const l of g.lines) force(safeCk(l.slotKey), m);
  }
  for (const g of groups) if (g.source === 'person' && g.status === 'accepted' && !mixedExemptGroup(ret.return_type, g.lines)) for (const l of g.lines) {
    const scope = await slotScopeProblem(db, { orgId, ret, key: l.slotKey });
    if (scope.problem) { force(safeCk(l.slotKey), scope.problem); problems.push({ code: 'adjustment_scope', message: `${g.memo}: ${scope.problem}` }); continue; }
    deltas.push({ ...l, label: g.memo, groupId: g.group_id, source: 'person' });
  }
  // Proposals from the tax amounts each deduction slot takes from each account AFTER the timing decisions that remove part of it (an accrual
  // not deductible this period is no nondeductible meal of this period): the eligible basis, with those decisions in its version.
  const proposalMembers = [];
  for (const sl of slots.values()) {
    if (!sl.known || !['books', 'cash_layer'].includes(sl.provider)) continue;
    const byAccount = new Map();
    for (const m of sl.members.filter(x => x.role === 'authoritative' || x.role === 'input')) {
      const v = sl.provider === 'books' ? semanticOf(sl.line, m.book ?? 0n) : semanticOf(sl.line, cashShare.get(m.id) ?? 0n);
      const e = byAccount.get(m.accountId) ?? { cents: 0n, name: m.accountName, version: [] };
      e.cents += v; e.version.push(`${m.kind}:${m.id}:${accounts.get(m.accountId)?.results?.activity?.version ?? ''}`);
      byAccount.set(m.accountId, e);
    }
    for (const [accountId, e] of byAccount) {
      const timed = engineDeltas.filter(d => d.slotKey === sl.key && d.accountId === accountId);
      proposalMembers.push({ slotKey: sl.key, accountId, accountName: e.name ?? '', cents: e.cents + timed.reduce((s, d) => s + d.cents, 0n),
        version: [...e.version, ...timed.map(d => `timing:${d.txnId}:${d.cents}`)].join(',') });
    }
  }
  // ONE operative-answer rule (Codex t3-r3 R3-2), for the candidates computed now and for the orphans below: the operative answer of a logical
  // proposal (its key) is its latest saved answer — the one row not marked superseded (lib/tax/adjustments.js marks the earlier ones when a
  // later answer is saved). A superseded answer is history, never selected again when its version returns; a retired (withdrawn) operative
  // answer is evidence, not an answer (R2-3) — the proposal waits. The operative answer is fresh only when it names the version computed now.
  const operativeOf = new Map();
  for (const g of groups) if (g.source === 'proposal' && !g.superseded_at) operativeOf.set(g.source_ref, g);
  const proposals = proposalsFor(ret, proposalMembers).map(p => {
    const op = operativeOf.get(p.key) ?? null;
    return { ...p, answer: op && op.status !== 'withdrawn' ? { ...op, fresh: op.source_version === p.version } : null };
  });
  for (const p of proposals) {
    if (p.answer?.fresh) { if (p.answer.status === 'accepted') for (const l of p.answer.lines) deltas.push({ ...l, label: p.answer.memo, rowLabel: `Nondeductible part: ${p.accountName}`, groupId: p.answer.group_id, source: 'proposal' }); continue; }
    for (const l of p.lines) force(collectionKey(l.slotKey, ctx), `A proposal waits: ${p.why} (${p.accountName}). Accept or reject it on the adjustments page.`);
  }
  // An accepted proposal answer whose proposal is no longer computed at all (Codex t3-r1 B5: the account renamed to a name no rule matches,
  // remapped to another line, its postings deleted, its sign changed): a saved decision is never discarded into the complete default. It is
  // reconciled by its SAVED record — the lines it moved and the account it was about — and holds them: each saved line's collection, and every
  // slot the account's activity feeds now where the provider consumes it (the replacement destination), until a person withdraws the answer
  // on the adjustments page (or answers the proposal computed now). Listed (orphanAnswers), an error, frozen with the revision.
  // The OPERATIVE answer of each logical proposal (its key) is the latest one saved (Codex t3-r2 R2-2): a later answer — a rejection or a new
  // acceptance of a changed version — supersedes an earlier acceptance, which stays history (kept, frozen) and is never revived as a hold when
  // the candidate stops being computed. The latest answer withdrawn (retired, R2-3) leaves nothing operative for the key: an earlier
  // acceptance does not take its place.
  const orphanAnswers = [];
  for (const g of operativeOf.values()) {
    if (g.status !== 'accepted' || proposals.some(p => p.key === g.source_ref)) continue;
    const accountId = Number((g.source_ref ?? '').split(':')[1]);
    const why = `An accepted proposal no longer matches its source (${g.memo}; ${accountName(accountId)} as it is now): the lines it decided are not known until the answer is withdrawn on the adjustments page (and, where the account now feeds another line, the proposal computed there is answered as well).`;
    orphanAnswers.push({ ...g, accountId, reason: why });
    problems.push({ code: 'proposal_orphan', message: why });
    for (const l of g.lines) force(safeCk(l.slotKey), why);
    for (const x of routed) if (x.member.kind !== 'unread' && x.member.accountId === accountId && x.member.measurement === 'activity' && consumesRoute(x)) force(safeCk(x.key), why);
  }

  // ---- 6. Packets (T1's interface): book portions proved against the saved mapping over an independent measurement (bookParts), the
  //         provider's own reference beside them; checked as a set (sameBase) and summed once (aggregate).
  const owners = allocationOwners(cov);
  const independent = own.status === 'measured' ? await measureAccounts(db, { orgId, sourceEntityId: own.entityId, periodStart: ret.period_start, periodEnd: ret.period_end, returnId: ret.return_id }) : new Map();
  const approvedAll = own.status === 'measured' ? await approvedAllOf(db, { orgId, returnId: ret.return_id, sourceEntityId: own.entityId }) : new Map();
  const withLines = [...new Set((own.accounts ?? []).filter(a => a.attributions.length).map(a => a.accountId))];
  const linesNow = withLines.length ? await measureLines(db, { orgId, sourceEntityId: own.entityId, accountIds: withLines, periodStart: ret.period_start, periodEnd: ret.period_end, returnId: ret.return_id }) : new Map();
  const providerRef = sl => {
    if (sl.provider === 'cash_layer') return { kind: 'cash_layer', id: sl.key, version: rec?.version ?? md5(json([...(cb ?? new Map())])) };
    if (sl.provider === 'cogs_workpaper') return { kind: 'cogs_workpaper', id: `act:${sl.activityId}`, version: md5(json([sl.cogs?.workpaper ?? null, sl.cogs?.values ?? null])) };
    if (sl.provider === 'manual') return { kind: 'manual_item', id: sl.key, version: md5(json(itemOf(sl.key))) };
    return { kind: 'books', id: sl.key, version: md5(json((sl.extras ?? []).map(m => [m.label, m.ledger]))) };
  };
  const packetOf = sl => {
    const consumed = [], refs = [providerRef(sl)];
    if (sl.value !== null) {
      // Only the book portions this provider consumes are proved and claimed: a reviewed workpaper's or a typed line's book neighbours are not.
      const takes = sl.members.filter(x => consumes(x.role, sl.provider, x.activityId) && (x.kind === 'binding' || x.kind === 'line'));
      const byPartition = new Map();
      for (const m of takes) { const k = `${m.accountId}/${m.measurement}`; if (!byPartition.has(k)) byPartition.set(k, []); byPartition.get(k).push(m); }
      for (const [k, ms] of byPartition) {
        const [accountId, measurement] = [Number(k.split('/')[0]), k.split('/')[1]];
        const p = accounts.get(accountId)?.results?.[measurement], m = independent.get(accountId);
        try {
          if (!p || !m) throw new Error('the account is not measured on this return');
          const parts = bookParts({ partition: p, provider: sl.provider, memberIds: new Set(ms.map(x => `${x.kind}:${x.id}`)), owners,
            measured: { cents: m[measurement], version: m.versions[measurement], lineGroups: m.lineGroups, normalization: m.normalization },
            lines: measurement === 'activity' && withLines.includes(accountId) ? linesNow.get(accountId) ?? [] : null, approved: approvedAll.get(k) ?? { rows: [], attributions: [] } });
          if (parts.cents !== ms.reduce((t, x) => t + x.cents, 0n)) throw new Error('the proved portions are not the slot’s allocations');
          consumed.push(...parts.consumedSlices); refs.push(...parts.sourceRefs);
        } catch (e) {
          sl.value = null; sl.known = false; sl.reasons.push(`${accountName(accountId)}: its mapping could not be proved for this slot (${e.message}).`);
        }
      }
    }
    const value = sl.line.type === 'statement'
      ? (sl.value === null ? { slotKey: sl.key, completeness: 'unresolved' } : { slotKey: sl.key, statementRows: (sl.rows.length ? sl.rows : [{ label: sl.line.label, cents: 0n }]).map(x => ({ label: x.label, amountCents: x.cents.toString() })) })
      : (sl.value === null ? { slotKey: sl.key, amountCents: null, completeness: 'unresolved' } : { slotKey: sl.key, amountCents: sl.value.toString() });
    return { providerKind: sl.provider, schemaVersion: 1, sourceVersion: `${sl.provider}:${sl.key}`, sourceRefs: refs, completeness: sl.value === null ? 'unresolved' : 'complete',
      reasons: sl.value === null ? (sl.reasons.length ? [...new Set(sl.reasons)] : ['not known']) : [], review: { state: 'unreviewed' }, values: [value], relatedOutputs: [], consumedSlices: consumed };
  };
  const packable = sl => sl.line && sl.provider && ['books', 'cash_layer', 'cogs_workpaper', 'manual'].includes(sl.provider) && ['amount', 'statement', 'code'].includes(sl.line.type);
  let packets = [];
  for (const sl of slots.values()) {
    if (!packable(sl) || sl.need?.subsetOf) continue;
    const packet = packetOf(sl);
    const bad = validatePacket(packet, ctx);
    if (bad.length) { sl.value = null; sl.known = false; sl.reasons.push(`The ${sl.provider} result is not sound: ${bad.join('; ')}`); continue; }
    packets.push({ packet, sl });
  }
  for (const { problem, id } of packetSetProblems(packets.map(x => x.packet))) {
    for (const x of packets.filter(y => y.packet.sourceRefs.some(rf => rf.kind === 'books_partition' && rf.id === id))) { x.sl.value = null; x.sl.known = false; x.sl.reasons.push(`Packets of these books disagree on their mapping: ${problem}`); }
    packets = packets.filter(y => !y.packet.sourceRefs.some(rf => rf.kind === 'books_partition' && rf.id === id));
  }
  const collections = aggregate(packets.map(x => x.packet), ctx);
  const values = new Map();
  const reasonsOf = new Map();
  for (const sl of slots.values()) if (sl.line && sl.provider) { const ck = collectionKey(sl.key, ctx); reasonsOf.set(ck, [...(reasonsOf.get(ck) ?? []), ...sl.reasons]); }
  for (const [ck, c] of collections) values.set(ck, { cents: c.status === 'complete' ? c.cents : null, reasons: c.status === 'conflict' ? ['Two providers or packets claim the same source or slot.'] : c.status === 'complete' ? [] : [...new Set(reasonsOf.get(ck) ?? ['not known'])] });
  // A slot with no owner (a provider problem, an unread contributor) or no sound packet is unknown in its collection — never left out as if it were zero.
  for (const sl of slots.values()) if (sl.line && !sl.need?.subsetOf && (!sl.provider || sl.value === null)) {
    const ck = collectionKey(sl.key, ctx);
    values.set(ck, { cents: null, reasons: [...new Set([...(values.get(ck)?.reasons ?? []), ...sl.reasons])] });
  }
  // Each accepted delta lands once, on its target's provider result (Codex t3-plan-r2 R2-11): a Form 1125-A line of an activity with no
  // workpaper has no provider result — the line is unknown, never a zero base; a classified component's deltas are applied with it below.
  const subsetKeys = new Set(needs.filter(n => n.subsetOf).map(n => n.key));
  for (const d of deltas) {
    const ck = collectionKey(d.slotKey, ctx);
    if (subsetKeys.has(ck)) continue;
    const act = /^f1125a\.main\.\d\|activity=act:(\d+)\|activity$/.exec(ck);
    if (act && !cogs.has(Number(act[1]))) {
      const m = `${d.label}: an adjustment to a Form 1125-A line of an activity with no COGS workpaper — start the workpaper first.`;
      problems.push({ code: 'adjustment_target', message: m }); force(ck, m); continue;
    }
    const v = values.get(ck) ?? { cents: 0n, reasons: [] };
    values.set(ck, v.cents === null ? v : { cents: v.cents + d.cents, reasons: v.reasons });
  }
  // A line nothing routes to: a known zero while the books are completely mapped for its measurement, unknown otherwise (never a silent zero).
  for (const id of reach) {
    const l = catalog.byId.get(id);
    if (!l || l.kind === 'computed' || l.instanceDims.length || isEngineLine(id) || !['amount', 'statement', 'code'].includes(l.type)) continue;
    for (const ms of measurementsOf(l)) {
      const k = `${id}|${ms}`, why = ms === 'activity' ? taint.activity : taint.balance;
      if (!values.has(k)) values.set(k, why.length ? { cents: null, reasons: [...new Set(why)] } : { cents: 0n, reasons: [] });
    }
  }
  // Classified components (qualified dividends within ordinary dividends, investment income within other income): typed, checked
  // against their parent as computed; unresolved while the parent has an amount and nothing is entered; zero when the parent is a known zero.
  const subsetPackets = [];
  for (const sl of slots.values()) {
    const n = sl.need;
    if (!n?.subsetOf || !sl.line) continue;
    const parent = forced.has(n.subsetOf) ? { cents: null } : values.get(n.subsetOf), it = itemOf(sl.key), pc = parent ? parent.cents : null;
    let v = null;
    if (pc === null) sl.reasons.push(`${sl.line.label} waits on ${n.parentLabel}, which is not known yet.`);
    else if (!it) { if (pc === 0n) v = 0n; else sl.reasons.push(`${sl.line.label}: say how much of ${n.parentLabel} (${pc} cents) it is, or mark it not applicable (none), on the typed items page.`); }
    else v = it.status === 'entered' ? it.amount : 0n;
    // The classification is the provider result; accepted deltas apply to it; the FINAL amount is what must be part of the parent.
    const moved = deltas.filter(d => collectionKey(d.slotKey, ctx) === sl.key).reduce((s, d) => s + d.cents, 0n);
    if (v !== null) {
      const x = v + moved;
      if (!(pc >= 0n ? x >= 0n && x <= pc : x <= 0n && x >= pc)) {
        sl.reasons.push(`${sl.line.label} (${x} cents${moved ? ', adjustments included' : ''}) is not part of ${n.parentLabel} (${pc} cents): correct it on the typed items page.`);
        problems.push({ code: 'subset', message: sl.reasons.at(-1) });
        v = null;
      }
    }
    sl.value = v; sl.known = v !== null; sl.moved = moved;
    const packet = packetOf(sl);
    if (!validatePacket(packet, ctx).length) subsetPackets.push(packet);
  }
  for (const [ck, c] of aggregate(subsetPackets, ctx)) values.set(ck, { cents: c.status === 'complete' ? c.cents + (slots.get(ck)?.moved ?? 0n) : null, reasons: c.status === 'complete' ? [] : [...new Set(reasonsOf.get(ck) ?? ['not known'])] });
  for (const sl of slots.values()) if (sl.need?.subsetOf && sl.value === null) values.set(collectionKey(sl.key, ctx), { cents: null, reasons: [...new Set(sl.reasons)] });

  // ---- 7. Openings tie-out, account by account (on the values before the formulas: Schedule L lines are inputs, never computed).
  const L = ret.return_type === 'form_1065' ? { assets: 'f1065.L.14', total: 'f1065.L.22' } : { assets: 'f1120s.L.15', total: 'f1120s.L.27' };
  // Every Schedule L input line, the per-owner ones included (Codex t3-r1 B2: loans to and from shareholders). A line kept per owner is
  // checked on its ACTUAL instance keys — the collection keys its beginning and ending bindings name — never on an unscoped key it does not
  // have: its instances' beginnings add up to the filed line total, and a failed predecessor check holds both measurements of every instance (an instance
  // whose ending route moved to another line included, so a beginning hold is never bypassed); a filed amount with no instance to hold it
  // holds every balance total.
  const lLines = catalog.lines.filter(l => l.cls === 'balance' && l.kind !== 'computed' && l.id.includes('.L.'));
  // The ACTUAL instances of a per-owner line (Codex t3-r2 R2-1): every collection the computation placed on it — the books, the cash layer,
  // a typed (assigned) amount, an adjustment's target, a pending placeholder — and every saved route to it (a hold must reach an instance
  // whose amount is not placed yet). Never an unscoped key for a line that has instances.
  const instancesOf = l => {
    if (!l.instanceDims.length) return [l.id];
    const out = new Set();
    const add = key => { const ck = safeCk(key); if (ck && parseSlotKey(ck).fieldId === l.id && ['begin', 'end'].includes(parseSlotKey(ck).measurement)) out.add(ck.slice(0, ck.lastIndexOf('|'))); };
    for (const k of [...values.keys(), ...forced.keys()]) if (k.startsWith(`${l.id}|`)) add(k);
    for (const d of deltas) if (d.slotKey.startsWith(`${l.id}|`)) add(d.slotKey);
    for (const a of own.accounts ?? []) for (const b of a.bindings) if (b.slot_key && b.slot_key.startsWith(`${l.id}|`)) add(b.slot_key);
    return [...out];
  };
  const beginOf = l => { let sum = 0n; for (const p of instancesOf(l)) { const v = values.get(`${p}|begin`)?.cents; if (v === null || v === undefined) return null; sum += v; } return sum; };
  // The holding helpers of every opening check, a verified first year's and a predecessor's alike (Codex t3-r5 R5-3):
  //   holdLine     the failed line's actual instances (or just the identified failing instances), both measurements, whatever their provider;
  //   holdAccount  ONE propagation rule (Codex t3-r4 R4-2, R4-4): the accounts the failed check was about — the account of a failed bridge,
  //                every account whose beginning opens on a line whose filed (or verified zero) amount is contradicted, missing, unknown or
  //                unallocated — carry the failure to the collections their beginning and ending balances route to NOW (a replacement line, a
  //                share of a split, another owner's instance), but only where the destination's provider CONSUMES the book amount
  //                (consumesRoute, as the closing and timing holds do): a books-fed replacement ending is unknown; a typed (assigned) ending the
  //                route only stands beside keeps its entered amount; a route not on the return holds nothing.
  const openingNotes = []; // book-source contradictions the return does not take (warnings)
  const holdLine = (l, message, ps = instancesOf(l)) => {
    if (!ps.length) taint.balance.push(message);
    for (const p of ps) for (const ms of ['begin', 'end']) force(`${p}|${ms}`, message);
  };
  const holdAccount = (id, message) => {
    for (const x of routed) if (x.member.kind !== 'unread' && x.member.accountId === id && ['begin', 'end'].includes(x.member.measurement) && consumesRoute(x)) force(safeCk(x.key), message);
  };
  const open = (l, code, message) => { problems.push({ code, message }); holdLine(l, message); for (const id of beginAccounts.get(l.id) ?? []) holdAccount(id, message); };
  if (ret.opening_state === 'unknown') problems.push({ code: 'openings_unknown', message: 'This period has no predecessor baseline and is not a verified first year: its beginning balances are the books’ and are not reviewed openings.' });
  else if (ret.opening_state === 'zero') {
    // A verified first year is a known zero predecessor. ONE rule with two separate questions (Codex t3-r6 R6-2, t3-r7 R7-2, t3-r8 R8-2), both
    // asked before anything nets, nothing zeroed or plugged:
    //   (a) does the opening a line actually PROVIDES contradict zero? Each actual instance on its own (a +10,000 instance is never approved by
    //       another's -10,000; an instance not known yet never hides a known nonzero one): a nonzero provided opening — book-fed or typed —
    //       fails, and holdLine holds only those failing instances, both measurements (Codex t3-r9 R9-2). A matching sibling's independent
    //       balances stay known; dependent totals still wait on the failed member. An unanswered typed opening is already unknown.
    //   (b) does any SOURCE account carry a nonzero beginning on the period's book basis (booksBeginOf: as posted, or the books' cash basis),
    //       whatever its beginning binding says (a slot, not on the return, none)? It reaches only the destinations that consume it now
    //       (holdAccount: consumesRoute) — a book-fed beginning or ending is held; a typed opening or ending the route only stands beside keeps its
    //       value, and a source with no consuming route at all holds nothing (its contradiction stays visible as a warning).
    const failedAccounts = new Set();
    for (const l of lLines) {
      const insts = instancesOf(l).map(p => [p, values.get(`${p}|begin`)?.cents]).filter(([, v]) => v !== null && v !== undefined && v !== 0n);
      if (!insts.length) continue;
      const shown = insts.map(([p, v]) => `${p.includes('|') ? p.slice(p.indexOf('|') + 1) : 'its beginning'} ${v} cents`);
      problems.push({ code: 'openings_initial', message: `${l.label}: a verified first year begins at zero, but the return shows ${shown.join(', ')}. Remove or redate the entries before the start date, correct the typed opening, or correct the start.` });
      holdLine(l, `${l.label}: a verified first year begins at zero, but the return shows ${shown.join(', ')}.`, insts.map(([p]) => p));
      for (const id of beginAccounts.get(l.id) ?? []) failedAccounts.add(id);
    }
    const ids = new Set([...(own.accounts ?? []).filter(a => !a.pl).map(a => a.accountId), ...(cb ? [...cb].filter(([, m]) => !m.pl).map(([id]) => id) : [])]);
    const contradicted = [...ids].filter(id => booksBeginOf(id) !== 0n);
    const consumingOf = id => routed.filter(x => x.member.kind !== 'unread' && x.member.accountId === id && ['begin', 'end'].includes(x.member.measurement) && consumesRoute(x));
    const held = contradicted.filter(id => consumingOf(id).length);
    if (held.length) {
      const m = `A verified first year begins at zero, but the books begin with ${held.map(id => `${accountName(id)} ${booksBeginOf(id)} cents`).join(', ')}, and the return still takes ${held.length === 1 ? 'that balance' : 'those balances'}. Remove or redate the entries before the start date, or correct the start.`;
      if (held.some(id => !failedAccounts.has(id))) problems.push({ code: 'openings_initial', message: m });
      for (const id of held) holdAccount(id, m);
    }
    for (const id of contradicted.filter(x => !held.includes(x))) openingNotes.push(`${accountName(id)}: its books begin with ${booksBeginOf(id)} cents before a verified first year; the return does not take it (typed or not on the return).`);
  }
  else {
    // Every check that fails leaves the line's beginning AND ending unknown (the ending balance carries the opening): a missing fact is not a
    // zero — the baseline must say zero —, an unknown fact, accounts opening on one line without an allocation, a mismatch.
    // The bridge checks of section 2 that failed (an opening naming no Schedule L line, a destination not routed to the line, a difference
    // reviewed against another books beginning): held now, on the lines' actual instances and the account's current destinations.
    for (const d of openingDeferred) {
      for (const id of d.fieldIds) { const l = catalog.byId.get(id); if (l) holdLine(l, d.message); else taint.balance.push(d.message); }
      if (d.accountId !== null) holdAccount(d.accountId, d.message);
    }
    const absent = [];
    for (const l of lLines) {
      const f = openings.facts.get(l.id), v = beginOf(l);
      const opening = [...(beginAccounts.get(l.id) ?? [])].filter(id => booksBeginOf(id) !== 0n || openings.accounts.get(id)?.rows.some(b => f?.factIds.includes(b.fact_id)));
      if (!f) { absent.push(l); continue; }
      if (f.state !== 'known') { open(l, 'openings_unknown', `${l.label}: last year’s ending balance is ${f.state === 'unknown' ? 'unknown' : 'not applicable'} in the baseline.`); continue; }
      const bridged = new Set(openings.bridges.filter(b => b.approved_by && f.factIds.includes(b.fact_id)).map(b => b.account_id));
      const left = opening.filter(id => !bridged.has(id));
      if (bridged.size && left.length) { open(l, 'openings_unreviewed', `${l.label}: the reviewed allocation of last year’s filed amount leaves out ${left.map(accountName).join(', ')}, which open${left.length === 1 ? 's' : ''} on this line: allocate the filed amount to every account that opens here (opening bridge).`); continue; }
      if (!bridged.size && opening.length > 1) { open(l, 'openings_unreviewed', `${l.label}: ${opening.length} accounts open on this line and last year’s filed return gives only its total: allocate it to them (opening bridge), so each account’s opening is reviewed — a matching total is not.`); continue; }
      if (v !== null && v !== f.cents) open(l, 'openings_unexplained', `${l.label}: the beginning is ${v} cents, last year’s filed ending ${f.cents} cents. Bridge the difference (opening bridge) or correct the mapping.`);
    }
    if (absent.length) {
      const m = `Last year’s filed balance sheet in the baseline has no amount for ${absent.length} line${absent.length === 1 ? '' : 's'} (${absent.slice(0, 5).map(l => l.label).join(', ')}${absent.length > 5 ? ', …' : ''}): record each, zero included.`;
      problems.push({ code: 'openings_unknown', message: m });
      for (const l of absent) { holdLine(l, m); for (const id of beginAccounts.get(l.id) ?? []) holdAccount(id, m); }
    }
  }
  for (const [ck, why] of forced) values.set(ck, { cents: null, reasons: [...new Set(why)] });
  // Engine inputs: net income per books; guaranteed payments of the M-1 (none bound: none; bound: stage T4); M-2's workpapers stay T4.
  values.set('books.ni.total|activity', bookNIKnown ? { cents: bookNI, reasons: [] } : { cents: null, reasons: bookNIWhy });
  if (ret.return_type === 'form_1065') values.set('gp.wp.m1|activity', t4.has('guaranteed_payment') ? { cents: null, reasons: [gpWhy] } : { cents: 0n, reasons: [] });
  for (const l of catalog.lines) if (l.kind !== 'computed' && !reach.has(l.id) && !values.has(`${l.id}|activity`) && !l.instanceDims.length && measurementsOf(l).includes('activity')) {
    values.set(`${l.id}|activity`, { cents: null, reasons: ['Not computed in this stage.'] });
  }
  // A missing source (an unmapped account, a held decision with no destination) makes unknown only what could CONSUME it (Codex t3-r2 R2-4):
  // every input collection of the return's slots that the books or the cash layer feed, that a reconstructed workpaper takes as its input, or
  // that nothing routes to yet (the unmapped amount could land there), and — through evaluate's dependency walk — every total built from one
  // of them. The leaf keeps its own amount (gross receipts stays what the books say). A typed or assigned amount, a reviewed workpaper's lines
  // and the engine's measured inputs (net income per books) are not places an unmapped amount could land, so they and the totals built only
  // from them (M-1 line 1, a reviewed activity's line 8) stay known — the tax treatment waits, the measured books do not.
  const { rows: acts } = await db.query(`SELECT activity_id, name, kind, schedule, property, effective_from::text AS effective_from, effective_to::text AS effective_to, disposed_on::text AS disposed_on
     FROM tax_activity WHERE org_id = $1 AND return_entity_id = $2 ORDER BY activity_id`, [orgId, entityId]);
  // A dimensional collection can be incomplete with NO member materialized (Codex t3-r3 R3-3): an unmapped cost could still be routed to the
  // cost of goods sold of a trade activity that has no Form 1125-A input or workpaper yet, so that activity's purchases are an unknown member
  // while the activity taint stands — its line 8 and the aggregate page-1 COGS (and applicability) are unknown, the measured book income and
  // another activity's reviewed line 8 are not. Once the source is disposed of (mapped anywhere), the empty collection is a known zero again.
  // The reconstructible cost inputs of Form 1125-A (lines 2-5: purchases, labor, section 263A, other costs) are built from routed movements
  // and costs; tax inventory (lines 1 and 7) is entered on the workpaper and no account can feed it (T2). COGS uncertainty (cogsWhy) therefore
  // reaches, per trade activity in effect (Codex t3-r4 R4-3, R4-5):
  //   a reconstructed workpaper  → its cost inputs 2-5 are null (their own amounts are incomplete, never a partial sum); lines 1 and 7 keep
  //                                their entered knownness;
  //   a reviewed workpaper        → nothing (its lines are typed from their source);
  //   no workpaper                → every cost input 2-5 with no member yet is materialized as an unknown member, so line 8, the aggregate
  //                                page-1 COGS and applicability are unknown — an input independently assigned and typed keeps its value.
  // Once every source is disposed of, an empty collection is a known zero again.
  const COST_INPUTS = ['2', '3', '4', '5'];
  const cogsWhy = [...taint.activity, ...inventoryWhy]; // every unmapped income or expense account, every held income domain, every undisposed inventory movement
  if (cogsWhy.length) {
    const cogsReasons = [...new Set(cogsWhy)];
    const trades = acts.filter(x => x.schedule === 'p1' && effectiveIn(x, ret));
    for (const a of trades) {
      const id = Number(a.activity_id), path = paperPaths.get(id) ?? null;
      if (path === 'reviewed') continue;
      for (const n of COST_INPUTS) {
        const k = `f1125a.main.${n}|activity=act:${id}|activity`, sl = slots.get(k);
        if (sl && sl.provider !== 'cogs_workpaper') continue; // an assigned, typed input is independent of the books
        if (sl || path === 'reconstruct') values.set(k, { cents: null, reasons: [...new Set([...(values.get(k)?.reasons ?? []), ...cogsReasons])] });
        else if (!values.has(k)) values.set(k, { cents: null, reasons: [`${a.name}: a cost whose destination is not known yet could still be its cost of goods sold.`, ...cogsReasons] });
      }
    }
    // Membership itself (Codex t3-r5 R5-2, t3-r6 R6-1): with NO trade activity in effect there is no member at all to carry the uncertainty —
    // the aggregate gets an unresolved placeholder on a pending instance (no activity is invented), so page-1 COGS, the totals and applicability
    // are unknown until the source is disposed of. With trades in effect, membership is each trade's own (above): a missing or book-fed input is
    // unknown, while a trade whose inputs are all present and independently authoritative (every input typed, or a reviewed workpaper) is
    // complete — no missing member is inferred merely because none of its inputs took the hold.
    if (!trades.length) values.set('f1125a.main.2|activity=act:pending|activity', { cents: null, reasons: ['Cost of goods sold: a source whose destination is not known yet could still be purchases of an activity not yet recorded.', ...cogsReasons] });
  }
  // Required membership of a STARTED Form 1125-A computation (Codex t3-r7 R7-1), whatever the sources: an activity without a COGS workpaper
  // whose computation was started by provider inputs (any of its six inputs assigned or answered) needs all six — beginning inventory,
  // purchases, labor, section 263A, other costs, ending inventory. One with no entry is unknown, not an empty zero: tax inventory is entered
  // on the workpaper or typed (T2 Contract 6), so no book balance or disposition of an inventory account can supply it. Nothing is invented,
  // and an activity with no input at all keeps the generic empty-collection meaning (a known zero once every source is disposed of).
  // Reconcile saved assignments independently of activity eligibility (Codex t3-r9 R9-1). An ended or moved reference still names an
  // unfinished member: validate it by the same scope rule as a typed input or workpaper, and keep its uncertainty in the formula graph.
  for (const key of assignedTo.keys()) if (/^f1125a\.main\.[1-57]\|/.test(key)) {
    const scope = await slotScopeProblem(db, { orgId, ret, key });
    if (scope.problem) { values.set(collectionKey(key, ctx), { cents: null, reasons: [scope.problem] }); problems.push({ code: 'cogs_scope', message: scope.problem }); }
  }
  for (const a of acts) {
    const id = Number(a.activity_id);
    if (cogs.has(id)) continue; // a workpaper supplies (or holds) every line itself
    const keys = ['1', '2', '3', '4', '5', '7'].map(n => `f1125a.main.${n}|activity=act:${id}|activity`);
    // Started by a materialized input or answer, or by a SAVED provider assignment that nothing has materialized yet (Codex t3-r8 R8-1: a
    // cogs_workpaper, books or cash-layer assignment with no workpaper or route) — an assigned input with no provider result is unknown too.
    if (!keys.some(k => slots.has(k) || values.has(k) || assignedTo.has(k))) continue;
    for (const k of keys) if (!values.has(k)) values.set(k, { cents: null, reasons: [`${a.name}: Form 1125-A line ${k.split('|')[0].split('.').at(-1)} is not entered; once any of its inputs is typed, every input is needed (zero included).`] });
  }
  const leafTaint = new Map();
  if (taint.activity.length || taint.balance.length) {
    const slotIds = new Set(catalog.slots.map(l => l.id));
    const byCk = new Map();
    for (const sl of slots.values()) if (sl.line) { const ck = safeCk(sl.key); if (ck) byCk.set(ck, [...(byCk.get(ck) ?? []), sl]); }
    // Where a missing amount could land: the books' and the cash layer's slots, a line nothing routes to, a reconstructed workpaper's COST
    // inputs (handled above: their own amounts are already null) — never a typed or assigned amount, a reviewed workpaper's line, or the
    // entered tax inventory.
    const isCostInput = k => /^f1125a\.main\.[2-5]\|/.test(k);
    const couldConsume = (sl, k) => !sl.provider || sl.provider === 'books' || sl.provider === 'cash_layer' || (sl.provider === 'cogs_workpaper' && paperPaths.get(Number(sl.activityId)) !== 'reviewed' && isCostInput(k));
    for (const k of values.keys()) {
      const p = parseSlotKey(k);
      if (!slotIds.has(p.fieldId) || isEngineLine(p.fieldId)) continue;
      const why = p.measurement === 'activity' ? taint.activity : taint.balance;
      if (!why.length) continue;
      const sls = byCk.get(k) ?? [];
      if (sls.length && !sls.some(sl => couldConsume(sl, k))) continue;
      if (!sls.length && p.fieldId.startsWith('f1125a.main.') && !isCostInput(k)) continue; // an empty tax-inventory line is nobody's destination
      leafTaint.set(k, [...new Set(why)]);
    }
  }
  // Pass 1: everything but the M-1 differences.
  const first = evaluate(catalog, values, leafTaint);
  const spec = M1[ret.return_type];
  const before = first.get(`${spec.endpoint}|activity`);
  // T: each slot's provider amount before adjustments; the adjustments are differences of their own (by class).
  // plKnown: the book side alone (a tax-exempt line needs only its book amount).
  const bridgeSlots = [...slots.values()].filter(sl => sl.line && (sl.provider || sl.members.length) && measurementsOf(sl.line).includes('activity'))
    .map(sl => ({ key: sl.key, fieldId: sl.fieldId, provider: sl.provider, value: sl.value, plCents: sl.plCents, plKnown: sl.plKnown, activityId: sl.activityId }));
  const bridge = bridgeRows({ catalog, returnType: ret.return_type, slots: bridgeSlots, notTax, tieouts: new Map([...tieouts].map(([id, t]) => [id, { ...t, name: cogs.get(id)?.name ?? `activity ${id}` }])),
    deltas, unknown: [...bridgeWhy, ...(before?.cents === null || before === undefined ? (before?.reasons?.length ? before.reasons : ['The return’s income is not known yet.']) : [])] });
  // Pass 2: the M-1 cells from the bridge.
  const m1 = new Map(values);
  for (const [cell, id] of Object.entries(spec.rows)) {
    const rows = [...bridge.cells[cell]];
    m1.set(`${id}|activity`, bridge.unknown.length ? { cents: null, reasons: bridge.unknown } : { cents: rows.reduce((t, [, c]) => t + c, 0n), reasons: [], rows: rows.map(([label, cents]) => ({ label, cents })) });
  }
  for (const [cell, id] of Object.entries(M1_ENGINE)) m1.set(`${id}|activity`, bridge.unknown.length ? { cents: null, reasons: bridge.unknown } : { cents: bridge.cells[cell], reasons: [] });
  const final = evaluate(catalog, m1, leafTaint);
  const endpoint = final.get(`${spec.endpoint}|activity`), m1Result = final.get(`${spec.result}|activity`);
  const residual = endpoint?.cents !== null && endpoint?.cents !== undefined && m1Result?.cents !== null && m1Result?.cents !== undefined ? endpoint.cents - m1Result.cents : null;

  // ---- 8. Checks.
  const checks = [];
  const err = (code, message, extra = {}) => checks.push({ level: 'error', code, message, ...extra });
  const warn = (code, message, extra = {}) => checks.push({ level: 'warning', code, message, ...extra });
  for (const ms of ['begin', 'end']) {
    const a = final.get(`${L.assets}|${ms}`), b = final.get(`${L.total}|${ms}`);
    if (a?.cents !== null && b?.cents !== null && a && b && a.cents !== b.cents) err('schedule_l_unbalanced', `Schedule L is out of balance at the ${ms === 'begin' ? 'beginning' : 'end'} of the year by ${a.cents - b.cents} cents (total assets less total liabilities and capital).`);
  }
  for (const p of problems) err(p.code, p.message, p.itemKey ? { itemKey: p.itemKey } : {});
  if (cov.totals.uncovered || cov.totals.unresolved || cov.totals.stale || cov.totals.blocked || cov.totals.hidden) {
    err('coverage', `${cov.totals.uncovered} accounts need mapping, ${cov.totals.unresolved} wait on something, ${cov.totals.stale} changed since mapped and ${cov.totals.blocked + cov.totals.hidden} books cannot be read here (mapping page).`);
  }
  for (const c of candidates) if (c.state !== 'decided') err('closing_candidate', `${c.state === 'stale' ? 'Changed since classified' : 'Possible closing entry'}: journal entry ${c.docNumber || c.txnId} of ${c.date}.`, { txnId: c.txnId });
  const subsetZero = n => n.subsetOf && values.get(n.subsetOf)?.cents === 0n;
  for (const n of needs) if (!itemOf(n.key) && n.key !== K1_ANSWER && !subsetZero(n)) err('manual_open', `${n.line?.label ?? n.key}${n.activity ? ` (${n.activity})` : ''}: not entered.`, { itemKey: n.key });
  if (k1Why) err('k1_inflows', k1Why);
  for (const p of proposals) if (!p.answer?.fresh) err('proposal_open', `${p.answer ? 'Changed since answered' : 'Waiting'}: ${p.why} (${p.accountName}).`, { key: p.key });
  for (const c of [...(rec?.candidates ?? []), ...(timing?.candidates ?? [])]) if (c.state !== 'decided') err('timing_open', `${c.state === 'stale' ? 'Changed since decided' : 'Timing review'}: ${c.reason}`, { txnId: c.txnId });
  for (const e of cogs.values()) for (const why of new Set(e.reasons)) err('cogs', `${e.name}: ${why}`);
  for (const sl of slots.values()) if (!sl.known && sl.provider !== 'manual' && sl.provider !== 'cogs_workpaper') for (const why of new Set(sl.reasons)) err('slot', `${sl.line?.label ?? sl.fieldId}: ${why}`, { slotKey: sl.key });
  for (const [k, c] of collections) if (c.status === 'conflict') err('provider_conflict', `${k}: two providers or packets claim the same source or slot.`);
  for (const w of new Set([...taint.activity, ...taint.balance])) err('incomplete', w);
  for (const u of bridge.unclassified) err('m1_unclassified', `${u.label}: ${u.cents} cents of book income or expense reach a line outside the income reconciliation; bind the account to a reconciled line or record the difference as an adjustment.`);
  if (residual !== null && residual !== 0n) err('m1_residual', `Schedule M-1 does not reconcile: the return’s income and net income per books plus the classified differences differ by ${residual} cents.`);
  for (const t of t4) err('t4', { guaranteed_payment: gpWhy, equity_event: 'Owner equity events are computed in stage T4.', k1_booked: 'K-1 income booked here is replaced by the K-1 record in stage T4.' }[t]);
  // An accepted answer superseded on a proposal that is still computed (its version changed: the proposal waits again, proposal_open above) is
  // history; one whose proposal is gone is an orphan, an error of its own (proposal_orphan above) — never a warning beside complete defaults.
  for (const g of groups) if (g.source === 'proposal' && !g.superseded_at && g.status === 'accepted' && proposals.some(p => p.key === g.source_ref) && !proposals.some(p => p.answer?.group_id === g.group_id && p.answer.fresh)) warn('stale_answer', `The answer to a proposal no longer matches it and is not applied: ${g.memo}.`);
  if (ret.return_type === 'form_1065') warn('t4_se', 'Schedule K lines 14a and 14c (self-employment) are computed with the partners’ records in stage T4: they show as not known.');
  for (const n of openingNotes) warn('openings_source', n);
  warn('finalization', 'This is a draft: marking the return final arrives with stage T4.');

  // ---- 9. Results (spec §4.3 results; the T5 printing slice reads these): catalog field ids, exact semantic cents as strings, one entry per
  // value, the four sign facts applied once (printedValue applies the form's own polarity when printing). A line kept per owner that waits
  // for stage T4 is listed (interest i:t4), unresolved, so a consumer sees it is missing rather than absent.
  const fields = [];
  for (const [k, v] of final) {
    const p = parseSlotKey(k);
    if (!reach.has(p.fieldId)) continue;
    // A statement line's rows add up to its amount: each provider's named rows, then one row per adjustment on the line.
    const rows = v.rows ?? [...[...slots.values()].filter(sl => sl.line?.type === 'statement' && collectionKey(sl.key, ctx) === k && sl.rows).flatMap(sl => sl.rows),
      ...deltas.filter(d => collectionKey(d.slotKey, ctx) === k).map(d => ({ label: d.rowLabel ?? d.label, cents: d.cents }))];
    const prov = [...slots.values()].filter(sl => collectionKey(sl.key, ctx) === k).map(sl => sl.provider).filter(Boolean);
    fields.push({ key: k, fieldId: p.fieldId, dims: p.dims, measurement: p.measurement, cents: s(v.cents), status: v.cents === null ? 'unresolved' : 'complete', reasons: v.reasons ?? [],
      providers: [...new Set(prov)], rows: catalog.byId.get(p.fieldId)?.type === 'statement' && v.cents !== null ? rows.map(x => ({ label: x.label, cents: s(x.cents) })) : null });
  }
  fields.sort((a, b) => (a.key < b.key ? -1 : 1));
  // The return's header as stored, every fact of it (final_return, the initial-period and predecessor exceptions too), but nothing personal.
  const { rows: [hdr] } = await db.query(`SELECT to_jsonb(r) - 'dependents_enc' - 'created_at' - 'updated_at' AS h FROM tax_return r WHERE r.org_id = $1 AND r.return_id = $2`, [orgId, ret.return_id]);
  const facts = applicabilityFacts(ret, final, { cogs, rentals: acts.filter(a => a.schedule === 'f8825' && String(a.effective_from) <= ret.period_end && (!a.effective_to || String(a.effective_to) >= ret.period_start)).length });
  // What the computation consumed, for the working revision to freeze (lib/tax/engine/revision.js): the return's header and its
  // activities, the cash layer's and the accrual gate's transactions, postings, applications and decisions, the adjustment groups whole.
  const deps = { header: { ...hdr.h, company: ret.entity_name },
  activities: acts.map(a => ({ ...a, activity_id: Number(a.activity_id) })), cash: rec?.deps ?? null, timing: timing?.deps ?? null,
  groups: groups.map(g => ({ id: g.group_id, purpose: g.purpose, source: g.source, ref: g.source_ref, version: g.source_version, memo: g.memo, evidence: g.evidence, status: g.status, reason: g.reason, by: g.decided_by, superseded: g.superseded_at ?? null, lines: g.lines })) };
  return {
    orgId, ret, engineVersion: ENGINE_VERSION, catalogHash: catalogHash(catalog), refused: null,
    fields, checks, values: final,
    bridge: { bookNetIncome: bookNIKnown ? s(bookNI) : null, endpoint: spec.endpoint, endpointCents: s(endpoint?.cents ?? null), m1Cents: s(m1Result?.cents ?? null), residual: s(residual),
      rows: bridge.rows.map(x => ({ ...x, cents: s(x.cents) })), unknown: bridge.unknown, unclassified: bridge.unclassified.map(u => ({ ...u, cents: s(u.cents) })) },
    slots: [...slots.values()].map(sl => ({ key: sl.key, fieldId: sl.fieldId, provider: sl.provider, cents: s(sl.value), reasons: [...new Set(sl.reasons)],
      members: sl.members.map(m => ({ kind: m.kind, id: m.id, accountId: m.accountId, accountName: m.accountName, measurement: m.measurement, ledgerCents: s(m.cents), bookCents: s(m.book), role: m.role, treatment: m.treatment, rowLabel: m.rowLabel })),
      extras: (sl.extras ?? []).map(m => ({ label: m.label, ledgerCents: s(m.ledger) })), cashItems: (sl.cashItems ?? []).map(it => ({ label: it.label, txnId: it.txnId, ledgerCents: s(it.cents) })) })),
    packets: [...packets.map(x => x.packet), ...subsetPackets], deltas: deltas.map(d => ({ ...d, cents: s(d.cents) })), proposals, orphanAnswers, candidates, cash: rec, timing, cogs, cogsClasses: cogs.classes ?? [], needs, items, orphanItems, holds, k1Answer, openings, cov,
    applicability: facts, deps,
  };
}
const REVIEW_LABEL = { imported_accrual_je: 'accrual entry', related_party_accrual: 'related party', economic_performance: 'economic performance' };
// The applicability facts the computed draft supplies (T1 review gate: derived once, from the same numbers, so they cannot contradict them),
// three-state: a COGS activity or a rental activity that exists decides by its existence and its known amounts — an unfinished workpaper
// is 'unknown', never false; a known-zero completed workpaper deducts no COGS. What the books cannot say is 'unknown'.
function applicabilityFacts(ret, values, { cogs, rentals }) {
  const get = k => values.get(k)?.cents ?? null;
  const cents = v => (v === null ? 'unknown' : v < 0n ? 0n : v);
  const threeState = keys => { let unknown = false; for (const k of keys) { const v = values.get(k); if (!v || v.cents === null) unknown = true; else if (v.cents !== 0n) return true; } return unknown ? 'unknown' : false; };
  // Whether the return deducts cost of goods sold follows the aggregate page-1 line 2 (Codex t3-r3 R3-3): unknown while any activity's
  // membership is unresolved (a placeholder member included), false only for a known zero, true for a known positive amount.
  const deductsCogs = threeState([`${ret.return_type === 'form_1065' ? 'f1065' : 'f1120s'}.p1.2|activity`]);
  const hasRental = rentals > 0 ? true : threeState([...values.keys()].filter(k => k.startsWith('f8825.main.')));
  const base = ret.return_type === 'form_1065'
    ? { receiptsCents: cents(get('f1065.p1.1a|activity')), assetsEndCents: cents(get('f1065.L.14|end')), k1sFiledAndFurnishedTimely: 'unknown', filesOrMustFileScheduleM3: 'unknown', deductsCogs, hasRental }
    : { receiptsCents: cents(get('f1120s.p1.1a|activity')), assetsEndCents: cents(get('f1120s.L.15|end')), officerCompCents: 'unknown', deductsCogs, hasRental };
  try { return { facts: Object.fromEntries(Object.entries(base).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])), schedules: applicability(ret.return_type, ret.form_edition, base) }; }
  catch (e) { return { facts: {}, schedules: null, problem: e.message }; }
}
