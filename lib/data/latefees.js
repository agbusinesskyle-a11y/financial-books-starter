import { withTransaction } from '../db.js';
import { ValidationError, lockEntity, logActivity, nextDocNumber } from './writes.js';
import { repost } from './ledger.js';
import { feeAmount, feeDates } from '../domain/latefees.js';
import { parseMoney, formatCents } from '../domain/money.js';
import { addDays } from '../domain/dates.js';

const fail = message => { throw new ValidationError(message); };

export const DEFAULT_POLICY = {
  enabled: false, fee_kind: 'flat', flat_cents: 2500, percent_bps: 150, grace_days: 0,
  repeat_every_days: null, max_fees_per_invoice: 1, effective_from: null,
};

export async function getPolicy(pool, { orgId, entityId }) {
  const { rows } = await pool.query('SELECT * FROM late_fee_policy WHERE org_id = $1 AND entity_id = $2', [orgId, entityId]);
  return rows[0] ?? { ...DEFAULT_POLICY };
}

// fields (form strings): enabled ('1'), feeKind, flat, percent, graceDays, repeat ('1'), repeatDays, maxFees.
// Turning fees on (or back on) sets effective_from = today, so days before that are never charged.
export async function savePolicy(pool, { orgId, entityId, fields: f, today }) {
  const enabled = f.enabled === '1';
  const feeKind = f.feeKind === 'percent' ? 'percent' : 'flat';
  const flat = parseMoney(String(f.flat ?? '').trim() || '0');
  if (flat === null || flat > 100_000_00) fail('The flat fee should be an amount like 25.00.');
  const pct = String(f.percent ?? '').trim() || '0';
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(pct) || Number(pct) > 100) fail('The percentage should be a number like 1.5.');
  const bps = Math.round(Number(pct) * 100);
  if (enabled && (feeKind === 'flat' ? flat : bps) <= 0) fail('Enter a fee greater than zero.');
  const int = (v, lo, hi, message) => {
    const s = String(v ?? '').trim();
    if (!/^\d{1,3}$/.test(s) || Number(s) < lo || Number(s) > hi) fail(message);
    return Number(s);
  };
  const graceDays = int(f.graceDays || '0', 0, 365, 'Grace days must be 0 to 365.');
  const repeat = f.repeat === '1';
  const repeatDays = repeat ? int(f.repeatDays, 1, 365, 'Repeat every 1 to 365 days.') : null;
  const maxFees = repeat ? int(f.maxFees, 1, 24, 'Charge at most 1 to 24 fees per invoice.') : 1;
  const current = await getPolicy(pool, { orgId, entityId });
  const effectiveFrom = enabled ? (current.enabled ? current.effective_from : today) : current.effective_from;
  await pool.query(
    `INSERT INTO late_fee_policy (org_id, entity_id, enabled, fee_kind, flat_cents, percent_bps, grace_days, repeat_every_days, max_fees_per_invoice, effective_from)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (org_id, entity_id) DO UPDATE SET enabled = $3, fee_kind = $4, flat_cents = $5, percent_bps = $6, grace_days = $7,
       repeat_every_days = $8, max_fees_per_invoice = $9, effective_from = $10, updated_at = now()`,
    [orgId, entityId, enabled, feeKind, flat, bps, graceDays, repeatDays, maxFees, effectiveFrom]);
}

export async function setCustomerLateFees(pool, { orgId, entityId, customerId, enabled, actor }) {
  await withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const { rowCount } = await tx.query('UPDATE customer SET late_fees_enabled = $4 WHERE org_id = $1 AND entity_id = $2 AND customer_id = $3',
      [orgId, entityId, customerId, enabled]);
    if (!rowCount) fail('Customer not found.');
    await logActivity(tx, { orgId, customerId, actor, kind: 'customer_updated', summary: `Late fees turned ${enabled ? 'on' : 'off'} for this customer` });
  });
}

