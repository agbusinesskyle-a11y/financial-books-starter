import PDFDocument from 'pdfkit';
import { ValidationError, EMAIL } from '../data/writes.js';
import { applyStyle, drawFooter } from '../pdf/style.js';
import { formatLongDate } from '../domain/dates.js';
import { PERIOD_LABELS } from './periods.js';
import { reportByKey } from './registry.js';
import { buildReport, getEntity } from './run.js';
import { drawReport, isLandscape } from './output.js';
import { nextRun } from './saved.js';

// Management reports (stage R5a): a package of reports for one period — cover page, contents, an introduction, the
// chosen reports (each with its own options and an optional note) and a closing note — as one PDF; drafts and
// published packages; emailed on a schedule.

const S = (key, title, query = '') => ({ key, title, query });
export const TEMPLATES = [
  ['company_overview', 'Company overview', 'last_month', [S('kpi_scorecard', 'Key performance indicators'), S('profit_and_loss', 'Profit and Loss'),
    S('balance_sheet', 'Balance Sheet'), S('statement_of_cash_flows', 'Statement of Cash Flows')]],
  ['sales_performance', 'Sales performance', 'last_month', [S('sales_by_customer_summary', 'Sales by Customer'), S('sales_by_product_summary', 'Sales by Product/Service'),
    S('income_by_customer_summary', 'Income by Customer'), S('ar_aging_summary', 'A/R Aging')]],
  ['expenses_performance', 'Expenses performance', 'last_month', [S('expenses_by_vendor_summary', 'Expenses by Vendor'),
    S('purchases_by_vendor_summary', 'Purchases by Vendor'), S('profit_and_loss', 'Profit and Loss'), S('ap_aging_summary', 'A/P Aging')]],
  ['monthly_comparison', 'Monthly comparison', 'last_month', [S('profit_and_loss', 'Profit and Loss — this month and last', 'cmp_pp=1&chg=1&pchg=1'),
    S('balance_sheet', 'Balance Sheet — this month and last', 'cmp_pp=1&chg=1')]],
  ['quarterly_comparison', 'Quarterly comparison', 'last_quarter', [S('profit_and_loss', 'Profit and Loss — this quarter and last', 'cmp_pp=1&chg=1&pchg=1'),
    S('balance_sheet', 'Balance Sheet — this quarter and last', 'cmp_pp=1&chg=1')]],
  ['annual_comparison', 'Annual comparison', 'last_year', [S('profit_and_loss', 'Profit and Loss — this year and last', 'cmp_py=1&chg=1&pchg=1'),
    S('balance_sheet', 'Balance Sheet — this year and last', 'cmp_py=1&chg=1')]],
  ['monthly_summary', 'Monthly financial summary', 'last_month', [S('kpi_scorecard', 'Key performance indicators'), S('profit_and_loss', 'Profit and Loss'),
    S('balance_sheet', 'Balance Sheet'), S('statement_of_cash_flows', 'Statement of Cash Flows')]],
  ['quarterly_summary', 'Quarterly financial summary', 'last_quarter', [S('kpi_scorecard', 'Key performance indicators'), S('profit_and_loss', 'Profit and Loss by month', 'columns=months'),
    S('balance_sheet', 'Balance Sheet'), S('statement_of_cash_flows', 'Statement of Cash Flows')]],
  ['annual_summary', 'Annual financial summary', 'last_year', [S('kpi_scorecard', 'Key performance indicators'), S('quarterly_pl', 'Profit and Loss by quarter', 'columns=quarters'),
    S('balance_sheet', 'Balance Sheet'), S('statement_of_cash_flows', 'Statement of Cash Flows')]],
  ['custom', 'Start from scratch', 'last_month', []],
];

const fail = message => { throw new ValidationError(message); };
const text = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, max);
// Admin-only reports (the audit log) can't go in a package: packages are seen by everyone who can see reports.
const cleanSection = s => ({ key: reportByKey(s.key) && !reportByKey(s.key).adminOnly ? s.key : null, title: text(s.title, 120), query: String(s.query ?? '').slice(0, 1500), note: text(s.note, 2000) });

export async function listManagement(db, { orgId, entityId }) {
  return (await db.query('SELECT * FROM mgmt_report WHERE org_id = $1 AND entity_id = $2 ORDER BY status DESC, lower(name)', [orgId, entityId])).rows;
}
export async function getManagement(db, { orgId, entityId, mgmtId }) {
  return (await db.query('SELECT * FROM mgmt_report WHERE org_id = $1 AND entity_id = $2 AND mgmt_id = $3', [orgId, entityId, mgmtId])).rows[0] ?? null;
}

