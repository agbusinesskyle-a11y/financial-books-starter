import { formId } from '../domain/ids.js';
import { withTransaction } from '../db.js';
import { isIsoDate, addDays } from '../domain/dates.js';
import { formatCents, parseMoney } from '../domain/money.js';
import { parseQuantity, lineAmount, quantityToSql } from '../domain/lines.js';
import { TYPE_LABELS } from '../domain/status.js';
import { repost, systemAccounts } from './ledger.js';
import { withInventoryReplay } from './inventory.js';
import { getSalesSettings } from './sales-settings.js';
import { assertNotReconciled } from './locks.js';
import { resolveRate, revalueCredit, setPartyCurrency } from './currencies.js';
import { allocate, toHome, formatMoney, homeShare } from '../domain/fx.js';
import { getAccountingSettings, applyTxnDimensions, checkLineClasses } from './accounting.js';

// Every write: one transaction, the entity row locked (serializes numbering and balances),
// all checks inside the transaction, and an activity_event alongside the change.

export class ValidationError extends Error {}
const fail = message => { throw new ValidationError(message); };

const SALES_TYPES = ['invoice', 'sales_receipt', 'credit_memo', 'estimate'];
const CHARGE_TYPES = ['invoice', 'late_fee'];
const CREDIT_TYPES = ['payment', 'credit_memo'];
const CUSTOMER_TYPES = ['invoice', 'payment', 'sales_receipt', 'credit_memo', 'late_fee', 'estimate'];
const PREFIX = { invoice: 'INV', sales_receipt: 'SR', credit_memo: 'CM', late_fee: 'LF', purchase_order: 'PO', estimate: 'EST', journal_entry: 'JE' };
const label = t => `${TYPE_LABELS[t.type]}${t.doc_number ? ` ${t.doc_number}` : t.payment_ref ? ` (${t.payment_ref})` : ''}`;

export async function lockEntity(tx, orgId, entityId) {
  const { rowCount } = await tx.query('SELECT 1 FROM entity WHERE org_id = $1 AND entity_id = $2 FOR UPDATE', [orgId, entityId]);
  if (!rowCount) fail('Company not found.');
}

async function loadCustomer(tx, orgId, entityId, customerId) {
  const { rows } = await tx.query(
    `SELECT c.customer_id, c.display_name, c.email, c.terms_id, c.currency, tm.due_days
       FROM customer c LEFT JOIN terms tm ON tm.org_id = c.org_id AND tm.terms_id = c.terms_id
      WHERE c.org_id = $1 AND c.entity_id = $2 AND c.customer_id = $3`, [orgId, entityId, customerId]);
  return rows[0] ?? fail('Customer not found.');
}

async function loadTxn(tx, orgId, txnId) {
  const { rows } = await tx.query('SELECT * FROM txn WHERE org_id = $1 AND txn_id = $2 FOR UPDATE', [orgId, txnId]);
  return rows[0] ?? fail('Transaction not found.');
}

async function appliedTotal(tx, txnId) {
  const { rows } = await tx.query(
    'SELECT coalesce(sum(amount_cents), 0)::bigint AS n FROM application WHERE credit_txn_id = $1 OR charge_txn_id = $1', [txnId]);
  return rows[0].n;
}

export async function nextDocNumber(tx, orgId, entityId, type) {
  const prefix = PREFIX[type];
  const { rows } = await tx.query(
    `SELECT coalesce(max(substring(doc_number FROM '^${prefix}-(\\d+)$')::bigint), 0) AS n,
            (SELECT next_invoice_number FROM sales_settings WHERE org_id = $1 AND entity_id = $2) AS start
       FROM txn WHERE org_id = $1 AND entity_id = $2 AND type = $3`, [orgId, entityId, type]);
  // Settings → Sales can set where invoice numbers continue from.
  const next = Math.max(Number(rows[0].n) + 1, type === 'invoice' ? Number(rows[0].start ?? 0) : 0);
  return `${prefix}-${String(next).padStart(4, '0')}`;
}

