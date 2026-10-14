import { withTransaction } from '../db.js';
import { ValidationError, lockEntity, logActivity, unapplyAll, nextDocNumber } from './writes.js';
import { repost, systemAccounts } from './ledger.js';
import { withInventoryReplay } from './inventory.js';
import { isIsoDate, addDays } from '../domain/dates.js';
import { formatCents, parseMoney } from '../domain/money.js';
import { parseQuantity, lineAmount, quantityToSql } from '../domain/lines.js';
import { TYPE_LABELS } from '../domain/status.js';
import { getAccountingSettings, applyTxnDimensions, checkLineClasses } from './accounting.js';
import { assertNotReconciled } from './locks.js';
import { resolveRate, revalueCredit } from './currencies.js';
import { toHome, allocate, formatMoney, homeShare } from '../domain/fx.js';

import { PAYMENT_METHODS } from '../domain/checks.js';

// A duplicate bill number: shown as a warning with a “Save anyway” button.
export class DuplicateWarning extends ValidationError {}

// Bills, vendor credits, expenses, checks and bill payments. Same rules as the customer side: one database
// transaction per write, the company row locked, balanced postings rewritten, a history line on the vendor.

const fail = message => { throw new ValidationError(message); };
export const DOC_TYPES = ['bill', 'expense', 'check', 'vendor_credit', 'purchase_order', 'item_receipt'];
const VENDOR_REQUIRED = ['bill', 'vendor_credit', 'purchase_order', 'item_receipt'];
const PAY_FROM_TYPES = { expense: ['bank', 'credit_card'], check: ['bank'], bill_payment: ['bank', 'credit_card'] };
const label = t => `${TYPE_LABELS[t.type]}${t.doc_number ? ` ${t.doc_number}` : ''}`;
const VOIDABLE = ['bill', 'bill_payment', 'expense', 'check', 'vendor_credit', 'purchase_order', 'item_receipt'];

// Takes back the vendor credits a bill payment applied to its bills.
async function unapplyCreditsVia(tx, orgId, paymentId) {
  const { rows } = await tx.query('DELETE FROM application WHERE org_id = $1 AND via_txn_id = $2 RETURNING credit_txn_id, charge_txn_id, amount_cents, foreign_cents', [orgId, paymentId]);
  for (const a of rows) {
    await tx.query('UPDATE txn SET open_cents = open_cents + $2, updated_at = now() WHERE txn_id = $1', [a.credit_txn_id, a.amount_cents]);
    await tx.query('UPDATE txn SET open_cents = open_cents + $2, foreign_open_cents = foreign_open_cents + $3, updated_at = now() WHERE txn_id = $1',
      [a.charge_txn_id, a.amount_cents, a.foreign_cents ?? 0]);
    await revalueCredit(tx, { orgId, txnId: a.credit_txn_id });
  }
  return rows.length;
}

// "-12.50" allowed on category lines (refunds, discounts); the document total must still be positive.
function signedMoney(text) {
  const s = String(text ?? '').trim();
  if (s.startsWith('-')) { const c = parseMoney(s.slice(1)); return c === null ? null : -c; }
  return parseMoney(s);
}

async function loadTxn(tx, orgId, entityId, txnId) {
  const { rows } = await tx.query('SELECT * FROM txn WHERE org_id = $1 AND entity_id = $2 AND txn_id = $3 FOR UPDATE', [orgId, entityId, txnId]);
  return rows[0] ?? fail('Transaction not found.');
}

export async function getBillSettings(db, { orgId, entityId }) {
  const { rows } = await db.query('SELECT require_approval, next_check_number FROM bill_settings WHERE org_id = $1 AND entity_id = $2', [orgId, entityId]);
  return rows[0] ?? { require_approval: true, next_check_number: 1001 };
}

export async function saveBillSettings(pool, { orgId, entityId, requireApproval, nextCheckNumber }) {
  const n = Number.parseInt(String(nextCheckNumber ?? '').trim(), 10);
  if (!Number.isSafeInteger(n) || n < 1 || n > 99_999_999) fail('The starting check number should be a whole number like 1001.');
  await withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    await tx.query(
      `INSERT INTO bill_settings (org_id, entity_id, require_approval, next_check_number) VALUES ($1,$2,$3,$4)
       ON CONFLICT (org_id, entity_id) DO UPDATE SET require_approval = EXCLUDED.require_approval, next_check_number = EXCLUDED.next_check_number`,
      [orgId, entityId, requireApproval === true, n]);
  });
}

// The next free check number for a bank account: one past the highest used, never below the company's starting number.
export async function nextCheckNumber(db, { orgId, entityId, accountId }) {
  const { rows: [r] } = await db.query(
    `SELECT coalesce(max(substring(doc_number FROM '^(\\d{1,9})$')::bigint), 0) AS n FROM txn
      WHERE org_id = $1 AND entity_id = $2 AND account_id = $3 AND type IN ('check', 'bill_payment') AND payment_method = 'Check'`,
    [orgId, entityId, accountId]);
  const { next_check_number: start } = await getBillSettings(db, { orgId, entityId });
  return String(Math.max(r.n + 1, start));
}

export async function payFromAccount(tx, orgId, entityId, type, accountId) {
  const allowed = PAY_FROM_TYPES[type];
  const { rows } = await tx.query('SELECT name, type FROM account WHERE org_id = $1 AND entity_id = $2 AND account_id = $3 AND active', [orgId, entityId, accountId]);
  if (!rows.length || !allowed.includes(rows[0].type)) fail(type === 'check' ? 'Choose the bank account the check is written on.' : 'Choose the bank or credit card account the money came from.');
  return rows[0];
}

// "123:2" -> { poTxnId: 123, poLineNo: 2 }: the purchase order line a bill / receipt line was received from.
const poRef = row => {
  const m = /^(\d{1,18}):(\d{1,4})$/.exec(String(row.po ?? ''));
  return m ? { poTxnId: Number(m[1]), poLineNo: Number(m[2]) } : { poTxnId: null, poLineNo: null };
};

// Adds (sign 1) or takes back (sign -1) what bill / receipt lines received against their purchase order lines,
// then refreshes each purchase order's open (unreceived) amount.
async function receiveOnPurchaseOrders(tx, orgId, lines, sign) {
  const pos = new Set();
  for (const l of lines.filter(x => x.poTxnId ?? x.po_txn_id)) {
    const po = l.poTxnId ?? l.po_txn_id, no = l.poLineNo ?? l.po_line_no;
    const qty = l.itemId ?? l.item_id ? quantityToSql(typeof l.qty === 'bigint' ? l.qty : BigInt(Math.round(Number(l.quantity) * 10000))) : '0';
    await tx.query(`UPDATE txn_line SET received_qty = greatest(received_qty + $3 * $4::numeric, 0), received_cents = greatest(received_cents + $3 * $5, 0)
                     WHERE org_id = $1 AND txn_id = $2 AND line_no = $6`,
      [orgId, po, sign, qty, l.itemId ?? l.item_id ? 0 : (l.amountCents ?? l.amount_cents), no]);
    pos.add(po);
  }
  for (const po of pos) await refreshPurchaseOrder(tx, orgId, po);
}

