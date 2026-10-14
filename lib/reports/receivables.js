import { daysBetween } from '../domain/dates.js';
import { TYPE_LABELS } from '../domain/status.js';

// What customers owe (A/R) and what is owed to vendors (A/P), as of any date: each document's open amount is its total
// less the applications dated on or before that day (open = total − applications holds for every document). Charges
// (invoices, late fees / bills, item receipts) are positive; unapplied credits (payments, credit memos / bill payments,
// vendor credits) negative. Used by the aging, open invoices, collections and balance reports.

export const SIDES = {
  ar: { charges: ['invoice', 'late_fee'], credits: ['payment', 'credit_memo'], party: 'customer', table: 'customer', label: 'Customer' },
  ap: { charges: ['bill', 'item_receipt'], credits: ['bill_payment', 'vendor_credit'], party: 'vendor', table: 'vendor', label: 'Vendor' },
};

export async function openItems(db, { orgId, entityId, side, asOf, partyIds = [] }) {
  const s = SIDES[side];
  const { rows } = await db.query(
    `SELECT t.txn_id, t.type, t.txn_date::text AS date, coalesce(t.due_date, t.txn_date)::text AS due, t.due_date::text AS due_date, t.doc_number, t.payment_ref, t.memo,
            t.total_cents::bigint AS total, t.${s.party}_id AS party_id, p.display_name AS party_name, tm.name AS terms,
            t.total_cents - coalesce((SELECT sum(a.amount_cents) FROM application a
                                       WHERE (a.charge_txn_id = t.txn_id OR a.credit_txn_id = t.txn_id) AND a.applied_on <= $3::date), 0) AS open
       FROM txn t JOIN ${s.table} p ON p.${s.party}_id = t.${s.party}_id LEFT JOIN terms tm ON tm.terms_id = t.terms_id
      WHERE t.org_id = $1 AND t.entity_id = $2 AND t.voided_at IS NULL AND t.txn_date <= $3::date AND t.type = ANY($4::text[])
      ORDER BY p.display_name, t.txn_date, t.txn_id`, [orgId, entityId, asOf, [...s.charges, ...s.credits]]);
  const want = partyIds.length ? new Set(partyIds) : null;
  const other = await otherOpenItems(db, { orgId, entityId, side, asOf });
  return [...rows.map(r => {
    const credit = s.credits.includes(r.type);
    const open = Number(r.open) * (credit ? -1 : 1);
    return { txnId: Number(r.txn_id), type: r.type, typeLabel: TYPE_LABELS[r.type], date: r.date, due: r.due, num: r.doc_number ?? r.payment_ref ?? '',
      memo: r.memo ?? '', terms: r.terms ?? '', total: Number(r.total) * (credit ? -1 : 1), open, partyId: Number(r.party_id), partyName: r.party_name,
      // A charge with no due date yet (an item receipt waiting for its bill) isn't overdue; credits age from their date.
      pastDue: !credit && !r.due_date ? 0 : Math.max(0, daysBetween(r.due, asOf)), credit };
  }), ...other].filter(i => i.open !== 0 && (!want || want.has(i.partyId)));
}

