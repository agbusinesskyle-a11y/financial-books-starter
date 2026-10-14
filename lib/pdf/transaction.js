import PDFDocument from 'pdfkit';
import { formatMoney } from '../domain/fx.js';
import { formatShortDate } from '../domain/dates.js';
import { TYPE_LABELS } from '../domain/status.js';
import { formatAddress } from '../views/format.js';
import { applyStyle, drawHeader, drawFooter } from './style.js';

const TITLES = { estimate: 'ESTIMATE', invoice: 'INVOICE', sales_receipt: 'SALES RECEIPT', credit_memo: 'CREDIT MEMO', payment: 'PAYMENT RECEIPT', late_fee: 'LATE FEE' };

// One PDF with every transaction starting on its own page. Each txn needs getTransaction() shape
// plus `customer` ({ display_name, billing_address }).
// packingSlip: the same documents as packing slips — ship-to address, items and quantities, no prices.
export function renderTransactionsPdf({ entity, txns, packingSlip = false }) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 54, info: { Title: txns.length === 1 ? title(txns[0]) : 'Transactions', Producer: 'Financial Books' } });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  applyStyle(doc, entity);
  txns.forEach((t, i) => { if (i) doc.addPage(); (packingSlip ? slip : page)(doc, entity, t); });
  doc.end();
  return done;
}

const title = t => `${TYPE_LABELS[t.type]} ${t.doc_number ?? t.payment_ref ?? ''}`.trim();

function slip(doc, entity, t) {
  const left = doc.page.margins.left, right = doc.page.width - doc.page.margins.right, width = right - left;
  const top = drawHeader(doc, entity);
  doc.font(doc.fb.b).fontSize(20).fillColor(doc.fb.accent).text('PACKING SLIP', left, 54, { width, align: 'right' });
  let y = Math.max(120, top + 18);
  const c = t.customer;
  doc.font(doc.fb.b).fontSize(9).fillColor('#555').text('SHIP TO', left, y);
  doc.font(doc.fb.r).fontSize(11).fillColor('#000').text(c.display_name, left, y + 13);
  const addr = formatAddress(c.shipping_same_as_billing === false && c.shipping_address ? c.shipping_address : c.billing_address);
  if (addr) doc.fontSize(10).text(addr, left, y + 28, { width: 260 });
  [[t.type === 'estimate' ? 'Estimate' : 'Invoice', t.doc_number ?? '—'], ['Date', formatShortDate(t.txn_date)]].forEach(([k, v], i) => {
    doc.font(doc.fb.b).fontSize(9).fillColor('#555').text(k.toUpperCase(), right - 220, y + i * 16, { width: 100 });
    doc.font(doc.fb.r).fontSize(10).fillColor('#000').text(v, right - 120, y + i * 16, { width: 120, align: 'right' });
  });
  y += 80;
  const cols = [[left, 30, '#', 'left'], [left + 30, width - 130, 'ITEM', 'left'], [right - 100, 100, 'QTY', 'right']];
  doc.rect(left, y, width, 20).fill('#e3f0ef');
  cols.forEach(([x, w, h, align]) => doc.font(doc.fb.b).fontSize(9).fillColor(doc.fb.accent).text(h, x + 4, y + 6, { width: w - 8, align }));
  y += 26;
  for (const l of t.lines.filter(x => x.kind !== 'subtotal')) {
    const desc = l.item_name && l.description !== l.item_name ? `${l.item_name}: ${l.description}` : (l.description ?? l.item_name ?? '');
    const h = Math.max(16, doc.font(doc.fb.r).fontSize(10).heightOfString(desc, { width: cols[1][1] - 8 }) + 6);
    if (y + h > doc.page.height - 100) { doc.addPage(); y = 54; }
    [String(l.line_no), desc, l.kind === 'text' ? '' : String(l.quantity)].forEach((v, i) => doc.font(doc.fb.r).fontSize(10).fillColor('#000').text(v, cols[i][0] + 4, y, { width: cols[i][1] - 8, align: cols[i][3] }));
    y += h;
    doc.moveTo(left, y - 3).lineTo(right, y - 3).strokeColor('#dde3ea').lineWidth(0.5).stroke();
  }
  drawFooter(doc);
}