export async function refreshPurchaseOrder(tx, orgId, poTxnId) {
  await tx.query(
    `UPDATE txn SET open_cents = CASE WHEN closed_at IS NOT NULL OR voided_at IS NOT NULL THEN 0 ELSE least(total_cents, (
        SELECT coalesce(sum(greatest(CASE WHEN l.item_id IS NOT NULL THEN l.amount_cents - round(l.received_qty * l.rate_cents)::bigint
                                          ELSE l.amount_cents - l.received_cents END, 0)), 0)
          FROM txn_line l WHERE l.txn_id = txn.txn_id)) END, updated_at = now()
      WHERE org_id = $1 AND txn_id = $2 AND type = 'purchase_order'`, [orgId, poTxnId]);
}

// Category and product rows from the form -> validated lines. Blank rows are ignored.
export async function parseVendorLines(tx, { orgId, entityId, categoryLines = [], itemLines = [] }) {
  const accounts = new Map((await tx.query(
    `SELECT account_id, name, system_key FROM account WHERE org_id = $1 AND entity_id = $2 AND active`, [orgId, entityId])).rows.map(a => [a.account_id, a]));
  const items = new Map((await tx.query(
    'SELECT item_id, name, purchase_cost_cents FROM item WHERE org_id = $1 AND entity_id = $2 AND active', [orgId, entityId])).rows.map(i => [i.item_id, i]));
  const out = [];
  // Billable (to the line's customer) and the line's class.
  const extras = (row, t, where) => {
    const billable = row.billable === true || row.billable === '1';
    if (billable && !t.customerId) fail(`${where}: choose the customer to bill, or untick Billable.`);
    return { billable, classId: /^\d{1,18}$/.test(String(row.classId ?? '')) ? Number(row.classId) : null };
  };
  const tag = async (row, where) => {
    let customerId = row.customerId ? Number(row.customerId) : null;
    const projectId = row.projectId ? Number(row.projectId) : null;
    if (projectId) {
      const p = (await tx.query(`SELECT p.customer_id FROM project p JOIN customer c ON c.customer_id = p.customer_id AND c.entity_id = $2
                                   WHERE p.org_id = $1 AND p.project_id = $3`, [orgId, entityId, projectId])).rows[0] ?? fail(`${where}: choose a valid project.`);
      if (customerId && customerId !== p.customer_id) fail(`${where}: that project belongs to a different customer.`);
      customerId = p.customer_id;
    } else if (customerId) {
      const c = await tx.query('SELECT 1 FROM customer WHERE org_id = $1 AND entity_id = $2 AND customer_id = $3', [orgId, entityId, customerId]);
      if (!c.rowCount) fail(`${where}: choose a valid customer.`);
    }
    return { customerId, projectId };
  };
  for (const [i, row] of categoryLines.entries()) {
    const blank = !row.accountId && !String(row.description ?? '').trim() && !String(row.amount ?? '').trim();
    if (blank) continue;
    const where = `Category line ${i + 1}`;
    const accountId = row.accountId ? Number(row.accountId) : null;
    const a = accountId ? accounts.get(accountId) : null;
    if (!a) fail(`${where}: choose a category (account).`);
    if (['ar', 'ap', 'undeposited'].includes(a.system_key)) fail(`${where}: “${a.name}” can’t be used as a category.`);
    const amount = signedMoney(row.amount);
    if (amount === null || amount === 0) fail(`${where}: enter an amount like 125.00.`);
    const t = await tag(row, where);
    out.push({ accountId, itemId: null, description: String(row.description ?? '').trim().slice(0, 500) || null, qty: 10_000n, rateCents: amount,
      amountCents: amount, ...poRef(row), ...t, ...extras(row, t, where) });
  }
  for (const [i, row] of itemLines.entries()) {
    const blank = !row.itemId && !String(row.description ?? '').trim() && !String(row.quantity ?? '').trim() && !String(row.rate ?? '').trim();
    if (blank) continue;
    const where = `Product line ${i + 1}`;
    const itemId = row.itemId ? Number(row.itemId) : null;
    const item = itemId ? items.get(itemId) : null;
    if (!item) fail(`${where}: choose a product or service.`);
    const qty = parseQuantity(String(row.quantity ?? '').trim() || '1') ?? fail(`${where}: quantity must be a number greater than 0.`);
    const rateText = String(row.rate ?? '').trim();
    const rate = rateText === '' ? (item.purchase_cost_cents ?? fail(`${where}: enter the cost.`)) : parseMoney(rateText);
    if (rate === null) fail(`${where}: cost must be an amount like 12.50.`);
    const t = await tag(row, where);
    out.push({ accountId: null, itemId, description: String(row.description ?? '').trim().slice(0, 500) || item.name, qty, rateCents: rate,
      amountCents: lineAmount(qty, rate), ...poRef(row), ...t, ...extras(row, t, where) });
  }
  if (!out.length) fail('Add at least one category or product line.');
  return out;
}

export async function saveVendorDoc(pool, p) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, p.orgId, p.entityId);
    return writeVendorDoc(tx, p);
  });
}

