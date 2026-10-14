import PDFDocument from 'pdfkit';
import { formatCents } from '../domain/money.js';
import { formatShortDate } from '../domain/dates.js';
import { formatAddress } from '../views/format.js';
import { applyStyle, drawHeader, drawFooter } from './style.js';


// A purchase order to send to the vendor: getVendorTxn() shape.
export function renderPurchaseOrderPdf({ entity, po }) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 54, info: { Title: `Purchase order ${po.doc_number ?? ''}`, Producer: 'Financial Books' } });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  const left = 54, right = doc.page.width - 54, width = right - left;
  applyStyle(doc, entity);
  const top = drawHeader(doc, entity);
  doc.font(doc.fb.b).fontSize(20).fillColor(doc.fb.accent).text('PURCHASE ORDER', left, 54, { width, align: 'right' });
  if (po.voided_at) doc.font(doc.fb.b).fontSize(12).fillColor('#b3261e').text('VOID', left, 80, { width, align: 'right' });

  let y = Math.max(120, top + 18);
  doc.font(doc.fb.b).fontSize(9).fillColor('#555').text('VENDOR', left, y).text('SHIP TO', left + 260, y);
  doc.font(doc.fb.r).fontSize(11).fillColor('#000').text(po.vendor_name, left, y + 13).text(entity.name, left + 260, y + 13);
  doc.fontSize(10).text(formatAddress(po.vendor_address), left, y + 28, { width: 240 }).text(formatAddress(entity.address), left + 260, y + 28, { width: 240 });
  const facts = [['P.O. number', po.doc_number ?? '—'], ['Date', formatShortDate(po.txn_date)], ...(po.due_date ? [['Expected', formatShortDate(po.due_date)]] : [])];
  facts.forEach(([k, v], i) => {
    doc.font(doc.fb.b).fontSize(9).fillColor('#555').text(k.toUpperCase(), right - 170, y + i * 16, { width: 80 });
    doc.font(doc.fb.r).fontSize(10).fillColor('#000').text(v, right - 90, y + i * 16, { width: 90, align: 'right' });
  });

  y = 210;
  doc.rect(left, y, width, 20).fill('#e3f0ef');
  doc.font(doc.fb.b).fontSize(9).fillColor('#333').text('ITEM', left + 6, y + 6).text('DESCRIPTION', left + 170, y + 6)
    .text('QTY', left + 330, y + 6, { width: 50, align: 'right' }).text('RATE', left + 385, y + 6, { width: 60, align: 'right' })
    .text('AMOUNT', right - 80, y + 6, { width: 74, align: 'right' });
  y += 26;
  doc.font(doc.fb.r).fontSize(10).fillColor('#000');
  for (const l of po.lines) {
    if (y > doc.page.height - 120) { doc.addPage(); y = 54; }
    const h = Math.max(doc.heightOfString(l.description ?? '', { width: 155 }), 12);
    doc.text(l.item_name ?? l.account_name ?? '', left + 6, y, { width: 160 }).text(l.description ?? '', left + 170, y, { width: 155 })
      .text(l.item_id ? String(Number(l.quantity)) : '', left + 330, y, { width: 50, align: 'right' })
      .text(l.item_id ? formatCents(l.rate_cents) : '', left + 385, y, { width: 60, align: 'right' })
      .text(formatCents(l.amount_cents), right - 80, y, { width: 74, align: 'right' });
    y += h + 8;
  }
  doc.moveTo(left, y).lineTo(right, y).strokeColor('#ccc').stroke();
  doc.font(doc.fb.b).fontSize(12).text('Total', right - 200, y + 10, { width: 100 }).text(formatCents(po.total_cents), right - 100, y + 10, { width: 94, align: 'right' });
  if (po.memo) doc.font(doc.fb.r).fontSize(10).fillColor('#333').text(po.memo, left, y + 40, { width });
  drawFooter(doc);
  doc.end();
  return done;
}
