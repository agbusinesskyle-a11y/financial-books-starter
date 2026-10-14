export async function listActivity(pool, { orgId, customerId, limit = 200 }) {
  const { rows } = await pool.query(
    `SELECT e.event_id, e.kind, e.summary, e.actor, e.occurred_at, e.txn_id
       FROM activity_event e
      WHERE e.org_id = $1 AND e.customer_id = $2
      ORDER BY e.occurred_at DESC, e.event_id DESC
      LIMIT $3`, [orgId, customerId, limit]);
  return rows;
}