// p: { orgId, entityId, actor, type, txnId?, vendorId, txnDate, dueDate, termsId, docNumber, memo, accountId (paid from),
//      paymentMethod, categoryLines, itemLines, systemKind?, recurringTemplateId?, activitySuffix? }. Caller holds the entity lock.
export async function writeVendorDoc(tx, p) {
  const { orgId, entityId, type, actor } = p;
  if (!DOC_TYPES.includes(type)) fail('Unknown transaction type.');
  if (!isIsoDate(p.txnDate)) fail('Enter a valid date.');
  const lines = await parseVendorLines(tx, p);
  let total = lines.reduce((s, l) => s + l.amountCents, 0);
  if (total <= 0) fail('The total must be more than $0.00.');
  await checkLineClasses(tx, { orgId, entityId, classIds: lines.map(l => l.classId) });
  if (lines.some(l => l.billable) && !['bill', 'expense', 'check'].includes(type)) fail('Only bills, expenses and checks can have billable lines.');

  let vendor = null;
  if (p.vendorId) {
    vendor = (await tx.query(
      `SELECT v.vendor_id, v.display_name, v.currency, tm.due_days FROM vendor v LEFT JOIN terms tm ON tm.org_id = v.org_id AND tm.terms_id = v.terms_id
        WHERE v.org_id = $1 AND v.entity_id = $2 AND v.vendor_id = $3`, [orgId, entityId, p.vendorId])).rows[0] ?? fail('Vendor not found.');
  } else if (VENDOR_REQUIRED.includes(type)) fail('Choose a vendor.');
  // Lines received from a purchase order must come from one of this vendor's open purchase orders.
  for (const l of lines.filter(x => x.poTxnId)) {
    if (type !== 'bill' && type !== 'item_receipt') fail('Only bills and item receipts can receive a purchase order.');
    const po = (await tx.query(`SELECT 1 FROM txn_line pl JOIN txn po ON po.txn_id = pl.txn_id
                                 WHERE po.org_id = $1 AND po.entity_id = $2 AND po.txn_id = $3 AND pl.line_no = $4 AND po.type = 'purchase_order'
                                   AND po.vendor_id = $5 AND po.voided_at IS NULL`, [orgId, entityId, l.poTxnId, l.poLineNo, vendor.vendor_id])).rowCount;
    if (!po) fail('A line points at a purchase order that isn’t this vendor’s.');
  }

  let dueDate = null;
  if (type === 'purchase_order' && p.dueDate) {
    if (!isIsoDate(p.dueDate)) fail('Enter a valid expected date.');
    dueDate = p.dueDate;
  }
  if (type === 'bill') {
    let days = vendor.due_days ?? 0;
    if (p.termsId) days = (await tx.query('SELECT due_days FROM terms WHERE org_id = $1 AND terms_id = $2 AND entity_id = $3', [orgId, p.termsId, entityId])).rows[0]?.due_days ?? fail('Choose valid terms.');
    if (p.dueDate) {
      if (!isIsoDate(p.dueDate)) fail('Enter a valid due date.');
      if (p.dueDate < p.txnDate) fail('The due date can’t be before the bill date.');
      dueDate = p.dueDate;
    } else dueDate = addDays(p.txnDate, days);
  }

  let accountId = null, method = null;
  if (type === 'expense' || type === 'check') {
    if (!p.accountId) fail(type === 'check' ? 'Choose the bank account the check is written on.' : 'Choose the account the money came from.');
    await payFromAccount(tx, orgId, entityId, type, p.accountId);
    accountId = p.accountId;
    method = type === 'check' ? 'Check' : (PAYMENT_METHODS.includes(p.paymentMethod) ? p.paymentMethod : null);
  }

  // A vendor billing in another currency: bills and credits are typed in it and carried at home amounts at the rate.
  // (Expenses, checks, purchase orders and item receipts stay in the home currency.)
  const fx = vendor?.currency && (type === 'bill' || type === 'vendor_credit') ? { code: vendor.currency, foreignTotal: total } : null;
  if (fx) {
    if (lines.some(l => l.poTxnId)) fail('Receiving a purchase order onto a foreign-currency bill isn’t supported yet.');
    const prior = p.txnId ? (await tx.query('SELECT exchange_rate FROM txn WHERE org_id = $1 AND txn_id = $2', [orgId, p.txnId])).rows[0] : null;
    fx.rate = prior?.exchange_rate && !String(p.exchangeRate ?? '').trim() ? Number(prior.exchange_rate)
      : await resolveRate(tx, { orgId, entityId, code: fx.code, date: p.txnDate, typed: p.exchangeRate });
    const parts = allocate(lines.map(l => l.amountCents), fx.rate);
    lines.forEach((l, i) => { l.foreignAmount = l.amountCents; l.foreignRate = l.rateCents; l.amountCents = parts.lines[i]; l.rateCents = Math.round(l.rateCents * fx.rate); });
    total = parts.total;
  }

  let txnId = p.txnId ?? null, existing = null, applied = 0;
  if (txnId) {
    existing = await loadTxn(tx, orgId, entityId, txnId);
    if (existing.type !== type) fail('Transaction not found.');
    await assertNotReconciled(tx, { orgId, txnId, override: p.editReconciled });
    if (existing.voided_at) fail('This transaction is voided and can’t be changed.');
    if (existing.vendor_id && existing.vendor_id !== (vendor?.vendor_id ?? null)) {
      const any = await tx.query('SELECT 1 FROM application WHERE credit_txn_id = $1 OR charge_txn_id = $1 LIMIT 1', [txnId]);
      if (any.rowCount) fail('The vendor can’t change while payments or credits are applied.');
    }
    applied = (await tx.query('SELECT coalesce(sum(amount_cents), 0)::bigint AS n FROM application WHERE credit_txn_id = $1 OR charge_txn_id = $1', [txnId])).rows[0].n;
    if (type === 'purchase_order') {
      const got = await tx.query('SELECT 1 FROM txn_line WHERE txn_id = $1 AND (received_qty > 0 OR received_cents > 0) LIMIT 1', [txnId]);
      if (got.rowCount) fail('Part of this purchase order has been received, so it can’t be changed. Close it and start a new one.');
      if (existing.closed_at) fail('This purchase order is closed.');
    }
    // Take back what the old lines received on purchase orders; the new lines are received below.
    const old = (await tx.query('SELECT * FROM txn_line WHERE txn_id = $1 AND po_txn_id IS NOT NULL', [txnId])).rows;
    if (old.length) await receiveOnPurchaseOrders(tx, orgId, old, -1);
    if (total < applied) fail(`${formatCents(applied)} is already applied to this ${TYPE_LABELS[type].toLowerCase()}; the total can’t go below that.`);
  }

  let docNumber = String(p.docNumber ?? '').trim().slice(0, 30) || null;
  // Duplicate bill numbers for a vendor: a warning the person can confirm past (Settings → Accounting).
  if (type === 'bill' && docNumber && vendor && !p.allowDuplicate && (await getAccountingSettings(tx, { orgId, entityId })).warnDuplicateBills) {
    const dup = await tx.query(`SELECT txn_date FROM txn WHERE org_id = $1 AND vendor_id = $2 AND type = 'bill' AND doc_number = $3 AND voided_at IS NULL AND txn_id IS DISTINCT FROM $4`,
      [orgId, vendor.vendor_id, docNumber, txnId]);
    if (dup.rowCount) throw new DuplicateWarning(`${vendor.display_name} already has bill ${docNumber} (dated ${dup.rows[0].txn_date}). Save anyway if this is a different bill.`);
  }
  if (type === 'purchase_order' && !docNumber) docNumber = existing?.doc_number ?? await nextDocNumber(tx, orgId, entityId, 'purchase_order');
  if (type === 'check' && !docNumber) docNumber = existing?.account_id === accountId && existing?.doc_number ? existing.doc_number : await nextCheckNumber(tx, { orgId, entityId, accountId });
  if (type === 'check' && !/^\d{1,9}$/.test(docNumber)) fail('Check numbers are digits only, like 1042.');
  const memo = String(p.memo ?? '').trim().slice(0, 1000) || null;
  const open = ['bill', 'vendor_credit', 'item_receipt', 'purchase_order'].includes(type) ? total - applied : 0;
  const foreignApplied = fx && existing
    ? Number((await tx.query(`SELECT coalesce(sum(foreign_cents), 0)::bigint AS n FROM application WHERE ${type === 'vendor_credit' ? 'credit_txn_id' : 'charge_txn_id'} = $1`,
      [txnId])).rows[0].n) : 0;
  if (fx && fx.foreignTotal < foreignApplied) fail(`${formatMoney(foreignApplied, fx.code)} is already applied; the total can’t go below that.`);
  if (fx && existing && foreignApplied > 0 && Number(existing.exchange_rate) !== fx.rate) {
    fail('Payments or credits are already applied at this exchange rate, so the rate can’t change. Remove them first.');
  }

  // Approval: new bills wait for approval when the company requires it; a changed amount needs approval again.
  let approval = null, approvedBy = null, approvedAt = null;
  if (type === 'bill') {
    const { require_approval: required } = await getBillSettings(tx, { orgId, entityId });
    if (!required || p.systemKind) { approval = 'approved'; approvedBy = existing?.approved_by ?? (required ? actor : null); approvedAt = existing?.approved_at ?? null; }
    else if (existing && existing.approval_status === 'approved' && existing.total_cents === total && existing.vendor_id === (vendor?.vendor_id ?? null)) {
      approval = 'approved'; approvedBy = existing.approved_by; approvedAt = existing.approved_at;
    } else approval = 'awaiting';
    if (approval === 'awaiting' && applied > 0) fail('This bill already has payments, so its amount can’t change.');
  }

  try {
    if (existing) {
      await tx.query(
        `UPDATE txn SET vendor_id = $3, doc_number = $4, txn_date = $5, due_date = $6, memo = $7, payment_method = $8, total_cents = $9, open_cents = $10,
                account_id = $11, approval_status = $12, approved_by = $13, approved_at = $14, rejected_reason = NULL, currency = $15, exchange_rate = $16,
                foreign_total_cents = $17, foreign_open_cents = $18, updated_at = now()
          WHERE org_id = $1 AND txn_id = $2`,
        [orgId, txnId, vendor?.vendor_id ?? null, docNumber, p.txnDate, dueDate, memo, method, total, open, accountId, approval, approvedBy, approvedAt,
          fx?.code ?? null, fx?.rate ?? null, fx?.foreignTotal ?? null, fx ? fx.foreignTotal - foreignApplied : null]);
      // Moved later than a payment or credit already applied to it: that application can't be dated before the
      // document, so the trigger (migration 028) re-dates it.
      await tx.query('UPDATE application SET applied_on = applied_on WHERE charge_txn_id = $1 OR credit_txn_id = $1', [txnId]);
      await tx.query('DELETE FROM txn_line WHERE org_id = $1 AND txn_id = $2', [orgId, txnId]);
    } else {
      txnId = (await tx.query(
        `INSERT INTO txn (org_id, entity_id, vendor_id, type, doc_number, txn_date, due_date, memo, payment_method, total_cents, open_cents, account_id,
           approval_status, approved_by, approved_at, system_kind, recurring_template_id, currency, exchange_rate, foreign_total_cents, foreign_open_cents)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING txn_id`,
        [orgId, entityId, vendor?.vendor_id ?? null, type, docNumber, p.txnDate, dueDate, memo, method, total, open, accountId, approval, approvedBy,
          approvedAt, p.systemKind ?? null, p.recurringTemplateId ?? null, fx?.code ?? null, fx?.rate ?? null, fx?.foreignTotal ?? null, fx?.foreignTotal ?? null])).rows[0].txn_id;
    }
  } catch (error) {
    if (error?.code === '23505') {
      fail(type === 'check' ? `Check number ${docNumber} is already used on that account.`
        : type === 'purchase_order' ? `Purchase order ${docNumber} already exists.` : `${TYPE_LABELS[type]} number ${docNumber} is already used for this vendor.`);
    }
    throw error;
  }
  for (const [i, l] of lines.entries()) {
    await tx.query(
      `INSERT INTO txn_line (org_id, txn_id, line_no, item_id, account_id, description, quantity, rate_cents, amount_cents, customer_id, project_id,
         po_txn_id, po_line_no, billable, class_id, foreign_amount_cents, foreign_rate_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [orgId, txnId, i + 1, l.itemId, l.accountId, l.description, quantityToSql(l.qty), l.rateCents, l.amountCents, l.customerId, l.projectId,
        l.poTxnId, l.poLineNo, l.billable ?? false, l.classId ?? null, l.foreignAmount ?? null, l.foreignRate ?? null]);
  }
  await receiveOnPurchaseOrders(tx, orgId, lines, 1);
  await applyTxnDimensions(tx, { orgId, entityId, txnId, dims: p.dims ?? {} });
  // Settings → Accounting: a new vendor credit goes against the vendor's oldest approved open bills.
  if (type === 'vendor_credit' && !existing && (await getAccountingSettings(tx, { orgId, entityId })).autoApplyVendor) {
    const { rows: bills } = await tx.query(
      `SELECT txn_id, open_cents, foreign_open_cents, foreign_total_cents, exchange_rate FROM txn WHERE org_id = $1 AND vendor_id = $2 AND type = 'bill' AND voided_at IS NULL AND open_cents > 0
          AND approval_status = 'approved' AND currency IS NOT DISTINCT FROM $3 ORDER BY due_date, txn_date, txn_id FOR UPDATE`, [orgId, vendor.vendor_id, fx?.code ?? null]);
    const start = fx ? fx.foreignTotal : total;
    let left = start;
    for (const b of bills) {
      if (left <= 0) break;
      const f = Math.min(left, Number(fx ? b.foreign_open_cents : b.open_cents));
      const home = !fx ? f : homeShare({ foreignTotal: b.foreign_total_cents, foreignOpen: b.foreign_open_cents, homeOpen: b.open_cents, part: f, rate: b.exchange_rate });
      await tx.query('INSERT INTO application (org_id, credit_txn_id, charge_txn_id, amount_cents, applied_on, foreign_cents) VALUES ($1,$2,$3,$4,$5,$6)',
        [orgId, txnId, b.txn_id, home, p.txnDate, fx ? f : null]);
      await tx.query('UPDATE txn SET open_cents = open_cents - $3, foreign_open_cents = foreign_open_cents - $4 WHERE org_id = $1 AND txn_id = $2',
        [orgId, b.txn_id, home, fx ? f : null]);
      left -= f;
    }
    if (!fx && left !== total) await tx.query('UPDATE txn SET open_cents = $3 WHERE org_id = $1 AND txn_id = $2', [orgId, txnId, left]);
  }
  if (fx && type === 'vendor_credit') await revalueCredit(tx, { orgId, txnId });
  await repost(tx, orgId, txnId);
  if (vendor) {
    const verb = existing ? 'updated' : 'created';
    await logActivity(tx, { orgId, vendorId: vendor.vendor_id, txnId, actor, kind: `${type}_${verb}`,
      summary: `${TYPE_LABELS[type]}${docNumber ? ` ${docNumber}` : ''} ${verb} for ${formatCents(total)}${approval === 'awaiting' ? ' · awaiting approval' : ''}${p.activitySuffix ?? ''}` });
  }
  return txnId;
}

// ---- approval ----

export async function approveBills(pool, { orgId, entityId, txnIds, actor }) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const { rows } = await tx.query(
      `UPDATE txn SET approval_status = 'approved', approved_by = $4, approved_at = now(), rejected_reason = NULL, updated_at = now()
        WHERE org_id = $1 AND entity_id = $2 AND txn_id = ANY($3) AND type = 'bill' AND voided_at IS NULL AND approval_status <> 'approved'
        RETURNING txn_id, vendor_id, doc_number, total_cents`, [orgId, entityId, txnIds, actor]);
    for (const r of rows) {
      await logActivity(tx, { orgId, vendorId: r.vendor_id, txnId: r.txn_id, actor, kind: 'bill_approved', summary: `Bill${r.doc_number ? ` ${r.doc_number}` : ''} for ${formatCents(r.total_cents)} approved by ${actor}` });
    }
    return rows.length;
  });
}

export async function rejectBill(pool, { orgId, entityId, txnId, reason, actor }) {
  const why = String(reason ?? '').trim().slice(0, 300);
  if (!why) fail('Say why the bill is rejected.');
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const t = await loadTxn(tx, orgId, entityId, txnId);
    if (t.type !== 'bill' || t.voided_at) fail('Only open bills can be rejected.');
    if (t.open_cents < t.total_cents) fail('This bill already has payments.');
    await tx.query(`UPDATE txn SET approval_status = 'rejected', rejected_reason = $3, approved_by = NULL, approved_at = NULL, updated_at = now()
                     WHERE org_id = $1 AND txn_id = $2`, [orgId, txnId, why]);
    await logActivity(tx, { orgId, vendorId: t.vendor_id, txnId, actor, kind: 'bill_rejected', summary: `${label(t)} rejected by ${actor}: ${why}` });
  });
}

// ---- paying bills ----

// payments: [{ billId, amountCents, creditCents }]. One bill payment per vendor; credits are taken from each vendor's
// oldest open vendor credits first. checkNo (optional) is the first check number when paying by check.
export async function payBills(pool, { orgId, entityId, actor, accountId, txnDate, method, checkNo = '', memo = '', payments, rates = {} }) {
  if (!isIsoDate(txnDate)) fail('Enter a valid payment date.');
  if (!PAYMENT_METHODS.includes(method)) fail('Choose how the bills were paid.');
  const rows = payments.filter(x => (x.amountCents ?? 0) > 0 || (x.creditCents ?? 0) > 0);
  if (!rows.length) fail('Select at least one bill and enter what you’re paying.');
  for (const x of rows) {
    if (!Number.isSafeInteger(x.amountCents) || x.amountCents < 0 || !Number.isSafeInteger(x.creditCents ?? 0) || (x.creditCents ?? 0) < 0) fail('Amounts must be positive.');
  }
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    return writeBillPayments(tx, { orgId, entityId, actor, accountId, txnDate, method, checkNo, memo, rows, rates });
  });
}

// The body of payBills for callers holding the entity lock (scheduled payments).
async function writeBillPayments(tx, { orgId, entityId, actor, accountId, txnDate, method, checkNo = '', memo = '', rows, activitySuffix = '', rates = {} }) {
  {
    const acct = await payFromAccount(tx, orgId, entityId, 'bill_payment', accountId);
    if (method === 'Check' && acct.type !== 'bank') fail('Checks are written on a bank account.');
    // One payment per vendor and currency. For a bill in another currency, amounts are in that currency.
    const groups = new Map();
    for (const x of rows) {
      const bill = await loadTxn(tx, orgId, entityId, x.billId);
      if (bill.type !== 'bill' || bill.voided_at) fail('Only open bills can be paid.');
      if (bill.approval_status !== 'approved') fail(`${label(bill)} needs approval before it can be paid.`);
      const open = bill.currency ? Number(bill.foreign_open_cents) : bill.open_cents;
      if (x.amountCents + (x.creditCents ?? 0) > open) fail(`${label(bill)} only has ${formatMoney(open, bill.currency)} open.`);
      if (method === 'ACH') {
        const { rows: [vv] } = await tx.query('SELECT display_name, bank_verified FROM vendor WHERE vendor_id = $1', [bill.vendor_id]);
        if (!vv.bank_verified) fail(`${vv.display_name}’s bank details changed through a vendor link. Confirm them on the vendor page before paying by ACH.`);
      }
      const key = `${bill.vendor_id}|${bill.currency ?? ''}`;
      if (!groups.has(key)) groups.set(key, { vendorId: bill.vendor_id, currency: bill.currency ?? null, list: [] });
      groups.get(key).list.push({ bill, amount: x.amountCents, credit: x.creditCents ?? 0 });
    }
    let nextNo = String(checkNo ?? '').trim();
    if (nextNo && !/^\d{1,9}$/.test(nextNo)) fail('Check numbers are digits only, like 1042.');
    const created = [];
    for (const { vendorId, currency, list } of groups.values()) {
      const total = list.reduce((s, x) => s + x.amount, 0);
      const rate = currency ? await resolveRate(tx, { orgId, entityId, code: currency, date: txnDate, typed: rates[currency] }) : null;
      let docNumber = null;
      if (method === 'Check' && total > 0) {
        docNumber = nextNo || await nextCheckNumber(tx, { orgId, entityId, accountId });
        nextNo = nextNo ? String(Number(nextNo) + 1) : '';
      }
      let txnId;
      try {
        txnId = (await tx.query(
          `INSERT INTO txn (org_id, entity_id, vendor_id, type, doc_number, txn_date, memo, payment_method, total_cents, open_cents, account_id,
             currency, exchange_rate, foreign_total_cents, foreign_open_cents)
           VALUES ($1,$2,$3,'bill_payment',$4,$5,$6,$7,$8,0,$9,$10,$11,$12,$13) RETURNING txn_id`,
          [orgId, entityId, vendorId, docNumber, txnDate, String(memo ?? '').trim().slice(0, 1000) || null, method, currency ? toHome(total, rate) : total, accountId,
            currency, rate, currency ? total : null, currency ? 0 : null])).rows[0].txn_id;
      } catch (error) {
        if (error?.code === '23505') fail(`Check number ${docNumber} is already used on ${acct.name}.`);
        throw error;
      }
      const done = [];
      const credits = (await tx.query(
        `SELECT * FROM txn WHERE org_id = $1 AND vendor_id = $2 AND type = 'vendor_credit' AND voided_at IS NULL AND open_cents > 0
            AND currency IS NOT DISTINCT FROM $3 ORDER BY txn_date, txn_id FOR UPDATE`, [orgId, vendorId, currency])).rows;
      const usedCredits = new Set();
      for (const { bill, amount, credit } of list) {
        // What comes off the bill (in its own currency) and the home amount that takes off A/P at the bill's rate.
        const relief = amount + credit;
        const reliefHome = !currency ? relief
          : homeShare({ foreignTotal: bill.foreign_total_cents, foreignOpen: bill.foreign_open_cents, homeOpen: bill.open_cents, part: relief, rate: bill.exchange_rate });
        let homeLeft = reliefHome;
        const homeOf = (part, last) => { const h = last ? homeLeft : Math.min(homeLeft, currency ? toHome(part, bill.exchange_rate) : part); homeLeft -= h; return h; };
        const uses = [];
        let need = credit;
        for (const c of credits) {
          if (need === 0) break;
          const avail = currency ? Number(c.foreign_open_cents) : c.open_cents;
          const use = Math.min(need, avail);
          if (use === 0) continue;
          uses.push({ c, use });
          need -= use;
        }
        if (need > 0) fail(`There isn’t ${formatMoney(credit, currency)} of vendor credit available for ${label(bill)}.`);
        const parts = [...(amount > 0 ? [{ payment: true, f: amount }] : []), ...uses.map(u => ({ ...u, f: u.use }))];
        for (const [i, part] of parts.entries()) {
          const home = homeOf(part.f, i === parts.length - 1);
          if (part.payment) {
            await tx.query('INSERT INTO application (org_id, credit_txn_id, charge_txn_id, amount_cents, applied_on, foreign_cents) VALUES ($1,$2,$3,$4,$5,$6)',
              [orgId, txnId, bill.txn_id, home, txnDate, currency ? part.f : null]);
          } else {
            // Its own row, tagged with this payment, so voiding the payment gives back exactly this part of the credit.
            await tx.query(
              `INSERT INTO application (org_id, credit_txn_id, charge_txn_id, amount_cents, applied_on, via_txn_id, foreign_cents) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
              [orgId, part.c.txn_id, bill.txn_id, home, txnDate, txnId, currency ? part.f : null]);
            if (currency) { part.c.foreign_open_cents = Number(part.c.foreign_open_cents) - part.f; usedCredits.add(part.c.txn_id); }
            else {
              await tx.query('UPDATE txn SET open_cents = open_cents - $2, updated_at = now() WHERE txn_id = $1', [part.c.txn_id, home]);
              part.c.open_cents -= home;
            }
          }
        }
        await tx.query(`UPDATE txn SET open_cents = open_cents - $2, foreign_open_cents = foreign_open_cents - $3, updated_at = now(),
                          scheduled_pay_date = CASE WHEN open_cents - $2 = 0 THEN NULL ELSE scheduled_pay_date END,
                          scheduled_account_id = CASE WHEN open_cents - $2 = 0 THEN NULL ELSE scheduled_account_id END
                         WHERE txn_id = $1`, [bill.txn_id, reliefHome, currency ? relief : null]);
        done.push(`${label(bill)} ${formatMoney(relief, currency)}`);
      }
      for (const id of usedCredits) await revalueCredit(tx, { orgId, txnId: id });
      if (currency) await revalueCredit(tx, { orgId, txnId });
      else await repost(tx, orgId, txnId);
      const creditUsed = list.reduce((s, x) => s + x.credit, 0);
      await logActivity(tx, { orgId, vendorId, txnId, actor, kind: 'bill_paid',
        summary: `Bill payment of ${formatMoney(total, currency)} from ${acct.name}${docNumber ? ` (check ${docNumber})` : ` (${method})`}${creditUsed ? ` + ${formatMoney(creditUsed, currency)} credit` : ''} · ${done.join(', ')}${activitySuffix}` });
      created.push(txnId);
    }
    return created;
  }
}

