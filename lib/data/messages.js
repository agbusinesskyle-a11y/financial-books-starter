import { withTransaction } from '../db.js';
import { getTransaction } from './transactions.js';
import { ValidationError, EMAIL } from './writes.js';
import { renderTransactionsPdf } from '../pdf/transaction.js';
import { formatCents } from '../domain/money.js';
import { formatShortDate } from '../domain/dates.js';
import { TYPE_LABELS } from '../domain/status.js';
import { getFormStyle, getSalesSettings, renderEmail, emailCopies } from './sales-settings.js';
import { createPayLink } from './online-payments.js';
import { formatMoney } from '../domain/fx.js';

const fail = message => { throw new ValidationError(message); };

// The company as customers see it on PDFs and emails: customer-facing email/address (falling back to the company's),
// its form style, and its logo when the style shows one. `replyEmail` is the company's own address.
export async function getEntity(pool, { orgId, entityId }) {
  const [{ rows }, style] = await Promise.all([pool.query(
    `SELECT entity_id, name, coalesce(customer_email, email) AS email, email AS own_email, phone, coalesce(customer_address, address) AS address,
            time_zone, website, legal_name, logo
       FROM entity WHERE org_id = $1 AND entity_id = $2`, [orgId, entityId]), getFormStyle(pool, { orgId, entityId })]);
  const e = rows[0];
  if (!e) return e;
  return { ...e, logo: style.showLogo ? e.logo : null, style };
}

// Full transactions (lines, applications, customer) in the order given, all from this entity.
export async function loadForPdf(pool, { orgId, entityId, txnIds }) {
  const out = [];
  for (const id of txnIds) {
    const t = await getTransaction(pool, { orgId, id });
    if (!t || t.entity_id !== entityId) throw new ValidationError('Transaction not found.');
    const { rows } = await pool.query('SELECT display_name, billing_address, shipping_address, shipping_same_as_billing, email, cc, bcc FROM customer WHERE org_id = $1 AND customer_id = $2', [orgId, t.customer_id]);
    out.push({ ...t, customer: rows[0] });
  }
  return out;
}

export async function transactionsPdf(pool, { orgId, entityId, txnIds, packingSlip = false }) {
  const [entity, txns] = await Promise.all([getEntity(pool, { orgId, entityId }), loadForPdf(pool, { orgId, entityId, txnIds })]);
  return renderTransactionsPdf({ entity, txns, packingSlip });
}

// Sends one email through `mailer` and records it: a message row and an activity event, in one
// transaction. A mailer error is recorded as a failed message, not thrown. `afterRecord(tx, status)`
// lets callers update their own rows in the same transaction. Returns 'sent' | 'logged' | 'failed'.
// recordText: what to keep in the message record instead of `text` (e.g. with a one-time link removed).
export async function deliver(pool, mailer, { orgId, customerId = null, vendorId = null, recordText = null, to, cc = null, bcc = null, fromFallback = null, subject, text, attachments = [], relatedTxnId = null,
  relatedStatementId = null, actor, activityKind, activitySummary, afterRecord = null }) {
  let result;
  try {
    result = await mailer.send({ to, cc, bcc, subject, text, attachments });
  } catch (error) {
    result = { status: 'failed', error: error.message };
  }
  const verb = { sent: 'emailed', logged: 'recorded as sent (email not set up in Settings)', failed: 'failed to send' }[result.status];
  await withTransaction(pool, async tx => {
    await tx.query(
      `INSERT INTO message (org_id, customer_id, vendor_id, direction, subject, body, to_addr, from_addr, related_txn_id, related_statement_id, status, error)
       VALUES ($1,$2,$3,'out',$4,$5,$6,$7,$8,$9,$10,$11)`,
      [orgId, customerId, vendorId, subject, recordText ?? text, to, mailer.from ?? fromFallback, relatedTxnId, relatedStatementId, result.status, result.error ?? null]);
    await tx.query(
      'INSERT INTO activity_event (org_id, customer_id, vendor_id, txn_id, kind, summary, actor) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [orgId, customerId, vendorId, relatedTxnId, result.status === 'failed' ? 'email_failed' : activityKind,
        `${activitySummary} ${verb} to ${to}`.replace(/\s+/g, ' '), actor]);
    if (afterRecord) await afterRecord(tx, result.status);
  });
  return result.status;
}

