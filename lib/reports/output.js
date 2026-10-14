import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { formatShortDate } from '../domain/dates.js';
import { applyStyle, drawFooter } from '../pdf/style.js';
import { formatter, excelMoneyFormat } from './customize.js';

// A report as text, Excel, CSV or PDF. `report` is runReport's result; report.opts.custom holds its Customize settings.

const fmtOf = report => formatter(report.opts?.custom);
export const pctText = p => formatter().pct(p);
export const amountText = v => formatter().money(v);
export const qtyText = q => (q === null || q === undefined ? '' : Number(q).toLocaleString('en-US', { maximumFractionDigits: 3 }));

// Text for one summary cell / one detail cell (fmt: the report's formatter).
export const cellText = (c, fmt = formatter()) => (!c ? '' : 'pct' in c ? fmt.pct(c.pct) : 'qty' in c ? qtyText(c.qty) : fmt.money(c.v));
const cellValue = c => ('pct' in c ? c.pct : 'qty' in c ? c.qty : c.v);
export function detailText(c, cells, fmt = formatter()) {
  const key = c.key, v = cells[key];
  if (c.money) return fmt.money(v);
  if (key === 'date') return v ? formatShortDate(v) : '';
  return v ?? '';
}
export { fmtOf };

export const reportFilename = (report, ext) => `${report.title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${report.opts.to}.${ext}`;

// Plain rows for CSV, Excel and PDF: [label, ...values] where values are numbers (cents / fractions) or text.
function tableRows(report) {
  if (report.detail) {
    return report.rows.map(r => (r.kind === 'line'
      ? { r, cells: report.columns.map(c => (c.money ? (r.cells[c.key] ?? null) : detailText(c, r.cells))) }
      : { r, cells: report.columns.map((c, i) => (i === 0 && r.label ? r.label : c.money ? (r.cells?.[c.key] ?? null) : '')) }));
  }
  return report.rows.map(r => ({ r, cells: [r.label, ...report.columns.map((c, i) => (r.cells?.[i] && cellValue(r.cells[i]) !== null && cellValue(r.cells[i]) !== undefined ? r.cells[i] : null))] }));
}
const isMoneyCol = (report, i) => (report.detail ? Boolean(report.columns[i].money) : i > 0 && !report.columns[i - 1].kind.startsWith('pct') && report.columns[i - 1].kind !== 'qty');
const isQtyCol = (report, i) => !report.detail && i > 0 && report.columns[i - 1].kind === 'qty';
// A value's type: a summary cell object says what it is; a detail value follows its column.
const typeOf = (report, i, v) => (v && typeof v === 'object' ? ('pct' in v ? 'pct' : 'qty' in v ? 'qty' : 'money') : isMoneyCol(report, i) ? 'money' : isQtyCol(report, i) ? 'qty' : 'pct');
const rawOf = v => (v && typeof v === 'object' ? cellValue(v) : v);
const showsHeader = (report, part) => !report.opts?.custom?.[`hide_${part}`];