// ---- scheduled payments ----

export async function scheduleBillPayment(pool, { orgId, entityId, txnId, payDate, accountId, method, today, actor }) {
  if (!isIsoDate(payDate)) fail('Enter the date to pay the bill.');
  if (payDate < today) fail('Pick today or a later date. To record a payment already made, use Pay bills.');
  if (!PAYMENT_METHODS.includes(method)) fail('Choose how the bill will be paid.');
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const t = await loadTxn(tx, orgId, entityId, txnId);
    if (t.type !== 'bill' || t.voided_at || t.open_cents === 0) fail('Only an open bill can be scheduled.');
    if (t.currency) fail('Scheduling payments for bills in another currency isn’t supported yet. Use Pay bills on the day.');
    if (t.approval_status !== 'approved') fail('Approve the bill before scheduling its payment.');
    const acct = await payFromAccount(tx, orgId, entityId, 'bill_payment', accountId);
    if (method === 'Check' && acct.type !== 'bank') fail('Checks are written on a bank account.');
    await tx.query('UPDATE txn SET scheduled_pay_date = $2, scheduled_account_id = $3, scheduled_method = $4, scheduled_by = $5, updated_at = now() WHERE txn_id = $1',
      [txnId, payDate, accountId, method, actor]);
    await logActivity(tx, { orgId, vendorId: t.vendor_id, txnId, actor, kind: 'payment_scheduled',
      summary: `${label(t)} scheduled to be paid ${payDate} from ${acct.name} (${method})` });
  });
}

