import PDFDocument from 'pdfkit';
import { formatMoney } from '../domain/fx.js';
import { formatShortDate } from '../domain/dates.js';
import { TYPE_LABELS } from '../domain/status.js';
import { AGING_BUCKETS, KIND_LABELS } from '../domain/statements.js';
import { formatAddress } from '../views/format.js';
import { applyStyle, drawHeader, drawFooter } from './style.js';


// content: buildStatement() output. customer: { display_name, billing_address }.
export function renderStatementPdf({ entity, customer, content: s }) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 54, info: { Title: `Statement ${s.statement_date}`, Producer: 'Financial Books' } });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  applyStyle(doc, entity);
  draw(doc, entity, customer, s);
  drawFooter(doc);
  doc.end();
  return done;
}

function draw(doc, entity, customer, s) {
  // A foreign-currency customer's statement is in their currency.
  const money = c => formatMoney(c, s.currency);
  const left = doc.page.margins.left, right = doc.page.width - doc.page.margins.right, width = right - left;
  const bottom = doc.page.height - doc.page.margins.bottom;
  const top = drawHeader(doc, entity);
  doc.font(doc.fb.b).fontSize(20).fillColor(doc.fb.accent).text('STATEMENT', left, 54, { width, align: 'right' });
  doc.font(doc.fb.r).fontSize(9).fillColor('#555').text(KIND_LABELS[s.kind], left, 80, { width, align: 'right' });

  let y = Math.max(120, top + 18);
  doc.font(doc.fb.b).fontSize(9).fillColor('#555').text('TO', left, y);
  doc.font(doc.fb.r).fontSize(11).fillColor('#000').text(customer.display_name, left, y + 13);
  const addr = formatAddress(customer.billing_address);
  if (addr) doc.fontSize(10).text(addr, left, y + 28, { width: 260 });
  const facts = [['Statement date', formatShortDate(s.statement_date)],
    ...(s.start_date ? [['Period', `${formatShortDate(s.start_date)} – ${formatShortDate(s.end_date)}`]] : []),
    [s.total_due_cents < 0 ? 'Credit balance' : 'Amount due', money(Math.abs(s.total_due_cents))]];
  facts.forEach(([k, v], i) => {
    doc.font(doc.fb.b).fontSize(9).fillColor('#555').text(k.toUpperCase(), right - 240, y + i * 16, { width: 110 });
    doc.font(i === facts.length - 1 ? doc.fb.b : doc.fb.r).fontSize(10).fillColor('#000').text(v, right - 130, y + i * 16, { width: 130, align: 'right' });
  });
  y += 80;

  const runningBalance = s.kind === 'balance_forward';
  const cols = [[left, 70, 'DATE', 'left'], [left + 70, 170, 'ACTIVITY', 'left'], [left + 240, 70, 'DUE', 'left'],
    [right - 180, 90, 'AMOUNT', 'right'], [right - 90, 90, runningBalance ? 'BALANCE' : 'OPEN', 'right']];
  const header = () => {
    doc.rect(left, y, width, 20).fill('#e3f0ef');
    cols.forEach(([x, w, h, align]) => doc.font(doc.fb.b).fontSize(9).fillColor(doc.fb.accent).text(h, x + 4, y + 6, { width: w - 8, align }));
    y += 26;
  };
  const line = vals => {
    if (y + 16 > bottom - 90) { doc.addPage(); y = 54; header(); }
    cols.forEach(([x, w, , align], i) => doc.font(doc.fb.r).fontSize(10).fillColor('#000').text(vals[i] ?? '', x + 4, y, { width: w - 8, align, lineBreak: false, ellipsis: true }));
    y += 16;
    doc.moveTo(left, y - 3).lineTo(right, y - 3).strokeColor('#dde3ea').lineWidth(0.5).stroke();
  };
  header();
  if (runningBalance) line([formatShortDate(s.start_date), 'Balance forward', '', '', money(s.opening_cents)]);
  for (const r of s.rows) {
    line([formatShortDate(r.date), `${TYPE_LABELS[r.type]} ${r.number}${r.memo ? ` — ${r.memo}` : ''}`.trim(), r.due_date ? formatShortDate(r.due_date) : '',
      money(r.amount_cents), money(runningBalance ? r.balance_cents : r.open_cents)]);
  }
  if (!s.rows.length && !runningBalance) line(['', 'Nothing open', '', '', '']);
  y += 8;
  doc.font(doc.fb.b).fontSize(12).fillColor('#000')
    .text(s.total_due_cents < 0 ? 'Credit balance' : 'Amount due', right - 260, y, { width: 150 })
    .text(money(Math.abs(s.total_due_cents)), right - 110, y, { width: 110, align: 'right' });
  y += 30;

  if (s.kind !== 'transaction' && s.show_aging !== false) {
    if (y > bottom - 50) { doc.addPage(); y = 54; }
    const w = width / AGING_BUCKETS.length;
    AGING_BUCKETS.forEach(([key, label], i) => {
      doc.rect(left + i * w, y, w, 36).strokeColor('#dde3ea').lineWidth(0.5).stroke();
      doc.font(doc.fb.b).fontSize(8).fillColor('#555').text(label.toUpperCase(), left + i * w + 4, y + 5, { width: w - 8, align: 'center' });
      doc.font(doc.fb.r).fontSize(10).fillColor('#000').text(money(s.aging[key]), left + i * w + 4, y + 19, { width: w - 8, align: 'center' });
    });
  }
}
