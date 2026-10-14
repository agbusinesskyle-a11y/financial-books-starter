import { daysBetween, isIsoDate } from './dates.js';

// Statement math, no database. Input transactions are plain rows:
//   { txn_id, type, doc_number, payment_ref, txn_date, due_date, total_cents, open_cents }
// Charges (invoice, late fee) count up; credits (payment, credit memo) count down.
// Voided transactions and sales receipts never reach here (they don't change what's owed).

export const STATEMENT_KINDS = [
  ['balance_forward', 'Balance forward'],
  ['open_item', 'Open item'],
  ['transaction', 'Transaction statement'],
];
export const KIND_LABELS = Object.fromEntries(STATEMENT_KINDS);
export const KIND_HELP = {
  balance_forward: 'Opening balance, then every charge and payment in the period with a running balance.',
  open_item: 'Only what’s still unpaid as of the statement date, plus any unapplied credits.',
  transaction: 'Every charge and payment in the period, with what’s still open on each.',
};

const CHARGES = new Set(['invoice', 'late_fee']);
export const signed = t => (CHARGES.has(t.type) ? 1 : -1);
const ref = t => t.doc_number ?? t.payment_ref ?? '';

export const AGING_BUCKETS = [['current', 'Current'], ['d1_30', '1–30 days past due'], ['d31_60', '31–60 days'], ['d61_90', '61–90 days'], ['over_90', 'Over 90 days']];

// Open charges grouped by how far past due they are on the statement date.
export function aging(openCharges, statementDate) {
  const out = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, over_90: 0 };
  for (const t of openCharges) {
    const late = t.due_date ? daysBetween(t.due_date, statementDate) : 0;
    const key = late <= 0 ? 'current' : late <= 30 ? 'd1_30' : late <= 60 ? 'd31_60' : late <= 90 ? 'd61_90' : 'over_90';
    out[key] += t.open_cents;
  }
  return out;
}

export function validateStatementRequest({ kind, statementDate, startDate, endDate }) {
  if (!KIND_LABELS[kind]) return 'Choose a statement type.';
  if (!isIsoDate(statementDate)) return 'Enter the statement date.';
  if (kind === 'open_item') return null;
  if (!isIsoDate(startDate) || !isIsoDate(endDate)) return 'Enter the start and end dates.';
  if (startDate > endDate) return 'The start date must be on or before the end date.';
  if (endDate > statementDate) return 'The end date can’t be after the statement date.';
  if (daysBetween(startDate, endDate) > 366 * 5) return 'Statements cover five years at most.';
  return null;
}

// Builds the statement content (what is stored and printed).
//   balance_forward: { openingCents, inRange }
//   open_item:       { openItems }   (open charges and unapplied credits dated on/before the statement date)
//   transaction:     { inRange }
// `openCharges` (for aging) = open charges dated on/before the statement date.
export function buildStatement({ kind, statementDate, startDate = null, endDate = null, openingCents = 0, inRange = [], openItems = [], openCharges = [], totalDueCents: owed = null }) {
  const byDate = (a, b) => (a.txn_date < b.txn_date ? -1 : a.txn_date > b.txn_date ? 1 : a.txn_id - b.txn_id);
  let rows, totalDueCents;
  if (kind === 'balance_forward') {
    let balance = openingCents;
    rows = [...inRange].sort(byDate).map(t => {
      const amount = signed(t) * t.total_cents;
      balance += amount;
      return { txn_id: t.txn_id, date: t.txn_date, type: t.type, number: ref(t), memo: t.statement_memo ?? null, due_date: t.due_date, amount_cents: amount, balance_cents: balance };
    });
    totalDueCents = balance;
  } else {
    const source = kind === 'open_item' ? openItems.filter(t => t.open_cents > 0) : inRange;
    rows = [...source].sort(byDate).map(t => ({
      txn_id: t.txn_id, date: t.txn_date, type: t.type, number: ref(t), memo: t.statement_memo ?? null, due_date: t.due_date,
      amount_cents: signed(t) * t.total_cents, open_cents: signed(t) * t.open_cents,
    }));
    totalDueCents = owed ?? rows.reduce((sum, r) => sum + r.open_cents, 0);
  }
  return {
    kind, statement_date: statementDate,
    start_date: kind === 'open_item' ? null : startDate, end_date: kind === 'open_item' ? null : endDate,
    opening_cents: kind === 'balance_forward' ? openingCents : null,
    rows, total_due_cents: totalDueCents,
    aging: aging(openCharges, statementDate),
  };
}
