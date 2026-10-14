import { withTransaction } from '../db.js';
import { assertNotReconciled } from './locks.js';
import { ValidationError, lockEntity, logActivity } from './writes.js';
import { repost, systemAccounts } from './ledger.js';
import { isIsoDate } from '../domain/dates.js';
import { formatCents, parseMoney } from '../domain/money.js';
import { TYPE_LABELS } from '../domain/status.js';

const fail = message => { throw new ValidationError(message); };

// Payments and sales receipts sitting in Undeposited Funds, oldest first.
export async function listUndeposited(db, { orgId, entityId }) {
  const sys = await systemAccounts(db, orgId, entityId);
  const { rows } = await db.query(
    `SELECT t.txn_id, t.type, t.txn_date, t.doc_number, t.payment_method, t.payment_ref, t.memo, t.customer_id, c.display_name AS customer_name,
            -- What actually reached Undeposited Funds (an online payment arrives less the processor's fee).
            CASE WHEN t.currency IS NOT NULL THEN round(t.foreign_total_cents * t.exchange_rate)::bigint ELSE t.total_cents END
              - t.fee_cents + t.surcharge_cents AS total_cents
       FROM txn t JOIN customer c ON c.customer_id = t.customer_id
      WHERE t.org_id = $1 AND t.entity_id = $2 AND t.voided_at IS NULL AND t.total_cents > 0
        AND t.type IN ('payment', 'sales_receipt') AND coalesce(t.account_id, $3) = $3
        AND (t.source IS NULL OR t.import_undeposited)
        AND NOT EXISTS (SELECT 1 FROM deposit_line d WHERE d.source_txn_id = t.txn_id)
      ORDER BY t.txn_date, t.txn_id`, [orgId, entityId, sys.undeposited]);
  return rows;
}

export async function listDeposits(db, { orgId, entityId, limit = 100 }) {
  const { rows } = await db.query(
    `SELECT t.txn_id, t.type, t.txn_date, t.memo, a.name AS account_name,
            CASE WHEN t.type = 'deposit' THEN t.total_cents
                 ELSE (SELECT coalesce(sum(p.amount_cents), 0) FROM posting p WHERE p.txn_id = t.txn_id AND p.account_id = t.account_id) END::bigint AS total_cents,
            CASE WHEN t.type = 'deposit' THEN (SELECT count(*)::int FROM deposit_line d WHERE d.deposit_txn_id = t.txn_id) ELSE 1 END AS line_count
       FROM txn t JOIN account a ON a.account_id = t.account_id
      WHERE t.org_id = $1 AND t.entity_id = $2 AND t.voided_at IS NULL
        -- a payment or sales receipt deposited straight to a bank account (Receive payment's "Deposit to") is its own deposit
        AND (t.type = 'deposit' OR (t.type IN ('payment', 'sales_receipt') AND a.type = 'bank'))
      ORDER BY t.txn_date DESC, t.txn_id DESC LIMIT $3`, [orgId, entityId, limit]);
  return rows;
}

export async function getDeposit(db, { orgId, entityId, txnId }) {
  const { rows: [d] } = await db.query(
    `SELECT t.*, a.name AS account_name, a.number AS account_number, cb.name AS cash_back_account_name
       FROM txn t JOIN account a ON a.account_id = t.account_id LEFT JOIN account cb ON cb.account_id = t.cash_back_account_id
      WHERE t.org_id = $1 AND t.entity_id = $2 AND t.txn_id = $3 AND t.type = 'deposit'`, [orgId, entityId, txnId]);
  if (!d) return null;
  const { rows: lines } = await db.query(
    `SELECT dl.*, s.type AS source_type, s.txn_date AS source_date, s.doc_number, s.payment_method, s.payment_ref,
            c.display_name AS customer_name, a.name AS account_name
       FROM deposit_line dl LEFT JOIN txn s ON s.txn_id = dl.source_txn_id
       LEFT JOIN customer c ON c.customer_id = dl.customer_id LEFT JOIN account a ON a.account_id = dl.account_id
      WHERE dl.org_id = $1 AND dl.deposit_txn_id = $2 ORDER BY dl.line_no`, [orgId, txnId]);
  return { ...d, lines };
}

const sourceLabel = s => `${TYPE_LABELS[s.type]}${s.doc_number ? ` ${s.doc_number}` : s.payment_ref ? ` (${s.payment_ref})` : ''}`;

// p: { accountId, txnDate, memo, sourceTxnIds: [..], otherLines: [{ accountId, customerId, description, amount (text) }],
//      cashBack: { accountId, memo, amount (text) } }
export async function saveDeposit(pool, args) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, args.orgId, args.entityId);
    return writeDeposit(tx, args);
  });
}