function page(doc, entity, t) {
  // A foreign-currency document prints in its own currency.
  const cur = t.currency ?? null;
  const formatCents = c => formatMoney(c, cur);
  const f = (foreign, home) => (cur && foreign !== null && foreign !== undefined ? foreign : home);
  const left = doc.page.margins.left, right = doc.page.width - doc.page.margins.right, width = right - left;
  const top = drawHeader(doc, entity);
  const st = doc.fb.style;
  doc.font(doc.fb.b).fontSize(20).fillColor(doc.fb.accent).text(TITLES[t.type], left, 54, { width, align: 'right' });
  if (t.voided_at) doc.font(doc.fb.b).fontSize(12).fillColor('#b3261e').text('VOID', left, 80, { width, align: 'right' });

  let y = Math.max(120, top + 18);
  doc.font(doc.fb.b).fontSize(9).fillColor('#555').text(t.type === 'payment' ? 'RECEIVED FROM' : 'BILL TO', left, y);
  if (t.bill_to) {
    // The Bill to as typed on this document (stage F4).
    doc.font(doc.fb.r).fontSize(10).fillColor('#000').text(t.bill_to, left, y + 13, { width: 200 });
  } else {
    doc.font(doc.fb.r).fontSize(11).fillColor('#000').text(t.customer.display_name, left, y + 13);
    const addr = formatAddress(t.customer.billing_address);
    if (addr) doc.fontSize(10).text(addr, left, y + 28, { width: 200 });
  }
  if (t.ship_to && t.type !== 'payment') {
    doc.font(doc.fb.b).fontSize(9).fillColor('#555').text('SHIP TO', left + 210, y);
    doc.font(doc.fb.r).fontSize(10).fillColor('#000').text(t.ship_to, left + 210, y + 13, { width: 150 });
  }

  const facts = [
    [t.type === 'payment' ? 'Reference' : 'Number', t.doc_number ?? t.payment_ref ?? '—'],
    ['Date', formatShortDate(t.txn_date)],
    ...(t.terms_name && st.showTerms ? [['Terms', t.terms_name]] : []),
    ...(t.due_date && st.showDueDate ? [[t.type === 'estimate' ? 'Expires' : 'Due date', formatShortDate(t.due_date)]] : []),
    ...(t.project_name && st.showProject ? [['Project', t.project_name]] : []),
    ...(t.payment_method ? [['Method', t.payment_method]] : []),
    ...(t.po_number ? [['P.O. number', t.po_number]] : []),
    ...(t.ship_via ? [['Ship via', t.ship_via]] : []),
    ...(t.ship_date ? [['Shipping date', formatShortDate(t.ship_date)]] : []),
    ...(t.tracking_no ? [['Tracking no.', t.tracking_no]] : []),
    ...(t.type === 'estimate' && t.accepted_by ? [['Accepted by', `${t.accepted_by}${t.accepted_date ? `, ${formatShortDate(t.accepted_date)}` : ''}`]] : []),
  ];
  facts.forEach(([k, v], i) => {
    doc.font(doc.fb.b).fontSize(9).fillColor('#555').text(k.toUpperCase(), right - 220, y + i * 16, { width: 100 });
    doc.font(doc.fb.r).fontSize(10).fillColor('#000').text(v, right - 120, y + i * 16, { width: 120, align: 'right' });
  });
  y = Math.max(y + 70, y + facts.length * 16 + 20);

  const dated = st.showServiceDate && t.lines.some(l => l.service_date);
  const cols = dated
    ? [[left, 30, '#', 'left'], [left + 30, 70, 'DATE', 'left'], [left + 100, width - 350, 'DESCRIPTION', 'left'], [right - 250, 70, 'QTY', 'right'], [right - 170, 80, 'RATE', 'right'], [right - 90, 90, 'AMOUNT', 'right']]
    : [[left, 30, '#', 'left'], [left + 30, width - 280, 'DESCRIPTION', 'left'], [right - 250, 70, 'QTY', 'right'], [right - 170, 80, 'RATE', 'right'], [right - 90, 90, 'AMOUNT', 'right']];
  const descCol = dated ? 2 : 1;
  if (t.lines.length) {
    doc.rect(left, y, width, 20).fill('#e3f0ef');
    cols.forEach(([x, w, h, align]) => doc.font(doc.fb.b).fontSize(9).fillColor(doc.fb.accent).text(h, x + 4, y + 6, { width: w - 8, align }));
    y += 26;
    let section = 0;
    for (const l of t.lines) {
      // Subtotal and text lines (stage F3): a subtotal shows the lines above it since the last one; text is words only.
      if (l.kind === 'subtotal' || l.kind === 'text') {
        const h = Math.max(16, doc.font(doc.fb.r).fontSize(10).heightOfString(l.description, { width: width - 120 }) + 6);
        if (y + h > doc.page.height - 140) { doc.addPage(); y = 54; }
        doc.font(l.kind === 'subtotal' ? doc.fb.b : doc.fb.r).fontSize(10).fillColor(l.kind === 'subtotal' ? '#000' : '#444')
          .text(l.description, cols[descCol][0] + 4, y, { width: width - (cols[descCol][0] - left) - 110 });
        if (l.kind === 'subtotal') { doc.font(doc.fb.b).text(formatCents(section), right - 90 + 4, y, { width: 82, align: 'right' }); section = 0; }
        y += h;
        doc.moveTo(left, y - 3).lineTo(right, y - 3).strokeColor('#dde3ea').lineWidth(0.5).stroke();
        continue;
      }
      section += Number(f(l.foreign_amount_cents, l.amount_cents));
      const desc = l.item_name && l.description !== l.item_name ? `${l.item_name}: ${l.description}` : l.description;
      const h = Math.max(16, doc.font(doc.fb.r).fontSize(10).heightOfString(desc, { width: cols[descCol][1] - 8 }) + 6);
      if (y + h > doc.page.height - 140) { doc.addPage(); y = 54; }
      const vals = [String(l.line_no), ...(dated ? [l.service_date ? formatShortDate(l.service_date) : ''] : []), desc, String(l.quantity), formatCents(f(l.foreign_rate_cents, l.rate_cents)), formatCents(f(l.foreign_amount_cents, l.amount_cents))];
      cols.forEach(([x, w, , align], i) => doc.font(doc.fb.r).fontSize(10).fillColor('#000').text(vals[i], x + 4, y, { width: w - 8, align }));
      y += h;
      doc.moveTo(left, y - 3).lineTo(right, y - 3).strokeColor('#dde3ea').lineWidth(0.5).stroke();
    }
    y += 8;
  }

  const discount = cur ? Number(t.foreign_discount_cents ?? 0) : Number(t.discount_cents ?? 0);
  const shipping = cur ? Number(t.foreign_shipping_cents ?? 0) : Number(t.shipping_cents ?? 0);
  const docTotal = Number(f(t.foreign_total_cents, t.total_cents)), docOpen = Number(f(t.foreign_open_cents, t.open_cents));
  const totals = [];
  if (discount || shipping) {
    totals.push(['Subtotal', formatCents(docTotal + discount - shipping)]);
    if (discount) totals.push([t.discount_percent ? `Discount (${Number(t.discount_percent)}%)` : 'Discount', `-${formatCents(discount)}`]);
    if (shipping) totals.push(['Shipping', formatCents(shipping)]);
  }
  totals.push([cur ? `Total (${cur})` : 'Total', formatCents(docTotal)]);
  if (t.type === 'invoice' || t.type === 'late_fee') totals.push(['Balance due', formatCents(docOpen)]);
  if (t.type === 'payment' || t.type === 'credit_memo') totals.push(['Unapplied', formatCents(docOpen)]);
  if (t.type === 'estimate' && t.deposit_request_percent) totals.push([`Deposit due (${Number(t.deposit_request_percent)}%)`, formatCents(Math.round(docTotal * Number(t.deposit_request_percent) / 100))]);
  totals.forEach(([k, v], i) => {
    doc.font(i === totals.length - 1 ? doc.fb.b : doc.fb.r).fontSize(11).fillColor('#000')
      .text(k, right - 220, y + i * 18, { width: 110 }).text(v, right - 110, y + i * 18, { width: 110, align: 'right' });
  });
  y += totals.length * 18 + 16;

  if (t.applications?.length) {
    doc.font(doc.fb.b).fontSize(10).fillColor('#000').text(t.type === 'payment' || t.type === 'credit_memo' ? 'Applied to' : 'Payments and credits', left, y);
    y += 16;
    for (const a of t.applications) {
      doc.font(doc.fb.r).fontSize(10).text(`${formatShortDate(a.applied_on)}  ${TYPE_LABELS[a.type]} ${a.doc_number ?? a.payment_ref ?? ''}`, left, y)
        .text(formatCents(f(a.foreign_cents, a.amount_cents)), right - 110, y, { width: 110, align: 'right' });
      y += 15;
    }
  }
  if (t.memo && st.showMessage) doc.font(doc.fb.i).fontSize(9).fillColor('#555').text(t.memo, left, Math.min(y + 12, doc.page.height - 100), { width });
  drawFooter(doc);
}
