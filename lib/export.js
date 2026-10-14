import ExcelJS from 'exceljs';
import { txnStatus, TYPE_LABELS } from './domain/status.js';

// Transaction List -> .xlsx (amounts as real numbers, dates as real dates).
export async function transactionsWorkbook({ customerName, rows, today }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Financial Books';
  const ws = wb.addWorksheet('Transactions', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Date', key: 'date', width: 12, style: { numFmt: 'm/d/yyyy' } },
    { header: 'Type', key: 'type', width: 14 },
    { header: 'No.', key: 'no', width: 14 },
    { header: 'Customer', key: 'customer', width: 28 },
    { header: 'Memo', key: 'memo', width: 34 },
    { header: 'Amount', key: 'amount', width: 14, style: { numFmt: '$#,##0.00' } },
    { header: 'Open balance', key: 'open', width: 14, style: { numFmt: '$#,##0.00' } },
    { header: 'Status', key: 'status', width: 26 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const t of rows) {
    ws.addRow({
      date: new Date(`${t.txn_date}T00:00:00Z`),
      type: TYPE_LABELS[t.type],
      no: t.doc_number ?? t.payment_ref ?? '',
      customer: t.customer_name ?? customerName,
      memo: t.memo ?? '',
      amount: t.total_cents / 100,
      open: t.open_cents / 100,
      status: txnStatus(t, today).text,
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export const exportFilename = name => `${String(name).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'customer'}-transactions.xlsx`;