export async function cancelScheduledPayment(pool, { orgId, entityId, txnId, actor }) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const t = await loadTxn(tx, orgId, entityId, txnId);
    if (!t.scheduled_pay_date) fail('This bill has no scheduled payment.');
    await tx.query('UPDATE txn SET scheduled_pay_date = NULL, scheduled_account_id = NULL, scheduled_method = NULL, scheduled_by = NULL WHERE txn_id = $1', [txnId]);
    await logActivity(tx, { orgId, vendorId: t.vendor_id, txnId, actor, kind: 'payment_unscheduled', summary: `Scheduled payment for ${label(t)} canceled` });
  });
}

// Daily job: pays every bill whose scheduled date has come, for its open amount, dated the scheduled day.
// A bill that can't be paid any more (rejected, already paid) loses its schedule and says why in its history.
// Returns { paid, failed }.
export async function runScheduledPayments(pool, { orgId, entityId, today, actor = 'system' }) {
  const { rows: due } = await pool.query(
    `SELECT txn_id FROM txn WHERE org_id = $1 AND entity_id = $2 AND scheduled_pay_date <= $3 ORDER BY scheduled_pay_date, txn_id`, [orgId, entityId, today]);
  const out = { paid: 0, failed: 0 };
  for (const { txn_id: txnId } of due) {
    await withTransaction(pool, async tx => {
      await lockEntity(tx, orgId, entityId);
      const t = await loadTxn(tx, orgId, entityId, txnId);
      if (!t.scheduled_pay_date || t.scheduled_pay_date > today) return;
      const clear = () => tx.query('UPDATE txn SET scheduled_pay_date = NULL, scheduled_account_id = NULL, scheduled_method = NULL, scheduled_by = NULL WHERE txn_id = $1', [txnId]);
      await tx.query('SAVEPOINT scheduled_payment');
      try {
        if (t.voided_at || t.open_cents === 0) fail('it’s already paid or voided');
        if (t.approval_status !== 'approved') fail('it isn’t approved');
        await writeBillPayments(tx, { orgId, entityId, actor, accountId: t.scheduled_account_id, txnDate: t.scheduled_pay_date, method: t.scheduled_method,
          rows: [{ billId: txnId, amountCents: t.open_cents, creditCents: 0 }], activitySuffix: ` (scheduled by ${t.scheduled_by ?? 'someone'})` });
        await clear();
        out.paid += 1;
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        await tx.query('ROLLBACK TO SAVEPOINT scheduled_payment');
        await clear();
        await logActivity(tx, { orgId, vendorId: t.vendor_id, txnId, actor, kind: 'payment_failed',
          summary: `Scheduled payment for ${label(t)} wasn’t made: ${error.message}` });
        out.failed += 1;
      }
    });
  }
  return out;
}

