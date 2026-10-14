import { ValidationError } from './writes.js';

// Transactions cleared in a finished reconciliation are locked: changing, voiding or deleting one needs an admin to
// say "change it anyway" (override). The error carries `reconciled = true` so editors can offer that.
export async function assertNotReconciled(tx, { orgId, txnId, override = false }) {
  if (override || !txnId) return;
  const { rows } = await tx.query(
    `SELECT r.statement_date, a.name FROM reconciled_item i JOIN reconciliation r ON r.rec_id = i.rec_id JOIN account a ON a.account_id = i.account_id
      WHERE r.org_id = $1 AND i.txn_id = $2 ORDER BY r.statement_date DESC LIMIT 1`, [orgId, txnId]);
  if (!rows.length) return;
  const error = new ValidationError(`This transaction was reconciled on ${rows[0].name} (statement ${rows[0].statement_date}). ` +
    'Changing it would throw that reconciliation off; an admin can change it anyway.');
  error.reconciled = true;
  throw error;
}

export async function isReconciled(db, { orgId, txnId }) {
  const { rows } = await db.query('SELECT 1 FROM reconciled_item i JOIN reconciliation r ON r.rec_id = i.rec_id WHERE r.org_id = $1 AND i.txn_id = $2 LIMIT 1', [orgId, txnId]);
  return rows.length > 0;
}