// A/R or A/P lines on other transactions — journal entries, checks, expenses (in books imported from QuickBooks, which
// lets those carry a customer's or vendor's balance) — open as of the date: the line less what's been applied to that
// line by then (a link to such a line names it: an entry can have lines on A/R and A/P, or for several names). A line
// without a name belongs to the party whose documents it was applied to.
async function otherOpenItems(db, { orgId, entityId, side, asOf }) {
  const s = SIDES[side];
  const docTypes = [...SIDES.ar.charges, ...SIDES.ar.credits, ...SIDES.ap.charges, ...SIDES.ap.credits];
  const { rows } = await db.query(
    `WITH lines AS (
       SELECT t.txn_id, t.type, t.txn_date, t.doc_number, t.memo, p.line_no, p.${s.party}_id AS party_id, sum(p.amount_cents)::bigint AS amount
         FROM posting p JOIN txn t ON t.txn_id = p.txn_id JOIN account a ON a.account_id = p.account_id AND a.system_key = $4
        WHERE p.org_id = $1 AND p.entity_id = $2 AND t.txn_date <= $3::date AND t.voided_at IS NULL AND t.type <> ALL($5::text[])
        GROUP BY t.txn_id, t.type, t.txn_date, t.doc_number, t.memo, p.line_no, p.${s.party}_id),
     links AS (
       SELECT a.charge_txn_id AS txn_id, a.charge_line_no AS line_no, a.credit_txn_id AS other, a.amount_cents
         FROM application a WHERE a.charge_txn_id IN (SELECT txn_id FROM lines) AND a.charge_line_no IS NOT NULL AND a.applied_on <= $3::date
       UNION ALL
       SELECT a.credit_txn_id, a.credit_line_no, a.charge_txn_id, a.amount_cents
         FROM application a WHERE a.credit_txn_id IN (SELECT txn_id FROM lines) AND a.credit_line_no IS NOT NULL AND a.applied_on <= $3::date),
     applied AS (
       SELECT l.txn_id, l.line_no, d.${s.party}_id AS party_id, sum(l.amount_cents)::bigint AS applied
         FROM links l JOIN txn d ON d.txn_id = l.other GROUP BY 1, 2, 3)
     SELECT 'line' AS kind, txn_id, type, txn_date::text AS date, doc_number, memo, line_no, party_id, amount FROM lines
     UNION ALL SELECT 'applied', txn_id, NULL, NULL, NULL, NULL, line_no, party_id, applied FROM applied`,
    [orgId, entityId, asOf, side, docTypes]);
  const lines = rows.filter(r => r.kind === 'line'), applied = rows.filter(r => r.kind === 'applied');
  const ids = [...new Set(rows.map(r => r.party_id).filter(x => x !== null))];
  const names = new Map(ids.length ? (await db.query(`SELECT ${s.party}_id AS id, display_name FROM ${s.table} WHERE ${s.party}_id = ANY($1::bigint[])`, [ids])).rows.map(r => [String(r.id), r.display_name]) : []);
  return lines.map(r => {
    const mine = applied.filter(x => x.txn_id === r.txn_id && x.line_no === r.line_no);
    const used = mine.reduce((t, x) => t + Number(x.amount), 0);
    const partyId = r.party_id ?? [...mine].filter(x => x.party_id !== null).sort((x, y) => Number(y.amount) - Number(x.amount))[0]?.party_id ?? null;
    // Debit-positive amounts; on A/P a credit is what's owed. A charge's open part shrinks by what's applied to it, and so does a credit's.
    const owed = side === 'ar' ? Number(r.amount) : -Number(r.amount);
    const open = owed > 0 ? owed - used : owed + used;
    return { txnId: Number(r.txn_id), type: r.type, typeLabel: TYPE_LABELS[r.type] ?? r.type, date: r.date, due: r.date, num: r.doc_number ?? '', memo: r.memo ?? '', terms: '',
      total: owed, open, partyId: partyId === null ? null : Number(partyId), partyName: names.get(String(partyId)) ?? '(no name)',
      pastDue: Math.max(0, daysBetween(r.date, asOf)), credit: owed < 0 };
  });
}

// Aging buckets: Current, then `periods` buckets of `days` each, the last one open-ended ("91 and over").
export function agingBuckets({ days = 30, periods = 4 } = {}) {
  const out = [{ key: 'current', label: 'Current', test: d => d <= 0 }];
  for (let i = 0; i < periods; i++) {
    const lo = i * days + 1, hi = (i + 1) * days;
    const last = i === periods - 1;
    out.push({ key: `b${i}`, label: last ? `${lo} and over` : `${lo} - ${hi}`, test: d => d >= lo && (last || d <= hi) });
  }
  return out;
}
export const bucketOf = (buckets, pastDue) => buckets.findIndex(b => b.test(pastDue));

const party = side => SIDES[side].label;
const line = (i, cells) => ({ kind: 'line', txnId: i.txnId, txnType: i.type, cells });

// A/R or A/P Aging Summary: a row per customer/vendor, a column per bucket, and the total.
export function agingSummary(items, { buckets }) {
  const byParty = new Map();
  for (const i of items) {
    if (!byParty.has(i.partyId)) byParty.set(i.partyId, { name: i.partyName, values: Array(buckets.length + 1).fill(0) });
    const v = byParty.get(i.partyId).values;
    v[bucketOf(buckets, i.pastDue)] += i.open;
    v[buckets.length] += i.open;
  }
  const rows = [...byParty].map(([id, p]) => ({ kind: 'account', label: p.name, depth: 0, partyId: id, values: p.values }));
  const total = rows.reduce((t, r) => t.map((x, k) => x + r.values[k]), Array(buckets.length + 1).fill(0));
  rows.push({ kind: 'computed', label: 'Total', depth: 0, values: total, grand: true });
  return { rows, total, columns: [...buckets.map(b => b.label), 'Total'] };
}

