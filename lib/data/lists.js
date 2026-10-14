import { parseTxnFilters } from '../domain/filters.js';

// Company-wide transaction lists (stage N3): Sales transactions, Invoices, Estimates, Expense transactions, Bills,
// Bill payments, Item receipts. Each list is a fixed set of types and its own status choices; every query parameter is
// whitelisted here before it reaches SQL.

const SALES_TYPES = ['invoice', 'payment', 'sales_receipt', 'credit_memo', 'late_fee', 'estimate', 'deposit'];
const EXPENSE_TYPES = ['expense', 'check', 'bill', 'bill_payment', 'vendor_credit', 'purchase_order', 'item_receipt'];

// status key → [label, SQL condition] ($1 = today).
const S = {
  all: ['All', 'true'],
  open: ['Open', `t.voided_at IS NULL AND t.open_cents > 0 AND t.type NOT IN ('estimate', 'purchase_order')`],
  overdue: ['Overdue', `t.voided_at IS NULL AND t.type IN ('invoice', 'late_fee', 'bill') AND t.open_cents > 0 AND t.due_date < $1::date`],
  paid: ['Paid', `t.voided_at IS NULL AND t.open_cents = 0 AND t.type IN ('invoice', 'late_fee', 'bill')`],
  unpaid: ['Unpaid', `t.voided_at IS NULL AND t.open_cents > 0`],
  not_due: ['Not due yet', `t.voided_at IS NULL AND t.open_cents > 0 AND (t.due_date IS NULL OR t.due_date >= $1::date)`],
  pending: ['Pending', `t.voided_at IS NULL AND coalesce(t.estimate_status, 'pending') = 'pending' AND t.open_cents = t.total_cents AND (t.due_date IS NULL OR t.due_date >= $1::date)`],
  accepted: ['Accepted', `t.voided_at IS NULL AND t.estimate_status = 'accepted'`],
  converted: ['Converted', `t.voided_at IS NULL AND t.type = 'estimate' AND t.open_cents < t.total_cents`],
  declined: ['Declined', `t.estimate_status = 'rejected'`],
  expired: ['Expired', `t.voided_at IS NULL AND coalesce(t.estimate_status, 'pending') = 'pending' AND t.open_cents = t.total_cents AND t.due_date < $1::date`],
  closed: ['Closed', `t.voided_at IS NULL AND (t.estimate_status = 'closed' OR t.closed_at IS NOT NULL)`],
  awaiting: ['Awaiting approval', `t.voided_at IS NULL AND t.approval_status = 'awaiting'`],
  to_print: ['To print', `t.voided_at IS NULL AND (t.type = 'check' OR t.payment_method = 'Check') AND t.printed_at IS NULL`],
  unapplied: ['Unapplied', `t.voided_at IS NULL AND t.open_cents > 0 AND t.type IN ('payment', 'credit_memo', 'vendor_credit')`],
  voided: ['Voided', 't.voided_at IS NOT NULL'],
};

export const LISTS = {
  'sales-transactions': { title: 'Sales transactions', side: 'customer', types: SALES_TYPES,
    typeOptions: [['all', 'All transactions'], ['invoice', 'Invoices'], ['payment', 'Payments'], ['sales_receipt', 'Sales receipts'],
      ['credit_memo', 'Credit memos'], ['late_fee', 'Late fees'], ['estimate', 'Estimates'], ['deposit', 'Deposits']],
    statuses: ['all', 'open', 'overdue', 'paid', 'unapplied', 'voided'] },
  invoices: { title: 'Invoices', side: 'customer', types: ['invoice', 'late_fee'], statuses: ['all', 'unpaid', 'overdue', 'not_due', 'paid', 'voided'] },
  estimates: { title: 'Estimates', side: 'customer', types: ['estimate'], statuses: ['all', 'pending', 'accepted', 'converted', 'closed', 'declined', 'expired', 'voided'] },
  'expense-transactions': { title: 'Expense transactions', side: 'vendor', types: EXPENSE_TYPES,
    typeOptions: [['all', 'All transactions'], ['expense', 'Expenses'], ['check', 'Checks'], ['bill', 'Bills'], ['bill_payment', 'Bill payments'],
      ['vendor_credit', 'Vendor credits'], ['purchase_order', 'Purchase orders'], ['item_receipt', 'Item receipts']],
    statuses: ['all', 'open', 'overdue', 'paid', 'awaiting', 'to_print', 'voided'] },
  bills: { title: 'Bills', side: 'vendor', types: ['bill'], statuses: ['all', 'unpaid', 'overdue', 'not_due', 'paid', 'awaiting', 'voided'] },
  'bill-payments': { title: 'Bill payments', side: 'vendor', types: ['bill_payment'], statuses: ['all', 'to_print', 'voided'] },
  'item-receipts': { title: 'Item receipts', side: 'vendor', types: ['item_receipt'], statuses: ['all', 'unpaid', 'voided'] },
};
export const statusLabel = key => S[key]?.[0] ?? key;

