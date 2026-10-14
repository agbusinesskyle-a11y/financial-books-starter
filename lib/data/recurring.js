import { formId } from '../domain/ids.js';
import { withTransaction } from '../db.js';
import { ValidationError, lockEntity, logActivity, writeSalesDoc, parseLines } from './writes.js';
import { writeVendorDoc, parseVendorLines, payFromAccount } from './payables.js';
import { nextOnOrAfter, validateRule } from '../domain/schedule.js';
import { addDays } from '../domain/dates.js';
import { centsToInput } from '../domain/money.js';
import { quantityToSql } from '../domain/lines.js';

const fail = message => { throw new ValidationError(message); };
const MODES = ['scheduled', 'reminder', 'unscheduled'];
const TYPES = ['invoice', 'sales_receipt'];
export const VENDOR_TEMPLATE_TYPES = ['bill', 'expense', 'check'];
const CATCH_UP_MAX = 60; // runs per template per job pass

const ruleOf = t => ({ unit: t.interval_unit, count: t.interval_count, start: t.start_date, end: t.end_date });

// A customer's (customerId) or a vendor's (vendorId) templates.
export async function listTemplates(pool, { orgId, customerId = null, vendorId = null }) {
  const { rows } = await pool.query(
    `SELECT r.*, coalesce((SELECT sum(amount_cents) FROM recurring_template_line l WHERE l.template_id = r.template_id), 0)::bigint AS total_cents,
            (SELECT max(run_date) FROM recurring_run x WHERE x.template_id = r.template_id) AS last_run_date
       FROM recurring_template r WHERE r.org_id = $1 AND ${vendorId ? 'r.vendor_id' : 'r.customer_id'} = $2
      ORDER BY r.active DESC, lower(r.name)`, [orgId, vendorId ?? customerId]);
  return rows;
}

export async function getTemplate(pool, { orgId, entityId, templateId }) {
  const { rows } = await pool.query('SELECT * FROM recurring_template WHERE org_id = $1 AND entity_id = $2 AND template_id = $3', [orgId, entityId, templateId]);
  if (!rows[0]) return null;
  const lines = await pool.query(
    `SELECT line_no, item_id, account_id, customer_id, project_id, description, quantity, rate_cents, amount_cents FROM recurring_template_line
      WHERE template_id = $1 ORDER BY line_no`, [templateId]);
  return { ...rows[0], lines: lines.rows };
}

// Template lines as editor rows (strings), for the template form and for "Use template".
export const templateLineRows = t => t.lines.map(l => ({
  itemId: l.item_id ? String(l.item_id) : '', description: l.description ?? '', quantity: String(Number(l.quantity)), rate: centsToInput(l.rate_cents),
}));

// A vendor template's lines as vendor-editor rows: { categoryLines, itemLines }.
export const vendorTemplateRows = t => ({
  categoryLines: t.lines.filter(l => !l.item_id).map(l => ({ accountId: l.account_id ? String(l.account_id) : '', description: l.description ?? '',
    amount: centsToInput(l.amount_cents), customerId: l.customer_id ? String(l.customer_id) : '', projectId: l.project_id ? String(l.project_id) : '' })),
  itemLines: t.lines.filter(l => l.item_id).map(l => ({ itemId: String(l.item_id), description: l.description ?? '', quantity: String(Number(l.quantity)),
    rate: centsToInput(l.rate_cents), customerId: l.customer_id ? String(l.customer_id) : '', projectId: l.project_id ? String(l.project_id) : '' })),
});

// The next date this template should run, on or after `from`, skipping a date already run.
async function computeNext(q, t, from) {
  if (t.mode === 'unscheduled') return null;
  let next = nextOnOrAfter(ruleOf(t), from > t.start_date ? from : t.start_date);
  if (next && t.template_id) {
    const done = await q.query('SELECT 1 FROM recurring_run WHERE template_id = $1 AND run_date = $2', [t.template_id, next]);
    if (done.rowCount) next = nextOnOrAfter(ruleOf(t), addDays(next, 1));
  }
  return next;
}

