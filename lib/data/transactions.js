// Transaction reads. Filters must come from parseTxnFilters (already whitelisted).

const STATUS_SQL = {
  all: 'true',
  open: `t.voided_at IS NULL AND t.open_cents > 0 AND t.type <> 'estimate'`,
  overdue: `t.voided_at IS NULL AND t.type IN ('invoice', 'late_fee') AND t.open_cents > 0 AND t.due_date < $3::date`,
  paid: `t.voided_at IS NULL AND t.open_cents = 0 AND t.type <> 'estimate'`,
  // Estimates (QBO lists their statuses in the same Status filter).
  pending: `t.voided_at IS NULL AND t.type = 'estimate' AND coalesce(t.estimate_status, 'pending') = 'pending' AND t.open_cents = t.total_cents AND (t.due_date IS NULL OR t.due_date >= $3::date)`,
  accepted: `t.voided_at IS NULL AND t.type = 'estimate' AND t.estimate_status = 'accepted'`,
  converted: `t.voided_at IS NULL AND t.type = 'estimate' AND t.open_cents < t.total_cents`,
  declined: `t.type = 'estimate' AND t.estimate_status = 'rejected'`,
  expired: `t.voided_at IS NULL AND t.type = 'estimate' AND coalesce(t.estimate_status, 'pending') = 'pending' AND t.open_cents = t.total_cents AND t.due_date < $3::date`,
  voided: 't.voided_at IS NOT NULL',
};
// Type filter. $2 = the customer. "All plus deposits" adds bank deposits holding this customer's payments; "Money
// received" is payments and sales receipts; "Recently paid" is invoices paid off in the last 30 days.
const TYPE_SQL = {
  all: `(t.customer_id = $2 OR (t.type = 'journal_entry' AND EXISTS (SELECT 1 FROM posting lp WHERE lp.txn_id = t.txn_id AND lp.customer_id = $2)))`,
  all_deposits: `(t.customer_id = $2 OR (t.type = 'journal_entry' AND EXISTS (SELECT 1 FROM posting lp WHERE lp.txn_id = t.txn_id AND lp.customer_id = $2))
    OR (t.type = 'deposit' AND EXISTS (SELECT 1 FROM deposit_line dl LEFT JOIN txn s ON s.txn_id = dl.source_txn_id
    WHERE dl.deposit_txn_id = t.txn_id AND (dl.customer_id = $2 OR s.customer_id = $2))))`,
  money_received: `t.customer_id = $2 AND t.type IN ('payment', 'sales_receipt')`,
  recently_paid: `t.customer_id = $2 AND t.type IN ('invoice', 'late_fee') AND t.voided_at IS NULL AND t.open_cents = 0
    AND (SELECT max(a.applied_on) FROM application a WHERE a.charge_txn_id = t.txn_id) >= $3::date - 29`,
};
const typeSql = type => TYPE_SQL[type] ?? `t.customer_id = $2 AND t.type = '${type}'`;
const SORT_SQL = {
  date: dir => `t.txn_date ${dir}, t.txn_id ${dir}`,
  number: dir => `t.doc_number ${dir} NULLS LAST, t.txn_id ${dir}`,
  amount: dir => `t.total_cents ${dir}, t.txn_id ${dir}`,
};