// Bill payment: change date, memo or check number only (amounts change by voiding and paying again, like QBO's warning-free path).
export async function updateBillPayment(pool, { orgId, entityId, txnId, txnDate, memo, docNumber, actor, override = false }) {
  if (!isIsoDate(txnDate)) fail('Enter a valid payment date.');
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    await assertNotReconciled(tx, { orgId, txnId, override });
    const t = await loadTxn(tx, orgId, entityId, txnId);
    if (t.type !== 'bill_payment' || t.voided_at) fail('Only a live bill payment can be edited.');
    let no = String(docNumber ?? '').trim() || null;
    if (t.payment_method === 'Check' && t.total_cents > 0 && (!no || !/^\d{1,9}$/.test(no))) fail('Enter the check number (digits only).');
    if (t.payment_method !== 'Check') no = t.doc_number;
    try {
      await tx.query('UPDATE txn SET txn_date = $3, memo = $4, doc_number = $5, updated_at = now() WHERE org_id = $1 AND txn_id = $2',
        [orgId, txnId, txnDate, String(memo ?? '').trim().slice(0, 1000) || null, no]);
    } catch (error) {
      if (error?.code === '23505') fail(`Check number ${no} is already used on that account.`);
      throw error;
    }
    // The payment's own applications and the vendor credits it used (tagged with it) take its new date.
    await tx.query('UPDATE application SET applied_on = $2 WHERE credit_txn_id = $1 OR via_txn_id = $1', [txnId, txnDate]);
    await repost(tx, orgId, txnId);
    await logActivity(tx, { orgId, vendorId: t.vendor_id, txnId, actor, kind: 'bill_payment_updated', summary: `${label({ ...t, doc_number: no })} updated` });
  });
}

