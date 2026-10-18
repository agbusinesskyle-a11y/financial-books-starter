// lib/tax/engine/cashbasis.js
// The books' own cash basis, exact (spec §3 engine/cashbasis.js, §5.2 "on the return's book_basis", §13.1 T3 exact arithmetic): what Schedule
// L and net income per books are when a period's books are kept on the cash basis. The rule is lib/reports/ledger-data.js ledgerLines(basis:
// 'cash') — everything that is not an accrual document as posted; each application, on its date, brings in its share of the document's own
// postings (shared on the cumulative amount applied, largest remainder) and, for the side that is not a document, undoes that much of its
// A/R or A/P leg; unapplied payments stay in A/R or A/P — computed here in BigInt from the beginning of the books through the period end
// (ledger-data converts to Number; test/tax-cashbasis.test.js checks the two agree within the safe range). Confirmed closing subsets are
// removed (lib/tax/measure.js closingExclusions). This is the BOOK basis; what the return recognizes is the tax cash layer (lib/tax/cash.js),
// whose reviewed differences (advances, receipt dates) are M-1 method-timing differences.
// → Map accountId → { begin, activity, end } (ledger cents, debits positive): income and expense begin at zero each year; retained earnings
// begins with every earlier year's cash-basis income, as the books close it.
import { PL_TYPES } from '../../reports/statements.js';
import { ACCRUAL_TYPES, prorateBig } from '../cash.js';
import { closingExclusions } from '../measure.js';

const AP_TYPES = ['bill', 'item_receipt', 'vendor_credit', 'bill_payment'];
export async function cashBasisMeasure(db, { orgId, ret }) {
  const S = ret.entity_id, start = ret.period_start, end = ret.period_end;
  const excluded = new Set((await closingExclusions(db, { orgId, returnId: ret.return_id, sourceEntityId: S })).keys);
  const { rows: accounts } = await db.query('SELECT account_id, type, system_key FROM account WHERE org_id = $1 AND entity_id = $2', [orgId, S]);
  const sys = Object.fromEntries(accounts.filter(a => ['ar', 'ap'].includes(a.system_key)).map(a => [a.system_key, Number(a.account_id)]));
  const out = new Map(accounts.map(a => [Number(a.account_id), { before: 0n, activity: 0n, pl: PL_TYPES.includes(a.type), retained: a.system_key === 'retained' }]));
  const add = (accountId, date, cents) => { const e = out.get(accountId); if (!e || !cents) return; if (date < start) e.before += cents; else e.activity += cents; };
  // 1. Everything that is not an accrual document, as posted.
  const { rows: direct } = await db.query(`SELECT p.account_id, p.txn_id, p.line_no, p.txn_date::text AS date, p.amount_cents::text AS cents FROM posting p JOIN txn t ON t.org_id = p.org_id AND t.txn_id = p.txn_id
     WHERE p.org_id = $1 AND p.entity_id = $2 AND p.txn_date <= $3::date AND t.type <> ALL($4::text[])`, [orgId, S, end, ACCRUAL_TYPES]);
  for (const r of direct) if (!excluded.has(`${r.txn_id}/${r.line_no ?? 0}`)) add(Number(r.account_id), r.date, BigInt(r.cents));
  // 2. Applications through the period end, in date order.
  const { rows: apps } = await db.query(`SELECT a.amount_cents::text AS amount, a.applied_on::text AS date, a.credit_txn_id, a.charge_txn_id, c.type AS credit_type, h.type AS charge_type
      FROM application a JOIN txn c ON c.org_id = a.org_id AND c.txn_id = a.credit_txn_id JOIN txn h ON h.org_id = a.org_id AND h.txn_id = a.charge_txn_id
     WHERE a.org_id = $1 AND h.entity_id = $2 AND a.applied_on <= $3::date AND (h.type = ANY($4::text[]) OR c.type = ANY($4::text[])) AND h.voided_at IS NULL AND c.voided_at IS NULL
     ORDER BY a.applied_on, a.application_id`, [orgId, S, end, ACCRUAL_TYPES]);
  const docIds = [...new Set(apps.flatMap(a => [ACCRUAL_TYPES.includes(a.charge_type) ? Number(a.charge_txn_id) : null, ACCRUAL_TYPES.includes(a.credit_type) ? Number(a.credit_txn_id) : null]).filter(Boolean))];
  const { rows: legsRows } = docIds.length ? await db.query(`SELECT txn_id, account_id, amount_cents::text AS cents FROM posting WHERE org_id = $1 AND txn_id = ANY($2::bigint[]) AND account_id <> ALL($3::bigint[])
     ORDER BY txn_id, line_no NULLS FIRST, posting_id`, [orgId, docIds, [sys.ar ?? 0, sys.ap ?? 0]]) : { rows: [] };
  const legsOf = new Map();
  for (const r of legsRows) { const id = Number(r.txn_id); if (!legsOf.has(id)) legsOf.set(id, []); legsOf.get(id).push({ accountId: Number(r.account_id), cents: BigInt(r.cents) }); }
  const paidSoFar = new Map();
  const share = (docId, amount, date) => {
    const legs = legsOf.get(docId) ?? [];
    const base = legs.reduce((s, l) => s + l.cents, 0n);
    if (!base) return;
    const prev = paidSoFar.get(docId) ?? { amount: 0n, parts: legs.map(() => 0n) };
    const total = prev.amount + amount, cum = prorateBig((base < 0n ? -1n : 1n) * total, legs.map(l => l.cents));
    paidSoFar.set(docId, { amount: total, parts: cum });
    legs.forEach((l, i) => add(l.accountId, date, cum[i] - prev.parts[i]));
  };
  for (const a of apps) {
    const amount = BigInt(a.amount), isAp = AP_TYPES.includes(a.charge_type) || AP_TYPES.includes(a.credit_type), ctl = isAp ? sys.ap : sys.ar;
    // The non-document side's A/R (or A/P) leg is undone for the applied part: + for the credit side (it was a credit to A/R, a debit to
    // A/P), - for the charge side.
    const undo = sign => add(ctl, a.date, (isAp ? -1n : 1n) * sign * amount);
    if (ACCRUAL_TYPES.includes(a.charge_type)) share(Number(a.charge_txn_id), amount, a.date); else undo(-1n);
    if (ACCRUAL_TYPES.includes(a.credit_type)) share(Number(a.credit_txn_id), amount, a.date); else undo(1n);
  }
  const priorIncome = [...out.values()].filter(e => e.pl).reduce((s, e) => s + e.before, 0n);
  const result = new Map();
  for (const [id, e] of out) {
    const begin = e.pl ? 0n : e.before + (e.retained ? priorIncome : 0n);
    result.set(id, { begin, activity: e.activity, end: begin + e.activity, pl: e.pl });
  }
  return result;
}
