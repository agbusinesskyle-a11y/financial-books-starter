// Customer reads. All queries are scoped by org_id.

const OPEN_SQL = `
  coalesce(sum(CASE WHEN t.voided_at IS NULL AND t.type IN ('invoice', 'late_fee') THEN t.open_cents
                    WHEN t.voided_at IS NULL AND t.type IN ('payment', 'credit_memo') THEN -t.open_cents
                    ELSE 0 END), 0)::bigint`;

export async function listCustomers(pool, { orgId, entityId, search = '', includeInactive = true }) {
  const term = search.trim();
  const { rows } = await pool.query(
    `SELECT c.customer_id, c.display_name, c.company_name, c.email, c.phone, c.active, c.currency, c.cc, c.bcc, c.billing_address, c.shipping_address,
            c.shipping_same_as_billing, ${OPEN_SQL} AS open_cents
       FROM customer c
       LEFT JOIN txn t ON t.org_id = c.org_id AND t.customer_id = c.customer_id
      WHERE c.org_id = $1 AND c.entity_id = $2
        AND ($3 = '' OR c.display_name ILIKE $4 OR c.company_name ILIKE $4 OR c.email ILIKE $4 OR c.phone ILIKE $4)
        AND ($5 OR c.active)
      GROUP BY c.customer_id
      ORDER BY c.active DESC, lower(c.display_name)`,
    [orgId, entityId, term, `%${term.replace(/[\\%_]/g, m => `\\${m}`)}%`, includeInactive]);
  return rows;
}

// Only a customer of this company (entityId) — a customer id from another company is "not found".
export async function getCustomer(pool, { orgId, entityId, id }) {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const { rows } = await pool.query(
    `SELECT c.*, tm.name AS terms_name, tm.due_days AS terms_due_days
       FROM customer c LEFT JOIN terms tm ON tm.org_id = c.org_id AND tm.terms_id = c.terms_id
      WHERE c.org_id = $1 AND c.customer_id = $2 AND c.entity_id = $3`, [orgId, id, entityId]);
  return rows[0] ?? null;
}

// Open balance = owed on charges − unapplied credits. Overdue = owed on charges past due.
export async function getSummary(pool, { orgId, customerId, today }) {
  const { rows } = await pool.query(
    `SELECT ${OPEN_SQL} AS open_cents,
            coalesce(sum(CASE WHEN t.voided_at IS NULL AND t.type IN ('invoice', 'late_fee') AND t.due_date < $3::date
                              THEN t.open_cents ELSE 0 END), 0)::bigint AS overdue_cents
       FROM txn t WHERE t.org_id = $1 AND t.customer_id = $2`, [orgId, customerId, today]);
  return { openCents: rows[0].open_cents, overdueCents: rows[0].overdue_cents };
}
