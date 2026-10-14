import PDFDocument from 'pdfkit';
import { formatCents } from '../domain/money.js';
import { formatShortDate } from '../domain/dates.js';
import { TYPE_LABELS } from '../domain/status.js';
import { formatAddress } from '../views/format.js';
import { applyStyle } from './style.js';

// Stage F5: QBO's "Print deposit slip and summary" / "summary only". The slip lists cash and each check for the bank teller;
// the summary lists everything in the deposit for your records. deposit: getDeposit() row.
const isCash = l => /cash/i.test(l.payment_method ?? '');
const what = l => (l.source_txn_id ? `${TYPE_LABELS[l.source_type]}${l.doc_number ? ` ${l.doc_number}` : ''}` : `${l.account_name ?? ''}${l.description ? ` · ${l.description}` : ''}`);

export function renderDepositSlipPdf({ entity, deposit: d, summaryOnly = false }) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 36, info: { Title: `Deposit ${d.txn_date}`, Producer: 'Financial Books' } });
  applyStyle(doc, entity);
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  const left = 36, right = doc.page.width - 36, width = right - left;
  const gross = d.lines.reduce((s, l) => s + Number(l.amount_cents), 0);
  const cashBack = Number(d.cash_back_cents ?? 0);
  if (!summaryOnly) {
    // ---- the slip ----
    doc.font(doc.fb.b).fontSize(13).fillColor('#000').text('DEPOSIT SLIP', left, 40);
    doc.font(doc.fb.b).fontSize(11).text(entity.name, left, 60);
    doc.font(doc.fb.r).fontSize(9).text(formatAddress(entity.address), left, 75, { width: 260 });
    doc.font(doc.fb.r).fontSize(9).text('Date', right - 200, 40).font(doc.fb.b).text(formatShortDate(d.txn_date), right - 120, 40);
    doc.font(doc.fb.r).text('Account', right - 200, 56).font(doc.fb.b).text(`${d.account_name}${d.account_number ? ` (${d.account_number})` : ''}`, right - 120, 56, { width: 120 });
    let y = 120;
    const row = (label, amount, bold = false) => {
      doc.font(bold ? doc.fb.b : doc.fb.r).fontSize(10).text(label, left, y, { width: width - 140 });
      doc.text(amount, right - 130, y, { width: 130, align: 'right' });
      y += 16;
    };
    const cash = d.lines.filter(l => l.source_txn_id && isCash(l)).reduce((s, l) => s + Number(l.amount_cents), 0);
    row('Cash', formatCents(cash));
    const checks = d.lines.filter(l => !(l.source_txn_id && isCash(l)));
    checks.forEach((l, i) => row(`Check ${i + 1}: ${l.customer_name ?? what(l)}${l.payment_ref ? ` · no. ${l.payment_ref}` : ''}`, formatCents(l.amount_cents)));
    doc.moveTo(left, y + 2).lineTo(right, y + 2).stroke();
    y += 8;
    row('Subtotal', formatCents(gross), true);
    if (cashBack) row('Less cash back', `-${formatCents(cashBack)}`);
    row('Net deposit', formatCents(d.total_cents), true);
    doc.font(doc.fb.r).fontSize(8).fillColor('#555').text(`${checks.length} item${checks.length === 1 ? '' : 's'} besides cash`, left, y + 4);
    doc.fillColor('#000');
    doc.addPage();
  }
  // ---- the summary ----
  doc.font(doc.fb.b).fontSize(13).fillColor('#000').text(`Deposit summary · ${entity.name}`, left, 40);
  doc.font(doc.fb.r).fontSize(10).text(`${formatShortDate(d.txn_date)} · deposited to ${d.account_name}${d.memo ? ` · ${d.memo}` : ''}`, left, 60, { width });
  let y = 90;
  const cols = [[left, 150, 'Received from'], [left + 155, 170, 'What'], [left + 330, 70, 'Method'], [left + 405, 60, 'Ref no.'], [right - 80, 80, 'Amount']];
  doc.font(doc.fb.b).fontSize(9);
  cols.forEach(([x, w, h], i) => doc.text(h, x, y, { width: w, align: i === 4 ? 'right' : 'left' }));
  y += 14;
  doc.moveTo(left, y - 2).lineTo(right, y - 2).stroke();
  doc.font(doc.fb.r);
  for (const l of d.lines) {
    if (y > doc.page.height - 80) { doc.addPage(); y = 40; }
    const cells = [l.customer_name ?? '—', what(l), l.payment_method ?? '', l.source_txn_id ? (l.doc_number ?? l.payment_ref ?? '') : '', formatCents(l.amount_cents)];
    cols.forEach(([x, w], i) => doc.text(cells[i], x, y, { width: w, align: i === 4 ? 'right' : 'left', lineBreak: false, ellipsis: true }));
    y += 14;
  }
  doc.moveTo(left, y + 2).lineTo(right, y + 2).stroke();
  y += 8;
  const total = (label, amount) => { doc.font(doc.fb.b).text(label, right - 260, y, { width: 170, align: 'right' }).text(amount, right - 80, y, { width: 80, align: 'right' }); y += 14; };
  total('Deposit subtotal', formatCents(gross));
  if (cashBack) total(`Less cash back${d.cash_back_account_name ? ` (${d.cash_back_account_name})` : ''}`, `-${formatCents(cashBack)}`);
  total('Deposit total', formatCents(d.total_cents));
  doc.end();
  return done;
}