// Late fees charged to one customer, newest first, with the invoice each was charged on.
export async function listCustomerLateFees(pool, { orgId, customerId }) {
  const { rows } = await pool.query(
    `SELECT f.txn_id, f.doc_number, f.txn_date, f.total_cents, f.open_cents, f.voided_at, s.txn_id AS source_txn_id, s.doc_number AS source_doc
       FROM txn f LEFT JOIN txn s ON s.org_id = f.org_id AND s.txn_id = f.source_txn_id
      WHERE f.org_id = $1 AND f.customer_id = $2 AND f.type = 'late_fee'
      ORDER BY f.txn_date DESC, f.txn_id DESC`, [orgId, customerId]);
  return rows;
}

// Daily job: charges every late fee due through `today`. Safe to run any number of times —
// late_fee_charge (invoice, date) is the idempotency key. Returns the number of fees created.
export async function runLateFees(pool, { orgId, entityId, today, actor = 'system' }) {
  const policy = await getPolicy(pool, { orgId, entityId });
  if (!policy.enabled) return 0;
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const { rows: invoices } = await tx.query(
      `SELECT t.txn_id, t.customer_id, t.doc_number, t.due_date, t.open_cents,
              coalesce(array_agg(to_char(c.assessed_on, 'YYYY-MM-DD')) FILTER (WHERE c.assessed_on IS NOT NULL), '{}') AS charged
         FROM txn t
         JOIN customer cu ON cu.org_id = t.org_id AND cu.customer_id = t.customer_id AND cu.late_fees_enabled
         LEFT JOIN late_fee_charge c ON c.source_txn_id = t.txn_id
        WHERE t.org_id = $1 AND t.entity_id = $2 AND t.type = 'invoice' AND t.voided_at IS NULL AND t.open_cents > 0
          AND t.due_date < $3::date AND t.currency IS NULL -- late fees are charged in the home currency only
        GROUP BY t.txn_id ORDER BY t.due_date, t.txn_id`,
      [orgId, entityId, addDays(today, -policy.grace_days)]);
    let created = 0;
    for (const inv of invoices) {
      for (const date of feeDates(policy, inv.due_date, today, inv.charged)) {
        // A fee dated in the past (the job catching up) is worked out from what was still owed on that date.
        const { rows: [o] } = await tx.query(
          `SELECT t.total_cents - coalesce((SELECT sum(a.amount_cents) FROM application a WHERE a.charge_txn_id = t.txn_id AND a.applied_on <= $2), 0) AS open
             FROM txn t WHERE t.txn_id = $1`, [inv.txn_id, date]);
        if (Number(o.open) <= 0) continue;
        const amount = feeAmount(policy, policy.fee_kind === 'percent' ? Number(o.open) : inv.open_cents);
        if (amount <= 0) continue;
        const doc = await nextDocNumber(tx, orgId, entityId, 'late_fee');
        const description = `Late fee on invoice ${inv.doc_number}`;
        const { rows: [fee] } = await tx.query(
          `INSERT INTO txn (org_id, entity_id, customer_id, type, doc_number, txn_date, due_date, memo, total_cents, open_cents, source_txn_id)
           VALUES ($1,$2,$3,'late_fee',$4,$5,$5,$6,$7,$7,$8) RETURNING txn_id`,
          [orgId, entityId, inv.customer_id, doc, date, description, amount, inv.txn_id]);
        await tx.query(
          `INSERT INTO txn_line (org_id, txn_id, line_no, description, quantity, rate_cents, amount_cents) VALUES ($1,$2,1,$3,1,$4,$4)`,
          [orgId, fee.txn_id, description, amount]);
        await repost(tx, orgId, fee.txn_id);
        await tx.query('INSERT INTO late_fee_charge (org_id, source_txn_id, assessed_on, fee_txn_id) VALUES ($1,$2,$3,$4)',
          [orgId, inv.txn_id, date, fee.txn_id]);
        await logActivity(tx, { orgId, customerId: inv.customer_id, txnId: fee.txn_id, actor, kind: 'late_fee_assessed',
          summary: `Late fee ${doc} of ${formatCents(amount)} charged on invoice ${inv.doc_number}` });
        created++;
      }
    }
    return created;
  });
}
