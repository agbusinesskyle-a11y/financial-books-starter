import { listAccounts, systemAccounts } from '../data/ledger.js';
import { getAccountingSettings } from '../data/accounting.js';
import { getEntity } from '../data/messages.js';
import { runReport } from './engine.js';
import { formatShortDate } from '../domain/dates.js';
import { reportCsv, reportXlsx, reportPdf, reportFilename } from './output.js';

// Runs a report for a company with everything it needs (settings, accounts, its note), for the report page, scheduled
// emails and management report packages alike.
export async function buildReport(db, { orgId, entityId, key, query, today, timeZone }) {
  const scope = { orgId, entityId };
  const [accounting, accounts, sys, note] = await Promise.all([getAccountingSettings(db, scope), listAccounts(db, scope), systemAccounts(db, orgId, entityId),
    db.query('SELECT note, updated_by FROM report_note WHERE org_id = $1 AND entity_id = $2 AND report_key = $3', [orgId, entityId, key]).then(r => r.rows[0] ?? null)]);
  const report = await runReport(db, { ...scope, key, query, today, accounting, accounts, retainedAccountId: sys.retained, timeZone });
  if (report) { report.note = note?.note ?? null; report.preparedOn = formatShortDate(today); }
  return { report, accounts, note };
}

export const FORMAT_TYPES = { csv: 'text/csv; charset=utf-8', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf' };

export async function renderReport(report, entity, format) {
  const body = format === 'csv' ? Buffer.from(reportCsv(report, entity.name)) : format === 'xlsx' ? await reportXlsx(report, entity.name) : await reportPdf(report, entity);
  return { body, type: FORMAT_TYPES[format], filename: reportFilename(report, format) };
}

export { getEntity };
