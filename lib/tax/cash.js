// lib/tax/cash.js
// The tax cash layer (spec §4.11, §5.3, §13.1 T3): what a cash-method return recognizes from accrual books, keyed to economic events, and
// the timing reviews a person decides. Exact BigInt cents throughout (lib/reports/ledger-data.js computes the books' own cash basis in
// Number; this module follows the same allocation rule — each application brings in its share of the document's postings, shared on the
// cumulative amount applied, largest remainder — in BigInt and never calls it).
// Economic events and their recognition:
//   direct      a transaction that is not an accrual document and posts income or expense with a cash leg (a bank, a credit card or
//               Undeposited Funds): a sales receipt, an expense or check, a card purchase (recognized when charged — the card-liability
//               repayment later posts no income or expense), a card refund (cc_credit: a negative deduction when credited), a merchant
//               settlement deposited straight to income (its bank date unless a reviewed receipt date moves it), a payment's processor
//               fee; recognized on its date. A voided transaction is no event at all (its postings and applications are left out);
//   noncash     a journal entry, an inventory adjustment or a revaluation with no cash leg (depreciation, a reclass): as posted, except
//               that an entry against receivables, payables or accrued/prepaid balances (an imported accrual, its reversal next year
//               too) is a timing review;
//   application each application (a payment or credit applied to an invoice, bill or credit, on its date) brings in that share of the
//               document's income and expense postings — partial payments, credit memos, refunds applied; an unpaid document nothing;
//   advance     money received or paid in the period and still unapplied at its end (a customer advance, a vendor prepayment): nothing
//               until reviewed; an unrestricted advance or a deducted prepayment is recognized WHOLE on a reviewed destination in this
//               period, and its later applications — in any later period — consume that amount in date order (a December advance is
//               recorded once, never again when January's or a later year's invoice arrives); a refundable deposit is recognized when
//               applied.
// Every reviewable event has an amount and a version (event_version): its legs, or the payment with every application of it up to the
// period end. A review records the version it was decided against; a later application, a resized or re-pointed one, or an edited
// transaction makes it STALE — then what it decided is unresolved (never the default) until it is decided again. A review is always of the
// event's whole amount: a split is refused in this stage. Reviews live on the return of the period the money moved (or the accrual was
// booked) in; a period reads its own, every earlier period's (advances consumed now) and its successor's (settlements dated after the
// period end whose reviewed receipt date falls in it). An undecided candidate does not stop the draft (the default stands: the books' own
// timing); it blocks finalization (spec §4.11) and is listed as waiting.
// Every transaction, posting and application consumed is collected with its version (deps): the working revision freezes them.
import { createHash } from 'node:crypto';
import { withTransaction } from '../db.js';
import { ValidationError } from '../data/writes.js';
import { PL_TYPES } from '../reports/statements.js';
import { parseCentsBig } from './partition.js';
import { isCogsLine } from './destinations.js';
import { closingExclusions } from './measure.js';
import { openTaxReturn, idOf, personOf, checkSlotScope } from './open-return.js';

