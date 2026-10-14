// Ledger lines for reports: every posting as { accountId, date, amount (cents, debit +), txnId, type, customerId, vendorId,
// classId, locationId, itemId, projectId }, on the accrual or the cash basis.
//
// Cash basis: invoices, credit memos, late fees, bills, vendor credits and item receipts count only as they are paid.
// Each application (a payment or credit applied to a charge, on its date) brings in that share of the charge's own
// postings (income, expense, inventory, discount, shipping…) and — for a payment — takes the same amount back out of A/R
// or A/P, so the payment lands in income or expense instead. A credit memo or vendor credit applied to a charge brings in
// its share too, so the two cancel without any cash. Unapplied payments stay in A/R or A/P. Every set of lines balances.

const ACCRUAL_TYPES = ['invoice', 'credit_memo', 'late_fee', 'bill', 'vendor_credit', 'item_receipt'];

const COLS = `p.account_id, p.txn_date::text AS date, p.amount_cents::bigint AS amount, p.txn_id, t.type, p.customer_id,
  coalesce(p.vendor_id, t.vendor_id) AS vendor_id, p.class_id, p.location_id, p.item_id, p.project_id`;

const toLine = r => ({ accountId: Number(r.account_id), date: r.date, amount: Number(r.amount), txnId: Number(r.txn_id), type: r.type,
  customerId: r.customer_id === null ? null : Number(r.customer_id), vendorId: r.vendor_id === null ? null : Number(r.vendor_id),
  classId: r.class_id === null ? null : Number(r.class_id), locationId: r.location_id === null ? null : Number(r.location_id),
  itemId: r.item_id === null ? null : Number(r.item_id), projectId: r.project_id === null ? null : Number(r.project_id) });

