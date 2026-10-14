import PDFDocument from 'pdfkit';
import { formatCents } from '../domain/money.js';
import { formatShortDate } from '../domain/dates.js';
import { checkWords } from '../domain/checks.js';
import { TYPE_LABELS } from '../domain/status.js';
import { formatAddress } from '../views/format.js';
import { applyStyle } from './style.js';

// Voucher checks on letter paper: the check in the top third, two identical stubs below (one for the vendor,
// one for your records). Each check: a getVendorTxn() row (check or bill payment).
export function renderChecksPdf({ entity, checks }) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 36, info: { Title: checks.length === 1 ? `Check ${checks[0].doc_number}` : 'Checks', Producer: 'Financial Books' } });
  applyStyle(doc, entity);
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  checks.forEach((c, i) => { if (i) doc.addPage(); voucher(doc, entity, c); });
  doc.end();
  return done;
}

const payee = c => c.check_name || c.vendor_name || 'Cash';

function voucher(doc, entity, c) {
  const left = 36, right = doc.page.width - 36, width = right - left, third = doc.page.height / 3;
  // ---- the check ----
  doc.font(doc.fb.b).fontSize(11).fillColor('#000').text(entity.name, left, 40);
  doc.font(doc.fb.r).fontSize(8).text(formatAddress(entity.address), left, 54, { width: 260 });
  doc.font(doc.fb.r).fontSize(8).text(c.account_name, left + 300, 40, { width: 150 });
  doc.font(doc.fb.b).fontSize(11).text(c.doc_number ?? '', left, 40, { width, align: 'right' });
  doc.font(doc.fb.r).fontSize(9).text('DATE', right - 150, 70).font(doc.fb.b).fontSize(11).text(formatShortDate(c.txn_date), right - 110, 68);

  doc.font(doc.fb.r).fontSize(8).text('PAY TO THE', left, 100).text('ORDER OF', left, 109);
  doc.font(doc.fb.b).fontSize(12).text(payee(c), left + 60, 102, { width: 330 });
  doc.rect(right - 130, 96, 130, 22).stroke();
  doc.font(doc.fb.b).fontSize(12).text(`**${formatCents(c.total_cents).replace('$', '')}`, right - 125, 102, { width: 120, align: 'right' });
  doc.moveTo(left + 60, 118).lineTo(right - 140, 118).stroke();

  doc.font(doc.fb.r).fontSize(10).text(checkWords(c.total_cents, 80), left, 132, { width: width - 60 });
  doc.font(doc.fb.r).fontSize(8).text('DOLLARS', right - 50, 134);
  doc.moveTo(left, 146).lineTo(right, 146).stroke();

  const addr = formatAddress(c.vendor_address);
  doc.font(doc.fb.r).fontSize(10).text(payee(c), left + 60, 160).text(addr, left + 60, 173, { width: 260 });
  doc.font(doc.fb.r).fontSize(8).text('MEMO', left, 220).text(c.memo ?? '', left + 36, 220, { width: 260 });
  doc.moveTo(left + 34, 230).lineTo(left + 300, 230).stroke();
  doc.moveTo(right - 220, 230).lineTo(right, 230).stroke();
  doc.font(doc.fb.r).fontSize(7).text('AUTHORIZED SIGNATURE', right - 220, 234, { width: 220, align: 'center' });
  if (c.voided_at) doc.font(doc.fb.b).fontSize(40).fillColor('#b3261e').text('VOID', left, 120, { width, align: 'center' }).fillColor('#000');

  // ---- two stubs ----
  for (const top of [third + 10, 2 * third + 10]) stub(doc, entity, c, top, left, width);
}

function stub(doc, entity, c, top, left, width) {
  doc.moveTo(left, top - 10).lineTo(left + width, top - 10).dash(3, { space: 3 }).stroke().undash();
  doc.font(doc.fb.b).fontSize(10).fillColor('#000').text(entity.name, left, top);
  doc.font(doc.fb.r).fontSize(10).text(`${payee(c)}`, left, top + 16)
    .text(`${formatShortDate(c.txn_date)}  ·  Check ${c.doc_number ?? ''}  ·  ${formatCents(c.total_cents)}`, left, top + 16, { width, align: 'right' });
  let y = top + 40;
  doc.font(doc.fb.b).fontSize(8).fillColor('#555');
  if (c.type === 'bill_payment') {
    doc.text('DATE', left, y).text('BILL', left + 80, y).text('DUE', left + 240, y).text('ORIGINAL', left + 320, y, { width: 80, align: 'right' })
      .text('PAID', left + width - 90, y, { width: 90, align: 'right' });
    y += 14;
    doc.font(doc.fb.r).fontSize(9).fillColor('#000');
    for (const a of c.applications.slice(0, 12)) {
      doc.text(formatShortDate(a.txn_date), left, y).text(`${TYPE_LABELS[a.type]} ${a.doc_number ?? ''}`, left + 80, y, { width: 150 })
        .text(a.due_date ? formatShortDate(a.due_date) : '', left + 240, y).text(formatCents(a.total_cents), left + 320, y, { width: 80, align: 'right' })
        .text(formatCents(a.amount_cents), left + width - 90, y, { width: 90, align: 'right' });
      y += 13;
    }
    if (c.applications.length > 12) doc.text(`…and ${c.applications.length - 12} more`, left, y);
  } else {
    doc.text('CATEGORY', left, y).text('DESCRIPTION', left + 200, y).text('AMOUNT', left + width - 90, y, { width: 90, align: 'right' });
    y += 14;
    doc.font(doc.fb.r).fontSize(9).fillColor('#000');
    for (const l of c.lines.slice(0, 12)) {
      doc.text(l.account_name ?? l.item_name ?? '', left, y, { width: 190 }).text(l.description ?? '', left + 200, y, { width: 220 })
        .text(formatCents(l.amount_cents), left + width - 90, y, { width: 90, align: 'right' });
      y += 13;
    }
  }
  doc.font(doc.fb.r).fontSize(8).fillColor('#555').text(c.memo ? `Memo: ${c.memo}` : '', left, top + 200, { width });
}