export async function createManagement(db, { orgId, entityId, template, entityName, actor }) {
  const t = TEMPLATES.find(([k]) => k === template) ?? fail('Choose a template.');
  const { rows: [r] } = await db.query(
    `INSERT INTO mgmt_report (org_id, entity_id, name, template, period, cover_title, cover_subtitle, prepared_by, sections, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING mgmt_id`,
    [orgId, entityId, t[1], t[0], t[2], t[1], entityName, actor, JSON.stringify(t[3].map(s => ({ ...s, note: '' }))), actor]);
  return r.mgmt_id;
}

// fields: name, status, period, basis, coverTitle, coverSubtitle, preparedBy, intro, closing, sections [{ key, title, query, note }],
// freq, day, to. today: for the first scheduled date.
export async function saveManagement(db, { orgId, entityId, mgmtId, fields: f, today }) {
  const existing = await getManagement(db, { orgId, entityId, mgmtId }) ?? fail('Management report not found.');
  const name = text(f.name, 120) || fail('Give the management report a name.');
  const sections = (f.sections ?? []).map(cleanSection).filter(s => s.key).slice(0, 30);
  const freq = ['none', 'daily', 'weekly', 'monthly'].includes(f.freq) ? f.freq : 'none';
  const day = Number(f.day);
  if (freq !== 'none' && !Number.isInteger(day)) fail('Choose the day to send it.');
  if (freq === 'weekly' && !(day >= 0 && day <= 6)) fail('Choose a day of the week.');
  if (freq === 'monthly' && !(day >= 1 && day <= 28)) fail('Choose a day of the month from 1 to 28.');
  const to = text(f.to, 1000).split(/[,;\s]+/).filter(Boolean);
  if (freq !== 'none' && (!to.length || to.length > 20 || !to.every(a => EMAIL.test(a)))) fail('Enter who to email it to (up to 20 addresses, separated by commas).');
  if (freq !== 'none' && f.status !== 'published') fail('Publish the management report before scheduling it.');
  const changed = freq !== existing.sched_freq || day !== existing.sched_day;
  await db.query(
    `UPDATE mgmt_report SET name = $3, status = $4, period = $5, basis = $6, cover_title = $7, cover_subtitle = $8, prepared_by = $9, intro = $10, closing = $11,
            sections = $12, sched_freq = $13, sched_day = $14, sched_to = $15, sched_next = $16, updated_at = now()
      WHERE org_id = $1 AND mgmt_id = $2`,
    [orgId, mgmtId, name, f.status === 'published' ? 'published' : 'draft', Object.hasOwn(PERIOD_LABELS, f.period) && f.period !== 'custom' ? f.period : 'last_month',
      f.basis === 'cash' ? 'cash' : 'accrual', text(f.coverTitle, 120) || null, text(f.coverSubtitle, 200) || null, text(f.preparedBy, 120) || null,
      text(f.intro, 5000) || null, text(f.closing, 5000) || null, JSON.stringify(sections), freq, freq === 'daily' ? 1 : day, to.join(', ') || null,
      freq === 'none' ? null : changed || !existing.sched_next ? nextRun(freq, day, today) : existing.sched_next]);
}

export async function deleteManagement(db, { orgId, entityId, mgmtId }) {
  await db.query('DELETE FROM mgmt_report WHERE org_id = $1 AND entity_id = $2 AND mgmt_id = $3', [orgId, entityId, mgmtId]);
}

// Every section runs for the package's period and basis (its other options are its own).
export const sectionQuery = (m, s) => ({ ...Object.fromEntries(new URLSearchParams(s.query)), period: m.period, basis: m.basis, run: '1' });

