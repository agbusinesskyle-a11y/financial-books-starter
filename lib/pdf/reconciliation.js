import PDFDocument from 'pdfkit';
import { formatCents } from '../domain/money.js';
import { formatShortDate } from '../domain/dates.js';
import { TYPE_LABELS } from '../domain/status.js';
import { applyStyle, drawHeader, drawFooter } from './style.js';

// The report for one finished reconciliation: the balances and every transaction it cleared.
export function renderReconciliationPdf({ entity, rec: r }) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 54, info: { Title: `Reconciliation ${r.account_name} ${r.statement_date}`, Producer: 'Financial Books' } });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  applyStyle(doc, entity);
  const left = doc.page.margins.left, right = doc.page.width - doc.page.margins.right, width = right - left;
  const top = drawHeader(doc, entity);
  doc.font(doc.fb.b).fontSize(16).fillColor(doc.fb.accent).text('RECONCILIATION REPORT', left, 54, { width, align: 'right' });
  let y = Math.max(120, top + 18);
  const pair = (k, v) => {
    doc.font(doc.fb.r).fontSize(10).fillColor('#000').text(k, left, y, { width: 260 }).text(v, left + 260, y, { width: 140, align: 'right' });
    y += 16;
  };
  doc.font(doc.fb.b).fontSize(12).text(`${r.account_name} — statement ending ${formatShortDate(r.statement_date)}`, left, y);
  y += 24;
  const cleared = r.items.reduce((s, i) => s + i.amount, 0);
  pair('Beginning balance', formatCents(r.beginning_cents));
  pair('Cleared transactions', formatCents(cleared));
  pair('Ending balance', formatCents(r.ending_cents));
  pair('Finished', `${r.completed_by}, ${new Date(r.completed_at).toISOString().slice(0, 10)}`);
  y += 12;
  doc.font(doc.fb.b).fontSize(9).fillColor(doc.fb.accent).text('DATE', left, y).text('TRANSACTION', left + 70, y).text('NAME', left + 250, y).text('AMOUNT', right - 100, y, { width: 100, align: 'right' });
  y += 16;
  for (const i of r.items) {
    if (y > doc.page.height - 90) { doc.addPage(); y = 54; }
    doc.font(doc.fb.r).fontSize(9).fillColor('#000').text(formatShortDate(i.txn_date), left, y)
      .text(`${TYPE_LABELS[i.type]} ${i.doc_number ?? i.payment_ref ?? ''}`.trim(), left + 70, y, { width: 170, lineBreak: false, ellipsis: true })
      .text(i.party ?? '', left + 250, y, { width: 150, lineBreak: false, ellipsis: true })
      .text(formatCents(i.amount), right - 100, y, { width: 100, align: 'right' });
    y += 14;
  }
  drawFooter(doc);
  doc.end();
  return done;
}