// The same inside the caller's transaction (the caller holds the entity lock).
export async function writeDeposit(tx, { orgId, entityId, actor, ...p }) {
  if (!isIsoDate(p.txnDate)) fail('Enter a valid deposit date.');
  const memo = String(p.memo ?? '').trim().slice(0, 1000) || null;
  const others = [];
  (p.otherLines ?? []).forEach((l, i) => {
    const blank = !l.accountId && !String(l.description ?? '').trim() && !String(l.amount ?? '').trim();
    if (blank) return;
    const amount = parseMoney(String(l.amount ?? '').trim());
    if (amount === null || amount <= 0) fail(`Other funds line ${i + 1}: enter an amount like 25.00.`);
    if (!l.accountId) fail(`Other funds line ${i + 1}: choose the account the money came from.`);
    others.push({ accountId: Number(l.accountId), customerId: l.customerId ? Number(l.customerId) : null,
      description: String(l.description ?? '').trim().slice(0, 300) || null, amount });
  });
  const ids = [...new Set((p.sourceTxnIds ?? []).map(Number).filter(Number.isSafeInteger))];
  if (!ids.length && !others.length) fail('Select at least one payment, or add other funds.');
  const bank = (await tx.query('SELECT name, type FROM account WHERE org_id = $1 AND entity_id = $2 AND account_id = $3 AND active',
    [orgId, entityId, p.accountId])).rows[0];
  if (!bank || bank.type !== 'bank') fail('Choose the bank account this deposit went into.');
  const waiting = new Map((await listUndeposited(tx, { orgId, entityId })).map(s => [s.txn_id, s]));
  const sources = ids.map(id => waiting.get(id) ?? fail('One of the selected payments is no longer waiting to be deposited. Reload and try again.'));
  for (const o of others) {
    const a = (await tx.query('SELECT type, system_key FROM account WHERE org_id = $1 AND entity_id = $2 AND account_id = $3 AND active',
      [orgId, entityId, o.accountId])).rows[0];
    if (!a || a.system_key === 'undeposited' || a.system_key === 'ar' || a.system_key === 'ap') {
      fail('Other funds must come from an account other than Undeposited Funds, A/R or A/P.');
    }
    if (o.customerId) {
      const c = await tx.query('SELECT 1 FROM customer WHERE org_id = $1 AND entity_id = $2 AND customer_id = $3', [orgId, entityId, o.customerId]);
      if (!c.rowCount) fail('Choose a valid customer.');
    }
  }
  const gross = sources.reduce((s, x) => s + x.total_cents, 0) + others.reduce((s, o) => s + o.amount, 0);
  // Cash back (stage F5): some of it kept as cash, into another account; the bank gets the rest.
  const cb = p.cashBack ?? {};
  let cashBack = 0, cashBackAccount = null;
  const cashBackMemo = String(cb.memo ?? '').trim().slice(0, 300) || null;
  if (String(cb.amount ?? '').trim()) {
    cashBack = parseMoney(String(cb.amount).trim());
    if (cashBack === null || cashBack < 0) fail('Cash back: enter an amount like 100.00.');
  }
  if (cashBack) {
    if (cashBack >= gross) fail(`Cash back must be less than the ${formatCents(gross)} being deposited.`);
    const a = cb.accountId ? (await tx.query('SELECT account_id, type, system_key FROM account WHERE org_id = $1 AND entity_id = $2 AND account_id = $3 AND active',
      [orgId, entityId, cb.accountId])).rows[0] : null;
    if (!a) fail('Cash back: choose the account the cash goes to.');
    if (['undeposited', 'ar', 'ap'].includes(a.system_key) || Number(a.account_id) === Number(p.accountId)) fail('Cash back can’t go to Undeposited Funds, A/R, A/P or the deposit’s own bank account.');
    cashBackAccount = Number(a.account_id);
  }
  const total = gross - cashBack;
  const { txn_id: txnId } = (await tx.query(
    `INSERT INTO txn (org_id, entity_id, type, txn_date, memo, total_cents, open_cents, account_id, cash_back_account_id, cash_back_cents, cash_back_memo)
     VALUES ($1,$2,'deposit',$3,$4,$5,0,$6,$7,$8,$9) RETURNING txn_id`,
    [orgId, entityId, p.txnDate, memo, total, p.accountId, cashBackAccount, cashBack, cashBack ? cashBackMemo : null])).rows[0];
  let n = 0;
  for (const s of sources) {
    await tx.query(`INSERT INTO deposit_line (org_id, deposit_txn_id, line_no, source_txn_id, customer_id, amount_cents) VALUES ($1,$2,$3,$4,$5,$6)`,
      [orgId, txnId, ++n, s.txn_id, s.customer_id, s.total_cents]);
  }
  for (const o of others) {
    await tx.query(
      `INSERT INTO deposit_line (org_id, deposit_txn_id, line_no, account_id, customer_id, description, amount_cents) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [orgId, txnId, ++n, o.accountId, o.customerId, o.description, o.amount]);
  }
  await repost(tx, orgId, txnId);
  for (const s of sources) {
    await logActivity(tx, { orgId, customerId: s.customer_id, txnId: s.txn_id, actor, kind: 'deposited',
      summary: `${sourceLabel(s)} for ${formatCents(s.total_cents)} deposited to ${bank.name} on ${p.txnDate}` });
  }
  return txnId;
}

// Removes a deposit; its payments go back to Undeposited Funds.
export async function deleteDeposit(pool, args) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, args.orgId, args.entityId);
    return deleteDepositTx(tx, args);
  });
}

// The same inside the caller's transaction (the caller holds the entity lock).
export async function deleteDepositTx(tx, { orgId, entityId, txnId, actor, override = false }) {
  await assertNotReconciled(tx, { orgId, txnId, override });
  const d = await getDeposit(tx, { orgId, entityId, txnId }) ?? fail('Deposit not found.');
  await tx.query('DELETE FROM txn WHERE org_id = $1 AND txn_id = $2', [orgId, txnId]);
  for (const l of d.lines.filter(x => x.source_txn_id)) {
    await logActivity(tx, { orgId, customerId: l.customer_id, txnId: l.source_txn_id, actor, kind: 'deposit_removed',
      summary: `${sourceLabel({ type: l.source_type, doc_number: l.doc_number, payment_ref: l.payment_ref })} taken out of the ${d.txn_date} deposit to ${d.account_name}; back in Undeposited Funds` });
  }
  return d;
}