const SORTS = { date: d => `t.txn_date ${d}, t.txn_id ${d}`, number: d => `t.doc_number ${d} NULLS LAST, t.txn_id ${d}`,
  amount: d => `t.total_cents ${d}, t.txn_id ${d}`, party: d => `party_name ${d} NULLS LAST, t.txn_id ${d}`, due: d => `t.due_date ${d} NULLS LAST, t.txn_id ${d}` };

// query → whitelisted filters for one list.
export function listFilters(slug, query, today) {
  const def = LISTS[slug];
  const base = parseTxnFilters({ ...query, type: undefined, status: undefined, sort: undefined }, today);
  const type = (def.typeOptions ?? []).some(([v]) => v === query.type) ? query.type : 'all';
  const status = def.statuses.includes(query.status) ? query.status : 'all';
  const sort = Object.hasOwn(SORTS, query.sort) ? query.sort : 'date';
  const party = /^\d{1,18}$/.test(String(query.party ?? '')) ? Number(query.party) : null;
  const q = String(query.q ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
  return { ...base, type, status, sort, party, q };
}

export const PAGE_SIZE = 100;

const SIGN = `(CASE WHEN t.type IN ('invoice', 'late_fee', 'sales_receipt', 'bill', 'expense', 'check', 'item_receipt') THEN 1
  WHEN t.type IN ('payment', 'credit_memo', 'vendor_credit', 'bill_payment') THEN -1 ELSE 0 END)`;

export async function listCompanyTxns(db, { orgId, entityId, slug, filters: f, today, pageSize = PAGE_SIZE }) {
  const def = LISTS[slug];
  const types = f.type === 'all' ? def.types : [f.type];
  const where = `$1::date IS NOT NULL AND t.org_id = $2 AND t.entity_id = $3 AND t.type = ANY($4) AND ${S[f.status][1]}
     AND ($5::date IS NULL OR t.txn_date >= $5::date) AND ($6::date IS NULL OR t.txn_date <= $6::date)
     AND ($7::bigint IS NULL OR t.${def.side === 'customer' ? 'customer_id' : 'vendor_id'} = $7::bigint)
     AND ($8::text = '' OR t.doc_number ILIKE $9 OR t.payment_ref ILIKE $9 OR t.memo ILIKE $9 OR c.display_name ILIKE $9 OR v.display_name ILIKE $9)`;
  const params = [today, orgId, entityId, types, f.from, f.to, f.party, f.q, `%${f.q.replace(/[\\%_]/g, ch => `\\${ch}`)}%`];
  const from = `FROM txn t LEFT JOIN customer c ON c.customer_id = t.customer_id LEFT JOIN vendor v ON v.vendor_id = t.vendor_id`;
  const [{ rows }, { rows: [sum] }] = await Promise.all([
    db.query(`SELECT t.txn_id, t.type, t.doc_number, t.payment_ref, t.txn_date::text AS txn_date, t.due_date::text AS due_date, t.memo,
            t.total_cents, t.open_cents, t.voided_at, t.approval_status, t.scheduled_pay_date::text AS scheduled_pay_date, t.closed_at,
            t.estimate_status, t.payment_method, t.printed_at, t.customer_id, t.vendor_id, coalesce(c.display_name, v.display_name) AS party_name
       ${from} WHERE ${where} ORDER BY ${SORTS[f.sort](f.dir === 'asc' ? 'ASC' : 'DESC')} LIMIT $10 OFFSET $11`,
    [...params, pageSize, (f.page - 1) * pageSize]),
    // Totals are signed like the balance they describe: payments and credits reduce it; estimates, purchase orders and
    // deposits (which only move money already counted) are left out.
    db.query(`SELECT count(*)::int AS n,
            coalesce(sum(${SIGN} * t.total_cents) FILTER (WHERE t.voided_at IS NULL), 0)::bigint AS total,
            coalesce(sum(${SIGN} * t.open_cents) FILTER (WHERE t.voided_at IS NULL), 0)::bigint AS open
       ${from} WHERE ${where}`, params),
  ]);
  return { rows: rows.map(r => ({ ...r, total_cents: Number(r.total_cents), open_cents: Number(r.open_cents) })),
    count: sum.n, total: Number(sum.total), open: Number(sum.open), pages: Math.max(1, Math.ceil(sum.n / pageSize)) };
}

// Party choices for the list's filter.
export async function partyChoices(db, { orgId, entityId, side }) {
  const table = side === 'customer' ? 'customer' : 'vendor';
  const { rows } = await db.query(`SELECT ${table}_id AS id, display_name AS name FROM ${table} WHERE org_id = $1 AND entity_id = $2 ORDER BY lower(display_name)`, [orgId, entityId]);
  return rows;
}