// One history line, on a customer's or a vendor's Activity tab (pass exactly one of customerId / vendorId).
export async function logActivity(tx, { orgId, customerId = null, vendorId = null, txnId = null, kind, summary, actor, data = {} }) {
  await tx.query(
    'INSERT INTO activity_event (org_id, customer_id, vendor_id, txn_id, kind, summary, actor, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [orgId, customerId, vendorId, txnId, kind, summary, actor, data]);
}

// The deposit a payment or sales receipt has been banked in, if any.
export async function depositOf(tx, orgId, txnId) {
  const { rows } = await tx.query(
    `SELECT d.txn_id, d.txn_date, a.name AS account_name FROM deposit_line dl JOIN txn d ON d.txn_id = dl.deposit_txn_id
       JOIN account a ON a.account_id = d.account_id WHERE dl.org_id = $1 AND dl.source_txn_id = $2`, [orgId, txnId]);
  return rows[0] ?? null;
}
const depositedMessage = (what, d) => `${what} is in the ${d.txn_date} deposit to ${d.account_name}. Remove it from that deposit first.`;

// Where a sales receipt's money goes: Undeposited Funds (default) or a bank account.
async function depositToAccount(tx, orgId, entityId, accountId) {
  const sys = await systemAccounts(tx, orgId, entityId);
  if (!accountId) return sys.undeposited;
  const { rows } = await tx.query('SELECT type, system_key FROM account WHERE org_id = $1 AND entity_id = $2 AND account_id = $3 AND active',
    [orgId, entityId, accountId]);
  if (!rows.length || !(rows[0].type === 'bank' || rows[0].system_key === 'undeposited')) fail('Deposit to Undeposited Funds or a bank account.');
  return accountId;
}

function uniqueViolation(error, message) {
  if (error?.code === '23505') throw new ValidationError(message);
  throw error;
}

// Form line rows -> validated lines. Blank rows are ignored. Each row: { itemId, description, quantity, rate }.
export function parseLines(rows, itemsById) {
  const out = [];
  rows.forEach((row, i) => {
    const n = i + 1;
    // Subtotal and text lines (stage F3): shown, never posted.
    if (row.kind === 'subtotal' || row.kind === 'text') {
      const description = String(row.description ?? '').trim().slice(0, 500) || (row.kind === 'subtotal' ? 'Subtotal' : '');
      if (!description) return; // an empty text line is dropped
      out.push({ kind: row.kind, itemId: null, description, qty: parseQuantity('1'), rateCents: 0, amountCents: 0, serviceDate: null, estimateLineNo: null,
        billableTxnId: null, billableLineNo: null, classId: null, timeEntryId: null });
      return;
    }
    const blank = !row.itemId && !String(row.description ?? '').trim() && !String(row.quantity ?? '').trim() && !String(row.rate ?? '').trim();
    if (blank) return;
    const itemId = row.itemId ? Number(row.itemId) : null;
    if (itemId !== null && !itemsById.has(itemId)) fail(`Line ${n}: choose a product or service from the list.`);
    const qty = parseQuantity(String(row.quantity ?? '').trim() || '1');
    if (qty === null) fail(`Line ${n}: quantity must be a number greater than 0 (up to 4 decimals).`);
    const rateText = String(row.rate ?? '').trim();
    const rate = rateText === '' && itemId !== null ? (itemsById.get(itemId).rule_rate_cents ?? itemsById.get(itemId).rate_cents) : parseMoney(rateText);
    if (rate === null) fail(`Line ${n}: rate must be an amount like 12.50.`);
    const description = String(row.description ?? '').trim() || (itemId !== null ? itemsById.get(itemId).name : '');
    if (!description) fail(`Line ${n}: add a product/service or a description.`);
    const serviceDate = String(row.serviceDate ?? '').trim() || null;
    if (serviceDate && !isIsoDate(serviceDate)) fail(`Line ${n}: the service date isn’t a valid date.`);
    const estimateLineNo = /^\d{1,4}$/.test(String(row.estimateLine ?? '')) ? Number(row.estimateLine) : null;
    const bill = /^(\d{1,18}):(\d{1,4})$/.exec(String(row.billable ?? ''));
    const classId = /^\d{1,18}$/.test(String(row.classId ?? '')) ? Number(row.classId) : null;
    const timeEntryId = /^\d{1,18}$/.test(String(row.timeEntry ?? '')) ? Number(row.timeEntry) : null;
    out.push({ kind: 'item', itemId, description: description.slice(0, 500), qty, rateCents: rate, amountCents: lineAmount(qty, rate), serviceDate, estimateLineNo,
      billableTxnId: bill ? Number(bill[1]) : null, billableLineNo: bill ? Number(bill[2]) : null, classId, timeEntryId });
  });
  if (!out.some(l => l.kind === 'item')) fail('Add at least one line.');
  // A subtotal at the very top sums nothing; drop subtotals that come before any product line.
  const firstItem = out.findIndex(l => l.kind === 'item');
  return out.filter((l, i) => !(l.kind === 'subtotal' && i < firstItem));
}

// Applications that use up `amountCents` on a customer's open invoices and late fees, oldest due first.
async function oldestCharges(tx, { orgId, customerId, amountCents, currency = null }) {
  const { rows } = await tx.query(
    `SELECT txn_id, ${currency ? 'foreign_open_cents' : 'open_cents'} AS open_cents FROM txn
      WHERE org_id = $1 AND customer_id = $2 AND type IN ('invoice', 'late_fee') AND voided_at IS NULL AND open_cents > 0 AND currency IS NOT DISTINCT FROM $3
      ORDER BY due_date, txn_date, txn_id`, [orgId, customerId, currency]);
  const out = [];
  let left = amountCents;
  for (const r of rows) {
    if (left <= 0) break;
    const amount = Math.min(left, Number(r.open_cents));
    out.push({ chargeTxnId: r.txn_id, amountCents: amount });
    left -= amount;
  }
  return out;
}

// Every billed cost line on an invoice must be a billable line for this customer that no other live invoice bills.
async function checkBillableLines(tx, { orgId, entityId, invoiceId, customerId }) {
  const { rows } = await tx.query(
    `SELECT b.line_no, c.billable, c.customer_id, t.voided_at, t.entity_id,
            EXISTS (SELECT 1 FROM txn_line o JOIN txn oi ON oi.txn_id = o.txn_id WHERE o.billable_txn_id = b.billable_txn_id AND o.billable_line_no = b.billable_line_no
                      AND o.txn_id <> b.txn_id AND oi.voided_at IS NULL) AS taken
       FROM txn_line b LEFT JOIN txn_line c ON c.txn_id = b.billable_txn_id AND c.line_no = b.billable_line_no LEFT JOIN txn t ON t.txn_id = c.txn_id
      WHERE b.txn_id = $1 AND b.billable_txn_id IS NOT NULL`, [invoiceId]);
  for (const r of rows) {
    if (!r.billable || r.customer_id !== customerId || r.voided_at || r.entity_id !== entityId) fail(`Line ${r.line_no}: that expense isn’t billable to this customer.`);
    if (r.taken) fail(`Line ${r.line_no}: that expense is already on another invoice.`);
  }
  const { rows: times } = await tx.query(
    `SELECT b.line_no, e.billable, e.customer_id, e.entity_id,
            EXISTS (SELECT 1 FROM txn_line o JOIN txn oi ON oi.txn_id = o.txn_id WHERE o.time_entry_id = b.time_entry_id AND o.txn_id <> b.txn_id AND oi.voided_at IS NULL) AS taken
       FROM txn_line b LEFT JOIN time_entry e ON e.entry_id = b.time_entry_id WHERE b.txn_id = $1 AND b.time_entry_id IS NOT NULL`, [invoiceId]);
  for (const r of times) {
    if (!r.billable || r.customer_id !== customerId || r.entity_id !== entityId) fail(`Line ${r.line_no}: that time isn’t billable to this customer.`);
    if (r.taken) fail(`Line ${r.line_no}: that time is already on another invoice.`);
  }
}

// ---- estimates ----

// How much of an estimate is on (non-voided) invoices.
// (A foreign-currency estimate and its invoices are compared in that currency.)
async function invoicedFromEstimate(tx, estimateId) {
  const { rows } = await tx.query(
    `SELECT coalesce(sum(coalesce(l.foreign_amount_cents, l.amount_cents)), 0)::bigint AS n FROM txn_line l JOIN txn i ON i.txn_id = l.txn_id
      WHERE l.estimate_txn_id = $1 AND i.voided_at IS NULL AND i.type = 'invoice'`, [estimateId]);
  return Number(rows[0].n);
}

// Recomputes what's left to invoice on an estimate and its status. No estimate line may be invoiced past its amount.
export async function refreshEstimate(tx, { orgId, estimateId }) {
  const { rows: [est] } = await tx.query(`SELECT * FROM txn WHERE org_id = $1 AND txn_id = $2 AND type = 'estimate' FOR UPDATE`, [orgId, estimateId]);
  if (!est) return;
  const { rows: over } = await tx.query(
    `SELECT e.line_no, coalesce(e.foreign_amount_cents, e.amount_cents) AS amount_cents, coalesce(sum(coalesce(l.foreign_amount_cents, l.amount_cents)), 0)::bigint AS invoiced
       FROM txn_line e LEFT JOIN txn_line l ON l.estimate_txn_id = e.txn_id AND l.estimate_line_no = e.line_no
         AND EXISTS (SELECT 1 FROM txn i WHERE i.txn_id = l.txn_id AND i.voided_at IS NULL AND i.type = 'invoice')
      WHERE e.txn_id = $1 GROUP BY e.line_no, coalesce(e.foreign_amount_cents, e.amount_cents)
     HAVING coalesce(sum(coalesce(l.foreign_amount_cents, l.amount_cents)), 0) > coalesce(e.foreign_amount_cents, e.amount_cents)`, [estimateId]);
  const fmt = c => formatMoney(c, est.currency ?? null);
  if (over.length) fail(`Line ${over[0].line_no} of estimate ${est.doc_number} would be invoiced for ${fmt(over[0].invoiced)}, more than its ${fmt(over[0].amount_cents)}.`);
  const invoiced = await invoicedFromEstimate(tx, estimateId);
  if (est.voided_at) return;
  const foreignOpen = est.currency ? Math.max(0, Number(est.foreign_total_cents) - invoiced) : null;
  if (est.currency) await tx.query('UPDATE txn SET foreign_open_cents = $2 WHERE txn_id = $1', [estimateId, foreignOpen]);
  const open = est.currency ? toHome(foreignOpen, est.exchange_rate) : Math.max(0, Number(est.total_cents) - invoiced);
  const status = open === 0 && invoiced > 0 ? 'closed'
    : invoiced > 0 && ['pending', 'closed'].includes(est.estimate_status) ? 'accepted' : est.estimate_status;
  await tx.query('UPDATE txn SET open_cents = $3, estimate_status = $4, updated_at = now() WHERE org_id = $1 AND txn_id = $2', [orgId, estimateId, open, status]);
}

// The deposit taken on an estimate: a payment into Undeposited Funds held as a credit, linked to the estimate, and applied
// to the first invoice made from it. deposit: { amountText, method }.
async function syncEstimateDeposit(tx, { orgId, entityId, estimateId, customerId, docNumber, txnDate, deposit, actor }) {
  const text = String(deposit.amountText ?? '').trim();
  const cents = text ? parseMoney(text) : 0;
  if (cents === null || cents < 0) fail('The deposit is an amount like 100.00.');
  const method = String(deposit.method ?? '').trim().slice(0, 50) || null;
  const { rows: [existing] } = await tx.query('SELECT * FROM txn WHERE org_id = $1 AND deposit_for_txn_id = $2 AND voided_at IS NULL FOR UPDATE', [orgId, estimateId]);
  if (existing && Number(existing.total_cents) === cents && (existing.payment_method ?? null) === method) return;
  if (existing) {
    if (await appliedTotal(tx, existing.txn_id) > 0) fail('The deposit on this estimate is already applied to an invoice. Change it from that payment instead.');
    const banked = await depositOf(tx, orgId, existing.txn_id);
    if (banked) fail(depositedMessage('The deposit on this estimate can’t change because it', banked));
    if (!cents) {
      await tx.query('DELETE FROM txn WHERE org_id = $1 AND txn_id = $2', [orgId, existing.txn_id]);
      await logActivity(tx, { orgId, customerId, txnId: estimateId, actor, kind: 'deposit_removed', summary: `Deposit on estimate ${docNumber} removed` });
      return;
    }
    await tx.query('UPDATE txn SET total_cents = $3, open_cents = $3, payment_method = $4, txn_date = $5, updated_at = now() WHERE org_id = $1 AND txn_id = $2',
      [orgId, existing.txn_id, cents, method, txnDate]);
    await repost(tx, orgId, existing.txn_id);
    return;
  }
  if (!cents) return;
  const { rows: [pay] } = await tx.query(
    `INSERT INTO txn (org_id, entity_id, customer_id, type, txn_date, memo, payment_method, total_cents, open_cents, deposit_for_txn_id)
     VALUES ($1,$2,$3,'payment',$4,$5,$6,$7,$7,$8) RETURNING txn_id`, [orgId, entityId, customerId, txnDate, `Deposit on estimate ${docNumber}`, method, cents, estimateId]);
  await repost(tx, orgId, pay.txn_id);
  await logActivity(tx, { orgId, customerId, txnId: pay.txn_id, actor, kind: 'payment_created', summary: `Deposit of ${formatCents(cents)} received on estimate ${docNumber}` });
}

// Applies what's left of an estimate's deposit to an invoice made from it.
async function applyEstimateDeposit(tx, { orgId, estimateId, invoiceId, appliedOn }) {
  const { rows: [pay] } = await tx.query(
    'SELECT * FROM txn WHERE org_id = $1 AND deposit_for_txn_id = $2 AND voided_at IS NULL AND open_cents > 0 FOR UPDATE', [orgId, estimateId]);
  if (!pay) return;
  const { rows: [inv] } = await tx.query('SELECT open_cents FROM txn WHERE org_id = $1 AND txn_id = $2', [orgId, invoiceId]);
  const amount = Math.min(Number(pay.open_cents), Number(inv.open_cents));
  if (amount <= 0) return;
  await applyFrom(tx, { orgId, credit: pay, applications: [{ chargeTxnId: invoiceId, amountCents: amount }], appliedOn });
  await tx.query('UPDATE txn SET open_cents = open_cents - $3 WHERE org_id = $1 AND txn_id = $2', [orgId, pay.txn_id, amount]);
}

// Accept / reject / close / reopen an estimate.
export async function setEstimateStatus(pool, { orgId, entityId, txnId, status, actor }) {
  if (!['pending', 'accepted', 'rejected', 'closed'].includes(status)) fail('Unknown estimate status.');
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const t = await loadTxn(tx, orgId, txnId);
    if (t.type !== 'estimate' || t.entity_id !== entityId) fail('Estimate not found.');
    if (t.voided_at) fail('This estimate is voided.');
    if (status === 'rejected' && t.open_cents < t.total_cents) fail('Part of this estimate is already invoiced, so it can’t be rejected. Close it instead.');
    await tx.query('UPDATE txn SET estimate_status = $3, updated_at = now() WHERE org_id = $1 AND txn_id = $2', [orgId, txnId, status]);
    const word = { pending: 'reopened', accepted: 'accepted', rejected: 'rejected', closed: 'closed' }[status];
    await logActivity(tx, { orgId, customerId: t.customer_id, txnId, actor, kind: `estimate_${word}`, summary: `Estimate ${t.doc_number} ${word}` });
  });
}

