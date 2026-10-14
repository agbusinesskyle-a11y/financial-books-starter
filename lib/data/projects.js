import { withTransaction } from '../db.js';
import { ValidationError, lockEntity, logActivity } from './writes.js';
import { isIsoDate } from '../domain/dates.js';
import { STATUS_LABELS } from '../domain/projects.js';

const fail = message => { throw new ValidationError(message); };

// Per project: invoiced (invoices, sales receipts, late fees), open (still owed on them), paid = invoiced − open,
// credits (credit memos), and how many transactions are assigned.
const TOTALS = `
  coalesce(sum(t.total_cents) FILTER (WHERE t.type IN ('invoice', 'sales_receipt', 'late_fee')), 0)::bigint AS invoiced_cents,
  coalesce(sum(t.open_cents) FILTER (WHERE t.type IN ('invoice', 'late_fee')), 0)::bigint AS open_cents,
  coalesce(sum(t.total_cents) FILTER (WHERE t.type = 'credit_memo'), 0)::bigint AS credit_cents,
  count(t.txn_id)::int AS txn_count`;

export async function listProjects(pool, { orgId, customerId }) {
  const { rows } = await pool.query(
    `SELECT p.project_id, p.name, p.status, p.start_date, p.end_date, p.description, ${TOTALS}
       FROM project p LEFT JOIN txn t ON t.org_id = p.org_id AND t.project_id = p.project_id AND t.voided_at IS NULL
      WHERE p.org_id = $1 AND p.customer_id = $2
      GROUP BY p.project_id
      ORDER BY (p.status = 'in_progress') DESC, lower(p.name)`, [orgId, customerId]);
  return rows.map(r => ({ ...r, paid_cents: r.invoiced_cents - r.open_cents }));
}

export async function getProject(pool, { orgId, entityId, projectId }) {
  const { rows } = await pool.query(
    `SELECT p.*, c.display_name AS customer_name, ${TOTALS}
       FROM project p JOIN customer c ON c.org_id = p.org_id AND c.customer_id = p.customer_id AND c.entity_id = $2
       LEFT JOIN txn t ON t.org_id = p.org_id AND t.project_id = p.project_id AND t.voided_at IS NULL
      WHERE p.org_id = $1 AND p.project_id = $3
      GROUP BY p.project_id, c.display_name`, [orgId, entityId, projectId]);
  const p = rows[0];
  return p ? { ...p, paid_cents: p.invoiced_cents - p.open_cents } : null;
}

export async function listProjectTransactions(pool, { orgId, projectId }) {
  const { rows } = await pool.query(
    `SELECT txn_id, type, doc_number, payment_ref, txn_date, due_date, memo, total_cents, open_cents, voided_at
       FROM txn WHERE org_id = $1 AND project_id = $2 ORDER BY txn_date DESC, txn_id DESC`, [orgId, projectId]);
  return rows;
}

// fields: { name, status, startDate, endDate, description } (form strings).
export async function saveProject(pool, { orgId, entityId, customerId, projectId = null, fields: f, actor }) {
  const name = String(f.name ?? '').trim().slice(0, 100);
  if (!name) fail('Give the project a name.');
  const status = STATUS_LABELS[f.status] ? f.status : 'in_progress';
  const start = String(f.startDate ?? '').trim() || null, end = String(f.endDate ?? '').trim() || null;
  if (start && !isIsoDate(start)) fail('Enter a valid start date.');
  if (end && !isIsoDate(end)) fail('Enter a valid end date.');
  if (start && end && end < start) fail('The end date must be on or after the start date.');
  const description = String(f.description ?? '').trim().slice(0, 2000) || null;
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const c = await tx.query('SELECT 1 FROM customer WHERE org_id = $1 AND entity_id = $2 AND customer_id = $3', [orgId, entityId, customerId]);
    if (!c.rowCount) fail('Customer not found.');
    try {
      if (projectId) {
        const { rowCount } = await tx.query(
          'UPDATE project SET name = $4, status = $5, start_date = $6, end_date = $7, description = $8 WHERE org_id = $1 AND customer_id = $2 AND project_id = $3',
          [orgId, customerId, projectId, name, status, start, end, description]);
        if (!rowCount) fail('Project not found.');
      } else {
        projectId = (await tx.query(
          'INSERT INTO project (org_id, customer_id, name, status, start_date, end_date, description) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING project_id',
          [orgId, customerId, name, status, start, end, description])).rows[0].project_id;
      }
    } catch (error) {
      if (error?.code === '23505') fail(`This customer already has a project named “${name}”.`);
      throw error;
    }
    await logActivity(tx, { orgId, customerId, actor, kind: 'project_saved', summary: `Project “${name}” ${f.isNew ? 'created' : 'updated'}` });
    return projectId;
  });
}

export async function deleteProject(pool, { orgId, entityId, projectId, actor }) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const p = await getProject(tx, { orgId, entityId, projectId }) ?? fail('Project not found.');
    if (p.txn_count || (await tx.query('SELECT 1 FROM txn WHERE org_id = $1 AND project_id = $2 LIMIT 1', [orgId, projectId])).rowCount) {
      fail(`“${p.name}” has transactions. Move them to another project (or none) first, or mark the project Completed.`);
    }
    await tx.query('DELETE FROM project WHERE org_id = $1 AND project_id = $2', [orgId, projectId]);
    await logActivity(tx, { orgId, customerId: p.customer_id, actor, kind: 'project_deleted', summary: `Project “${p.name}” deleted` });
    return p;
  });
}
