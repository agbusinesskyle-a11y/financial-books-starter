import { TYPE_LABELS } from '../domain/status.js';

// Forms, stage F2: what QBO's More menu shows for any saved transaction — its transaction journal (the postings it made)
// and its audit history (every change to it, by whom).

// One transaction of this company, any type, with its party.
export async function anyTxn(db, { orgId, entityId, txnId }) {
  const { rows: [t] } = await db.query(`
    SELECT t.*, coalesce(c.display_name, v.display_name) AS party, c.customer_id AS party_customer, v.vendor_id AS party_vendor
      FROM txn t LEFT JOIN customer c ON c.customer_id = t.customer_id LEFT JOIN vendor v ON v.vendor_id = t.vendor_id
     WHERE t.org_id = $1 AND t.entity_id = $2 AND t.txn_id = $3`, [orgId, entityId, Number(txnId) || 0]);
  return t ?? null;
}

// Where a transaction's own page is.
export function txnHref(t) {
  if (['invoice', 'payment', 'sales_receipt', 'credit_memo', 'late_fee', 'estimate'].includes(t.type)) return `/txns/${t.txn_id}`;
  if (t.type === 'deposit') return `/deposits/${t.txn_id}`;
  if (['journal_entry', 'transfer', 'cc_payment', 'fx_revaluation', 'inventory_adjustment'].includes(t.type)) return `/ledger/${t.txn_id}`;
  return `/vtxns/${t.txn_id}`;
}
export const txnTitle = t => `${TYPE_LABELS[t.type] ?? t.type}${t.doc_number ? ` ${t.doc_number}` : t.payment_ref ? ` ${t.payment_ref}` : ''}`;

// Its postings: debit and credit per account line, with name, class and location.
export async function transactionJournal(db, { orgId, txnId }) {
  const { rows } = await db.query(`
    SELECT p.posting_id, p.line_no, a.account_id, a.name AS account, a.number, p.amount_cents, p.memo, coalesce(c.display_name, v.display_name) AS name,
           cl.name AS class_name, lo.name AS location_name
      FROM posting p JOIN account a ON a.account_id = p.account_id
      LEFT JOIN customer c ON c.customer_id = p.customer_id LEFT JOIN vendor v ON v.vendor_id = p.vendor_id
      LEFT JOIN class cl ON cl.class_id = p.class_id LEFT JOIN location lo ON lo.location_id = p.location_id
     WHERE p.org_id = $1 AND p.txn_id = $2
     ORDER BY CASE WHEN p.amount_cents > 0 THEN 0 ELSE 1 END, p.line_no NULLS FIRST, p.posting_id`, [orgId, txnId]);
  const debits = rows.filter(r => r.amount_cents > 0).reduce((s, r) => s + Number(r.amount_cents), 0);
  const credits = -rows.filter(r => r.amount_cents < 0).reduce((s, r) => s + Number(r.amount_cents), 0);
  return { rows, debits, credits };
}

const SKIP = new Set(['updated_at', 'created_at', 'open_cents', 'foreign_open_cents', 'org_id', 'entity_id', 'txn_id']);
// Every change to it: the transaction itself, and its applications, attachments and tags.
export async function transactionHistory(db, { orgId, txnId }) {
  const id = String(Number(txnId));
  const { rows } = await db.query(`
    SELECT audit_id, at, actor, action, table_name, before, after FROM audit_log
     WHERE org_id = $1 AND ((table_name = 'txn' AND row_id = $2::bigint)
        OR (table_name IN ('application', 'document', 'txn_tag', 'deposit_line') AND (coalesce(after, before) ->> 'txn_id' = $2::text OR coalesce(after, before) ->> 'credit_txn_id' = $2::text
            OR coalesce(after, before) ->> 'charge_txn_id' = $2::text OR coalesce(after, before) ->> 'deposit_txn_id' = $2::text)))
     ORDER BY at DESC, audit_id DESC LIMIT 500`, [orgId, id]);
  const what = { txn: 'Transaction', application: 'Payment applied', document: 'Attachment', txn_tag: 'Tag', deposit_line: 'Deposit line' };
  return rows.map(r => {
    const changes = r.action === 'update'
      ? Object.keys(r.after ?? {}).filter(k => !SKIP.has(k)).map(k => ({ field: k.replace(/_cents$/, '').replace(/_id$/, '').replaceAll('_', ' '), from: r.before?.[k], to: r.after?.[k], money: k.endsWith('_cents') }))
      : [];
    return { at: r.at, actor: r.actor, action: r.action, thing: what[r.table_name] ?? r.table_name, changes,
      amount: r.table_name === 'application' ? Number((r.after ?? r.before)?.amount_cents ?? 0) : null, filename: r.table_name === 'document' ? (r.after ?? r.before)?.filename : null };
  });
}