// fields: { name, txnType, mode, unit, count, startDate, endDate, termsId, memo, autoSend, lines: [{itemId, description, quantity, rate}] }.
// The first run is the first scheduled date on or after today (a start date in the past doesn't back-create).
// Vendor templates: pass vendorId (instead of customerId) and fields.accountId / categoryLines / itemLines.
export async function saveTemplate(pool, { orgId, entityId, customerId = null, vendorId = null, templateId = null, fields: f, today, actor }) {
  const name = String(f.name ?? '').trim().slice(0, 100);
  if (!name) fail(vendorId ? 'Give the template a name, like “Monthly rent”.' : 'Give the template a name, like “Monthly hay delivery”.');
  if (vendorId ? !VENDOR_TEMPLATE_TYPES.includes(f.txnType) : !TYPES.includes(f.txnType)) fail(vendorId ? 'Choose bill, expense or check.' : 'Choose invoice or sales receipt.');
  if (!MODES.includes(f.mode)) fail('Choose how the template runs.');
  const scheduled = f.mode !== 'unscheduled';
  const count = Number(f.count);
  const startDate = String(f.startDate ?? '').trim(), endDate = String(f.endDate ?? '').trim() || null;
  if (scheduled) {
    const problem = validateRule({ unit: f.unit, count, start: startDate, end: endDate });
    if (problem) fail(problem);
  }
  const termsId = formId(f.termsId, () => fail('One of the choices isn’t valid. Reload the page and try again.'));
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const who = vendorId ? 'vendor' : 'customer';
    const c = await tx.query(`SELECT 1 FROM ${who} WHERE org_id = $1 AND entity_id = $2 AND ${who}_id = $3`, [orgId, entityId, vendorId ?? customerId]);
    if (!c.rowCount) fail(vendorId ? 'Vendor not found.' : 'Customer not found.');
    if (termsId !== null && !(await tx.query('SELECT 1 FROM terms WHERE org_id = $1 AND terms_id = $2 AND entity_id = $3', [orgId, termsId, entityId])).rowCount) fail('Choose valid terms.');
    let lines, accountId = null;
    if (vendorId) {
      lines = await parseVendorLines(tx, { orgId, entityId, categoryLines: f.categoryLines ?? [], itemLines: f.itemLines ?? [] });
      if (f.txnType !== 'bill') {
        accountId = formId(f.accountId, () => fail('Choose the account the money comes from.')) ?? fail('Choose the account the money comes from.');
        await payFromAccount(tx, orgId, entityId, f.txnType, accountId);
      }
    } else {
      const items = await tx.query('SELECT item_id, name, rate_cents FROM item WHERE org_id = $1 AND entity_id = $2', [orgId, entityId]);
      lines = parseLines(f.lines, new Map(items.rows.map(i => [i.item_id, i])));
    }
    if (lines.reduce((s, l) => s + l.amountCents, 0) <= 0) fail('The total must be more than $0.00.');
    const row = {
      template_id: templateId, mode: f.mode, interval_unit: scheduled ? f.unit : null, interval_count: scheduled ? count : null,
      start_date: scheduled ? startDate : null, end_date: scheduled ? endDate : null,
    };
    const next = await computeNext(tx, row, today);
    const values = [name, f.txnType, f.mode, row.interval_unit, row.interval_count, row.start_date, row.end_date, next, termsId,
      String(f.memo ?? '').trim().slice(0, 1000) || null, !vendorId && f.mode === 'scheduled' && f.autoSend === true, accountId];
    try {
      if (templateId) {
        const { rowCount } = await tx.query(
          `UPDATE recurring_template SET name = $4, txn_type = $5, mode = $6, interval_unit = $7, interval_count = $8, start_date = $9, end_date = $10,
                  next_run_date = CASE WHEN active THEN $11::date END, terms_id = $12, memo = $13, auto_send = $14, account_id = $15, updated_at = now()
            WHERE org_id = $1 AND entity_id = $2 AND template_id = $3`, [orgId, entityId, templateId, ...values]);
        if (!rowCount) fail('Template not found.');
        await tx.query('DELETE FROM recurring_template_line WHERE template_id = $1', [templateId]);
      } else {
        templateId = (await tx.query(
          `INSERT INTO recurring_template (org_id, entity_id, customer_id, vendor_id, name, txn_type, mode, interval_unit, interval_count, start_date, end_date,
             next_run_date, terms_id, memo, auto_send, account_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING template_id`, [orgId, entityId, customerId, vendorId, ...values])).rows[0].template_id;
      }
    } catch (error) {
      if (error?.code === '23505') fail(`This ${vendorId ? 'vendor' : 'customer'} already has a template named “${name}”.`);
      throw error;
    }
    for (const [i, l] of lines.entries()) {
      await tx.query(
        `INSERT INTO recurring_template_line (org_id, template_id, line_no, item_id, account_id, customer_id, project_id, description, quantity, rate_cents, amount_cents)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [orgId, templateId, i + 1, l.itemId, l.accountId ?? null, l.customerId ?? null, l.projectId ?? null,
          l.description, quantityToSql(l.qty), l.rateCents, l.amountCents]);
    }
    await logActivity(tx, { orgId, customerId, vendorId, actor, kind: 'recurring_saved', summary: `Recurring template “${name}” ${f.isNew ? 'created' : 'updated'}` });
    return templateId;
  });
}

// Pause / resume. Resuming starts again from today: runs missed while paused are skipped.
export async function setTemplateActive(pool, { orgId, entityId, templateId, active, today, actor }) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const { rows: [t] } = await tx.query('SELECT * FROM recurring_template WHERE org_id = $1 AND entity_id = $2 AND template_id = $3 FOR UPDATE', [orgId, entityId, templateId]);
    if (!t) fail('Template not found.');
    const next = active ? await computeNext(tx, t, today) : null;
    await tx.query('UPDATE recurring_template SET active = $2, next_run_date = $3, updated_at = now() WHERE template_id = $1', [templateId, active, next]);
    await logActivity(tx, { orgId, customerId: t.customer_id, vendorId: t.vendor_id, actor, kind: 'recurring_saved', summary: `Recurring template “${t.name}” ${active ? 'resumed' : 'paused'}` });
    return t;
  });
}

export async function deleteTemplate(pool, { orgId, entityId, templateId, actor }) {
  return withTransaction(pool, async tx => {
    await lockEntity(tx, orgId, entityId);
    const { rows: [t] } = await tx.query('DELETE FROM recurring_template WHERE org_id = $1 AND entity_id = $2 AND template_id = $3 RETURNING customer_id, vendor_id, name',
      [orgId, entityId, templateId]);
    if (!t) fail('Template not found.');
    await logActivity(tx, { orgId, customerId: t.customer_id, vendorId: t.vendor_id, actor, kind: 'recurring_deleted', summary: `Recurring template “${t.name}” deleted` });
    return t;
  });
}

// Daily job: runs every active scheduled/reminder template due through `today`, catching up missed
// dates. recurring_run (template, date) makes it safe to run repeatedly. Returns
// [{ templateId, runDate, outcome, txnId, autoSend }] for this pass.
export async function runRecurring(pool, { orgId, entityId, today, actor = 'system' }) {
  const { rows: due } = await pool.query(
    `SELECT template_id FROM recurring_template
      WHERE org_id = $1 AND entity_id = $2 AND active AND mode <> 'unscheduled' AND next_run_date <= $3 ORDER BY next_run_date, template_id`,
    [orgId, entityId, today]);
  const results = [];
  for (const { template_id: templateId } of due) {
    for (let i = 0; i < CATCH_UP_MAX; i++) {
      const r = await withTransaction(pool, async tx => {
        await lockEntity(tx, orgId, entityId);
        const { rows: [t] } = await tx.query('SELECT * FROM recurring_template WHERE template_id = $1 FOR UPDATE', [templateId]);
        if (!t || !t.active || t.mode === 'unscheduled' || !t.next_run_date || t.next_run_date > today) return null;
        const runDate = t.next_run_date;
        const advance = async () => tx.query('UPDATE recurring_template SET next_run_date = $2 WHERE template_id = $1',
          [templateId, nextOnOrAfter(ruleOf(t), addDays(runDate, 1))]);
        if ((await tx.query('SELECT 1 FROM recurring_run WHERE template_id = $1 AND run_date = $2', [templateId, runDate])).rowCount) {
          await advance();
          return { templateId, runDate, outcome: 'skipped' };
        }
        let outcome, txnId = null, error = null;
        if (t.mode === 'reminder') {
          outcome = 'reminded';
          await logActivity(tx, { orgId, customerId: t.customer_id, vendorId: t.vendor_id, actor, kind: 'recurring_reminder', data: { template_id: templateId },
            summary: `Reminder: create the ${{ invoice: 'invoice', sales_receipt: 'sales receipt', bill: 'bill', expense: 'expense', check: 'check' }[t.txn_type]} from recurring template “${t.name}”` });
        } else {
          const { rows: lines } = await tx.query('SELECT * FROM recurring_template_line WHERE template_id = $1 ORDER BY line_no', [templateId]);
          await tx.query('SAVEPOINT recurring_create');
          try {
            txnId = t.vendor_id
              ? await writeVendorDoc(tx, { orgId, entityId, vendorId: t.vendor_id, type: t.txn_type, actor, txnDate: runDate, termsId: t.terms_id, memo: t.memo,
                accountId: t.account_id, ...vendorTemplateRows({ lines }), recurringTemplateId: templateId, activitySuffix: ` from recurring template “${t.name}”` })
              : await writeSalesDoc(tx, {
                orgId, entityId, customerId: t.customer_id, type: t.txn_type, actor, txnDate: runDate, termsId: t.terms_id, memo: t.memo,
                lines: templateLineRows({ lines }), recurringTemplateId: templateId, activitySuffix: ` from recurring template “${t.name}”`,
              });
            outcome = 'created';
          } catch (e) {
            if (!(e instanceof ValidationError)) throw e;
            await tx.query('ROLLBACK TO SAVEPOINT recurring_create');
            outcome = 'failed';
            error = e.message;
            await logActivity(tx, { orgId, customerId: t.customer_id, vendorId: t.vendor_id, actor, kind: 'recurring_failed',
              summary: `Recurring template “${t.name}” couldn’t create its ${runDate} transaction: ${e.message}` });
          }
        }
        await tx.query('INSERT INTO recurring_run (org_id, template_id, run_date, outcome, txn_id, error) VALUES ($1,$2,$3,$4,$5,$6)',
          [orgId, templateId, runDate, outcome, txnId, error]);
        await advance();
        return { templateId, runDate, outcome, txnId, autoSend: t.auto_send && outcome === 'created' };
      });
      if (!r) break;
      if (r.outcome !== 'skipped') results.push(r);
    }
  }
  return results;
}