// Placeholder values for a customer transaction's email.
// (A foreign-currency document's amounts are in its currency.)
export const txnEmailValues = (entity, t) => ({
  customer: t.customer.display_name, company: entity.name, number: t.doc_number ?? t.payment_ref ?? '',
  amount: formatMoney(t.currency ? t.foreign_total_cents : t.total_cents, t.currency),
  balance: formatMoney(t.currency ? t.foreign_open_cents : t.open_cents, t.currency), due_date: t.due_date ? formatShortDate(t.due_date) : formatShortDate(t.txn_date),
});
const TEMPLATE_FOR = { invoice: 'invoice', late_fee: 'invoice', sales_receipt: 'sales_receipt', credit_memo: 'credit_memo', payment: 'payment', estimate: 'estimate' };

// Emails one transaction as a PDF and records the message + activity. Returns the message status.
// origin: the app's address; with online payments on, an invoice email gets a one-time "Pay now" link (not kept in the record).
// This transaction's Cc / Bcc (stage F4; else the customer's), with the company's own copies.
function txnCopies(t, company) {
  const join = (...xs) => [...new Set(xs.filter(Boolean).flatMap(x => String(x).split(/[,;]/).map(s => s.trim()).filter(Boolean)))].join(', ') || null;
  return { cc: join(company.cc, t.email_cc ?? t.customer.cc), bcc: join(company.bcc, t.email_bcc ?? t.customer.bcc) };
}

export async function sendTransaction(pool, mailer, { orgId, entityId, txnId, actor, origin = null }) {
  const [entity, settings] = await Promise.all([getEntity(pool, { orgId, entityId }), getSalesSettings(pool, { orgId, entityId })]);
  const [t] = await loadForPdf(pool, { orgId, entityId, txnIds: [txnId] });
  if (t.voided_at) fail('A voided transaction can’t be sent.');
  if (!t.customer.email) fail(`${t.customer.display_name} has no email address. Add one in Customer Details.`);
  const pdf = await renderTransactionsPdf({ entity, txns: [t] });
  let { subject, text } = renderEmail(settings, TEMPLATE_FOR[t.type], txnEmailValues(entity, t), entity.style.footer);
  let recordText = null;
  const token = origin && (t.type === 'invoice' || t.type === 'late_fee') ? await createPayLink(pool, { orgId, entityId, txnId: t.txn_id }) : null;
  if (token) {
    const pay = `Pay online: ${origin}/pay/${token}`;
    recordText = `${text}\n\nPay online: (one-time payment link, not kept)`;
    text = `${text}\n\n${pay}`;
  }
  const filename = `${(t.doc_number ?? t.payment_ref ?? `${t.type}-${t.txn_id}`).replace(/[^A-Za-z0-9-]+/g, '-')}.pdf`;
  return deliver(pool, mailer, {
    orgId, customerId: t.customer_id, to: t.customer.email, fromFallback: entity.email, subject, text, recordText, ...txnCopies(t, emailCopies(settings, entity)),
    attachments: [{ filename, content: pdf, contentType: 'application/pdf' }], relatedTxnId: t.txn_id, actor,
    activityKind: `${t.type}_sent`, activitySummary: `${TYPE_LABELS[t.type]} ${t.doc_number ?? t.payment_ref ?? ''}`,
  });
}

// ---- Conversations ----

// Every message with this customer, newest first, with what it was about.
export async function listMessages(pool, { orgId, customerId, limit = 200 }) {
  const { rows } = await pool.query(
    `SELECT m.message_id, m.direction, m.subject, m.body, m.to_addr, m.from_addr, m.status, m.error, m.occurred_at,
            m.related_txn_id, t.type AS txn_type, t.doc_number, t.payment_ref, m.related_statement_id
       FROM message m LEFT JOIN txn t ON t.org_id = m.org_id AND t.txn_id = m.related_txn_id
      WHERE m.org_id = $1 AND m.customer_id = $2
      ORDER BY m.occurred_at DESC, m.message_id DESC LIMIT $3`, [orgId, customerId, limit]);
  return rows;
}