// Pays a bill's whole open amount today from one account, without printing a check.
export async function markBillPaid(pool, { orgId, entityId, txnId, accountId, txnDate, actor }) {
  const { rows: [b] } = await pool.query('SELECT open_cents, foreign_open_cents FROM txn WHERE org_id = $1 AND entity_id = $2 AND txn_id = $3 AND type = $4', [orgId, entityId, txnId, 'bill']);
  if (!b) fail('Bill not found.');
  if (b.open_cents === 0) fail('This bill is already paid.');
  // A foreign bill is paid in full in its currency at the rate on the payment date.
  return payBills(pool, { orgId, entityId, actor, accountId, txnDate, method: 'Other',
    payments: [{ billId: txnId, amountCents: Number(b.foreign_open_cents ?? b.open_cents), creditCents: 0 }] });
}

// ---- void and delete ----

export async function voidVendorTxn(pool, { orgId, entityId, txnId, actor, override = false }) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    await assertNotReconciled(tx, { orgId, txnId, override });
    const t = await loadTxn(tx, orgId, entityId, txnId);
    if (!VOIDABLE.includes(t.type)) fail('Transaction not found.');
    if (t.voided_at) fail('This transaction is already voided.');
    if (t.type === 'bill' && t.open_cents < t.total_cents) fail(`${label(t)} has payments or credits applied. Void those first.`);
    const viaCredits = t.type === 'bill_payment' ? await unapplyCreditsVia(tx, orgId, txnId) : 0;
    const removed = await unapplyAll(tx, orgId, txnId) + viaCredits;
    await receiveOnPurchaseOrders(tx, orgId, (await tx.query('SELECT * FROM txn_line WHERE txn_id = $1 AND po_txn_id IS NOT NULL', [txnId])).rows, -1);
    await tx.query(`UPDATE txn SET voided_at = now(), total_cents = 0, open_cents = 0, foreign_open_cents = CASE WHEN currency IS NULL THEN NULL ELSE 0 END,
                      updated_at = now() WHERE org_id = $1 AND txn_id = $2`, [orgId, txnId]);
    await repost(tx, orgId, txnId);
    if (t.vendor_id) {
      await logActivity(tx, { orgId, vendorId: t.vendor_id, txnId, actor, kind: 'txn_voided',
        summary: `${label(t)} voided (was ${formatCents(t.total_cents)})${removed ? ` · reopened what it paid` : ''}` });
    }
    return t;
  });
}