// ---- price rules ----

// Rules in force for a customer on a date (newest first).
export async function activeRules(db, { orgId, entityId, customerId = null, date }) {
  const { rows } = await db.query(
    `SELECT rule_id, name, kind, price_cents, percent_off::float8 AS percent_off, item_ids, customer_ids FROM price_rule
      WHERE org_id = $1 AND entity_id = $2 AND active AND (start_date IS NULL OR start_date <= $3) AND (end_date IS NULL OR end_date >= $3)
        AND (cardinality(customer_ids) = 0 OR $4::bigint = ANY(customer_ids))
      ORDER BY rule_id DESC`, [orgId, entityId, isIsoDate(date) ? date : '1970-01-01', customerId]);
  return rows;
}

// The rule price for one item, or null. The first matching rule (newest) wins.
export function rulePrice(rules, { itemId, rateCents }) {
  const r = rules.find(x => !x.item_ids.length || x.item_ids.map(Number).includes(Number(itemId)));
  if (!r) return null;
  const cents = r.kind === 'fixed' ? Number(r.price_cents) : Math.round(Number(rateCents) * (100 - r.percent_off) / 100);
  return { rateCents: cents, rule: r.name };
}

// Discount (percent or amount, taken off before tax) and shipping from the editor's text fields.
function parseExtras(p, subtotal) {
  let discountCents = 0, discountPercent = null, shippingCents = 0;
  const dText = String(p.discountValue ?? '').trim();
  if (dText) {
    if (p.discountKind === 'percent') {
      const pct = Number(dText.replace('%', ''));
      if (!/^\d{1,3}(\.\d{1,4})?%?$/.test(dText) || !(pct > 0 && pct <= 100)) fail('The discount percent is a number between 0 and 100, like 10.');
      discountPercent = pct;
      discountCents = Math.round(subtotal * pct / 100);
    } else {
      discountCents = parseMoney(dText);
      if (discountCents === null || discountCents < 0) fail('The discount is an amount like 25.00.');
    }
    if (discountCents > subtotal) fail('The discount can’t be more than the lines add up to.');
  }
  const sText = String(p.shipping ?? '').trim();
  if (sText) {
    shippingCents = parseMoney(sText);
    if (shippingCents === null || shippingCents < 0) fail('Shipping is an amount like 15.00.');
  }
  return { discountCents, discountPercent, shippingCents };
}

// The deposit taken on an invoice: a payment into Undeposited Funds, applied to the invoice and linked to it.
// deposit: { amountText, method } (amountText blank or 0 removes it). Caller holds the entity lock.
async function syncInvoiceDeposit(tx, { orgId, entityId, invoiceId, customerId, docNumber, txnDate, deposit, actor }) {
  const text = String(deposit.amountText ?? '').trim();
  const cents = text ? parseMoney(text) : 0;
  if (cents === null || cents < 0) fail('The deposit is an amount like 100.00.');
  const { rows: [existing] } = await tx.query('SELECT * FROM txn WHERE org_id = $1 AND deposit_for_txn_id = $2 AND voided_at IS NULL FOR UPDATE',
    [orgId, invoiceId]);
  const method = String(deposit.method ?? '').trim().slice(0, 50) || null;
  if (existing && Number(existing.total_cents) === cents && (existing.payment_method ?? null) === method) return;
  if (existing) {
    const banked = await depositOf(tx, orgId, existing.txn_id);
    if (banked) fail(depositedMessage('The deposit on this invoice can’t change because it', banked));
    await unapplyAll(tx, orgId, existing.txn_id);
    if (!cents) {
      await tx.query('DELETE FROM txn WHERE org_id = $1 AND txn_id = $2', [orgId, existing.txn_id]);
      await logActivity(tx, { orgId, customerId, txnId: invoiceId, actor, kind: 'deposit_removed', summary: `Deposit on invoice ${docNumber} removed` });
      return;
    }
  }
  if (!cents) return;
  const { rows: [inv] } = await tx.query('SELECT open_cents FROM txn WHERE org_id = $1 AND txn_id = $2', [orgId, invoiceId]);
  if (cents > Number(inv.open_cents)) fail(`The deposit can’t be more than the invoice’s open balance (${formatCents(inv.open_cents)}).`);
  let paymentId = existing?.txn_id;
  const memo = `Deposit on invoice ${docNumber}`;
  if (existing) {
    await tx.query('UPDATE txn SET total_cents = $3, open_cents = $3, payment_method = $4, txn_date = $5, memo = $6, updated_at = now() WHERE org_id = $1 AND txn_id = $2',
      [orgId, paymentId, cents, method, txnDate, memo]);
  } else {
    paymentId = (await tx.query(
      `INSERT INTO txn (org_id, entity_id, customer_id, type, txn_date, memo, payment_method, total_cents, open_cents, deposit_for_txn_id)
       VALUES ($1,$2,$3,'payment',$4,$5,$6,$7,$7,$8) RETURNING txn_id`, [orgId, entityId, customerId, txnDate, memo, method, cents, invoiceId])).rows[0].txn_id;
  }
  const { rows: [credit] } = await tx.query('SELECT * FROM txn WHERE org_id = $1 AND txn_id = $2', [orgId, paymentId]);
  await applyFrom(tx, { orgId, credit, applications: [{ chargeTxnId: invoiceId, amountCents: cents }], appliedOn: txnDate });
  await tx.query('UPDATE txn SET open_cents = 0 WHERE org_id = $1 AND txn_id = $2', [orgId, paymentId]);
  await repost(tx, orgId, paymentId);
  await logActivity(tx, { orgId, customerId, txnId: paymentId, actor, kind: existing ? 'payment_updated' : 'payment_created',
    summary: `Deposit of ${formatCents(cents)} ${existing ? 'changed' : 'received'} on invoice ${docNumber}` });
}

export async function saveSalesDoc(pool, p) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, p.orgId, p.entityId);
    return writeSalesDoc(tx, p);
  });
}

