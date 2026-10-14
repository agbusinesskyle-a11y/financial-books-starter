// Reads for the vendor side: lists, one transaction, open bills to pay, project costs.
import { addDays } from '../domain/dates.js';

export const VENDOR_TXN_FILTERS = [
  ['all', 'All transactions'], ['bill', 'Bills'], ['open_bills', 'Open bills'], ['overdue', 'Overdue bills'], ['awaiting', 'Awaiting approval'],
  ['bill_payment', 'Bill payments'], ['expense', 'Expenses'], ['check', 'Checks'], ['vendor_credit', 'Vendor credits'],
  ['purchase_order', 'Purchase orders'], ['item_receipt', 'Item receipts'],
];
export const VENDOR_DATE_FILTERS = [['365', 'Last 12 months'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['ytd', 'This year'], ['all', 'All dates']];

export function parseVendorTxnFilters(q, today) {
  return {
    type: VENDOR_TXN_FILTERS.some(([k]) => k === q.type) ? q.type : 'all',
    date: VENDOR_DATE_FILTERS.some(([k]) => k === q.date) ? q.date : '365',
    page: Math.min(100_000, Math.max(1, Number.parseInt(q.page, 10) || 1)),
    tag: /^\d{1,18}$/.test(String(q.tag ?? '')) ? Number(q.tag) : null,
    today,
  };
}

function dateFrom(f) {
  if (f.date === 'all') return null;
  if (f.date === 'ytd') return `${f.today.slice(0, 4)}-01-01`;
  return addDays(f.today, -Number(f.date));
}

// Category column: the one account (or product) on the document, or "Split".
const CATEGORY = `
  (SELECT CASE WHEN count(*) = 1 THEN max(coalesce(a.name, i.name)) WHEN count(*) > 1 THEN '--Split--' END
     FROM txn_line l LEFT JOIN account a ON a.account_id = l.account_id LEFT JOIN item i ON i.item_id = l.item_id
    WHERE l.txn_id = t.txn_id)`;

export async function listVendorTxns(db, { orgId, vendorId, filters: f, pageSize = 50 }) {
  const params = [orgId, vendorId];
  const where = ['t.org_id = $1', 't.vendor_id = $2'];
  const from = dateFrom(f);
  if (from) { params.push(from); where.push(`t.txn_date >= $${params.length}`); }
  if (f.tag) { params.push(f.tag); where.push(`EXISTS (SELECT 1 FROM txn_tag x WHERE x.txn_id = t.txn_id AND x.tag_id = $${params.length})`); }
  switch (f.type) {
    case 'all': break;
    case 'open_bills': where.push(`t.type = 'bill' AND t.open_cents > 0 AND t.voided_at IS NULL`); break;
    case 'overdue': params.push(f.today); where.push(`t.type = 'bill' AND t.open_cents > 0 AND t.voided_at IS NULL AND t.due_date < $${params.length}`); break;
    case 'awaiting': where.push(`t.type = 'bill' AND t.approval_status = 'awaiting' AND t.voided_at IS NULL`); break;
    default: params.push(f.type); where.push(`t.type = $${params.length}`);
  }
  const { rows } = await db.query(
    `SELECT t.txn_id, t.type, t.doc_number, t.txn_date, t.due_date, t.memo, t.total_cents, t.open_cents, t.voided_at, t.approval_status,
            t.payment_method, t.printed_at, t.system_kind, t.closed_at, t.scheduled_pay_date, t.source, ${CATEGORY} AS category, count(*) OVER ()::int AS total_rows
       FROM txn t WHERE ${where.join(' AND ')}
      ORDER BY t.txn_date DESC, t.txn_id DESC LIMIT ${pageSize} OFFSET ${(f.page - 1) * pageSize}`, params);
  return { rows, total: rows[0]?.total_rows ?? 0, pageSize };
}

// One vendor-side transaction with its lines, what it paid / what paid it, and names for display.
export async function getVendorTxn(db, { orgId, entityId, txnId }) {
  const { rows: [t] } = await db.query(
    `SELECT t.*, v.display_name AS vendor_name, v.email AS vendor_email, v.billing_address AS vendor_address, v.check_name,
            (SELECT coalesce(array_agg(tt.tag_id), '{}') FROM txn_tag tt WHERE tt.txn_id = t.txn_id) AS tag_ids,
            EXISTS (SELECT 1 FROM reconciled_item ri WHERE ri.txn_id = t.txn_id) AS reconciled,
            a.name AS account_name, a.type AS account_type, sa.name AS scheduled_account_name
       FROM txn t LEFT JOIN vendor v ON v.vendor_id = t.vendor_id LEFT JOIN account a ON a.account_id = t.account_id
       LEFT JOIN account sa ON sa.account_id = t.scheduled_account_id
      WHERE t.org_id = $1 AND t.entity_id = $2 AND t.txn_id = $3
        AND t.type IN ('bill', 'bill_payment', 'expense', 'check', 'vendor_credit', 'purchase_order', 'item_receipt')`, [orgId, entityId, txnId]);
  if (!t) return null;
  const { rows: lines } = await db.query(
    `SELECT l.*, a.name AS account_name, i.name AS item_name, c.display_name AS customer_name, p.name AS project_name
       FROM txn_line l LEFT JOIN account a ON a.account_id = l.account_id LEFT JOIN item i ON i.item_id = l.item_id
       LEFT JOIN customer c ON c.customer_id = l.customer_id LEFT JOIN project p ON p.project_id = l.project_id
      WHERE l.org_id = $1 AND l.txn_id = $2 ORDER BY l.line_no`, [orgId, txnId]);
  // Bills: the payments and credits applied to them. Payments / credits: the bills they paid.
  const { rows: applications } = await db.query(
    `SELECT ap.amount_cents, ap.foreign_cents, ap.applied_on, ap.source AS link_source, o.txn_id, o.type, o.doc_number, o.txn_date, o.due_date, o.total_cents, o.open_cents, o.payment_method
       FROM application ap JOIN txn o ON o.txn_id = CASE WHEN ap.credit_txn_id = $2 THEN ap.charge_txn_id ELSE ap.credit_txn_id END
      WHERE ap.org_id = $1 AND (ap.credit_txn_id = $2 OR ap.charge_txn_id = $2) ORDER BY ap.applied_on, ap.application_id`, [orgId, txnId]);
  return { ...t, lines, applications };
}

// Approved, open bills (optionally one vendor's), oldest due first, with each vendor's available credit.
export async function listOpenBills(db, { orgId, entityId, vendorId = null, includeUnapproved = false }) {
  const params = [orgId, entityId];
  let extra = '';
  if (vendorId) { params.push(vendorId); extra += ` AND t.vendor_id = $${params.length}`; }
  if (!includeUnapproved) extra += ` AND t.approval_status = 'approved'`;
  const { rows } = await db.query(
    // Amounts in the bill's own currency (a foreign bill is paid in its currency).
    `SELECT t.txn_id, t.vendor_id, v.display_name AS vendor_name, v.bank_verified, t.doc_number, t.txn_date, t.due_date, t.currency,
            coalesce(t.foreign_total_cents, t.total_cents) AS total_cents, coalesce(t.foreign_open_cents, t.open_cents) AS open_cents, t.approval_status,
            coalesce((SELECT sum(coalesce(c.foreign_open_cents, c.open_cents)) FROM txn c WHERE c.org_id = t.org_id AND c.vendor_id = t.vendor_id AND c.type = 'vendor_credit'
                       AND c.voided_at IS NULL AND c.currency IS NOT DISTINCT FROM t.currency), 0)::bigint AS vendor_credit_cents
       FROM txn t JOIN vendor v ON v.vendor_id = t.vendor_id
      WHERE t.org_id = $1 AND t.entity_id = $2 AND t.type = 'bill' AND t.voided_at IS NULL AND t.open_cents > 0 ${extra}
      ORDER BY t.due_date, t.txn_id`, params);
  return rows;
}

// What a project cost: vendor-side lines tagged to it (credits subtract).
export async function projectCosts(db, { orgId, projectId }) {
  const { rows } = await db.query(
    `SELECT t.txn_id, t.type, t.doc_number, t.txn_date, v.display_name AS vendor_name, l.description, coalesce(a.name, i.name) AS category,
            CASE WHEN t.type = 'vendor_credit' THEN -l.amount_cents ELSE l.amount_cents END AS amount_cents
       FROM txn_line l JOIN txn t ON t.txn_id = l.txn_id LEFT JOIN vendor v ON v.vendor_id = t.vendor_id
       LEFT JOIN account a ON a.account_id = l.account_id LEFT JOIN item i ON i.item_id = l.item_id
      WHERE l.org_id = $1 AND l.project_id = $2 AND t.voided_at IS NULL AND t.type IN ('bill', 'expense', 'check', 'vendor_credit')
      ORDER BY t.txn_date DESC, t.txn_id DESC, l.line_no`, [orgId, projectId]);
  return { rows, totalCents: rows.reduce((s, r) => s + r.amount_cents, 0) };
}

// Checks waiting to be printed for a bank account (or all).
export async function listChecksToPrint(db, { orgId, entityId }) {
  const { rows } = await db.query(
    `SELECT t.txn_id, t.type, t.doc_number, t.txn_date, t.total_cents, v.display_name AS vendor_name, a.name AS account_name
       FROM txn t LEFT JOIN vendor v ON v.vendor_id = t.vendor_id JOIN account a ON a.account_id = t.account_id
      WHERE t.org_id = $1 AND t.entity_id = $2 AND t.voided_at IS NULL AND t.printed_at IS NULL AND t.total_cents > 0
        AND (t.type = 'check' OR (t.type = 'bill_payment' AND t.payment_method = 'Check'))
      ORDER BY a.name, t.doc_number`, [orgId, entityId]);
  return rows;
}