// Splits `amount` across `weights` in proportion, adding up exactly (largest remainder).
export function prorate(amount, weights) {
  const total = weights.reduce((s, w) => s + w, 0);
  if (!total) return weights.map(() => 0);
  const exact = weights.map(w => (amount * w) / total);
  const out = exact.map(x => Math.trunc(x));
  let left = amount - out.reduce((s, x) => s + x, 0);
  const order = exact.map((x, i) => [Math.abs(x - out[i]), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left !== 0 && k < order.length; k++) { const i = order[k][1]; out[i] += Math.sign(left); left -= Math.sign(left); }
  return out;
}

// lines(db, { orgId, entityId, from (null = beginning), to, basis: 'accrual' | 'cash' }).
export async function ledgerLines(db, { orgId, entityId, from = null, to, basis = 'accrual' }) {
  const range = 'p.org_id = $1 AND p.entity_id = $2 AND ($3::date IS NULL OR p.txn_date >= $3::date) AND p.txn_date <= $4::date';
  if (basis !== 'cash') {
    const { rows } = await db.query(`SELECT ${COLS} FROM posting p JOIN txn t ON t.txn_id = p.txn_id WHERE ${range}`, [orgId, entityId, from, to]);
    return rows.map(toLine);
  }
  const { rows: sysRows } = await db.query(`SELECT system_key, account_id FROM account WHERE org_id = $1 AND entity_id = $2 AND system_key IN ('ar', 'ap')`, [orgId, entityId]);
  const sys = Object.fromEntries(sysRows.map(r => [r.system_key, Number(r.account_id)]));
  // 1. Everything that isn't an accrual document, as posted.
  const { rows: direct } = await db.query(
    `SELECT ${COLS} FROM posting p JOIN txn t ON t.txn_id = p.txn_id WHERE ${range} AND t.type <> ALL($5::text[])`, [orgId, entityId, from, to, ACCRUAL_TYPES]);
  const out = direct.map(toLine);
  // 2. Applications in the period. An accrual document (invoice, bill, credit) brings in its share of its postings; any
  // other side (a payment, or — in books imported from QuickBooks — a journal entry or check on A/R or A/P) has its A/R or
  // A/P leg undone for the applied part, since what it settled is now income or expense.
  const { rows: apps } = await db.query(
    `SELECT a.amount_cents::bigint AS amount, a.applied_on::text AS date, a.credit_txn_id, a.charge_txn_id, c.type AS credit_type, h.type AS charge_type,
            c.customer_id AS credit_customer, c.vendor_id AS credit_vendor, c.class_id AS credit_class, c.location_id AS credit_location,
            h.customer_id AS charge_customer, h.vendor_id AS charge_vendor, h.class_id AS charge_class, h.location_id AS charge_location,
            h.total_cents AS charge_total, c.total_cents AS credit_total
       FROM application a JOIN txn c ON c.txn_id = a.credit_txn_id JOIN txn h ON h.txn_id = a.charge_txn_id
      WHERE a.org_id = $1 AND h.entity_id = $2 AND ($3::date IS NULL OR $3::date IS NOT NULL) AND a.applied_on <= $4::date
        AND (h.type = ANY($5::text[]) OR c.type = ANY($5::text[])) AND h.voided_at IS NULL AND c.voided_at IS NULL
      ORDER BY a.applied_on, a.application_id`, [orgId, entityId, from, to, ACCRUAL_TYPES]);
  // Every application up to the end date is read (in date order) so each document's lines are shared out on what's been
  // paid on it in total — the last payment then clears every line exactly; only those in the period are reported.
  if (!apps.length) return out;
  const docIds = [...new Set(apps.flatMap(a => [ACCRUAL_TYPES.includes(a.charge_type) ? Number(a.charge_txn_id) : null,
    ACCRUAL_TYPES.includes(a.credit_type) ? Number(a.credit_txn_id) : null]).filter(Boolean))];
  const { rows: docPostings } = await db.query(
    `SELECT ${COLS} FROM posting p JOIN txn t ON t.txn_id = p.txn_id WHERE p.org_id = $1 AND p.txn_id = ANY($2::bigint[]) AND p.account_id <> ALL($3::bigint[])`,
    [orgId, docIds, [sys.ar ?? 0, sys.ap ?? 0]]);
  const byDoc = new Map();
  for (const r of docPostings) { const l = toLine(r); if (!byDoc.has(l.txnId)) byDoc.set(l.txnId, []); byDoc.get(l.txnId).push(l); }
  const paidSoFar = new Map(); // document → { amount paid so far, each leg's share of it }
  const share = (docId, amount, date) => {
    const legs = byDoc.get(docId) ?? [];
    const base = legs.reduce((s, l) => s + l.amount, 0);
    if (!base) return;
    // The legs add up to the document's A/R or A/P side with the sign flipped; each leg's share of everything paid so far
    // (rounded so the shares add up exactly), minus its share before this payment.
    const prev = paidSoFar.get(docId) ?? { amount: 0, parts: legs.map(() => 0) };
    const total = prev.amount + amount;
    const cum = prorate(Math.sign(base) * total, legs.map(l => l.amount));
    paidSoFar.set(docId, { amount: total, parts: cum });
    if (from && date < from) return;
    legs.forEach((l, i) => { const part = cum[i] - prev.parts[i]; if (part) out.push({ ...l, amount: part, date, cash: true }); });
  };
  const AP_TYPES = ['bill', 'item_receipt', 'vendor_credit', 'bill_payment'];
  const n = v => (v === null || v === undefined ? null : Number(v));
  for (const a of apps) {
    const amount = Number(a.amount), chargeId = Number(a.charge_txn_id), creditId = Number(a.credit_txn_id);
    const inPeriod = !from || a.date >= from;
    const isAp = AP_TYPES.includes(a.charge_type) || AP_TYPES.includes(a.credit_type);
    // The non-document side's A/R (or A/P) leg undone for the applied part: + for the credit side's leg (it was a credit to
    // A/R, a debit to A/P), − for the charge side's. It carries that side's customer or vendor, class and location.
    const undo = (txnId, type, sign, who) => {
      if (!inPeriod) return;
      out.push({ accountId: isAp ? sys.ap : sys.ar, date: a.date, amount: (isAp ? -1 : 1) * sign * amount, txnId, type,
        customerId: isAp ? null : n(who.customer), vendorId: isAp ? n(who.vendor) : null, classId: n(who.class), locationId: n(who.location),
        itemId: null, projectId: null, cash: true });
    };
    if (ACCRUAL_TYPES.includes(a.charge_type)) share(chargeId, amount, a.date);
    else undo(chargeId, a.charge_type, -1, { customer: a.charge_customer, vendor: a.charge_vendor, class: a.charge_class, location: a.charge_location });
    if (ACCRUAL_TYPES.includes(a.credit_type)) share(creditId, amount, a.date);
    else undo(creditId, a.credit_type, 1, { customer: a.credit_customer, vendor: a.credit_vendor, class: a.credit_class, location: a.credit_location });
  }
  return out;
}