// The body of saveSalesDoc for callers that already hold the entity lock in their own transaction
// (recurring runs). p.recurringTemplateId links a created transaction to its template.
export async function writeSalesDoc(tx, p) {
  const { orgId, entityId, customerId, type, actor } = p;
  if (!SALES_TYPES.includes(type)) fail('Unknown transaction type.');
  if (!isIsoDate(p.txnDate)) fail('Enter a valid date.');
  {
    const items = await tx.query('SELECT item_id, name, rate_cents FROM item WHERE org_id = $1 AND entity_id = $2', [orgId, entityId]);
    const rules = await activeRules(tx, { orgId, entityId, customerId, date: p.txnDate });
    for (const i of items.rows) i.rule_rate_cents = rulePrice(rules, { itemId: i.item_id, customerId, rateCents: i.rate_cents })?.rateCents ?? null;
    const lines = parseLines(p.lines, new Map(items.rows.map(i => [i.item_id, i])));
    const subtotal = lines.reduce((s, l) => s + l.amountCents, 0);
    const settings = await getSalesSettings(tx, { orgId, entityId });
    const acct = await getAccountingSettings(tx, { orgId, entityId });
    await checkLineClasses(tx, { orgId, entityId, classIds: lines.map(l => l.classId) });
    let { discountCents, discountPercent, shippingCents } = type === 'credit_memo' || type === 'estimate'
      ? { discountCents: 0, discountPercent: null, shippingCents: 0 } : parseExtras(p, subtotal);
    let total = subtotal - discountCents + shippingCents;
    if (total <= 0) fail('The total must be more than $0.00.');
    const customer = await loadCustomer(tx, orgId, entityId, customerId);
    // A customer billed in another currency: everything typed is in their currency; the books get home amounts at the rate.
    const fx = customer.currency ? { code: customer.currency, foreignTotal: total } : null;
    if (fx) {
      const prior = p.txnId ? (await tx.query('SELECT exchange_rate FROM txn WHERE org_id = $1 AND txn_id = $2', [orgId, p.txnId])).rows[0] : null;
      fx.rate = prior?.exchange_rate && !String(p.exchangeRate ?? '').trim() ? Number(prior.exchange_rate)
        : await resolveRate(tx, { orgId, entityId, code: fx.code, date: p.txnDate, typed: p.exchangeRate });
      if (p.deposit && String(p.deposit.amountText ?? '').trim()) fail('Deposits on foreign-currency invoices and estimates aren’t supported yet. Record a payment instead.');
      if (lines.some(l => l.billableTxnId || l.timeEntryId)) fail('Billable time and expenses can’t go on a foreign-currency invoice yet. Add them as ordinary lines in the customer’s currency.');
      const parts = allocate([...lines.map(l => l.amountCents), -discountCents, shippingCents], fx.rate);
      lines.forEach((l, i) => { l.foreignAmount = l.amountCents; l.foreignRate = l.rateCents; l.amountCents = parts.lines[i]; l.rateCents = Math.round(l.rateCents * fx.rate); });
      fx.discount = discountCents;
      fx.shipping = shippingCents;
      discountCents = -parts.lines[lines.length];
      shippingCents = parts.lines[lines.length + 1];
      total = parts.total;
    }

    // Terms: chosen on the invoice, else the customer's, else the company default (Settings → Sales).
    let dueDate = null, termsId = p.termsId ?? customer.terms_id ?? settings.defaultTermsId ?? null, termsDays = 0;
    if (termsId) {
      const t = await tx.query('SELECT due_days FROM terms WHERE org_id = $1 AND terms_id = $2 AND entity_id = $3', [orgId, termsId, entityId]);
      if (!t.rowCount) fail('Choose valid terms.');
      termsDays = t.rows[0].due_days;
    }
    if (type !== 'invoice') termsId = null;
    const estimateId = type === 'invoice' ? (p.estimateId ?? null) : null;
    if (type === 'estimate') {
      if (p.dueDate && !isIsoDate(p.dueDate)) fail('Enter a valid expiration date.');
      if (p.dueDate && p.dueDate < p.txnDate) fail('The expiration date can’t be before the estimate date.');
      dueDate = p.dueDate || null;
    } else if (type === 'invoice') {
      if (p.dueDate) {
        if (!isIsoDate(p.dueDate)) fail('Enter a valid due date.');
        if (p.dueDate < p.txnDate) fail('The due date can’t be before the invoice date.');
        dueDate = p.dueDate;
      } else dueDate = addDays(p.txnDate, termsDays);
    }

    let txnId = p.txnId ?? null, applied = 0, existing = null, existingEstimates = null;
    if (txnId) {
      existing = await loadTxn(tx, orgId, txnId);
      if (existing.type !== type || existing.entity_id !== entityId) fail('Transaction not found.');
      await assertNotReconciled(tx, { orgId, txnId, override: p.editReconciled });
      if (existing.voided_at) fail('This transaction is voided and can’t be changed.');
      // An opening balance is credited to Opening Balance Equity, not a sales line; the invoice editor would rebuild it
      // as sales. Delete it and set the balance again instead (as for a vendor's opening balance).
      if (existing.system_kind === 'opening_balance') fail('An opening balance can’t be edited as an invoice. Delete it and enter the balance again, or use a journal entry.');
      if (existing.customer_id !== customer.customer_id) fail('The customer on an existing transaction can’t be changed.');
      applied = type === 'estimate' ? await invoicedFromEstimate(tx, txnId) : await appliedTotal(tx, txnId);
      if (type === 'estimate' && !fx && total < applied) fail(`${formatCents(applied)} of this estimate is already invoiced; the total can’t go below that.`);
      if (type !== 'estimate' && total < applied) fail(`${formatCents(applied)} is already applied to this ${TYPE_LABELS[type].toLowerCase()}; the total can’t go below that.`);
    }
    const accountId = type === 'sales_receipt' ? await depositToAccount(tx, orgId, entityId, p.depositToId ?? null) : null;
    if (existing && type === 'sales_receipt') {
      const d = await depositOf(tx, orgId, txnId);
      if (d && p.txnDate > d.txn_date) fail(depositedMessage(`This sales receipt can’t be dated after its deposit (${d.txn_date}) because it`, d));
      if (d && (total !== existing.total_cents || accountId !== (existing.account_id ?? (await systemAccounts(tx, orgId, entityId)).undeposited))) {
        fail(depositedMessage(`This sales receipt’s amount and deposit account can’t change because it`, d));
      }
    }
    const projectId = p.projectId ?? null;
    if (projectId !== null) {
      const pr = await tx.query('SELECT 1 FROM project WHERE org_id = $1 AND project_id = $2 AND customer_id = $3', [orgId, projectId, customer.customer_id]);
      if (!pr.rowCount) fail('Choose one of this customer’s projects, or none.');
    }
    const open = type === 'sales_receipt' ? 0 : total - applied;
    const foreignApplied = fx && existing
      ? (type === 'estimate' ? await invoicedFromEstimate(tx, txnId)
        : Number((await tx.query(`SELECT coalesce(sum(foreign_cents), 0)::bigint AS n FROM application WHERE ${type === 'credit_memo' ? 'credit_txn_id' : 'charge_txn_id'} = $1`,
          [txnId])).rows[0].n)) : 0;
    if (fx && fx.foreignTotal < foreignApplied) fail(`${formatMoney(foreignApplied, fx.code)} is already ${type === 'estimate' ? 'invoiced' : 'applied'}; the total can’t go below that.`);
    // Payments were matched at this rate; changing it would leave a balance nobody can pay.
    if (fx && existing && foreignApplied > 0 && type !== 'estimate' && Number(existing.exchange_rate) !== fx.rate) {
      fail('Payments or credits are already applied at this exchange rate, so the rate can’t change. Remove them first.');
    }
    if (estimateId) {
      const { rows: [est] } = await tx.query(`SELECT customer_id, voided_at, estimate_status FROM txn WHERE org_id = $1 AND txn_id = $2 AND type = 'estimate' FOR UPDATE`,
        [orgId, estimateId]);
      if (!est || est.customer_id !== customer.customer_id) fail('That estimate belongs to a different customer.');
      if (est.voided_at || est.estimate_status === 'rejected') fail('A voided or rejected estimate can’t be invoiced.');
    }
    // With custom numbers off (Settings → Sales), new documents always take the next number.
    const typed = settings.customNumbers || existing ? String(p.docNumber ?? '').trim().slice(0, 30) : '';
    const docNumber = typed || (existing?.doc_number ?? await nextDocNumber(tx, orgId, entityId, type));
    const memo = String(p.memo ?? '').trim().slice(0, 1000) || null;
    const method = type === 'sales_receipt' ? (String(p.paymentMethod ?? '').trim().slice(0, 50) || null) : null;
    const ref = type === 'sales_receipt' ? (String(p.paymentRef ?? '').trim().slice(0, 50) || null) : null;

    try {
      if (txnId) {
        await tx.query(
          `UPDATE txn SET doc_number = $3, txn_date = $4, due_date = $5, memo = $6, payment_method = $7, payment_ref = $8,
                  total_cents = $9, open_cents = $10, project_id = $11, account_id = $12, terms_id = $13, discount_cents = $14,
                  discount_percent = $15, shipping_cents = $16, currency = $17, exchange_rate = $18, foreign_total_cents = $19, foreign_open_cents = $20,
                  updated_at = now() WHERE org_id = $1 AND txn_id = $2`,
          [orgId, txnId, docNumber, p.txnDate, dueDate, memo, method, ref, total, open, projectId, accountId, termsId, discountCents,
            discountPercent, shippingCents, fx?.code ?? null, fx?.rate ?? null, fx?.foreignTotal ?? null,
            fx ? (type === 'sales_receipt' ? 0 : fx.foreignTotal - foreignApplied) : null]);
        // Moved later than a payment or credit already applied to it: the trigger (migration 028) re-dates those
        // applications so none is dated before the invoice (aging and cash basis stay right).
        await tx.query('UPDATE application SET applied_on = applied_on WHERE charge_txn_id = $1 OR credit_txn_id = $1', [txnId]);
        existingEstimates = (await tx.query('SELECT DISTINCT estimate_txn_id AS id FROM txn_line WHERE org_id = $1 AND txn_id = $2 AND estimate_txn_id IS NOT NULL',
          [orgId, txnId])).rows.map(r => r.id);
        await tx.query('DELETE FROM txn_line WHERE org_id = $1 AND txn_id = $2', [orgId, txnId]);
      } else {
        txnId = (await tx.query(
          `INSERT INTO txn (org_id, entity_id, customer_id, type, doc_number, txn_date, due_date, memo, payment_method, payment_ref, total_cents, open_cents,
             recurring_template_id, project_id, account_id, terms_id, discount_cents, discount_percent, shipping_cents, estimate_status,
             currency, exchange_rate, foreign_total_cents, foreign_open_cents)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING txn_id`,
          [orgId, entityId, customer.customer_id, type, docNumber, p.txnDate, dueDate, memo, method, ref, total, open, p.recurringTemplateId ?? null,
            projectId, accountId, termsId, discountCents, discountPercent, shippingCents, type === 'estimate' ? 'pending' : null,
            fx?.code ?? null, fx?.rate ?? null, fx?.foreignTotal ?? null, fx ? (type === 'sales_receipt' ? 0 : fx.foreignTotal) : null])).rows[0].txn_id;
      }
    } catch (error) { uniqueViolation(error, `${TYPE_LABELS[type]} number ${docNumber} is already used.`); }

    for (const [i, l] of lines.entries()) {
      await tx.query(
        `INSERT INTO txn_line (org_id, txn_id, line_no, item_id, description, quantity, rate_cents, amount_cents, service_date, estimate_txn_id, estimate_line_no,
           class_id, billable_txn_id, billable_line_no, account_id, time_entry_id, foreign_amount_cents, foreign_rate_cents, kind)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [orgId, txnId, i + 1, l.itemId, l.description, quantityToSql(l.qty), l.rateCents, l.amountCents, l.serviceDate ?? null,
          estimateId && l.estimateLineNo ? estimateId : null, estimateId && l.estimateLineNo ? l.estimateLineNo : null,
          l.classId ?? null, type === 'invoice' ? l.billableTxnId : null, type === 'invoice' ? l.billableLineNo : null,
          type === 'invoice' && l.billableTxnId ? acct.billableIncomeAccountId : null, type === 'invoice' ? l.timeEntryId : null,
          l.kind === 'item' || !l.kind ? (l.foreignAmount ?? null) : null, l.kind === 'item' || !l.kind ? (l.foreignRate ?? null) : null, l.kind ?? 'item']);
    }
    if (type === 'invoice') await checkBillableLines(tx, { orgId, entityId, invoiceId: txnId, customerId: customer.customer_id });
    await applyTxnDimensions(tx, { orgId, entityId, txnId, dims: p.dims ?? {} });
    if (p.extras) await saveSalesExtras(tx, { orgId, txnId, type, extras: p.extras });
    await tx.query('UPDATE txn SET foreign_discount_cents = $2, foreign_shipping_cents = $3 WHERE txn_id = $1', [txnId, fx?.discount ?? null, fx?.shipping ?? null]);
    // Estimates this invoice draws on (now or before an edit) get their invoiced amount and status recomputed.
    for (const est of new Set([...(existingEstimates ?? []), ...(estimateId ? [estimateId] : []), ...(type === 'estimate' && existing ? [txnId] : [])])) {
      await refreshEstimate(tx, { orgId, estimateId: est, customerId: customer.customer_id });
    }
    if (estimateId) await applyEstimateDeposit(tx, { orgId, estimateId, invoiceId: txnId, appliedOn: p.txnDate });
    if (type === 'credit_memo' && !existing && acct.autoApplyCustomer) {
      const credit = await loadTxn(tx, orgId, txnId);
      const { sum } = await applyFrom(tx, { orgId, credit,
        applications: await oldestCharges(tx, { orgId, customerId: customer.customer_id, amountCents: fx ? fx.foreignTotal : total, currency: fx?.code ?? null }),
        appliedOn: p.txnDate });
      if (sum && !fx) await tx.query('UPDATE txn SET open_cents = open_cents - $3 WHERE org_id = $1 AND txn_id = $2', [orgId, txnId, sum]);
    }
    if (type === 'credit_memo' && fx) await revalueCredit(tx, { orgId, txnId });
    if (type === 'estimate' && p.deposit !== undefined) {
      await syncEstimateDeposit(tx, { orgId, entityId, estimateId: txnId, customerId: customer.customer_id, docNumber, txnDate: p.txnDate, deposit: p.deposit, actor });
    }
    await repost(tx, orgId, txnId);
    if (type === 'invoice' && p.deposit !== undefined) {
      await syncInvoiceDeposit(tx, { orgId, entityId, invoiceId: txnId, customerId: customer.customer_id, docNumber, txnDate: p.txnDate, deposit: p.deposit, actor });
    }
    const noun = TYPE_LABELS[type];
    await logActivity(tx, {
      orgId, customerId: customer.customer_id, txnId, actor,
      kind: `${type}_${existing ? 'updated' : 'created'}`,
      summary: `${noun} ${docNumber} ${existing ? 'updated' : 'created'} for ${formatCents(total)}${p.activitySuffix ?? ''}`,
    });
    return txnId;
  }
}

// Validates and writes applications from one credit to charges. Caller holds the entity lock.
export async function applyFrom(tx, { orgId, credit, applications, appliedOn }) {
  let sum = 0;
  const done = [];
  for (const a of applications) {
    if (!Number.isSafeInteger(a.amountCents) || a.amountCents <= 0) continue;
    const charge = await loadTxn(tx, orgId, a.chargeTxnId);
    if (!CHARGE_TYPES.includes(charge.type)) fail('Payments and credits can only be applied to invoices and late fees.');
    if (charge.customer_id !== credit.customer_id) fail('That invoice belongs to a different customer.');
    if (charge.voided_at) fail(`${label(charge)} is voided.`);
    if ((charge.currency ?? null) !== (credit.currency ?? null)) fail(`${label(charge)} is in ${charge.currency ?? 'home currency'}; this is in ${credit.currency ?? 'home currency'}.`);
    if (charge.currency) {
      // Foreign: the typed amount is in the customer's currency; it takes the invoice's home amount at the invoice's rate.
      if (a.amountCents > Number(charge.foreign_open_cents)) fail(`${label(charge)} only has ${formatMoney(charge.foreign_open_cents, charge.currency)} open.`);
      const home = homeShare({ foreignTotal: charge.foreign_total_cents, foreignOpen: charge.foreign_open_cents, homeOpen: charge.open_cents, part: a.amountCents, rate: charge.exchange_rate });
      sum += a.amountCents;
      await tx.query(
        // Each application is its own dated row (dated no earlier than either side; the database enforces that too).
        'INSERT INTO application (org_id, credit_txn_id, charge_txn_id, amount_cents, applied_on, foreign_cents) VALUES ($1,$2,$3,$4,$5,$6)',
        [orgId, credit.txn_id, charge.txn_id, home, a.appliedOn ?? appliedOn, a.amountCents]);
      await tx.query('UPDATE txn SET open_cents = open_cents - $3, foreign_open_cents = foreign_open_cents - $4, updated_at = now() WHERE org_id = $1 AND txn_id = $2',
        [orgId, charge.txn_id, home, a.amountCents]);
      done.push(`${label(charge)} ${formatMoney(a.amountCents, charge.currency)}`);
      continue;
    }
    if (a.amountCents > charge.open_cents) fail(`${label(charge)} only has ${formatCents(charge.open_cents)} open.`);
    sum += a.amountCents;
    await tx.query(
      'INSERT INTO application (org_id, credit_txn_id, charge_txn_id, amount_cents, applied_on) VALUES ($1,$2,$3,$4,$5)',
      [orgId, credit.txn_id, charge.txn_id, a.amountCents, a.appliedOn ?? appliedOn]);
    await tx.query('UPDATE txn SET open_cents = open_cents - $3, updated_at = now() WHERE org_id = $1 AND txn_id = $2', [orgId, charge.txn_id, a.amountCents]);
    done.push(`${label(charge)} ${formatCents(a.amountCents)}`);
  }
  return { sum, done };
}

// Removes every application touching txnId, restoring the open amount on the other side.
export async function unapplyAll(tx, orgId, txnId) {
  const { rows } = await tx.query(
    'DELETE FROM application WHERE org_id = $1 AND (credit_txn_id = $2 OR charge_txn_id = $2) RETURNING credit_txn_id, charge_txn_id, amount_cents, foreign_cents',
    [orgId, txnId]);
  for (const a of rows) {
    if (a.credit_txn_id === txnId) {
      await tx.query('UPDATE txn SET open_cents = open_cents + $3, foreign_open_cents = foreign_open_cents + $4, updated_at = now() WHERE org_id = $1 AND txn_id = $2',
        [orgId, a.charge_txn_id, a.amount_cents, a.foreign_cents ?? 0]);
    } else {
      await tx.query('UPDATE txn SET open_cents = open_cents + $3, updated_at = now() WHERE org_id = $1 AND txn_id = $2', [orgId, a.credit_txn_id, a.amount_cents]);
      // A foreign payment or credit is worth its own rate again for what came back.
      await revalueCredit(tx, { orgId, txnId: a.credit_txn_id });
    }
  }
  return rows.length;
}

export async function savePayment(pool, p) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, p.orgId, p.entityId);
    return savePaymentTx(tx, p);
  });
}

// The same inside the caller's transaction (the caller holds the entity lock): a bank review settling invoices.
export async function savePaymentTx(tx, p) {
  const { orgId, entityId, customerId, actor } = p;
  if (!isIsoDate(p.txnDate)) fail('Enter a valid payment date.');
  if (!Number.isSafeInteger(p.amountCents) || p.amountCents <= 0) fail('Enter the amount received.');
  {
    const customer = await loadCustomer(tx, orgId, entityId, customerId);
    const method = String(p.paymentMethod ?? '').trim().slice(0, 50) || null;
    const ref = String(p.paymentRef ?? '').trim().slice(0, 50) || null;
    const memo = String(p.memo ?? '').trim().slice(0, 1000) || null;
    let txnId = p.txnId ?? null;
    // Deposit to: Undeposited Funds (stored as none) or a bank account.
    const sysAccounts = await systemAccounts(tx, orgId, entityId);
    const depositTo = await depositToAccount(tx, orgId, entityId, p.depositToId ?? null);
    const accountId = Number(depositTo) === Number(sysAccounts.undeposited) ? null : Number(depositTo);
    // A customer in another currency pays in it: amounts typed are theirs; the payment is worth its own rate.
    const code = customer.currency ?? null;
    let rate = null;
    if (code) {
      const prior = txnId ? (await tx.query('SELECT exchange_rate FROM txn WHERE org_id = $1 AND txn_id = $2', [orgId, txnId])).rows[0] : null;
      rate = prior?.exchange_rate && !String(p.exchangeRate ?? '').trim() ? Number(prior.exchange_rate)
        : await resolveRate(tx, { orgId, entityId, code, date: p.txnDate, typed: p.exchangeRate });
    }
    const home = code ? toHome(p.amountCents, rate) : p.amountCents;
    const priorParts = new Map();
    if (txnId) {
      const existing = await loadTxn(tx, orgId, txnId);
      if (existing.type !== 'payment' || existing.entity_id !== entityId) fail('Payment not found.');
      await assertNotReconciled(tx, { orgId, txnId, override: p.editReconciled });
      if (existing.voided_at) fail('This payment is voided and can’t be changed.');
      if (existing.customer_id !== customer.customer_id) fail('The customer on an existing payment can’t be changed.');
      const d = await depositOf(tx, orgId, txnId);
      if (d && p.txnDate > d.txn_date) fail(depositedMessage(`This payment can’t be dated after its deposit (${d.txn_date}) because it`, d));
      if (d && (p.amountCents !== Number(existing.foreign_total_cents ?? existing.total_cents) || (code && Number(existing.exchange_rate) !== rate))) {
        fail(depositedMessage('The amount and exchange rate can’t change because this payment', d));
      }
      if (d && accountId) fail(depositedMessage('This payment', d));
      // Remember how it was applied (each part with its own date) so an edit that doesn't change an invoice's applied
      // amount keeps those dates — cash basis and aging stay where they were.
      const { rows: before } = await tx.query(
        `SELECT charge_txn_id, applied_on::text AS d, coalesce(foreign_cents, amount_cents)::bigint AS amt FROM application WHERE credit_txn_id = $1
          ORDER BY applied_on, application_id`, [txnId]);
      for (const r of before) {
        if (!priorParts.has(Number(r.charge_txn_id))) priorParts.set(Number(r.charge_txn_id), []);
        priorParts.get(Number(r.charge_txn_id)).push({ date: r.d, amount: Number(r.amt) });
      }
      await unapplyAll(tx, orgId, txnId);
      await tx.query(
        `UPDATE txn SET txn_date = $3, payment_method = $4, payment_ref = $5, memo = $6, total_cents = $7, open_cents = $7, currency = $8, exchange_rate = $9,
                foreign_total_cents = $10, foreign_open_cents = $10, account_id = $11, updated_at = now()
          WHERE org_id = $1 AND txn_id = $2`, [orgId, txnId, p.txnDate, method, ref, memo, home, code, rate, code ? p.amountCents : null, accountId]);
    } else {
      txnId = (await tx.query(
        `INSERT INTO txn (org_id, entity_id, customer_id, type, txn_date, payment_method, payment_ref, memo, total_cents, open_cents, currency, exchange_rate,
           foreign_total_cents, foreign_open_cents, account_id)
         VALUES ($1,$2,$3,'payment',$4,$5,$6,$7,$8,$8,$9,$10,$11,$11,$12) RETURNING txn_id`,
        [orgId, entityId, customer.customer_id, p.txnDate, method, ref, memo, home, code, rate, code ? p.amountCents : null, accountId])).rows[0].txn_id;
    }
    await repost(tx, orgId, txnId);
    const credit = await loadTxn(tx, orgId, txnId);
    let applications = p.applications ?? [];
    // Settings → Accounting: a new payment nobody applied goes to the oldest open invoices.
    if (!p.txnId && !applications.length && (await getAccountingSettings(tx, { orgId, entityId })).autoApplyCustomer) {
      applications = await oldestCharges(tx, { orgId, customerId: customer.customer_id, amountCents: p.amountCents, currency: code });
    }
    // Split each application back into its earlier dated parts (oldest first); anything more is dated the payment date.
    if (priorParts.size) {
      applications = applications.flatMap(a => {
        let left = a.amountCents;
        const out = [];
        for (const part of priorParts.get(a.chargeTxnId) ?? []) {
          if (left <= 0) break;
          const take = Math.min(left, part.amount);
          out.push({ ...a, amountCents: take, appliedOn: part.date });
          left -= take;
        }
        if (left > 0) out.push({ ...a, amountCents: left });
        return out;
      });
    }
    const { sum, done } = await applyFrom(tx, { orgId, credit, applications, appliedOn: p.txnDate });
    const money = c => (code ? formatMoney(c, code) : formatCents(c));
    if (sum > p.amountCents) fail(`You applied ${money(sum)} but only received ${money(p.amountCents)}.`);
    if (code) await revalueCredit(tx, { orgId, txnId });
    else await tx.query('UPDATE txn SET open_cents = total_cents - $3 WHERE org_id = $1 AND txn_id = $2', [orgId, txnId, sum]);
    const unapplied = p.amountCents - sum;
    await logActivity(tx, {
      orgId, customerId: customer.customer_id, txnId, actor,
      kind: p.txnId ? 'payment_updated' : 'payment_received',
      summary: `Payment of ${money(p.amountCents)} ${p.txnId ? 'updated' : 'received'}${ref ? ` (${ref})` : ''}` +
        (done.length ? ` · applied to ${done.join(', ')}` : '') + (unapplied ? ` · ${money(unapplied)} unapplied` : ''),
    });
    return txnId;
  }
}

// Applies an existing payment's or credit memo's open amount to charges.
export async function applyCredit(pool, { orgId, entityId, creditTxnId, applications, appliedOn, actor }) {
  if (!isIsoDate(appliedOn)) fail('Invalid date.');
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const credit = await loadTxn(tx, orgId, creditTxnId);
    if (!CREDIT_TYPES.includes(credit.type) || credit.entity_id !== entityId) fail('Only payments and credit memos can be applied.');
    if (credit.voided_at) fail('This transaction is voided.');
    const { sum, done } = await applyFrom(tx, { orgId, credit, applications, appliedOn });
    if (sum === 0) fail('Enter an amount to apply.');
    if (credit.currency) {
      if (sum > Number(credit.foreign_open_cents)) fail(`Only ${formatMoney(credit.foreign_open_cents, credit.currency)} is available to apply.`);
      await revalueCredit(tx, { orgId, txnId: credit.txn_id });
    } else {
      if (sum > credit.open_cents) fail(`Only ${formatCents(credit.open_cents)} is available to apply.`);
      await tx.query('UPDATE txn SET open_cents = open_cents - $3, updated_at = now() WHERE org_id = $1 AND txn_id = $2', [orgId, credit.txn_id, sum]);
    }
    await logActivity(tx, { orgId, customerId: credit.customer_id, txnId: credit.txn_id, actor, kind: 'credit_applied',
      summary: `${label(credit)} applied to ${done.join(', ')}` });
  });
}

export async function voidTxn(pool, { orgId, entityId, txnId, actor, override = false }) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const t = await loadTxn(tx, orgId, txnId);
    await assertNotReconciled(tx, { orgId, txnId, override });
    if (t.entity_id !== entityId) fail('Transaction not found.');
    if (t.voided_at) fail('This transaction is already voided.');
    if (t.type === 'deposit') fail('Deposits are removed from the deposit page, not voided.');
    if (!CUSTOMER_TYPES.includes(t.type)) fail('Transaction not found.');
    const banked = await depositOf(tx, orgId, txnId);
    if (banked) fail(depositedMessage(`${label(t)}`, banked));
    const removed = await unapplyAll(tx, orgId, txnId);
    await tx.query(
      'UPDATE txn SET voided_at = now(), total_cents = 0, open_cents = 0, foreign_open_cents = CASE WHEN currency IS NULL THEN NULL ELSE 0 END, updated_at = now() WHERE org_id = $1 AND txn_id = $2', [orgId, txnId]);
    await repost(tx, orgId, txnId);
    for (const est of await estimatesOf(tx, txnId)) await refreshEstimate(tx, { orgId, estimateId: est });
    await logActivity(tx, { orgId, customerId: t.customer_id, txnId, actor, kind: 'txn_voided',
      summary: `${label(t)} voided (was ${formatCents(t.total_cents)})${removed ? ` · ${removed} application${removed === 1 ? '' : 's'} removed` : ''}` });
  });
}

export async function deleteTxn(pool, args) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, args.orgId, args.entityId);
    return deleteTxnTx(tx, args);
  });
}

// The same inside the caller's transaction (the caller holds the entity lock): a bank review's Undo.
export async function deleteTxnTx(tx, { orgId, entityId, txnId, actor, override = false }) {
  {
    const t = await loadTxn(tx, orgId, txnId);
    await assertNotReconciled(tx, { orgId, txnId, override });
    if (t.entity_id !== entityId) fail('Transaction not found.');
    if (t.type === 'deposit') fail('Deposits are removed from the deposit page.');
    if (!CUSTOMER_TYPES.includes(t.type)) fail('Transaction not found.');
    const banked = await depositOf(tx, orgId, txnId);
    if (banked) fail(depositedMessage(`${label(t)}`, banked));
    const fees = await tx.query('SELECT 1 FROM txn WHERE org_id = $1 AND source_txn_id = $2 LIMIT 1', [orgId, txnId]);
    if (fees.rowCount) fail(`${label(t)} has late fees charged on it. Delete those late fees first, or void it instead.`);
    // As in QBO: deleting a payment or credit reopens what it paid; deleting a paid invoice leaves its payments as credits.
    const removed = await unapplyAll(tx, orgId, txnId);
    await logActivity(tx, { orgId, customerId: t.customer_id, txnId: null, actor, kind: 'txn_deleted',
      summary: `${label(t)} for ${formatCents(t.total_cents)} deleted${removed ? ` · ${removed} application${removed === 1 ? '' : 's'} removed` : ''}`,
      data: { txn_id: t.txn_id, doc_number: t.doc_number } });
    const estimates = await estimatesOf(tx, txnId);
    await withInventoryReplay(tx, orgId, txnId, () => tx.query('DELETE FROM txn WHERE org_id = $1 AND txn_id = $2', [orgId, txnId]));
    for (const est of estimates) await refreshEstimate(tx, { orgId, estimateId: est });
    return t.customer_id;
  }
}

const estimatesOf = async (tx, txnId) =>
  (await tx.query('SELECT DISTINCT estimate_txn_id AS id FROM txn_line WHERE txn_id = $1 AND estimate_txn_id IS NOT NULL', [txnId])).rows.map(r => r.id);

export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DELIVERY = ['email', 'print', 'none'];

export async function saveCustomer(pool, { orgId, entityId, customerId = null, fields: f, actor, afterCreate = null }) {
  const creating = customerId === null;
  const text = (v, max) => String(v ?? '').trim().slice(0, max) || null;
  // Like QBO, the display name can be left blank and comes from the company or the person's name.
  const displayName = text(f.displayName, 100) ?? text(f.companyName, 100)
    ?? text([f.title, f.firstName, f.middleName, f.lastName, f.suffix].map(x => String(x ?? '').trim()).filter(Boolean).join(' '), 100);
  if (!displayName) fail('Enter a customer display name.');
  const more = customerMoreFields(f, text);
  const email = text(f.email, 200);
  if (email && !EMAIL.test(email)) fail('Enter a valid email address.');
  const address = prefix => {
    const a = { line1: text(f[`${prefix}Line1`], 200), city: text(f[`${prefix}City`], 100), state: text(f[`${prefix}State`], 50), postal: text(f[`${prefix}Postal`], 20) };
    return Object.values(a).some(Boolean) ? a : null;
  };
  const delivery = DELIVERY.includes(f.preferredDelivery) ? f.preferredDelivery : 'email';
  const termsId = formId(f.termsId, () => fail('One of the choices isn’t valid. Reload the page and try again.'));
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    if (termsId !== null) {
      const t = await tx.query('SELECT 1 FROM terms WHERE org_id = $1 AND terms_id = $2 AND entity_id = $3', [orgId, termsId, entityId]);
      if (!t.rowCount) fail('Choose valid terms.');
    }
    const sameAsBilling = f.shippingSameAsBilling === true;
    const values = [displayName, text(f.companyName, 100), email, text(f.phone, 40), text(f.mobile, 40), address('billing'),
      sameAsBilling ? null : address('shipping'), sameAsBilling, text(f.noteLine, 300), termsId, f.taxExempt === true,
      text(f.taxExemptReason, 200), text(f.preferredPaymentMethod, 50), delivery, f.lateFeesEnabled === true, f.active === true];
    try {
      if (customerId) {
        const { rowCount } = await tx.query(
          `UPDATE customer SET display_name = $3, company_name = $4, email = $5, phone = $6, mobile = $7, billing_address = $8,
              shipping_address = $9, shipping_same_as_billing = $10, note_line = $11, terms_id = $12, tax_exempt = $13,
              tax_exempt_reason = $14, preferred_payment_method = $15, preferred_delivery = $16, late_fees_enabled = $17, active = $18
            WHERE org_id = $1 AND customer_id = $2 AND entity_id = $19`, [orgId, customerId, ...values, entityId]);
        if (!rowCount) fail('Customer not found.');
      } else {
        customerId = (await tx.query(
          `INSERT INTO customer (org_id, entity_id, display_name, company_name, email, phone, mobile, billing_address, shipping_address,
              shipping_same_as_billing, note_line, terms_id, tax_exempt, tax_exempt_reason, preferred_payment_method, preferred_delivery,
              late_fees_enabled, active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING customer_id`,
          [orgId, entityId, ...values])).rows[0].customer_id;
      }
    } catch (error) { uniqueViolation(error, `A customer named “${displayName}” already exists.`); }
    if (more) await saveCustomerMore(tx, { orgId, entityId, customerId, more });
    // The currency is set before an opening balance is written (setting it after would be refused: it has a transaction).
    if (f.currency !== undefined) await setPartyCurrency(tx, { orgId, entityId, table: 'customer', id: customerId, code: f.currency });
    if (creating && afterCreate) await afterCreate(tx, customerId);
    if (f.sendReminders !== undefined) {
      await tx.query('UPDATE customer SET no_reminders = $3 WHERE org_id = $1 AND customer_id = $2', [orgId, customerId, f.sendReminders !== true]);
    }
    await logActivity(tx, { orgId, customerId, actor, kind: f.isNew ? 'customer_created' : 'customer_updated',
      summary: f.isNew ? `Customer ${displayName} created` : 'Customer details updated' });
    return customerId;
  });
}

// The rest of QBO's customer fields (stage C1). Only when the form sent them (older callers leave them alone).
const PREFERRED_CONTACT = ['email', 'phone', 'mobile', 'text', 'mail'];
function customerMoreFields(f, text) {
  if (f.firstName === undefined && f.creditLimit === undefined) return null;
  const emails = (v, label) => {
    const list = String(v ?? '').split(/[,;]/).map(x => x.trim()).filter(Boolean);
    if (list.length > 10) fail(`${label}: up to 10 addresses.`);
    for (const e of list) if (!EMAIL.test(e)) fail(`${label}: “${e}” isn’t a valid email address.`);
    return list.length ? list.join(', ') : null;
  };
  let website = text(f.website, 200);
  if (website && !/^https?:\/\//i.test(website)) website = `https://${website}`;
  if (website && !/^https?:\/\/[^\s/$.?#][^\s]*$/i.test(website)) fail('Enter a website like example.com.');
  const limitText = String(f.creditLimit ?? '').trim().replace(/[$,]/g, '');
  if (limitText && (!/^\d+(\.\d{1,2})?$/.test(limitText) || parseMoney(limitText) === null)) fail('Credit limit should be an amount like 5000.00.');
  const parent = /^\d{1,18}$/.test(String(f.parentCustomerId ?? '')) ? Number(f.parentCustomerId) : null;
  const social = (f.social ?? []).map(x => ({ network: text(x.network, 40), url: text(x.url, 300) })).filter(x => x.url).slice(0, 5);
  for (const x of social) if (!/^https?:\/\//i.test(x.url)) x.url = `https://${x.url}`;
  const addrs = (f.otherAddresses ?? []).map(a => ({ label: text(a.label, 60), line1: text(a.line1, 200), city: text(a.city, 100), state: text(a.state, 50), postal: text(a.postal, 20) }))
    .filter(a => a.line1 || a.city || a.postal).slice(0, 10);
  return {
    title: text(f.title, 20), first_name: text(f.firstName, 60), middle_name: text(f.middleName, 60), last_name: text(f.lastName, 60), suffix: text(f.suffix, 20),
    cc: emails(f.cc, 'Cc'), bcc: emails(f.bcc, 'Bcc'), fax: text(f.fax, 40), other_phone: text(f.otherPhone, 40), website, check_name: text(f.checkName, 100),
    parent_customer_id: parent, email_marketing: f.emailMarketing === true,
    credit_limit_cents: limitText ? parseMoney(limitText) : null, customer_type: text(f.customerType, 60),
    invoice_language: ['English', 'Spanish', 'French'].includes(f.invoiceLanguage) ? f.invoiceLanguage : 'English',
    source: text(f.source, 60), referred_by: text(f.referredBy, 100), job_title: text(f.jobTitle, 100), contact_role: text(f.contactRole, 60),
    preferred_contact: PREFERRED_CONTACT.includes(f.preferredContact) ? f.preferredContact : null, industry: text(f.industry, 60),
    social: JSON.stringify(social), other_addresses: JSON.stringify(addrs),
  };
}

async function saveCustomerMore(tx, { orgId, entityId, customerId, more }) {
  if (more.parent_customer_id !== null) {
    // A sub-customer's parent is another customer of this company, and never one of its own sub-customers.
    const { rows } = await tx.query(
      `WITH RECURSIVE up AS (SELECT customer_id, parent_customer_id, 1 AS depth FROM customer WHERE org_id = $1 AND entity_id = $2 AND customer_id = $3
         UNION ALL SELECT c.customer_id, c.parent_customer_id, up.depth + 1 FROM customer c JOIN up ON c.customer_id = up.parent_customer_id WHERE up.depth < 50)
       SELECT customer_id FROM up`, [orgId, entityId, more.parent_customer_id]);
    if (!rows.length) fail('Choose a parent customer from the list.');
    if (rows.some(r => r.customer_id === customerId)) fail('A customer can’t be under itself or one of its own sub-customers.');
  }
  const cols = Object.keys(more);
  await tx.query(`UPDATE customer SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')} WHERE org_id = $1 AND customer_id = $2`,
    [orgId, customerId, ...cols.map(c => more[c])]);
}

// A new customer's opening balance: an invoice dated as of the balance, credited to Opening Balance Equity.
export async function writeCustomerOpening(tx, { orgId, entityId, customerId, txnDate, cents, actor }) {
  if (!isIsoDate(txnDate)) fail('Enter the date the opening balance is as of.');
  if (!(cents > 0)) return null;
  const { rows: [c] } = await tx.query('SELECT currency FROM customer WHERE org_id = $1 AND customer_id = $2', [orgId, customerId]);
  if (c?.currency) fail(`For a customer billed in ${c.currency}, enter what they owe as an invoice in ${c.currency} instead of an opening balance.`);
  const sys = await systemAccounts(tx, orgId, entityId);
  const txnId = (await tx.query(
    `INSERT INTO txn (org_id, entity_id, customer_id, type, doc_number, txn_date, due_date, memo, total_cents, open_cents, system_kind)
     VALUES ($1, $2, $3, 'invoice', NULL, $4, $4, 'Opening balance', $5, $5, 'opening_balance') RETURNING txn_id`,
    [orgId, entityId, customerId, txnDate, cents])).rows[0].txn_id;
  await tx.query(`INSERT INTO txn_line (org_id, txn_id, line_no, description, quantity, rate_cents, amount_cents, account_id)
     VALUES ($1, $2, 1, 'Opening balance', 1, $3, $3, $4)`, [orgId, txnId, cents, sys.opening_equity]);
  await repost(tx, orgId, txnId);
  await logActivity(tx, { orgId, customerId, txnId, actor, kind: 'invoice_created', summary: `Opening balance of ${formatCents(cents)} as of ${txnDate}` });
  return txnId;
}

// Make customers active or inactive (QBO's Edit ▾ → Make inactive). An inactive customer with a balance is allowed,
// as in QBO, but stays visible in A/R.
export async function setCustomersActive(pool, { orgId, entityId, ids, active, actor }) {
  return withTransaction(pool, async tx => {
    // The company lock, as postings take it: a bank batch that checked this customer is active posts before it changes.
    await lockEntity(tx, orgId, entityId);
    const { rows } = await tx.query('UPDATE customer SET active = $4 WHERE org_id = $1 AND entity_id = $2 AND customer_id = ANY($3) AND active <> $4 RETURNING customer_id',
      [orgId, entityId, ids, active]);
    for (const r of rows) await logActivity(tx, { orgId, customerId: r.customer_id, actor, kind: 'customer_updated', summary: `Customer made ${active ? 'active' : 'inactive'}` });
    return rows.length;
  });
}

// Moves everything from `fromId` onto `intoId`, then deletes `fromId` (QBO's Merge contacts).
export async function mergeCustomers(pool, { orgId, entityId, fromId, intoId, actor }) {
  if (fromId === intoId) fail('Choose a different customer to merge into.');
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const both = (await tx.query('SELECT customer_id, display_name, currency FROM customer WHERE org_id = $1 AND entity_id = $2 AND customer_id = ANY($3) FOR UPDATE',
      [orgId, entityId, [fromId, intoId]])).rows;
    const from = both.find(c => c.customer_id === fromId) ?? fail('Customer not found.');
    const into = both.find(c => c.customer_id === intoId) ?? fail('Choose the customer to keep.');
    if ((from.currency ?? null) !== (into.currency ?? null)) fail('Both customers must use the same currency to be merged.');
    const clash = await tx.query(
      `SELECT a.name FROM recurring_template a JOIN recurring_template b ON b.name = a.name AND b.customer_id = $3
        WHERE a.org_id = $1 AND a.customer_id = $2 LIMIT 1`, [orgId, fromId, intoId]);
    if (clash.rowCount) fail(`Both customers have a recurring transaction named “${clash.rows[0].name}”. Rename or delete one first.`);
    const pclash = await tx.query(
      `SELECT a.name FROM project a JOIN project b ON lower(b.name) = lower(a.name) AND b.customer_id = $3 WHERE a.org_id = $1 AND a.customer_id = $2 LIMIT 1`,
      [orgId, fromId, intoId]);
    if (pclash.rowCount) fail(`Both customers have a project named “${pclash.rows[0].name}”. Rename one first.`);
    // Sub-customers of the one going away move under the one kept (never under itself).
    await tx.query('UPDATE customer SET parent_customer_id = CASE WHEN customer_id = $3 THEN NULL ELSE $3 END WHERE org_id = $1 AND parent_customer_id = $2',
      [orgId, fromId, intoId]);
    const moved = {};
    for (const [table, key] of [['txn', 'transactions'], ['document', 'documents'], ['message', 'messages'], ['activity_event', 'history'], ['project', 'projects']]) {
      moved[key] = (await tx.query(`UPDATE ${table} SET customer_id = $3 WHERE org_id = $1 AND customer_id = $2`, [orgId, fromId, intoId])).rowCount;
    }
    const { rows: others } = await tx.query(
      `SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'customer_id'
          AND table_name NOT IN ('customer', 'txn', 'document', 'message', 'activity_event', 'project')`);
    for (const { table_name: t } of others) {
      const hasOrg = (await tx.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = 'org_id'`, [t])).rowCount;
      await tx.query(`UPDATE ${t} SET customer_id = $2 WHERE customer_id = $1${hasOrg ? ' AND org_id = $3' : ''}`, hasOrg ? [fromId, intoId, orgId] : [fromId, intoId]);
    }
    // Price rules list customers in an array: the merged customer's rules now apply to the one kept.
    await tx.query(`UPDATE price_rule SET customer_ids = (SELECT array_agg(DISTINCT CASE WHEN x = $2 THEN $3 ELSE x END) FROM unnest(customer_ids) x)
      WHERE org_id = $1 AND $2 = ANY(customer_ids)`, [orgId, fromId, intoId]);
    await tx.query('DELETE FROM customer WHERE org_id = $1 AND customer_id = $2', [orgId, fromId]);
    await logActivity(tx, { orgId, customerId: intoId, actor, kind: 'customer_updated',
      summary: `${from.display_name} merged into ${into.display_name}: ${moved.transactions} transaction${moved.transactions === 1 ? '' : 's'}, ${moved.documents} document${moved.documents === 1 ? '' : 's'} moved` });
    return { from, into, moved };
  });
}

// ---- reads used by the forms ----

export async function listItems(pool, { orgId, entityId }) {
  const { rows } = await pool.query(
    `SELECT item_id, name, rate_cents, kind FROM item WHERE org_id = $1 AND entity_id = $2 AND active AND kind <> 'system' ORDER BY lower(name)`,
    [orgId, entityId]);
  return rows;
}

export async function listTerms(pool, { orgId, entityId }) {
  const { rows } = await pool.query('SELECT terms_id, name, due_days FROM terms WHERE org_id = $1 AND entity_id = $2 ORDER BY due_days, name', [orgId, entityId]);
  return rows;
}

// Open charges for a customer, oldest due first. With paymentTxnId, also the charges that payment is
// applied to, with `applied_cents` = what it applied (open_cents is then "open if this payment were removed").
export async function listOpenCharges(pool, { orgId, customerId, paymentTxnId = null }) {
  const { rows } = await pool.query(
    // Amounts in the invoice's own currency (a foreign customer's payment form works in theirs).
    `SELECT t.txn_id, t.type, t.doc_number, t.txn_date, t.due_date, t.currency, coalesce(t.foreign_total_cents, t.total_cents) AS total_cents,
            coalesce(t.foreign_open_cents, t.open_cents) + coalesce(a.fx, 0) AS open_cents,
            coalesce(a.fx, 0)::bigint AS applied_cents
       FROM txn t
       -- A payment can be applied to one invoice in several parts (each dated): one row per invoice, with their total.
       LEFT JOIN (SELECT charge_txn_id, sum(amount_cents)::bigint AS amount_cents, sum(coalesce(foreign_cents, amount_cents))::bigint AS fx
                    FROM application WHERE credit_txn_id = $3 GROUP BY charge_txn_id) a ON a.charge_txn_id = t.txn_id
      WHERE t.org_id = $1 AND t.customer_id = $2 AND t.type IN ('invoice', 'late_fee') AND t.voided_at IS NULL
        AND (t.open_cents > 0 OR a.amount_cents IS NOT NULL)
      ORDER BY t.due_date, t.txn_id`, [orgId, customerId, paymentTxnId]);
  return rows;
}

export async function listOpenCredits(pool, { orgId, customerId }) {
  const { rows } = await pool.query(
    `SELECT txn_id, type, doc_number, payment_ref, txn_date, total_cents, open_cents FROM txn
      WHERE org_id = $1 AND customer_id = $2 AND type IN ('payment', 'credit_memo') AND voided_at IS NULL AND open_cents > 0
      ORDER BY txn_date, txn_id`, [orgId, customerId]);
  return rows;
}

// Forms, stage F4: the rest of QBO's sales form fields — email copies, Bill to / Ship to as shown on the document,
// shipping details, the customer's P.O. number, an internal note, a statement memo, print later / send later, and for
// estimates who accepted it, when, and the deposit asked for.
const EMAILS = /^\s*([^\s@,;]+@[^\s@,;]+\.[^\s@,;]+)(\s*[,;]\s*[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+)*\s*$/;
export async function saveSalesExtras(tx, { orgId, txnId, type, extras: x }) {
  const text = (v, n) => String(v ?? '').trim().slice(0, n) || null;
  for (const [label, v] of [['Cc', x.cc], ['Bcc', x.bcc]]) if (String(v ?? '').trim() && !EMAILS.test(String(v))) fail(`${label}: enter email addresses separated by commas.`);
  for (const [label, v] of [['Ship date', x.shipDate], ['Accepted date', x.acceptedDate]]) if (String(v ?? '').trim() && !isIsoDate(String(v).trim())) fail(`${label} isn’t a valid date.`);
  let pct = null;
  if (type === 'estimate' && String(x.depositRequest ?? '').trim()) {
    pct = Number(String(x.depositRequest).replace('%', '').trim());
    if (!(pct > 0 && pct <= 100)) fail('Deposit request: enter a percent between 0 and 100, like 25.');
  }
  await tx.query(`UPDATE txn SET email_cc = $3, email_bcc = $4, bill_to = $5, ship_to = $6, ship_via = $7, ship_date = $8, tracking_no = $9, po_number = $10,
      internal_note = $11, statement_memo = $12, print_later = $13, send_later = $14, accepted_by = $15, accepted_date = $16, deposit_request_percent = $17
    WHERE org_id = $1 AND txn_id = $2`,
  [orgId, txnId, text(x.cc, 500), text(x.bcc, 500), text(x.billTo, 500), text(x.shipTo, 500), text(x.shipVia, 60), text(x.shipDate, 10), text(x.trackingNo, 60),
    text(x.poNumber, 40), text(x.internalNote, 2000), text(x.statementMemo, 500), x.printLater === true, x.sendLater === true,
    type === 'estimate' ? text(x.acceptedBy, 100) : null, type === 'estimate' ? text(x.acceptedDate, 10) : null, pct]);
  // An estimate someone accepted is accepted (QBO).
  if (type === 'estimate' && text(x.acceptedBy, 100)) {
    await tx.query(`UPDATE txn SET estimate_status = 'accepted' WHERE org_id = $1 AND txn_id = $2 AND estimate_status = 'pending'`, [orgId, txnId]);
  }
}
