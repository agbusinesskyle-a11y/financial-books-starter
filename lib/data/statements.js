import { withTransaction } from '../db.js';
import { ValidationError } from './writes.js';
import { getEntity, deliver } from './messages.js';
import { buildStatement, validateStatementRequest, KIND_LABELS } from '../domain/statements.js';
import { addDays, formatShortDate } from '../domain/dates.js';
import { formatCents } from '../domain/money.js';
import { renderStatementPdf } from '../pdf/statement.js';
import { getSalesSettings, renderEmail, emailCopies } from './sales-settings.js';

const fail = message => { throw new ValidationError(message); };
// A foreign-currency customer's statement is in their currency.
const COLS = `txn_id, type, doc_number, payment_ref, txn_date, due_date, statement_memo, coalesce(foreign_total_cents, total_cents) AS total_cents,
  coalesce(foreign_open_cents, open_cents) AS open_cents`;
// Transactions that change what the customer owes.
const LIVE = `org_id = $1 AND customer_id = $2 AND voided_at IS NULL AND type IN ('invoice', 'late_fee', 'payment', 'credit_memo')`;

async function customerFor(pool, { orgId, entityId, customerId }) {
  const { rows } = await pool.query('SELECT customer_id, display_name, email, billing_address FROM customer WHERE org_id = $1 AND entity_id = $2 AND customer_id = $3',
    [orgId, entityId, customerId]);
  return rows[0] ?? fail('Customer not found.');
}

// Computes a statement from the books (not saved). `request`: { kind, statementDate, startDate, endDate }.
export async function computeStatement(pool, { orgId, entityId, customerId, request }) {
  const [content, settings, cust] = await Promise.all([computeContent(pool, { orgId, entityId, customerId, request }), getSalesSettings(pool, { orgId, entityId }),
    pool.query('SELECT currency FROM customer WHERE customer_id = $1', [customerId])]);
  return { ...content, show_aging: settings.statementAging, currency: cust.rows[0]?.currency ?? null };
}

async function computeContent(pool, { orgId, entityId, customerId, request }) {
  const problem = validateStatementRequest(request);
  if (problem) fail(problem);
  await customerFor(pool, { orgId, entityId, customerId });
  const { kind, statementDate, startDate, endDate } = request;
  const q = async (sql, params) => (await pool.query(sql, [orgId, customerId, ...params])).rows;
  // What was still open on the statement date (applications made after it don't count yet), so a statement dated in the
  // past shows what was owed then — the same figure as A/R aging on that date.
  const asOf = `SELECT * FROM (SELECT txn_id, type, doc_number, payment_ref, txn_date, due_date, statement_memo, coalesce(foreign_total_cents, total_cents) AS total_cents,
      coalesce(foreign_total_cents, total_cents) - coalesce((SELECT sum(coalesce(a.foreign_cents, a.amount_cents)) FROM application a
        WHERE (a.charge_txn_id = t.txn_id OR a.credit_txn_id = t.txn_id) AND a.applied_on <= $3), 0)::bigint AS open_cents
    FROM txn t WHERE ${LIVE} AND txn_date <= $3) x WHERE open_cents > 0`;
  const openCharges = await q(`${asOf} AND type IN ('invoice', 'late_fee')`, [statementDate]);
  if (kind === 'open_item') {
    const openItems = await q(asOf, [statementDate]);
    return buildStatement({ kind, statementDate, openItems, openCharges });
  }
  const inRange = await q(`SELECT ${COLS} FROM txn WHERE ${LIVE} AND txn_date BETWEEN $3 AND $4`, [startDate, endDate]);
  if (kind === 'transaction') {
    // Each row's open amount as of the statement date, and the amount due = everything still owed on that date (the
    // same figure as the aging at the bottom and A/R aging), not just what's in the date range.
    const open = new Map((await q(asOf, [statementDate])).map(t => [t.txn_id, t]));
    const rows = inRange.map(t => ({ ...t, open_cents: open.get(t.txn_id)?.open_cents ?? 0 }));
    const owed = [...open.values()].reduce((s, t) => s + (['invoice', 'late_fee'].includes(t.type) ? 1 : -1) * Number(t.open_cents), 0);
    return buildStatement({ kind, statementDate, startDate, endDate, inRange: rows, openCharges, totalDueCents: owed });
  }
  let openingCents = 0;
  if (kind === 'balance_forward') {
    const [row] = await q(
      `SELECT coalesce(sum(CASE WHEN type IN ('invoice', 'late_fee') THEN coalesce(foreign_total_cents, total_cents) ELSE -coalesce(foreign_total_cents, total_cents) END), 0)::bigint AS n
         FROM txn WHERE ${LIVE} AND txn_date <= $3`, [addDays(startDate, -1)]);
    openingCents = row.n;
  }
  return buildStatement({ kind, statementDate, startDate, endDate, openingCents, inRange, openCharges });
}