const fail = message => { throw new ValidationError(message); };
const md5 = text => createHash('md5').update(text).digest('hex');
export const versionOf = state => md5(JSON.stringify(state, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
export const ACCRUAL_TYPES = ['invoice', 'credit_memo', 'late_fee', 'bill', 'vendor_credit', 'item_receipt'];
const ACCRUAL_BALANCES = ['accounts_receivable', 'accounts_payable', 'other_current_asset', 'other_current_liability'];
const VENDOR_TYPES = ['bill_payment', 'check', 'expense', 'bill', 'vendor_credit', 'item_receipt'];
export const RECEIPT_WINDOW_DAYS = 7;
export const REVIEW_KINDS = {
  unrestricted_advance: 'Unrestricted advance: income when received', refundable_deposit: 'Refundable deposit: income when applied', prepaid_expense: 'Prepayment',
  opening_ar_ap_payment: 'Money applied to an earlier balance', earlier_settlement: 'Received or paid before this period and applied now', receipt_date: 'Reviewed receipt date',
  imported_accrual_je: 'Accrual journal entry', related_party_accrual: 'Accrual to a related party', economic_performance: 'Economic performance not met by the period end',
};
// The decisions that answer one situation replace each other on save (one decision per transaction and situation).
const GROUPS = [['unrestricted_advance', 'refundable_deposit', 'prepaid_expense'], ['opening_ar_ap_payment'], ['earlier_settlement'], ['receipt_date'],
  ['imported_accrual_je', 'related_party_accrual', 'economic_performance']];
export const ACCRUAL_KINDS = GROUPS[4];
const groupOf = kind => GROUPS.find(g => g.includes(kind));
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
// The size of an amount whatever its side (an event's gross amount, a remainder): never a tax amount's sign (those stay semantic).
const gross = c => (c < 0n ? -c : c);

// Exact largest-remainder split of amount across weights (lib/reports/ledger-data.js prorate, in BigInt): each part truncates amount × w /
// total toward zero; the cents left go one at a time, with the sign of what is left, to the largest remainders (ties to the earlier weight).
export function prorateBig(amount, weights) {
  const total = weights.reduce((s, w) => s + w, 0n);
  if (total === 0n) return weights.map(() => 0n);
  const parts = weights.map((w, i) => { const num = amount * w; const q = num / total; return { i, q, rem: gross(num - q * total) }; });
  let left = amount - parts.reduce((s, p) => s + p.q, 0n);
  const order = [...parts].sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  for (let k = 0; left !== 0n && k < order.length; k += 1) { const step = left > 0n ? 1n : -1n; order[k].q += step; left -= step; }
  return parts.map(p => p.q);
}

// Every period of a company, for reviews that cross a boundary.
async function periodsOf(db, { orgId, entityId }) {
  const { rows } = await db.query(`SELECT return_id, status, period_start::text AS s, period_end::text AS e FROM tax_return WHERE org_id = $1 AND entity_id = $2 ORDER BY period_start`, [orgId, entityId]);
  return rows.map(r => ({ ...r, return_id: Number(r.return_id) }));
}
// Reviews of some returns, each with whether its transaction still matches (the event version is checked by the caller, which knows the event).
async function reviewsOf(db, { orgId, returnIds }) {
  const ids = [...new Set(returnIds.filter(Boolean).map(Number))];
  if (!ids.length) return [];
  const { rows } = await db.query(`SELECT r.review_id, r.return_id, r.txn_id, r.kind, r.decision, r.slot_key, r.cents::text AS cents, r.recognize_on::text AS recognize_on, r.txn_version,
      r.event_version, r.affected_accounts, r.affected_domains, r.source_accounts, r.reviewed_by, r.reason, txn_version(r.txn_id) AS current_version FROM cash_timing_review r WHERE r.org_id = $1 AND r.return_id = ANY($2::bigint[]) ORDER BY r.review_id`, [orgId, ids]);
  return rows.map(r => ({ ...r, review_id: Number(r.review_id), return_id: Number(r.return_id), txn_id: Number(r.txn_id), cents: r.cents === null ? null : BigInt(r.cents),
    affected_accounts: (r.affected_accounts ?? []).map(Number), affected_domains: r.affected_domains?.length ? r.affected_domains : ['income'], source_accounts: (r.source_accounts ?? []).map(Number), stale: r.current_version !== r.txn_version }));
}
// What a revision freezes of a decision read: its content, not only its id.
const reviewDep = r => ({ id: r.review_id, returnId: r.return_id, txnId: r.txn_id, kind: r.kind, decision: r.decision, slot: r.slot_key, cents: r.cents, on: r.recognize_on,
  txnVersion: r.txn_version, eventVersion: r.event_version, accounts: r.affected_accounts, domains: r.affected_domains, sources: r.source_accounts, by: r.reviewed_by, reason: r.reason });

// The source's accounts, and which are cash, P&L or accrual balances.
async function accountsOf(db, { orgId, entityId }) {
  const { rows } = await db.query('SELECT account_id, name, type, system_key FROM account WHERE org_id = $1 AND entity_id = $2', [orgId, entityId]);
  return new Map(rows.map(a => [Number(a.account_id), { id: Number(a.account_id), name: a.name, type: a.type, systemKey: a.system_key,
    cash: a.type === 'bank' || a.type === 'credit_card' || a.system_key === 'undeposited', pl: PL_TYPES.includes(a.type),
    accrual: ACCRUAL_BALANCES.includes(a.type) && a.system_key !== 'undeposited' }]));
}
// Transactions of the source with all their legs: those dated in [from, to] that are not accrual documents (direct), or those named.
async function txnsWithLegs(db, { orgId, entityId, from = null, to = null, ids = [] }) {
  const { rows } = await db.query(`SELECT t.txn_id, t.type, t.txn_date::text AS date, t.doc_number, txn_version(t.txn_id) AS v, p.line_no, p.account_id, p.amount_cents::text AS cents
      FROM txn t JOIN posting p ON p.org_id = t.org_id AND p.txn_id = t.txn_id
     WHERE t.org_id = $1 AND t.entity_id = $2 AND t.voided_at IS NULL
       AND ((t.type <> ALL($5::text[]) AND t.txn_date BETWEEN $3::date AND $4::date) OR t.txn_id = ANY($6::bigint[]))
     ORDER BY t.txn_date, t.txn_id, p.line_no NULLS FIRST, p.posting_id`, [orgId, entityId, from ?? '9999-12-31', to ?? '0001-01-01', ACCRUAL_TYPES, ids]);
  const out = new Map();
  for (const r of rows) {
    const id = Number(r.txn_id);
    if (!out.has(id)) out.set(id, { txnId: id, type: r.type, date: r.date, docNumber: r.doc_number, txnVersion: r.v, legs: [] });
    out.get(id).legs.push({ lineNo: r.line_no === null ? null : Number(r.line_no), accountId: Number(r.account_id), cents: BigInt(r.cents) });
  }
  return [...out.values()];
}
const lineKeyOf = (txnId, lineNo) => `${txnId}/${lineNo ?? 0}`;
const legsState = legs => legs.map(l => [l.accountId, l.lineNo, l.cents]);

// The cash recognition of one source on one cash-method return. → { byAccount: Map accountId → ledger cents (debit +), slotItems: [{ slotKey,
// cents (ledger), txnId, kind, label, reviewId }], events, candidates, selectable: { receipts }, unresolved: [{ reason, accountIds, slotKeys }],
// applications (this period's), reviews, deps: { txns: Map txnId → version, postings: Map txnId → legs, applications, reviews: Map id → review },
// version }.
export async function cashRecognition(db, { orgId, ret }) {
  const S = ret.entity_id, start = ret.period_start, end = ret.period_end;
  const accounts = await accountsOf(db, { orgId, entityId: S });
  const excluded = new Set((await closingExclusions(db, { orgId, returnId: ret.return_id, sourceEntityId: S })).keys);
  const periods = await periodsOf(db, { orgId, entityId: S });
  const periodOf = date => periods.find(p => p.s <= date && date <= p.e) ?? null;
  const next = periods.find(p => p.s === addDays(end, 1)) ?? null;
  const reviews = await reviewsOf(db, { orgId, returnIds: [ret.return_id, next?.return_id, ...periods.filter(p => p.e < start).map(p => p.return_id)] });
  const own = reviews.filter(r => r.return_id === Number(ret.return_id));
  const deps = { txns: new Map(), postings: new Map(), applications: [], reviews: new Map() };
  const useTxn = t => { deps.txns.set(t.txnId, t.txnVersion); deps.postings.set(t.txnId, legsState(t.legs)); };
  const useReview = r => { if (r) deps.reviews.set(r.review_id, reviewDep(r)); };
  own.forEach(useReview);
  const byAccount = new Map(), slotItems = [], events = [], candidates = [], unresolved = [], receipts = [];
  const recognize = (accountId, cents, ev) => { if (!cents) return; byAccount.set(accountId, (byAccount.get(accountId) ?? 0n) + cents); events.push({ ...ev, accountId, cents }); };
  // wide: what is unresolved has no account or destination of its own (money applied to an opening balance): the return's income is.
  // domains: what the decision decided, as saved with it (a timing decision: income).
  const unresolve = (reason, { accountIds = [], slotKeys = [], wide = false, domains = ['income'] }) => unresolved.push({ reason, accountIds: [...new Set(accountIds.map(Number))], slotKeys: [...new Set(slotKeys.filter(Boolean))], wide, domains });
  // A candidate and the state of its decision: open (none), decided (it matches the transaction AND the event), stale (made against another).
  const candidate = (c, kinds) => {
    const review = own.find(r => r.txn_id === c.txnId && kinds.includes(r.kind)) ?? null;
    const state = !review ? 'open' : review.stale || review.event_version !== c.eventVersion ? 'stale' : 'decided';
    const out = { ...c, kinds, review, state };
    candidates.push(out);
    return out;
  };
  const plLegs = t => t.legs.filter(l => accounts.get(l.accountId)?.pl && !excluded.has(lineKeyOf(t.txnId, l.lineNo)));
  const fresh = (r, eventVersion) => r && !r.stale && r.event_version === eventVersion;

  // Prepaid accounts a reviewed, deducted prepayment was paid into (this period or earlier), read from the SAVED decisions (source_accounts:
  // the prepaid accounts the payment posted to when it was decided — Codex t3-plan-r6 R6-1), never from the payment as it is now: an entry
  // using up such a prepayment waits for a decision instead of being deducted again by default. Each saved decision is checked against its
  // source as it is now — the payment unchanged (its version), dated in the period that decided it, still paying into the saved accounts,
  // not voided or gone — otherwise the association is STALE: the entry using the account is held, never deducted by default, until the
  // decision is cleared on its own period. Every decision an entry uses is a dependency of this period (frozen with the revision).
  const prepaidReviews = reviews.filter(r => r.kind === 'prepaid_expense' && r.decision === 'include' && r.return_id !== next?.return_id);
  const { rows: prepaidNow } = prepaidReviews.length ? await db.query(`SELECT t.txn_id, t.txn_date::text AS date, t.voided_at IS NOT NULL AS voided,
      coalesce(array_agg(p.account_id) FILTER (WHERE p.amount_cents > 0 AND a.type = 'other_current_asset'), '{}') AS into_accounts
      FROM txn t LEFT JOIN posting p ON p.org_id = t.org_id AND p.txn_id = t.txn_id LEFT JOIN account a ON a.org_id = p.org_id AND a.account_id = p.account_id
     WHERE t.org_id = $1 AND t.txn_id = ANY($2::bigint[]) AND t.type IN ('expense', 'check') GROUP BY t.txn_id, t.txn_date, t.voided_at`, [orgId, prepaidReviews.map(r => r.txn_id)]) : { rows: [] };
  // The payments themselves, as they are now (version and legs), frozen with the revision when an entry uses them — present or, when voided or
  // deleted, explicitly absent (Codex t3-plan-r7 R7-4) — whatever the coverage of the accounts they post to.
  const prepaidSrc = new Map(prepaidReviews.length ? (await txnsWithLegs(db, { orgId, entityId: S, ids: prepaidReviews.map(r => r.txn_id) })).map(t => [t.txnId, t]) : []);
  const deductedPrepaid = new Map(); // prepaid account → [{ review, why (stale) | null }]
  for (const r of prepaidReviews) {
    const p = periods.find(x => x.return_id === r.return_id), y = p?.e.slice(0, 4) ?? '', now = prepaidNow.find(x => Number(x.txn_id) === r.txn_id) ?? null;
    const into = (now?.into_accounts ?? []).map(Number);
    const why = !now || now.voided ? `The prepayment ${r.txn_id}, deducted when paid on the ${y} period, is no longer in the books: clear that decision.`
      : r.stale ? `The prepayment ${r.txn_id}, deducted when paid on the ${y} period, changed since: review it again there.`
        : !p || now.date < p.s || now.date > p.e ? `The prepayment ${r.txn_id}, deducted when paid on the ${y} period, is now dated ${now.date}, outside that period: clear that decision.`
          : r.source_accounts.some(id => !into.includes(id)) ? `The prepayment ${r.txn_id}, deducted when paid on the ${y} period, no longer pays into the prepaid account it was decided on: clear that decision.` : null;
    for (const id of r.source_accounts) { if (!deductedPrepaid.has(id)) deductedPrepaid.set(id, []); deductedPrepaid.get(id).push({ review: r, why }); }
  }

  // 1. Direct and noncash transactions of the period, and settlements dated after it whose reviewed receipt date (on the next period's
  //    return) falls in it.
  const fromNext = next ? reviews.filter(r => r.return_id === next.return_id && r.kind === 'receipt_date' && r.recognize_on >= start && r.recognize_on <= end) : [];
  const txns = await txnsWithLegs(db, { orgId, entityId: S, from: start, to: end, ids: fromNext.map(r => r.txn_id) });
  // A settlement the next period moved into this one that is gone (voided, deleted): what it brought in is unresolved, never a known zero.
  for (const r of fromNext) if (!txns.some(t => t.txnId === r.txn_id)) {
    useReview(r);
    unresolve(`A deposit reviewed as received on ${r.recognize_on}, in this period, is no longer in the books: clear its receipt date on the next period.`, { accountIds: r.affected_accounts, wide: !r.affected_accounts.length });
  }
  for (const t of txns) {
    useTxn(t);
    const pl = plLegs(t);
    const hasCash = t.legs.some(l => accounts.get(l.accountId)?.cash);
    const inPeriod = t.date >= start && t.date <= end;
    let on = t.date;
    const incomeDeposit = hasCash && t.type === 'deposit' && pl.some(l => l.cents < 0n);
    const receiptVersion = versionOf(['receipt', legsState(pl)]);
    // The next period's receipt date for this deposit, reconciled whatever the deposit's date is now (Codex t3-plan-r4 R4-1): it holds only
    // while the deposit is still dated in that period and unchanged; redated (into this period, or anywhere else) or changed, it stays a
    // dependency and what it decided — the accounts it brought income to, and those the deposit posts to now — is unresolved, never
    // recognized by default, until it is cleared on the next period.
    const succ = fromNext.find(x => x.txn_id === t.txnId);
    if (succ) {
      useReview(succ);
      const eligible = !inPeriod && t.date >= next.s && t.date <= next.e;
      if (!eligible || !fresh(succ, receiptVersion)) {
        const accountIds = [...pl.map(l => l.accountId), ...succ.affected_accounts];
        unresolve(eligible ? `The deposit of ${t.date} was reviewed as received on ${succ.recognize_on}, in this period, and has changed since: review its receipt date again on the next period.`
          : `The deposit now dated ${t.date} was reviewed on the next period as received on ${succ.recognize_on}; it is no longer dated in that period: clear its receipt date on the next period.`, { accountIds, wide: !accountIds.length });
        continue;
      }
      on = succ.recognize_on;
    } else if (incomeDeposit) {
      // A settlement may be an earlier period's receipt the bank dated later (a card batch): the first week is suggested; any other
      // deposit to income can be selected and reviewed.
      const ev = { txnId: t.txnId, date: t.date, docNumber: t.docNumber, txnVersion: t.txnVersion, cents: -pl.reduce((s, l) => s + l.cents, 0n), eventVersion: receiptVersion, needsSlot: false, accountIds: pl.map(l => l.accountId) };
      const suggested = t.date <= addDays(start, RECEIPT_WINDOW_DAYS - 1);
      if (suggested || own.some(r => r.txn_id === t.txnId && r.kind === 'receipt_date')) {
        const c = candidate({ ...ev, reason: suggested ? `A deposit to income on ${t.date}, in the first ${RECEIPT_WINDOW_DAYS} days of the period: is it money received in the previous period (a card settlement)?`
          : `A deposit to income on ${t.date}, reviewed for its receipt date.` }, ['receipt_date']);
        if (c.state === 'decided') on = c.review.recognize_on;
        if (c.state === 'stale') unresolve(`The deposit of ${t.date} changed after its receipt date was reviewed: review it again.`, { accountIds: [...pl.map(l => l.accountId), ...c.review.affected_accounts] });
      } else receipts.push(ev);
      if (on < start) continue;
    }
    // Money into a prepaid asset (an expense or a check categorized to a prepaid account; a transfer or journal entry is not a purchase):
    // nothing until reviewed.
    const prepaid = hasCash && inPeriod && ['expense', 'check'].includes(t.type) ? t.legs.filter(l => accounts.get(l.accountId)?.type === 'other_current_asset' && !accounts.get(l.accountId)?.cash && l.cents > 0n) : [];
    if (prepaid.length) {
      const c = candidate({ txnId: t.txnId, date: t.date, docNumber: t.docNumber, txnVersion: t.txnVersion, cents: prepaid.reduce((s, l) => s + l.cents, 0n), eventVersion: versionOf(['prepaid', legsState(prepaid)]),
        reason: `Paid ${t.date} to a prepaid account: deduct it now (cash method) or when it is used?`, needsSlot: true, side: 'vendor', accountIds: [], sourceAccountIds: prepaid.map(l => l.accountId) }, ['prepaid_expense']);
      if (c.state === 'decided' && c.review.decision === 'include') slotItems.push({ slotKey: c.review.slot_key, cents: c.review.cents, txnId: t.txnId, kind: 'prepaid', label: `Prepayment ${t.docNumber || t.txnId}`, reviewId: c.review.review_id });
      if (c.state === 'stale') unresolve(`The prepayment of ${t.date} changed after it was reviewed: review it again.`, c.review.decision === 'include' ? { slotKeys: [c.review.slot_key] } : { wide: true });
    }
    if (!pl.length) continue;
    const accrual = !hasCash && inPeriod && t.legs.some(l => accounts.get(l.accountId)?.accrual);
    if (accrual) {
      // The prepayments this entry uses up, by the SAVED record: each is a dependency; a stale one holds this entry's income and expense.
      const used = t.legs.filter(l => l.cents < 0n && deductedPrepaid.has(l.accountId)).flatMap(l => deductedPrepaid.get(l.accountId));
      const usesDeducted = used.length > 0;
      for (const u of used) {
        useReview(u.review);
        const src = prepaidSrc.get(u.review.txn_id);
        if (src) useTxn(src); else { deps.txns.set(u.review.txn_id, null); deps.postings.set(u.review.txn_id, []); }
      }
      for (const u of used) if (u.why) unresolve(`Journal entry ${t.docNumber || t.txnId} uses up a prepayment whose decision no longer matches its payment. ${u.why}`, { accountIds: pl.map(l => l.accountId) });
      const c = candidate({ txnId: t.txnId, date: t.date, docNumber: t.docNumber, txnVersion: t.txnVersion, cents: pl.reduce((s, l) => s + gross(l.cents), 0n), eventVersion: versionOf(['accrual', legsState(pl)]), needsSlot: false, accountIds: pl.map(l => l.accountId),
        reason: usesDeducted ? 'A journal entry uses up a prepayment that was deducted when paid: is this expense deducted again (include) or not (exclude)?'
          : 'A journal entry accrues income or expense against a receivable, payable or accrued balance: on the cash method it counts only when paid.' }, ['imported_accrual_je']);
      if (c.state === 'decided' && c.review.decision === 'exclude') { events.push({ kind: 'excluded', txnId: t.txnId, date: t.date, cents: 0n }); continue; }
      if (c.state === 'stale') unresolve(`Journal entry ${t.docNumber || t.txnId} changed after it was reviewed: review it again.`, { accountIds: [...pl.map(l => l.accountId), ...c.review.affected_accounts] });
      if (c.state === 'open' && usesDeducted) unresolve(`Journal entry ${t.docNumber || t.txnId} uses up a prepayment already deducted: decide it before it is deducted again.`, { accountIds: pl.map(l => l.accountId) });
    }
    const kind = !hasCash ? 'noncash' : t.legs.some(l => accounts.get(l.accountId)?.type === 'credit_card') ? 'card' : t.type === 'deposit' ? 'settlement' : 'direct';
    for (const l of pl) recognize(l.accountId, l.cents, { kind, txnId: t.txnId, lineNo: l.lineNo, date: on });
  }

  // 2. Applications: every one up to the period end, in date order, so each document is shared on its cumulative applied amount.
  const { rows: apps } = await db.query(`SELECT a.application_id, a.amount_cents::text AS amount, a.applied_on::text AS date, a.credit_txn_id, a.charge_txn_id, c.type AS credit_type, h.type AS charge_type,
      c.txn_date::text AS credit_date, c.total_cents::text AS credit_total, c.doc_number AS credit_doc, txn_version(c.txn_id) AS credit_version, txn_version(h.txn_id) AS charge_version
      FROM application a JOIN txn c ON c.org_id = a.org_id AND c.txn_id = a.credit_txn_id JOIN txn h ON h.org_id = a.org_id AND h.txn_id = a.charge_txn_id
     WHERE a.org_id = $1 AND h.entity_id = $2 AND a.applied_on <= $3::date AND h.voided_at IS NULL AND c.voided_at IS NULL
     ORDER BY a.applied_on, a.application_id`, [orgId, S, end]);
  for (const a of apps) {
    Object.assign(a, { id: Number(a.application_id), credit: Number(a.credit_txn_id), charge: Number(a.charge_txn_id), cents: BigInt(a.amount), chargeDoc: ACCRUAL_TYPES.includes(a.charge_type), creditDoc: ACCRUAL_TYPES.includes(a.credit_type) });
    deps.txns.set(a.credit, a.credit_version); deps.txns.set(a.charge, a.charge_version);
    deps.applications.push([a.id, a.credit, a.charge, a.cents, a.date]);
  }
  const appState = list => list.map(a => [a.id, a.charge, a.cents, a.date]);
  const { rows: sys } = await db.query(`SELECT system_key, account_id FROM account WHERE org_id = $1 AND entity_id = $2 AND system_key IN ('ar', 'ap')`, [orgId, S]);
  const arap = sys.map(r => Number(r.account_id));
  const docIds = [...new Set(apps.flatMap(a => [a.chargeDoc ? a.charge : null, a.creditDoc ? a.credit : null]).filter(Boolean))];
  const { rows: docPostings } = docIds.length ? await db.query(`SELECT p.txn_id, p.line_no, p.account_id, p.amount_cents::text AS cents FROM posting p WHERE p.org_id = $1 AND p.txn_id = ANY($2::bigint[])
     ORDER BY p.txn_id, p.line_no NULLS FIRST, p.posting_id`, [orgId, docIds]) : { rows: [] };
  const legsOf = new Map();
  for (const r of docPostings) {
    const id = Number(r.txn_id), leg = { lineNo: r.line_no === null ? null : Number(r.line_no), accountId: Number(r.account_id), cents: BigInt(r.cents) };
    if (!deps.postings.has(id)) deps.postings.set(id, []);
    deps.postings.get(id).push(legsState([leg])[0]);
    if (arap.includes(leg.accountId)) continue;
    if (!legsOf.has(id)) legsOf.set(id, []);
    legsOf.get(id).push(leg);
  }
  const docAccounts = docId => (legsOf.get(docId) ?? []).filter(l => accounts.get(l.accountId)?.pl).map(l => l.accountId);
  const here = apps.filter(a => a.date >= start);
  const byCredit = list => { const m = new Map(); for (const a of list) { if (!m.has(a.credit)) m.set(a.credit, []); m.get(a.credit).push(a); } return m; };
  const suppressedOf = new Map(); // application id → cents of it already recognized earlier (consumed)
  const undecidable = new Set(); // settlements whose earlier decision went stale: nothing of them is offered or recognized as decided now
  // 2a. A settlement from before the period applied in it — to documents and to opening balances alike: the period its money moved in
  //     decided it. ONE budget per settlement (what that decision recognized, less every application since), consumed in date order by
  //     every application in this period whatever it settles, so money recognized once is never offered or recognized again. With no Tax
  //     Books period there, its applications to documents are reviewed here (earlier_settlement); those to opening balances go to 2b.
  //     A saved advance or prepayment decision of an earlier period is found by the transaction it decided and owned by the return it was
  //     SAVED on — never the period the payment's current date falls in (Codex t3-plan-r5 R5-1): redated out of that period (into this one,
  //     into another earlier one, before the periods kept here), it stays a dependency and what it decided is unresolved — the accounts it
  //     decided and those the applications bring income or expense to now —, never recognized by default, until it is cleared there.
  const earlierDecided = new Map();
  for (const r of reviews) if (GROUPS[0].includes(r.kind) && periods.some(p => p.return_id === r.return_id && p.e < start)) earlierDecided.set(r.txn_id, r);
  for (const [credit, list] of byCredit(here.filter(a => !a.creditDoc && (a.credit_date < start || earlierDecided.has(a.credit))))) {
    const a0 = list[0], saved = earlierDecided.get(credit) ?? null;
    const p = saved ? periods.find(x => x.return_id === saved.return_id) : periodOf(a0.credit_date);
    const touched = list.flatMap(a => (a.chargeDoc ? docAccounts(a.charge) : []));
    if (saved && !(a0.credit_date >= p.s && a0.credit_date <= p.e)) {
      useReview(saved);
      undecidable.add(credit);
      const accountIds = [...touched, ...saved.affected_accounts];
      unresolve(`${REVIEW_KINDS[saved.kind]} ${a0.credit_doc || credit} was decided on the ${p.e.slice(0, 4)} period and the payment is now dated ${a0.credit_date}: clear the decision on the ${p.e.slice(0, 4)} period, or date the payment back in it.`,
        { accountIds, domains: saved.affected_domains, wide: list.some(a => !a.chargeDoc) || !accountIds.length });
      continue;
    }
    if (p) {
      const r = saved ?? reviews.find(x => x.return_id === p.return_id && x.txn_id === credit && GROUPS[0].includes(x.kind)) ?? null;
      if (!r) continue; // undecided there: shown there; here the books' timing stands
      useReview(r);
      const upTo = apps.filter(a => a.credit === credit && a.date <= p.e);
      if (!fresh(r, versionOf(['advance', BigInt(a0.credit_total), appState(upTo)]))) {
        undecidable.add(credit);
        unresolve(`${REVIEW_KINDS[r.kind]} ${a0.credit_doc || credit} (decided on the ${p.e.slice(0, 4)} period) changed after it was decided: review it again there.`,
          { accountIds: [...touched, ...r.affected_accounts], wide: list.some(a => !a.chargeDoc) });
        continue;
      }
      if (r.decision !== 'include') continue;
      let left = gross(r.cents) - apps.filter(a => a.credit === credit && a.date > p.e && a.date < start).reduce((s, a) => s + a.cents, 0n);
      for (const a of list) {
        const take = left <= 0n ? 0n : left < a.cents ? left : a.cents;
        left -= take;
        if (take) { suppressedOf.set(a.id, take); events.push({ kind: 'carried', reviewId: r.review_id, applicationId: a.id, txnId: credit, target: a.chargeDoc ? 'document' : 'opening_balance', date: a.date, cents: take, left }); }
        if (take < a.cents) {
          undecidable.add(credit);
          unresolve(`${a0.credit_doc || credit} is applied beyond the amount recognized when it was received: review it again on the ${p.e.slice(0, 4)} period.`, { accountIds: a.chargeDoc ? docAccounts(a.charge) : [], wide: !a.chargeDoc });
        }
      }
    } else {
      const docsOnly = list.filter(a => a.chargeDoc);
      if (!docsOnly.length) continue;
      const c = candidate({ txnId: credit, date: a0.date, docNumber: a0.credit_doc, txnVersion: a0.credit_version, cents: docsOnly.reduce((s, a) => s + a.cents, 0n), applications: docsOnly.map(a => a.id),
        eventVersion: versionOf(['earlier', appState(docsOnly)]), needsSlot: false, accountIds: touched,
        reason: `Received or paid ${a0.credit_date}, before the periods kept here, and applied in this period: income or a deduction now (include), or already counted before (exclude)?` }, ['earlier_settlement']);
      if (c.state === 'decided' && c.review.decision === 'exclude') for (const a of docsOnly) { suppressedOf.set(a.id, a.cents); events.push({ kind: 'carried', reviewId: c.review.review_id, applicationId: a.id, txnId: credit, target: 'document', date: a.date, cents: a.cents }); }
      if (c.state === 'stale') unresolve(`${a0.credit_doc || credit} changed after it was reviewed: review it again.`, { accountIds: [...touched, ...c.review.affected_accounts] });
    }
  }
  // 2b. Money applied in the period to an earlier balance with no document behind it (an imported journal entry on A/R or A/P): it brings
  //     in no income or expense of its own; one review per payment covers what of it is not already recognized (2a) — never an amount
  //     recognized before.
  for (const [credit, all] of byCredit(here.filter(a => !a.chargeDoc && !a.creditDoc))) {
    if (undecidable.has(credit)) continue; // unresolved in 2a
    const list = all.map(a => ({ ...a, open: a.cents - (suppressedOf.get(a.id) ?? 0n) })).filter(a => a.open > 0n);
    if (!list.length) continue; // all of it was recognized when received
    const a0 = list[0], vendor = VENDOR_TYPES.includes(a0.credit_type) || VENDOR_TYPES.includes(a0.charge_type);
    const c = candidate({ txnId: credit, date: a0.date, docNumber: a0.credit_doc, txnVersion: a0.credit_version, cents: list.reduce((s, a) => s + a.open, 0n), applications: list.map(a => a.id),
      eventVersion: versionOf(['opening', list.map(a => [a.id, a.charge, a.cents, a.open, a.date])]), needsSlot: true, side: vendor ? 'vendor' : 'customer', accountIds: [],
      reason: `Money applied in this period to an earlier balance with no invoice or bill behind it (${list.length} application${list.length === 1 ? '' : 's'}): is it income or a deduction this period?` }, ['opening_ar_ap_payment']);
    if (c.state === 'decided' && c.review.decision === 'include') slotItems.push({ slotKey: c.review.slot_key, cents: c.review.cents, txnId: credit, kind: 'opening_payment', label: `Applied to an earlier balance ${a0.credit_doc || credit}`, reviewId: c.review.review_id });
    if (c.state === 'stale') unresolve(`The money applied to an earlier balance by ${a0.credit_doc || credit} changed after it was reviewed: review it again.`, c.review.decision === 'include' ? { slotKeys: [c.review.slot_key] } : { wide: true });
  }
  // 2c. Each application's share of its documents: each leg's part of everything applied so far, less its part before; recognized when it
  //     falls in the period and is not already recognized (consumed).
  const paidSoFar = new Map();
  const share = (docId, amount, date, ev, recognizeIt) => {
    const legs = legsOf.get(docId) ?? [];
    const base = legs.reduce((s, l) => s + l.cents, 0n);
    if (!base || !amount) return;
    const prev = paidSoFar.get(docId) ?? { amount: 0n, parts: legs.map(() => 0n) };
    const total = prev.amount + amount, cum = prorateBig((base < 0n ? -1n : 1n) * total, legs.map(l => l.cents));
    paidSoFar.set(docId, { amount: total, parts: cum });
    if (!recognizeIt) return;
    legs.forEach((l, i) => { const part = cum[i] - prev.parts[i]; if (part && accounts.get(l.accountId)?.pl) recognize(l.accountId, part, { ...ev, docId, lineNo: l.lineNo, date }); });
  };
  for (const a of apps) {
    if (!a.chargeDoc && !a.creditDoc) continue;
    const ev = { kind: 'application', applicationId: a.id, txnId: a.credit }, inPeriod = a.date >= start, sup = suppressedOf.get(a.id) ?? 0n;
    for (const [docId, isDoc] of [[a.charge, a.chargeDoc], [a.credit, a.creditDoc]]) {
      if (!isDoc) continue;
      share(docId, sup, a.date, ev, false);
      share(docId, a.cents - sup, a.date, ev, inPeriod);
    }
  }

  // 3. Money received or paid in the period and still unapplied at its end (an advance, an overpayment, a vendor prepayment).
  const { rows: open } = await db.query(`SELECT t.txn_id, t.type, t.txn_date::text AS date, t.doc_number, t.total_cents::text AS total, txn_version(t.txn_id) AS v FROM txn t
     WHERE t.org_id = $1 AND t.entity_id = $2 AND t.type IN ('payment', 'bill_payment') AND t.voided_at IS NULL AND t.txn_date BETWEEN $3::date AND $4::date ORDER BY t.txn_date, t.txn_id`, [orgId, S, start, end]);
  for (const t of open) {
    const id = Number(t.txn_id), mine = apps.filter(a => a.credit === id), total = BigInt(t.total);
    const unapplied = total - mine.reduce((s, a) => s + a.cents, 0n);
    if (unapplied <= 0n) continue;
    deps.txns.set(id, t.v);
    const vendor = t.type === 'bill_payment';
    const c = candidate({ txnId: id, date: t.date, docNumber: t.doc_number, txnVersion: t.v, cents: unapplied, eventVersion: versionOf(['advance', total, appState(mine)]), side: vendor ? 'vendor' : 'customer', needsSlot: true, accountIds: [],
      reason: vendor ? `Paid ${t.date} and not applied to a bill by the period end: a deductible prepayment now, or when the bill arrives?`
        : `Received ${t.date} and not applied to an invoice by the period end: an unrestricted advance (income now) or a refundable deposit (income when applied)?` },
    vendor ? ['prepaid_expense'] : ['unrestricted_advance', 'refundable_deposit']);
    if (c.state === 'decided' && c.review.decision === 'include') slotItems.push({ slotKey: c.review.slot_key, cents: c.review.cents, txnId: id, kind: 'advance', label: `${vendor ? 'Prepayment' : 'Advance'} ${t.doc_number || id}`, reviewId: c.review.review_id });
    if (c.state === 'stale') unresolve(`${vendor ? 'The prepayment' : 'The advance'} ${t.doc_number || id} changed after it was reviewed (an application or the payment itself): review it again.`, c.review.decision === 'include' ? { slotKeys: [c.review.slot_key] } : { wide: true });
  }
  // A decision of this period that no event of it matches any more (the payment fully applied since, the deposit no longer to income):
  // still listed, stale, until it is cleared or made again — and what it decided is unresolved.
  // The accounts it decided (recorded when it was made) and those the transaction posts to now are unresolved, so an exclusion whose entry
  // became, say, a direct cash expense is not deducted by default.
  for (const r of own) if (!candidates.some(c => c.review?.review_id === r.review_id)) {
    candidates.push({ txnId: r.txn_id, date: null, docNumber: null, txnVersion: r.current_version, cents: r.cents === null ? 0n : gross(r.cents), eventVersion: null, needsSlot: false, kinds: groupOf(r.kind),
      reason: `${REVIEW_KINDS[r.kind]}: the transaction no longer shows this situation in this period — clear the decision.`, review: r, state: 'stale' });
    const now = txns.find(x => x.txnId === r.txn_id);
    const accountIds = [...r.affected_accounts, ...(now ? plLegs(now).map(l => l.accountId) : [])];
    unresolve(`${REVIEW_KINDS[r.kind]} on transaction ${r.txn_id} no longer matches the books: clear it or decide again.`,
      { slotKeys: r.decision === 'include' ? [r.slot_key] : [], accountIds, wide: !accountIds.length && !(r.decision === 'include' && r.slot_key) });
  }
  const applications = here.map(a => ({ id: a.id, credit: a.credit, charge: a.charge, appliedOn: a.date, cents: a.cents }));
  const version = versionOf([[...byAccount].sort((a, b) => a[0] - b[0]), slotItems.map(x => [x.slotKey, x.cents, x.txnId]), [...deps.txns].sort((a, b) => a[0] - b[0]), deps.applications,
    [...deps.reviews.values()], unresolved]);
  return { byAccount, slotItems, events, candidates, selectable: { receipts }, unresolved, applications, reviews: own, deps, version };
}

// The timing reviews of an accrual return (spec §13.1 T3: an accrual partnership's all-events and economic-performance gates — a book accrual
// is not automatically deductible). Accrual journal entries of the period are candidates by shape; a bill, an expense or any other transaction
// of the period with income or expense legs can be selected and reviewed (a related-party accrual unpaid at the period end, a service not
// performed by then) — the bills still unpaid at the period end are offered (selectable); no tax law is inferred from a bill. Every decision
// made stays a candidate, matched or not, so a stale one is shown. An exclusion removes that transaction's income and expense legs
// (lib/tax/engine/compute.js turns it into engine adjustments, method_timing, on the slots the books own); a stale decision leaves the same
// legs unresolved. → { candidates, selectable: { bills }, exclusions: [{ txnId, kind, legs }], stale: [{ txnId, kind, legs, reason }], reviews, deps, version }
export async function accrualTiming(db, { orgId, ret }) {
  const S = ret.entity_id, start = ret.period_start, end = ret.period_end;
  const accounts = await accountsOf(db, { orgId, entityId: S });
  const excluded = new Set((await closingExclusions(db, { orgId, returnId: ret.return_id, sourceEntityId: S })).keys);
  const own = (await reviewsOf(db, { orgId, returnIds: [ret.return_id] })).filter(r => ACCRUAL_KINDS.includes(r.kind));
  const plLegs = t => t.legs.filter(l => accounts.get(l.accountId)?.pl && !excluded.has(lineKeyOf(t.txnId, l.lineNo)));
  const { rows: unpaid } = await db.query(`SELECT t.txn_id FROM txn t WHERE t.org_id = $1 AND t.entity_id = $2 AND t.type = 'bill' AND t.voided_at IS NULL AND t.txn_date BETWEEN $3::date AND $4::date
      AND t.total_cents > coalesce((SELECT sum(a.amount_cents) FROM application a WHERE a.org_id = t.org_id AND a.charge_txn_id = t.txn_id AND a.applied_on <= $4::date), 0)`, [orgId, S, start, end]);
  const period = await txnsWithLegs(db, { orgId, entityId: S, from: start, to: end, ids: [...own.map(r => r.txn_id), ...unpaid.map(r => Number(r.txn_id))] });
  const byId = new Map(period.map(t => [t.txnId, t]));
  const deps = { txns: new Map(), postings: new Map(), applications: [], reviews: new Map(own.map(r => [r.review_id, reviewDep(r)])) };
  const event = t => { const pl = plLegs(t); return { txnId: t.txnId, date: t.date, docNumber: t.docNumber, txnVersion: t.txnVersion, legs: pl, accountIds: pl.map(l => l.accountId), cents: pl.reduce((s, l) => s + gross(l.cents), 0n), eventVersion: versionOf(['accrual', legsState(pl)]), needsSlot: false }; };
  const candidates = [], exclusions = [], stale = [];
  const add = (t, reason) => {
    deps.txns.set(t.txnId, t.txnVersion); deps.postings.set(t.txnId, legsState(t.legs));
    const ev = event(t), review = own.find(r => r.txn_id === t.txnId) ?? null;
    // A reviewed transaction now dated outside the period is no longer this period's to decide: shown, stale, and never excluded here.
    if (t.date < start || t.date > end) {
      candidates.push({ ...ev, legs: [], kinds: ACCRUAL_KINDS, reason: `${t.docNumber || `Transaction ${t.txnId}`} is now dated ${t.date}, outside this period: clear the decision.`, review, state: 'stale', eventVersion: null });
      stale.push({ txnId: t.txnId, kind: review?.kind, legs: [], accounts: review?.affected_accounts ?? [], domains: review?.affected_domains ?? ['income'], reason: `${t.docNumber || `Transaction ${t.txnId}`} was reviewed here and is now dated ${t.date}, outside this period: clear the decision.` });
      return;
    }
    const state = !review ? 'open' : review.stale || review.event_version !== ev.eventVersion ? 'stale' : 'decided';
    candidates.push({ ...ev, kinds: t.type === 'journal_entry' ? ACCRUAL_KINDS : ACCRUAL_KINDS.slice(1), reason, review, state });
    if (state === 'decided' && review.decision === 'exclude' && ev.legs.length) exclusions.push({ txnId: t.txnId, kind: review.kind, legs: ev.legs });
    // A stale decision invalidates what it decided (the accounts recorded with it) and what the source posts to now — legs or not.
    if (state === 'stale') stale.push({ txnId: t.txnId, kind: review.kind, legs: ev.legs, accounts: review.affected_accounts, domains: review.affected_domains, reason: `${t.docNumber || `Transaction ${t.txnId}`} changed after its accrual was reviewed: review it again.` });
  };
  for (const t of period) {
    const shape = !t.legs.some(l => accounts.get(l.accountId)?.cash) && t.legs.some(l => accounts.get(l.accountId)?.accrual) && plLegs(t).length && !ACCRUAL_TYPES.includes(t.type) && t.date >= start && t.date <= end;
    if (shape) add(t, 'An accrual journal entry: are the all-events test and economic performance met by the period end?');
  }
  for (const r of own) {
    if (candidates.some(c => c.txnId === r.txn_id)) continue;
    const t = byId.get(r.txn_id);
    if (t) { add(t, `${REVIEW_KINDS[r.kind]}: reviewed on this transaction.`); continue; }
    // Voided or gone: the decision is still shown, stale, until it is cleared.
    candidates.push({ txnId: r.txn_id, date: null, docNumber: null, txnVersion: null, legs: [], cents: 0n, eventVersion: null, needsSlot: false, kinds: ACCRUAL_KINDS, reason: 'No longer a transaction of this period: clear the decision.', review: r, state: 'stale' });
    stale.push({ txnId: r.txn_id, kind: r.kind, legs: [], accounts: r.affected_accounts, domains: r.affected_domains, reason: `A reviewed accrual (transaction ${r.txn_id}) is no longer in the books: clear the decision.` });
  }
  const bills = unpaid.map(r => byId.get(Number(r.txn_id))).filter(t => t && !candidates.some(c => c.txnId === t.txnId) && plLegs(t).length).map(t => ({ ...event(t), kinds: ACCRUAL_KINDS.slice(1) }));
  return { candidates, selectable: { bills }, exclusions, stale, reviews: own, deps, version: versionOf([[...deps.reviews.values()], [...deps.txns].sort((a, b) => a[0] - b[0])]) };
}
// One transaction of the period as an accrual event (a related-party or economic-performance review of a transaction that is neither a
// candidate nor offered: an expense paid to a related party late in the year, say); null when it has no income or expense legs of the period.
export async function accrualEventOf(db, { orgId, ret, txnId }) {
  const accounts = await accountsOf(db, { orgId, entityId: ret.entity_id });
  const excluded = new Set((await closingExclusions(db, { orgId, returnId: ret.return_id, sourceEntityId: ret.entity_id })).keys);
  const [t] = await txnsWithLegs(db, { orgId, entityId: ret.entity_id, ids: [txnId] });
  if (!t || t.date < ret.period_start || t.date > ret.period_end) return null;
  const pl = t.legs.filter(l => accounts.get(l.accountId)?.pl && !excluded.has(lineKeyOf(t.txnId, l.lineNo)));
  if (!pl.length) return null;
  return { txnId: t.txnId, date: t.date, txnVersion: t.txnVersion, legs: pl, accountIds: pl.map(l => l.accountId), cents: pl.reduce((s, l) => s + gross(l.cents), 0n), eventVersion: versionOf(['accrual', legsState(pl)]), needsSlot: false, kinds: ACCRUAL_KINDS.slice(1) };
}

// The candidates a person answers for one return (cash-method: the cash layer's; accrual: the accrual gates).
export async function timingCandidates(db, { orgId, ret }) {
  return ret.tax_method === 'cash' ? (await cashRecognition(db, { orgId, ret })).candidates : (await accrualTiming(db, { orgId, ret })).candidates;
}

// A destination a reviewed amount may be recognized on: a canonical, non-computed income or deduction slot of the period's catalog that
// the books may feed (not a balance, a typed line or a COGS line), every dimension of it this return's (lib/tax/open-return.js).
export async function checkReviewSlot(db, { orgId, ret, key }) {
  const line = await checkSlotScope(db, { orgId, ret, key });
  if (line.cls === 'balance' || line.kind === 'manual' || isCogsLine(line.id) || !['amount', 'statement'].includes(line.type)) fail(`${line.label} does not take a reviewed income or deduction amount.`);
  return line;
}

// Record a person's timing decision on an event as the page showed it: the transaction version AND the event version (its amount and the
// applications it was decided against). A candidate, a deposit to income selected for a receipt date, or (accrual return) any transaction of
// the period with income or expense legs. The whole amount or nothing: a split is refused in this stage.
// reason: undefined keeps the note of the decision this one replaces (a form that does not carry the field); '' clears it; text replaces it.
export async function saveTimingReview(pool, { orgId, entityId, returnId, txnId, kind, decision, slotKey = null, amount = null, recognizeOn = null, expectTxnVersion, expectEventVersion, reviewedBy, reason }) {
  if (!REVIEW_KINDS[kind]) fail('Choose what this transaction is.');
  if (!['include', 'exclude'].includes(decision)) fail('Choose include or exclude.');
  const who = personOf(reviewedBy);
  return withTransaction(pool, async tx => {
    const ret = await openTaxReturn(tx, { orgId, entityId, returnId });
    const id = idOf(txnId, 'The transaction');
    const { rows: [t] } = await tx.query('SELECT txn_id, txn_date::text AS date, txn_version(txn_id) AS v FROM txn WHERE org_id = $1 AND entity_id = $2 AND txn_id = $3', [orgId, ret.entity_id, id]);
    if (!t) fail('Transaction not found in this company’s books.');
    if (!expectTxnVersion || expectTxnVersion !== t.v) fail('This transaction changed since the page was shown. Look at it again before deciding.');
    const cash = ret.tax_method === 'cash';
    if (cash && ['related_party_accrual', 'economic_performance'].includes(kind)) fail('On the cash method an expense is deducted when paid: related-party and economic-performance reviews are for an accrual-method return.');
    if (!cash && !ACCRUAL_KINDS.includes(kind)) fail('That review is for a cash-method return.');
    const found = cash ? await cashRecognition(tx, { orgId, ret }) : await accrualTiming(tx, { orgId, ret });
    let c = found.candidates.find(x => x.txnId === id && x.kinds.includes(kind)) ?? null;
    if (!c && cash && kind === 'receipt_date') c = found.selectable.receipts.find(x => x.txnId === id) ?? null;
    if (!c && !cash && kind !== 'imported_accrual_je') c = found.selectable.bills.find(x => x.txnId === id) ?? await accrualEventOf(tx, { orgId, ret, txnId: id });
    if (!c) fail(cash ? 'That transaction is not waiting for this decision in this period.' : 'That transaction has no income or expense of this period to review.');
    // Eligible now, whichever path found it: a stale or orphaned decision can only be cleared; an accrual is a transaction of this period with
    // income or expense legs.
    if (!c.eventVersion) fail('That decision no longer matches a situation of this period: clear it.');
    if (!cash && (t.date < ret.period_start || t.date > ret.period_end || !(c.legs ?? []).length)) fail('That transaction has no income or expense of this period to review.');
    if (!expectEventVersion || expectEventVersion !== c.eventVersion) fail('The amount or the applications behind this decision changed since the page was shown. Look at it again before deciding.');
    if (kind === 'unrestricted_advance' && decision !== 'include') fail('An unrestricted advance is income when received: include it, or call it a refundable deposit.');
    if (kind === 'refundable_deposit' && decision !== 'exclude') fail('A refundable deposit is income when applied: exclude it now.');
    let cents = null, slot = null, on = null;
    if (kind === 'receipt_date') {
      on = String(recognizeOn ?? '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(on) || Number.isNaN(Date.parse(`${on}T00:00:00Z`)) || on >= t.date) fail('A reviewed receipt date is a day before the bank date.');
      if (on >= ret.period_start) fail('That receipt date is in this same period: the tax year does not change, so no review is needed.');
      const { rows: [p] } = await tx.query('SELECT status, period_start::text AS s FROM tax_return WHERE org_id = $1 AND entity_id = $2 AND period_end = $3::date - 1', [orgId, ret.entity_id, ret.period_start]);
      if (!p) fail('The previous period is not kept in Tax Books, so the receipt cannot move into it: open that period first.');
      if (p.status !== 'open') fail(`The previous period is ${p.status}: its return no longer changes.`);
      if (on < p.s) fail('A receipt date more than one period before the bank date is not taken in this stage.');
    } else if (decision === 'include' && c.needsSlot) {
      await checkReviewSlot(tx, { orgId, ret, key: slotKey });
      slot = slotKey;
      const typed = parseCentsBig(amount);
      if (typed === null || typed <= 0n) fail('Enter the amount to recognize, like 1250.00.');
      if (typed !== c.cents) fail(`A decision takes the whole ${c.cents} cents this shows: a split is not taken in this stage (leave it undecided, or record the part as an adjustment).`);
      // Stored in ledger sign: money received is a credit (income), money paid a debit (a deduction).
      cents = c.side === 'vendor' ? typed : -typed;
    }
    const { rows: [prior] } = await tx.query('SELECT reason FROM cash_timing_review WHERE org_id = $1 AND return_id = $2 AND txn_id = $3 AND kind = ANY($4::text[])', [orgId, ret.return_id, id, groupOf(kind)]);
    const note = reason === undefined ? prior?.reason ?? null : String(reason ?? '').trim().slice(0, 500) || null;
    await tx.query('DELETE FROM cash_timing_review WHERE org_id = $1 AND return_id = $2 AND txn_id = $3 AND kind = ANY($4::text[])', [orgId, ret.return_id, id, groupOf(kind)]);
    // Saved with its identity: the return, the transaction, the accounts it decides and its domain (a timing decision: income), the balance
    // accounts the money moved through (a prepayment's prepaid account), the reason.
    await tx.query(`INSERT INTO cash_timing_review (org_id, return_id, source_entity_id, txn_id, kind, decision, slot_key, cents, recognize_on, txn_version, event_version, affected_accounts, affected_domains, source_accounts, reviewed_by, reason)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, [orgId, ret.return_id, ret.entity_id, id, kind, decision, slot, cents === null ? null : cents.toString(), on, t.v, c.eventVersion,
      [...new Set((c.accountIds ?? []).map(Number))], ['income'], [...new Set((c.sourceAccountIds ?? []).map(Number))], who, note]);
  });
}
export async function clearTimingReview(pool, { orgId, entityId, returnId, reviewId }) {
  return withTransaction(pool, async tx => {
    const ret = await openTaxReturn(tx, { orgId, entityId, returnId });
    const { rowCount } = await tx.query('DELETE FROM cash_timing_review WHERE org_id = $1 AND return_id = $2 AND review_id = $3', [orgId, ret.return_id, idOf(reviewId, 'The decision')]);
    if (!rowCount) fail('That decision is not on this period.');
  });
}