export async function listTransactions(pool, { orgId, customerId, filters, today, pageSize = 50 }) {
  const status = STATUS_SQL[filters.status];
  const order = SORT_SQL[filters.sort]?.(filters.dir === 'asc' ? 'ASC' : 'DESC');
  if (!status || !order || !/^[a-z_]+$/.test(filters.type)) throw new Error('unvalidated filters');
  const limit = pageSize > 0 ? pageSize : null; // pageSize 0 = everything (export)
  const offset = limit ? (filters.page - 1) * limit : 0;
  const where = `t.org_id = $1 AND ${typeSql(filters.type)}
        AND $3::date IS NOT NULL -- today; always typed, used by the overdue status
        AND ${status}
        AND ($4::date IS NULL OR t.txn_date >= $4::date)
        AND ($5::date IS NULL OR t.txn_date <= $5::date)
        AND ($6::bigint IS NULL OR EXISTS (SELECT 1 FROM txn_tag x WHERE x.txn_id = t.txn_id AND x.tag_id = $6::bigint))`;
  const params = [orgId, customerId, today, filters.from, filters.to, filters.tag ?? null];
  const [{ rows }, { rows: [sum] }] = await Promise.all([
    pool.query(
      `SELECT t.txn_id, t.type, t.doc_number, t.txn_date, t.due_date, t.memo, t.payment_ref, t.total_cents, t.open_cents, t.customer_id,
              t.voided_at, t.estimate_status, t.payment_method, t.source, coalesce(c.display_name, '') AS customer_name,
              (SELECT max(m.occurred_at) FROM message m WHERE m.org_id = t.org_id AND m.related_txn_id = t.txn_id AND m.direction = 'out'
                 AND m.status IN ('sent', 'logged')) AS sent_at
         FROM txn t LEFT JOIN customer c ON c.org_id = t.org_id AND c.customer_id = t.customer_id
        WHERE ${where}
        ORDER BY ${order}
        LIMIT $7 OFFSET $8`,
      [...params, limit, offset]),
    // The Total row is what the rows add to the customer's balance: payments and credits subtract; estimates, deposits
    // (other customers' money too) and journal entries (only some lines are this customer's) are left out.
    pool.query(`SELECT count(*)::int AS n, coalesce(sum(CASE WHEN t.type IN ('payment', 'credit_memo') THEN -t.total_cents ELSE t.total_cents END)
              FILTER (WHERE t.voided_at IS NULL AND t.type NOT IN ('estimate', 'deposit', 'journal_entry')), 0)::bigint AS total
         FROM txn t WHERE ${where}`, params),
  ]);
  return { rows, total: sum.n, sumCents: Number(sum.total) };
}

export async function getTransaction(pool, { orgId, id }) {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const { rows } = await pool.query(
    `SELECT t.*, c.display_name AS customer_name, c.email AS customer_email, p.name AS project_name, tm.name AS terms_name,
            (SELECT coalesce(array_agg(tt.tag_id), '{}') FROM txn_tag tt WHERE tt.txn_id = t.txn_id) AS tag_ids,
            EXISTS (SELECT 1 FROM reconciled_item ri WHERE ri.txn_id = t.txn_id) AS reconciled,
            (SELECT d.txn_id FROM txn d WHERE d.deposit_for_txn_id = t.txn_id AND d.voided_at IS NULL) AS deposit_txn_id,
            (SELECT d.total_cents FROM txn d WHERE d.deposit_for_txn_id = t.txn_id AND d.voided_at IS NULL) AS deposit_cents,
            (SELECT d.payment_method FROM txn d WHERE d.deposit_for_txn_id = t.txn_id AND d.voided_at IS NULL) AS deposit_method
       FROM txn t JOIN customer c ON c.org_id = t.org_id AND c.customer_id = t.customer_id
       LEFT JOIN project p ON p.org_id = t.org_id AND p.project_id = t.project_id
       LEFT JOIN terms tm ON tm.org_id = t.org_id AND tm.terms_id = t.terms_id
      WHERE t.org_id = $1 AND t.txn_id = $2`, [orgId, id]);
  if (!rows.length) return null;
  const txn = rows[0];
  const [lines, applied] = await Promise.all([
    pool.query(
      `SELECT l.line_no, l.kind, l.item_id, l.description, l.quantity::float8 AS quantity, l.rate_cents, l.amount_cents, i.name AS item_name, l.class_id,
              l.billable_txn_id, l.billable_line_no, l.time_entry_id, l.foreign_amount_cents, l.foreign_rate_cents,
              to_char(l.service_date, 'YYYY-MM-DD') AS service_date
         FROM txn_line l LEFT JOIN item i ON i.org_id = l.org_id AND i.item_id = l.item_id
        WHERE l.org_id = $1 AND l.txn_id = $2 ORDER BY l.line_no`, [orgId, id]),
    pool.query(
      `SELECT a.amount_cents, a.foreign_cents, a.applied_on, a.source AS link_source, o.txn_id, o.type, o.doc_number, o.payment_ref, o.txn_date
         FROM application a
         JOIN txn o ON o.org_id = a.org_id AND o.txn_id = CASE WHEN a.credit_txn_id = $2 THEN a.charge_txn_id ELSE a.credit_txn_id END
        WHERE a.org_id = $1 AND (a.credit_txn_id = $2 OR a.charge_txn_id = $2)
        ORDER BY a.applied_on, o.txn_id`, [orgId, id]),
  ]);
  return { ...txn, lines: lines.rows, applications: applied.rows };
}