export async function deleteVendorTxn(pool, args) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, args.orgId, args.entityId);
    return deleteVendorTxnTx(tx, args);
  });
}

// The same inside the caller's transaction (the caller holds the entity lock).
export async function deleteVendorTxnTx(tx, { orgId, entityId, txnId, actor, override = false }) {
  await assertNotReconciled(tx, { orgId, txnId, override });
  const t = await loadTxn(tx, orgId, entityId, txnId);
  if (!VOIDABLE.includes(t.type)) fail('Transaction not found.');
  if (t.type === 'bill' && t.open_cents < t.total_cents) fail(`${label(t)} has payments or credits applied. Delete or void those first.`);
  if (t.type === 'bill_payment') await unapplyCreditsVia(tx, orgId, txnId);
  if (t.type === 'purchase_order') {
    const got = await tx.query('SELECT 1 FROM txn_line WHERE po_txn_id = $1 LIMIT 1', [txnId]);
    if (got.rowCount) fail(`${label(t)} has been received on bills or item receipts. Close it instead.`);
  }
  await unapplyAll(tx, orgId, txnId);
  await receiveOnPurchaseOrders(tx, orgId, (await tx.query('SELECT * FROM txn_line WHERE txn_id = $1 AND po_txn_id IS NOT NULL', [txnId])).rows, -1);
  if (t.vendor_id) {
    await logActivity(tx, { orgId, vendorId: t.vendor_id, txnId: null, actor, kind: 'txn_deleted',
      summary: `${label(t)} for ${formatCents(t.total_cents)} deleted`, data: { txn_id: t.txn_id } });
  }
  await withInventoryReplay(tx, orgId, txnId, () => tx.query('DELETE FROM txn WHERE org_id = $1 AND txn_id = $2', [orgId, txnId]));
  return t;
}

export async function markChecksPrinted(pool, { orgId, entityId, txnIds, actor }) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const { rows } = await tx.query(
      `UPDATE txn SET printed_at = now() WHERE org_id = $1 AND entity_id = $2 AND txn_id = ANY($3) AND printed_at IS NULL
          AND (type = 'check' OR (type = 'bill_payment' AND payment_method = 'Check')) RETURNING txn_id, vendor_id, doc_number`, [orgId, entityId, txnIds]);
    for (const r of rows.filter(x => x.vendor_id)) {
      await logActivity(tx, { orgId, vendorId: r.vendor_id, txnId: r.txn_id, actor, kind: 'check_printed', summary: `Check ${r.doc_number} printed` });
    }
    return rows.length;
  });
}

// ---- purchase orders and item receipts ----

export async function closePurchaseOrder(pool, { orgId, entityId, txnId, actor }) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const t = await loadTxn(tx, orgId, entityId, txnId);
    if (t.type !== 'purchase_order' || t.voided_at) fail('Only an open purchase order can be closed.');
    if (t.closed_at) fail('This purchase order is already closed.');
    await tx.query('UPDATE txn SET closed_at = now(), open_cents = 0, updated_at = now() WHERE txn_id = $1', [txnId]);
    await logActivity(tx, { orgId, vendorId: t.vendor_id, txnId, actor, kind: 'po_closed', summary: `${label(t)} closed` });
  });
}

export async function reopenPurchaseOrder(pool, { orgId, entityId, txnId, actor }) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const t = await loadTxn(tx, orgId, entityId, txnId);
    if (t.type !== 'purchase_order' || !t.closed_at) fail('Only a closed purchase order can be reopened.');
    await tx.query('UPDATE txn SET closed_at = NULL, updated_at = now() WHERE txn_id = $1', [txnId]);
    await refreshPurchaseOrder(tx, orgId, txnId);
    await logActivity(tx, { orgId, vendorId: t.vendor_id, txnId, actor, kind: 'po_reopened', summary: `${label(t)} reopened` });
  });
}

// The vendor's bill arrived for goods already received: the item receipt becomes that bill (same lines, same postings).
export async function convertReceiptToBill(pool, { orgId, entityId, txnId, billDate, docNumber, actor }) {
  if (!isIsoDate(billDate)) fail('Enter the bill date.');
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const t = await loadTxn(tx, orgId, entityId, txnId);
    if (t.type !== 'item_receipt' || t.voided_at) fail('Only an item receipt can be turned into a bill.');
    const { rows: [v] } = await tx.query(
      `SELECT tm.due_days FROM vendor v LEFT JOIN terms tm ON tm.org_id = v.org_id AND tm.terms_id = v.terms_id WHERE v.vendor_id = $1`, [t.vendor_id]);
    const { require_approval: required } = await getBillSettings(tx, { orgId, entityId });
    const no = String(docNumber ?? '').trim().slice(0, 30) || t.doc_number;
    try {
      // The stock (and what's owed for it) arrived on the receipt date, so the bill keeps that date — moving it would
      // re-cost every sale in between. The vendor's terms count from the bill's own date.
      if (billDate < t.txn_date) fail(`The bill date can’t be before the items were received (${t.txn_date}).`);
      await tx.query(`UPDATE txn SET type = 'bill', due_date = $2, doc_number = $3, approval_status = $4, updated_at = now() WHERE txn_id = $1`,
        [txnId, addDays(billDate, v?.due_days ?? 0), no, required ? 'awaiting' : 'approved']);
    } catch (error) {
      if (error?.code === '23505') fail(`Bill number ${no} is already used for this vendor.`);
      throw error;
    }
    await repost(tx, orgId, txnId);
    await logActivity(tx, { orgId, vendorId: t.vendor_id, txnId, actor, kind: 'receipt_billed',
      summary: `Item receipt${t.doc_number ? ` ${t.doc_number}` : ''} turned into bill${no ? ` ${no}` : ''} for ${formatCents(t.total_cents)}` });
    return txnId;
  });
}

// "Save and submit for approval" (stage F1): an unpaid bill goes (back) to waiting for approval.
export async function submitBillForApproval(pool, { orgId, entityId, txnId }) {
  const { rowCount } = await pool.query(`UPDATE txn SET approval_status = 'awaiting', approved_by = NULL, approved_at = NULL, rejected_reason = NULL, updated_at = now()
    WHERE org_id = $1 AND entity_id = $2 AND txn_id = $3 AND type = 'bill' AND voided_at IS NULL AND open_cents = total_cents AND approval_status <> 'awaiting'`,
  [orgId, entityId, txnId]);
  return rowCount > 0;
}