export async function statementPreviewPdf(pool, { orgId, entityId, customerId, request }) {
  const [content, entity, customer] = await Promise.all([
    computeStatement(pool, { orgId, entityId, customerId, request }), getEntity(pool, { orgId, entityId }), customerFor(pool, { orgId, entityId, customerId })]);
  return renderStatementPdf({ entity, customer, content });
}

// Saves a statement snapshot and logs it. Returns the statement id.
export async function createStatement(pool, { orgId, entityId, customerId, request, actor }) {
  const content = await computeStatement(pool, { orgId, entityId, customerId, request });
  return withTransaction(pool, async tx => {
    const { rows } = await tx.query(
      `INSERT INTO statement (org_id, entity_id, customer_id, kind, statement_date, start_date, end_date, total_due_cents, content)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING statement_id`,
      [orgId, entityId, customerId, content.kind, content.statement_date, content.start_date, content.end_date, content.total_due_cents, content]);
    await tx.query('INSERT INTO activity_event (org_id, customer_id, kind, summary, actor) VALUES ($1,$2,$3,$4,$5)',
      [orgId, customerId, 'statement_created', `${KIND_LABELS[content.kind]} statement created (${formatCents(content.total_due_cents)} due)`, actor]);
    return rows[0].statement_id;
  });
}

export async function listStatements(pool, { orgId, customerId }) {
  const { rows } = await pool.query(
    `SELECT statement_id, kind, statement_date, start_date, end_date, total_due_cents, created_at, sent_at, sent_to
       FROM statement WHERE org_id = $1 AND customer_id = $2 ORDER BY created_at DESC, statement_id DESC`, [orgId, customerId]);
  return rows;
}

export async function getStatement(pool, { orgId, entityId, statementId }) {
  const { rows } = await pool.query('SELECT * FROM statement WHERE org_id = $1 AND entity_id = $2 AND statement_id = $3', [orgId, entityId, statementId]);
  return rows[0] ?? null;
}

export async function statementPdf(pool, { orgId, entityId, statement }) {
  const [entity, customer] = await Promise.all([getEntity(pool, { orgId, entityId }), customerFor(pool, { orgId, entityId, customerId: statement.customer_id })]);
  return renderStatementPdf({ entity, customer, content: statement.content });
}

export const statementFilename = s => `statement-${s.statement_date}.pdf`;

export async function sendStatement(pool, mailer, { orgId, entityId, statementId, actor }) {
  const s = await getStatement(pool, { orgId, entityId, statementId }) ?? fail('Statement not found.');
  const customer = await customerFor(pool, { orgId, entityId, customerId: s.customer_id });
  if (!customer.email) fail(`${customer.display_name} has no email address. Add one in Customer Details.`);
  const [entity, settings] = await Promise.all([getEntity(pool, { orgId, entityId }), getSalesSettings(pool, { orgId, entityId })]);
  const pdf = await renderStatementPdf({ entity, customer, content: s.content });
  const due = s.total_due_cents;
  const { subject, text } = renderEmail(settings, 'statement', { customer: customer.display_name, company: entity.name, number: '',
    amount: formatCents(due), balance: due < 0 ? `${formatCents(-due)} in credit` : formatCents(due), due_date: formatShortDate(s.statement_date) }, entity.style.footer);
  return deliver(pool, mailer, {
    orgId, customerId: s.customer_id, to: customer.email, fromFallback: entity.email, subject, text, ...emailCopies(settings, entity),
    attachments: [{ filename: statementFilename(s), content: pdf, contentType: 'application/pdf' }], relatedStatementId: s.statement_id, actor,
    activityKind: 'statement_sent', activitySummary: `Statement dated ${formatShortDate(s.statement_date)}`,
    afterRecord: async (tx, status) => {
      if (status !== 'failed') await tx.query('UPDATE statement SET sent_at = now(), sent_to = $3 WHERE org_id = $1 AND statement_id = $2', [orgId, s.statement_id, customer.email]);
    },
  });
}