// A/R or A/P Aging Detail: the open documents grouped by bucket (oldest bucket first, as QuickBooks shows it).
export function agingDetail(items, { buckets, side }) {
  const rows = [];
  let grand = 0;
  for (let k = buckets.length - 1; k >= 0; k--) {
    const mine = items.filter(i => bucketOf(buckets, i.pastDue) === k).sort((a, b) => b.pastDue - a.pastDue || a.date.localeCompare(b.date));
    if (!mine.length) continue;
    const label = k === 0 ? 'Current' : `${buckets[k].label} days past due`;
    rows.push({ kind: 'section', label });
    let open = 0, amount = 0;
    for (const i of mine) {
      rows.push(line(i, { date: i.date, type: i.typeLabel, num: i.num, name: i.partyName, due: i.due, past_due: i.pastDue ? String(i.pastDue) : '', amount: i.total, open: i.open }));
      open += i.open; amount += i.total;
    }
    rows.push({ kind: 'total', label: `Total for ${label}`, cells: { amount, open } });
    grand += open;
  }
  if (rows.length) rows.push({ kind: 'total', label: 'Total', grand: true, cells: { open: grand } });
  const columns = [{ key: 'date', label: 'Date' }, { key: 'type', label: 'Transaction type' }, { key: 'num', label: 'No.' }, { key: 'name', label: party(side) },
    { key: 'due', label: 'Due date' }, { key: 'past_due', label: 'Past due' }, { key: 'amount', label: 'Amount', money: true }, { key: 'open', label: 'Open balance', money: true }];
  return { rows, columns, total: grand };
}

// Open Invoices / Unpaid Bills (and Collections: overdue charges only), grouped by customer or vendor.
export function openByParty(items, { side, overdueOnly = false, contacts = null, running = false }) {
  const list = overdueOnly ? items.filter(i => !i.credit && i.pastDue > 0) : items;
  const rows = [];
  let grand = 0;
  const parties = [...new Set(list.map(i => i.partyId))];
  for (const id of parties) {
    const mine = list.filter(i => i.partyId === id);
    const c = contacts?.get(id);
    rows.push({ kind: 'section', label: c ? [mine[0].partyName, c.phone, c.email].filter(Boolean).join(' · ') : mine[0].partyName, partyId: id });
    let open = 0, amount = 0;
    for (const i of mine) {
      open += i.open; amount += i.total;
      rows.push(line(i, { date: i.date, type: i.typeLabel, num: i.num, terms: i.terms, due: i.due, past_due: i.pastDue && !i.credit ? String(i.pastDue) : '',
        amount: i.total, open: i.open, balance: open }));
    }
    rows.push({ kind: 'total', label: `Total for ${mine[0].partyName}`, cells: { amount, open, balance: running ? open : null } });
    grand += open;
  }
  if (rows.length) rows.push({ kind: 'total', label: 'Total', grand: true, cells: { open: grand, balance: running ? grand : null } });
  const columns = [{ key: 'date', label: 'Date' }, { key: 'type', label: 'Transaction type' }, { key: 'num', label: 'No.' },
    ...(running ? [] : [{ key: 'terms', label: 'Terms' }]), { key: 'due', label: 'Due date' }, ...(running ? [] : [{ key: 'past_due', label: 'Past due' }]),
    { key: 'amount', label: 'Amount', money: true }, { key: 'open', label: 'Open balance', money: true }, ...(running ? [{ key: 'balance', label: 'Balance', money: true }] : [])];
  return { rows, columns, total: grand };
}

// Customer / Vendor Balance Summary: one total per customer or vendor.
export function balanceSummary(items) {
  const by = new Map();
  for (const i of items) {
    if (!by.has(i.partyId)) by.set(i.partyId, { name: i.partyName, v: 0 });
    by.get(i.partyId).v += i.open;
  }
  const rows = [...by].filter(([, p]) => p.v).map(([id, p]) => ({ kind: 'account', label: p.name, depth: 0, partyId: id, values: [p.v] }));
  const total = rows.reduce((s, r) => s + r.values[0], 0);
  rows.push({ kind: 'computed', label: 'Total', depth: 0, values: [total], grand: true });
  return { rows, total };
}