export function reportCsv(report, entityName) {
  // Text that a spreadsheet would run as a formula gets a leading ' ; numbers (including negative amounts) stay numbers.
  const esc = v => {
    const s = String(v ?? '');
    if (/^-?\d+(\.\d+)?%?$/.test(s)) return s;
    return /[",\n\r]/.test(s) || /^[=+\-@\t]/.test(s) ? `"${s.replace(/^([=+\-@\t])/, "'$1").replace(/"/g, '""')}"` : s;
  };
  const head = report.detail ? report.columns.map(c => c.label) : ['', ...report.columns.map(c => c.label)];
  const lines = [[report.title], ...(showsHeader(report, 'company') ? [[entityName]] : []), ...(showsHeader(report, 'period') ? [[report.subtitle]] : []),
    ...(report.note ? [[report.note]] : []), [], head];
  for (const { r, cells } of tableRows(report)) {
    lines.push(cells.map((v, i) => {
      if (i === 0 && !report.detail) return `${'  '.repeat(r.depth ?? 0)}${v}`;
      if (v === null || v === '') return '';
      const n = rawOf(v), t = typeOf(report, i, v);
      if (typeof n === 'number') return t === 'money' ? (n / 100).toFixed(2) : t === 'qty' ? String(n) : (Number.isFinite(n) ? `${(n * 100).toFixed(2)}%` : '');
      return v;
    }));
  }
  if (showsHeader(report, 'basis')) lines.push([], [`${report.basisLabel} · prepared ${report.preparedOn ?? new Date().toISOString().slice(0, 10)}`]);
  return `${lines.map(l => l.map(esc).join(',')).join('\r\n')}\r\n`;
}

// Excel: real numbers; "Total for" lines are SUM formulas over the lines they add up (with the computed value cached).
export async function reportXlsx(report, entityName) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Financial Books';
  wb.calcProperties.fullCalcOnLoad = true;
  // Sheet names can't hold * ? : \ / [ ], start or end with ', be “History”, or run past 31 characters.
  let sheetName = report.title.replace(/[*?:\\/[\]]/g, '-').slice(0, 31).replace(/^'+|'+$/g, '').trim();
  if (!sheetName || sheetName.toLowerCase() === 'history') sheetName = 'Report';
  const ws = wb.addWorksheet(sheetName);
  const width = report.detail ? report.columns.length : report.columns.length + 1;
  const align = report.opts?.custom?.align === 'left' ? 'left' : 'center';
  const title = (text, size, bold = true) => { const row = ws.addRow([text]); row.font = { bold, size }; ws.mergeCells(row.number, 1, row.number, width); row.alignment = { horizontal: align }; };
  if (showsHeader(report, 'company')) title(entityName, 14);
  title(report.title, 12);
  if (showsHeader(report, 'period')) title(report.subtitle, 10, false);
  if (report.note) { const row = ws.addRow([report.note]); ws.mergeCells(row.number, 1, row.number, width); row.alignment = { wrapText: true }; row.font = { italic: true }; }
  ws.addRow([]);
  const head = ws.addRow(report.detail ? report.columns.map(c => c.label) : ['', ...report.columns.map(c => c.label)]);
  head.font = { bold: true };
  head.eachCell(c => { c.border = { bottom: { style: 'thin' } }; });
  ws.views = [{ state: 'frozen', ySplit: head.number, xSplit: report.detail ? 0 : 1 }];
  const colLetter = n => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
  const stack = [];
  const banded = report.opts?.custom?.banded;
  let band = false;
  for (const { r, cells } of tableRows(report)) {
    const row = ws.addRow(cells.map((v, i) => {
      const n = rawOf(v);
      if (typeof n !== 'number') return v;
      return typeOf(report, i, v) === 'money' ? n / 100 : (Number.isFinite(n) ? n : null);
    }));
    // Each cell's own number format (a column can mix money, percentages and counts, as on the KPI scorecard).
    cells.forEach((v, i) => {
      if (typeof rawOf(v) !== 'number') return;
      const t = typeOf(report, i, v);
      row.getCell(i + 1).numFmt = t === 'money' ? excelMoneyFormat(report.opts?.custom) : t === 'qty' ? '#,##0.###' : '0.00%';
    });
    if (!report.detail) {
      row.getCell(1).alignment = { indent: r.depth ?? 0 };
      // Totals as SUM formulas over the rows they close.
      if (r.kind === 'section' || r.parent) stack.push({ members: r.parent ? [row.number] : [] });
      else if (r.kind === 'total' && stack.length) {
        const frame = stack.pop();
        if (frame.members.length) {
          report.columns.forEach((c, i) => {
            if (c.kind !== 'value') return;
            const cell = row.getCell(i + 2), L = colLetter(i + 2);
            cell.value = { formula: frame.members.map(n => `${L}${n}`).join('+'), result: (rawOf(cells[i + 1]) ?? 0) / 100 };
          });
        }
        stack.at(-1)?.members.push(row.number);
      } else if (stack.length) stack.at(-1).members.push(row.number);
    }
    if (r.kind !== 'line' && r.kind !== 'account') row.font = { bold: true };
    if (banded && (band = !band)) row.eachCell({ includeEmpty: true }, c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F5F8' } }; });
    if (r.grand) row.eachCell(c => { c.border = { top: { style: 'thin' }, bottom: { style: 'double' } }; });
  }
  const money = excelMoneyFormat(report.opts?.custom);
  (report.detail ? report.columns : [{}, ...report.columns]).forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    if (isMoneyCol(report, i)) { col.numFmt = money; col.width = 15; }
    else if (isQtyCol(report, i)) { col.numFmt = '#,##0.###'; col.width = 10; }
    else if (!report.detail && i > 0) { col.numFmt = '0.00%'; col.width = 11; }
    else col.width = i === 0 ? (report.detail ? 12 : 42) : c.key === 'memo' ? 30 : 18;
  });
  if (showsHeader(report, 'basis')) { ws.addRow([]); ws.addRow([`${report.basisLabel}`]).font = { italic: true, size: 9 }; }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Draws one report into a PDF document from the current page (management reports put several in one document).
export function drawReport(doc, report, entity, { company = true } = {}) {
  const { fb } = doc;
  const fmt = fmtOf(report);
  const custom = report.opts?.custom ?? {};
  const cols = report.detail ? report.columns.length : report.columns.length + 1;
  const left = doc.page.margins.left, right = doc.page.width - doc.page.margins.right, width = right - left;
  const fontSize = cols > 10 ? 6.5 : cols > 7 ? 7.5 : 9;
  const align = custom.align === 'left' ? 'left' : 'center';
  // Column widths: the label (or memo) gets what is left after the fixed-width columns.
  let widths;
  if (report.detail) {
    // Fixed widths for the usual columns, the rest share what is left; then everything is scaled to fit the page.
    const fixed = { date: 52, type: 70, num: 42, posting: 34, name: 95, split: 95, account: 110, detail_type: 80 };
    const base = c => (c.money ? 62 : fixed[c.key]);
    const flex = report.columns.filter(c => !base(c));
    const rest = (width - report.columns.reduce((s, c) => s + (base(c) ?? 0), 0)) / Math.max(1, flex.length);
    widths = report.columns.map(c => base(c) ?? Math.max(50, rest));
    const sum = widths.reduce((s, w) => s + w, 0);
    if (sum > width) widths = widths.map(w => (w * width) / sum);
  } else {
    // The label column keeps at least 110pt; the amounts share the rest (a report too wide for that says so instead).
    const labelW = Math.max(110, Math.min(220, width - 80 * report.columns.length));
    const valueW = Math.min(80, (width - labelW) / report.columns.length);
    widths = [width - valueW * report.columns.length, ...report.columns.map(() => valueW)];
  }
  if (!report.detail && widths[1] < 24) {
    doc.font(fb.b).fontSize(11).fillColor('#000').text(report.title, left, doc.page.margins.top, { width, align: 'center' });
    doc.font(fb.r).fontSize(10).fillColor('#333').text(`This report has ${report.columns.length} columns — too many to fit on a PDF page. Download it as Excel or CSV, or choose fewer columns.`,
      left, doc.y + 12, { width });
    return doc;
  }
  const xs = widths.reduce((acc, w, i) => [...acc, acc[i] + w], [left]);
  const heads = report.detail ? report.columns.map(c => c.label) : ['', ...report.columns.map(c => c.label)];
  const numeric = i => (report.detail ? Boolean(report.columns[i].money) : i > 0);
  let y;
  const header = first => {
    y = doc.page.margins.top;
    if (first) {
      if (company && !custom.hide_company) { doc.font(fb.b).fontSize(13).fillColor(fb.accent).text(entity.name, left, y, { width, align }); y = doc.y + 2; }
      doc.font(fb.b).fontSize(11).fillColor('#000').text(report.title, left, y, { width, align });
      if (!custom.hide_period) doc.font(fb.r).fontSize(9).fillColor('#333').text(report.subtitle, left, doc.y + 2, { width, align });
      if (report.note) doc.font(fb.i).fontSize(9).fillColor('#333').text(report.note, left, doc.y + 6, { width, align: 'left' });
      y = doc.y + 12;
    }
    doc.font(fb.b).fontSize(fontSize).fillColor(fb.accent);
    let h = 0;
    heads.forEach((t, i) => { doc.text(t, xs[i] + 2, y, { width: Math.max(1, widths[i] - 4), align: numeric(i) ? 'right' : 'left', height: fontSize * 3.6, ellipsis: true }); h = Math.max(h, doc.y - y); });
    y += h + 3;
    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor('#999').stroke();
    y += 4;
  };
  header(true);
  const rowH = fontSize + 4;
  let band = false;
  for (const { r, cells } of tableRows(report)) {
    if (y > doc.page.height - 60) { drawFooter(doc); doc.addPage(); header(false); }
    if (custom.banded && (band = !band)) doc.rect(left, y - 1.5, width, rowH).fill('#f2f5f8');
    const bold = r.kind !== 'line' && r.kind !== 'account';
    cells.forEach((v, i) => {
      const n = rawOf(v), type = typeOf(report, i, v);
      let t = v;
      if (typeof n === 'number') t = type === 'money' ? fmt.money(n) : type === 'qty' ? qtyText(n) : fmt.pct(n);
      if (v === null) t = '';
      const indent = !report.detail && i === 0 ? (r.depth ?? 0) * 8 : 0;
      doc.font(bold ? fb.b : fb.r).fontSize(fontSize).fillColor(type === 'money' && fmt.red(n) ? '#b3261e' : '#000');
      doc.text(String(t ?? ''), xs[i] + 2 + indent, y, { width: Math.max(1, widths[i] - 4 - indent), align: numeric(i) ? 'right' : 'left', lineBreak: false, ellipsis: true });
    });
    if (r.grand || custom.grid === 'all') doc.moveTo(left, y - 1.5).lineTo(right, y - 1.5).lineWidth(r.grand ? 0.5 : 0.25).strokeColor(r.grand ? '#000' : '#ccc').stroke();
    y += rowH;
  }
  y += 8;
  const foot = [!custom.hide_basis ? report.basisLabel : '', !custom.hide_prepared ? `Prepared ${report.preparedOn ?? new Date().toISOString().slice(0, 10)}` : ''].filter(Boolean).join(' · ');
  if (foot) doc.font(fb.i).fontSize(8).fillColor('#555').text(foot, left, Math.min(y, doc.page.height - 50), { width, align });
  return doc;
}

export const isLandscape = report => (report.detail ? report.columns.length : report.columns.length + 1) > 5;

// PDF in the company's form style; landscape when the report is wide; the column heads repeat on every page.
export function reportPdf(report, entity) {
  const doc = new PDFDocument({ size: 'LETTER', layout: isLandscape(report) ? 'landscape' : 'portrait', margin: 36, info: { Title: report.title, Producer: 'Financial Books' } });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  applyStyle(doc, entity);
  drawReport(doc, report, entity);
  drawFooter(doc);
  doc.end();
  return done;
}