const clean = (v, max) => String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);

async function customerOf(pool, { orgId, entityId, customerId }) {
  const { rows } = await pool.query('SELECT customer_id, display_name, email FROM customer WHERE org_id = $1 AND entity_id = $2 AND customer_id = $3', [orgId, entityId, customerId]);
  return rows[0] ?? fail('Customer not found.');
}

// Compose: a plain email to the customer through the company's mailer.
export async function sendCustomerEmail(pool, mailer, { orgId, entityId, customerId, to, subject, body, actor }) {
  const c = await customerOf(pool, { orgId, entityId, customerId });
  const address = clean(to, 200);
  if (!EMAIL.test(address)) fail('Enter the email address to send to.');
  const s = clean(subject, 200);
  if (!s) fail('Enter a subject.');
  const text = clean(body, 20_000);
  if (!text) fail('Write a message.');
  const entity = await getEntity(pool, { orgId, entityId });
  return deliver(pool, mailer, { orgId, customerId: c.customer_id, to: address, fromFallback: entity.email, subject: s, text, actor,
    activityKind: 'email_sent', activitySummary: `Email “${s}”` });
}

// Records a reply the customer sent (pasted in by hand; inbound mail isn't received automatically).
export async function logReply(pool, { orgId, entityId, customerId, from, subject, body, actor }) {
  const c = await customerOf(pool, { orgId, entityId, customerId });
  const address = clean(from, 200) || c.email || null;
  if (address && !EMAIL.test(address)) fail('The “from” address doesn’t look like an email address.');
  const text = clean(body, 20_000);
  if (!text) fail('Paste the customer’s reply.');
  const s = clean(subject, 200) || null;
  await withTransaction(pool, async tx => {
    await tx.query(
      `INSERT INTO message (org_id, customer_id, direction, subject, body, from_addr, status) VALUES ($1,$2,'in',$3,$4,$5,'received')`,
      [orgId, c.customer_id, s, text, address]);
    await tx.query(
      'INSERT INTO activity_event (org_id, customer_id, kind, summary, actor) VALUES ($1,$2,$3,$4,$5)',
      [orgId, c.customer_id, 'reply_logged', `Reply from ${address ?? c.display_name} logged${s ? `: “${s}”` : ''}`, actor]);
  });
}

// ---- automatic invoice reminders (Settings → Messages and reminders), run by the daily job ----

// Sends every reminder due today: one per invoice per rule, ever. Invoices due before reminders were turned on are left
// alone, and a reminder more than a week late is skipped rather than sent. Returns { sent, failed }.
export async function runReminders(pool, mailerFn, { orgId, entityId, today }) {
  const settings = await getSalesSettings(pool, { orgId, entityId });
  const out = { sent: 0, failed: 0 };
  if (!settings.remindersOn || !settings.reminderRules.length) return out;
  let mailer = null;
  for (const { days } of settings.reminderRules) {
    const { rows } = await pool.query(
      `SELECT t.txn_id FROM txn t JOIN customer c ON c.customer_id = t.customer_id
        WHERE t.org_id = $1 AND t.entity_id = $2 AND t.type = 'invoice' AND t.voided_at IS NULL AND t.open_cents > 0
          AND c.email IS NOT NULL AND NOT c.no_reminders AND t.due_date >= $5
          AND t.due_date + $3::int BETWEEN $4::date - 6 AND $4::date
          AND NOT EXISTS (SELECT 1 FROM invoice_reminder r WHERE r.txn_id = t.txn_id AND r.rule_days = $3)
        ORDER BY t.due_date, t.txn_id`, [orgId, entityId, days, today, settings.remindersFrom]);
    for (const { txn_id: txnId } of rows) {
      mailer ??= await mailerFn();
      // Claim it first so two runs can never both send it.
      const claim = await pool.query(`INSERT INTO invoice_reminder (org_id, txn_id, rule_days, status) VALUES ($1,$2,$3,'sending')
        ON CONFLICT DO NOTHING RETURNING txn_id`, [orgId, txnId, days]);
      if (!claim.rowCount) continue;
      let status;
      try { status = await sendReminder(pool, mailer, { orgId, entityId, txnId, settings }); } catch (error) {
        console.error(`reminder for txn ${txnId} failed: ${error.message}`);
        status = 'failed';
      }
      await pool.query('UPDATE invoice_reminder SET status = $3 WHERE txn_id = $1 AND rule_days = $2', [txnId, days, status]);
      if (status === 'failed') out.failed++; else out.sent++;
    }
  }
  return out;
}