// The package as one PDF: cover, contents (filled in once the page numbers are known), introduction, each report on
// fresh pages, closing note.
// maxSections / maxYears (the public demo): only the first few sections, each over a bounded span.
export async function managementPdf(db, { orgId, entityId, mgmt: m, today, timeZone, maxSections = null, maxYears = null }) {
  const entity = await getEntity(db, { orgId, entityId });
  const reports = [];
  for (const s of maxSections ? m.sections.slice(0, maxSections) : m.sections) {
    if (!reportByKey(s.key) || reportByKey(s.key).adminOnly) continue;
    const { report } = await buildReport(db, { orgId, entityId, key: s.key, query: sectionQuery(m, s), today, timeZone, maxYears });
    if (report) reports.push({ s, report: { ...report, title: s.title || report.title, note: s.note || null } });
  }
  const doc = new PDFDocument({ size: 'LETTER', margin: 54, bufferPages: true, info: { Title: m.name, Producer: 'Financial Books' } });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  const fb = applyStyle(doc, entity);
  const width = () => doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const period = reports[0]?.report.subtitle ?? PERIOD_LABELS[m.period];
  // Cover.
  if (fb.style.showLogo && entity.logo) { try { doc.image(entity.logo, doc.page.margins.left, 120, { fit: [200, 70] }); } catch { /* skip an unreadable logo */ } }
  doc.font(fb.b).fontSize(26).fillColor(fb.accent).text(m.cover_title || m.name, doc.page.margins.left, 260, { width: width() });
  doc.font(fb.r).fontSize(14).fillColor('#333').text(m.cover_subtitle || entity.name, { width: width() }).moveDown(0.6);
  doc.fontSize(12).text(period, { width: width() }).moveDown(2);
  doc.fontSize(10).fillColor('#555').text([m.prepared_by ? `Prepared by ${m.prepared_by}` : '', formatLongDate(today), m.basis === 'cash' ? 'Cash basis' : 'Accrual basis'].filter(Boolean).join('  ·  '), { width: width() });
  // Contents page (written at the end).
  doc.addPage();
  const contentsPage = doc.bufferedPageRange().count - 1;
  const starts = [];
  if (m.intro) {
    doc.addPage();
    doc.font(fb.b).fontSize(16).fillColor(fb.accent).text('Introduction', { width: width() }).moveDown(0.5);
    doc.font(fb.r).fontSize(11).fillColor('#000').text(m.intro, { width: width() });
  }
  for (const { report } of reports) {
    doc.addPage({ layout: isLandscape(report) ? 'landscape' : 'portrait', margin: 36 });
    starts.push(doc.bufferedPageRange().count);
    drawReport(doc, report, entity, { company: false });
  }
  if (m.closing) {
    doc.addPage({ layout: 'portrait', margin: 54 });
    doc.font(fb.b).fontSize(16).fillColor(fb.accent).text('Notes', { width: width() }).moveDown(0.5);
    doc.font(fb.r).fontSize(11).fillColor('#000').text(m.closing, { width: width() });
  }
  doc.switchToPage(contentsPage);
  doc.font(fb.b).fontSize(16).fillColor(fb.accent).text('Contents', doc.page.margins.left, doc.page.margins.top, { width: width() }).moveDown(1);
  reports.forEach(({ report }, i) => {
    const y = doc.y;
    doc.font(fb.r).fontSize(11).fillColor('#000').text(report.title, doc.page.margins.left, y, { width: width() - 60 });
    doc.text(String(starts[i]), doc.page.margins.left + width() - 50, y, { width: 50, align: 'right' });
    doc.moveDown(0.4);
  });
  const range = doc.bufferedPageRange();
  for (let i = 1; i < range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font(fb.r).fontSize(8).fillColor('#777').text(`${m.name} · page ${i + 1} of ${range.count}`, doc.page.margins.left, doc.page.height - 30, { width: width(), align: 'center' });
    doc.page.margins.bottom = bottom;
  }
  drawFooter(doc);
  doc.end();
  return { body: await done, filename: `${m.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${today}.pdf`, sections: reports.length };
}

// Published packages on a schedule (daily jobs).
export async function runManagementSchedules(db, { orgId, entityId, today, timeZone, mailer }) {
  const { rows } = await db.query(`SELECT * FROM mgmt_report WHERE org_id = $1 AND entity_id = $2 AND status = 'published' AND sched_freq <> 'none' AND sched_next <= $3::date`,
    [orgId, entityId, today]);
  const out = { sent: 0, failed: 0 };
  let m = null;
  for (const r of rows) {
    try {
      m ??= await mailer();
      const pdf = await managementPdf(db, { orgId, entityId, mgmt: r, today, timeZone });
      await m.send({ to: r.sched_to, subject: r.name, text: `${r.name} is attached.\n\nSent on a schedule from Financial Books.`,
        attachments: [{ filename: pdf.filename, content: pdf.body, contentType: 'application/pdf' }] });
      await db.query('UPDATE mgmt_report SET last_sent_at = now(), last_error = NULL, sched_next = $2 WHERE mgmt_id = $1', [r.mgmt_id, nextRun(r.sched_freq, r.sched_day, today)]);
      out.sent++;
    } catch (error) {
      await db.query('UPDATE mgmt_report SET last_error = $2 WHERE mgmt_id = $1', [r.mgmt_id, String(error.message).slice(0, 300)]);
      out.failed++;
    }
  }
  return out;
}