// "Send reminder" from a row or batch: the reminder email now, for an open invoice whose customer has an email address.
export async function sendReminderNow(pool, mailer, { orgId, entityId, txnId, actor }) {
  const [t] = await loadForPdf(pool, { orgId, entityId, txnIds: [txnId] });
  if (!t || !['invoice', 'late_fee'].includes(t.type)) fail('Reminders are for invoices.');
  if (t.voided_at || Number(t.open_cents) <= 0) fail(`${TYPE_LABELS[t.type]} ${t.doc_number ?? ''} has nothing left to pay.`);
  if (!t.customer.email) fail(`${t.customer.display_name} has no email address. Add one in Customer Details.`);
  return sendReminder(pool, mailer, { orgId, entityId, txnId, settings: await getSalesSettings(pool, { orgId, entityId }), actor });
}

async function sendReminder(pool, mailer, { orgId, entityId, txnId, settings, actor = 'system' }) {
  const entity = await getEntity(pool, { orgId, entityId });
  const [t] = await loadForPdf(pool, { orgId, entityId, txnIds: [txnId] });
  const pdf = await renderTransactionsPdf({ entity, txns: [t] });
  const { subject, text } = renderEmail(settings, 'reminder', txnEmailValues(entity, t), entity.style.footer);
  return deliver(pool, mailer, {
    orgId, customerId: t.customer_id, to: t.customer.email, fromFallback: entity.email, subject, text, ...emailCopies(settings, entity),
    attachments: [{ filename: `${(t.doc_number ?? `invoice-${t.txn_id}`).replace(/[^A-Za-z0-9-]+/g, '-')}.pdf`, content: pdf, contentType: 'application/pdf' }],
    relatedTxnId: t.txn_id, actor, activityKind: 'reminder_sent', activitySummary: `Reminder for invoice ${t.doc_number ?? ''}`,
  });
}

// Stage F4 — Email view: exactly what "send" would email (to, copies, subject, words), without sending.
export async function previewTransactionEmail(pool, { orgId, entityId, txnId }) {
  const [entity, settings] = await Promise.all([getEntity(pool, { orgId, entityId }), getSalesSettings(pool, { orgId, entityId })]);
  const [t] = await loadForPdf(pool, { orgId, entityId, txnIds: [txnId] });
  const { subject, text } = renderEmail(settings, TEMPLATE_FOR[t.type], txnEmailValues(entity, t), entity.style.footer);
  return { to: t.customer.email ?? null, ...txnCopies(t, emailCopies(settings, entity)), subject, text, txn: t, entity };
}

// Stage F4 — Print later / Send later: what's waiting, and doing them.
export async function salesQueue(db, { orgId, entityId, which }) {
  const flag = which === 'send' ? 'send_later' : 'print_later';
  const { rows } = await db.query(`SELECT t.txn_id, t.type, t.doc_number, t.txn_date, t.total_cents, c.display_name AS customer, c.email
    FROM txn t JOIN customer c ON c.customer_id = t.customer_id WHERE t.org_id = $1 AND t.entity_id = $2 AND t.${flag} AND t.voided_at IS NULL
    ORDER BY t.txn_date, t.txn_id`, [orgId, entityId]);
  return rows;
}
export async function clearQueued(db, { orgId, entityId, which, txnIds }) {
  const flag = which === 'send' ? 'send_later' : 'print_later';
  await db.query(`UPDATE txn SET ${flag} = false WHERE org_id = $1 AND entity_id = $2 AND txn_id = ANY($3::bigint[])`, [orgId, entityId, txnIds]);
}
