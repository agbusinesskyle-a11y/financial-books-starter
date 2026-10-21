// Synthetic QuickBooks export shared by importer and rebuild tests.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';

const ACCOUNTS = [
  { name: 'Operating', type: 'Bank', detail: 'Checking' }, { name: 'Accounts Receivable', type: 'Accounts receivable (A/R)', detail: 'Accounts Receivable (A/R)' },
  { name: 'Undeposited Funds', type: 'Other Current Assets', detail: 'Undeposited Funds' }, { name: 'Planes', type: 'Fixed Assets', detail: 'Other fixed assets' },
  { name: 'Cub', parent: 'Planes', type: 'Fixed Assets', detail: 'Vehicles' }, { name: 'Engine', parent: 'Planes:Cub', type: 'Fixed Assets', detail: 'Vehicles' },
  { name: 'Visa', type: 'Credit Card', detail: 'Credit Card' },
  { name: 'Owner Equity', type: 'Equity', detail: 'Owner\'s Equity' }, { name: 'Retained Earnings', type: 'Equity', detail: 'Retained Earnings' },
  { name: 'Rental income', type: 'Income', detail: 'Service/Fee Income' }, { name: 'Fuel', type: 'Expenses', detail: 'Auto' },
  { name: 'Repairs', type: 'Expenses', detail: 'Repair & maintenance' }, { name: 'Petty Cash', type: 'Other Current Assets', detail: 'Other Current Assets' },
  { name: 'Accounts Payable', type: 'Accounts payable (A/P)', detail: 'Accounts Payable (A/P)' }, { name: 'Sales', type: 'Income', detail: 'Sales of Product Income' },
  { name: 'Cost of Goods Sold', type: 'Cost of Goods Sold', detail: 'Supplies & Materials - COGS' }, { name: 'Inventory Asset', type: 'Other Current Assets', detail: 'Inventory' },
  { name: 'Bad Debt', type: 'Expenses', detail: 'Bad debts' },
].map(a => ({ ...a, parent: a.parent ?? null, fullName: a.parent ? `${a.parent}:${a.name}` : a.name }));
// [date, type, num, name, memo, [[account, debit, credit, lineName?, lineMemo?]]]
export const TXNS = [
  ['01/05/2024', 'Deposit', null, 'Owner', 'Start-up money', [['Operating', 50000, 0], ['Owner Equity', 0, 50000]]],
  ['01/10/2024', 'Check', '101', 'Hangar Co', 'Rent', [['Operating', 0, 1200], ['Repairs', 1200, 0]]],
  ['01/11/2024', 'Check', '101', 'Hangar Co', 'Same number again', [['Operating', 0, 300], ['Repairs', 300, 0]]],
  ['01/12/2024', 'Expense', null, 'Fuel Stop', null, [['Visa', 0, 250.55], ['Fuel', 200.55, 0], ['Repairs', 50, 0], ['Fuel', 0, 0, null, 'Free coffee']]],
  ['01/15/2024', 'Check', '102', 'Chase', 'Card payment', [['Operating', 0, 250.55], ['Visa', 250.55, 0]]],
  ['01/20/2024', 'Credit Card Credit', null, 'Fuel Stop', 'Refund', [['Visa', 20, 0], ['Fuel', 0, 20]]],
  ['02/01/2024', 'Invoice', '1001', 'Flight School', null, [['Accounts Receivable', 3000, 0], ['Rental income', 0, 3000]]],
  ['02/10/2024', 'Payment', null, 'Flight School', null, [['Undeposited Funds', 3000, 0], ['Accounts Receivable', 0, 3000]]],
  ['02/11/2024', 'Deposit', null, null, null, [['Operating', 2900, 0], ['Undeposited Funds', 0, 3000], ['Petty Cash', 100, 0]]],
  ['03/01/2024', 'Deposit', null, 'Flight School', 'Rent and fuel', [['Operating', 900, 0], ['Rental income', 0, 1000, 'Flight School'], ['Petty Cash', 100, 0]]],
  ['03/05/2024', 'Transfer', null, null, null, [['Petty Cash', 50, 0], ['Operating', 0, 50]]],
  ['12/31/2024', 'Journal Entry', 'JE-1', null, 'Buy the Cub', [['Planes:Cub', 40000, 0], ['Operating', 0, 40000]]],
  ['12/31/2024', 'Journal Entry', 'JE-2', null, 'Engine overhaul', [['Planes:Cub:Engine', 9000, 0], ['Operating', 0, 9000]]],
  // Sales and purchase documents (invoices, payments, bills, bill payments) — with an open invoice and an open bill.
  ['04/01/2024', 'Invoice', '1002', 'Flight School', 'Oil', [['Accounts Receivable', 500, 0], ['Sales', 0, 500], ['Cost of Goods Sold', 200, 0], ['Inventory Asset', 0, 200]]],
  ['04/02/2024', 'Payment', null, 'Flight School', null, [['Operating', 500, 0], ['Accounts Receivable', 0, 500]]],
  ['04/05/2024', 'Invoice', '1003', 'Flight School', null, [['Accounts Receivable', 700, 0], ['Rental income', 0, 700]]],
  ['04/10/2024', 'Bill', 'B-1', 'Hangar Co', null, [['Accounts Payable', 0, 400], ['Repairs', 400, 0]]],
  ['04/12/2024', 'Bill Payment (Check)', '103', 'Hangar Co', null, [['Accounts Payable', 400, 0], ['Operating', 0, 400]]],
  ['04/20/2024', 'Bill', 'B-2', 'Hangar Co', null, [['Accounts Payable', 0, 250], ['Fuel', 250, 0]]],
  // An invoice written off by a journal entry naming the customer; another by one QuickBooks exports with no name.
  ['05/01/2024', 'Invoice', '1004', 'Flight School', null, [['Accounts Receivable', 300, 0], ['Rental income', 0, 300]]],
  ['05/02/2024', 'Journal Entry', 'JE-3', null, 'Write off', [['Accounts Receivable', 0, 300, 'Flight School'], ['Bad Debt', 300, 0]]],
  ['05/03/2024', 'Invoice', '1005', 'Gone Ranch', null, [['Accounts Receivable', 150, 0], ['Rental income', 0, 150]]],
  ['05/04/2024', 'Journal Entry', 'JE-4', null, 'Bad debt', [['Accounts Receivable', 0, 150], ['Bad Debt', 150, 0]]],
  // A voided check: QuickBooks shows it with no amounts.
  ['05/10/2024', 'Check', '104', 'Hangar Co', 'Voided', [['Operating', 0, 0], ['Repairs', 0, 0]]],
  // A card refund paid to a customer: a card credit has no customer, so it stays a journal entry naming them (KYL-648).
  ['06/15/2024', 'Credit Card Credit', null, 'Flight School', 'Customer paid on the card', [['Visa', 75, 0], ['Rental income', 0, 75]]],
];
export const OPEN = [{ side: 'ar', type: 'Invoice', date: '2024-04-05', num: '1003', name: 'Flight School', open: 70000, due: '2024-05-05' },
  { side: 'ap', type: 'Bill', date: '2024-04-20', num: 'B-2', name: 'Hangar Co', open: 25000, due: '2024-05-20' }];

// Every account's net (debit − credit) in cents, as QuickBooks' Trial Balance shows it.
export const trialBalanceOf = txns => {
  const tb = new Map();
  for (const [, , , , , lines] of txns) for (const [acct, d, c] of lines) tb.set(acct, (tb.get(acct) ?? 0) + Math.round(d * 100) - Math.round(c * 100));
  return tb;
};
export async function writeJournal(file, txns, title = 'All Dates') {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Journal');
  ws.addRow(['Test Air']); ws.addRow(['Journal']); ws.addRow([title]); ws.addRow([]);
  ws.addRow([null, 'Date', 'Transaction Type', 'Num', 'Name', 'Memo/Description', 'Account', 'Debit', 'Credit']);
  if (!txns.length) ws.addRow(Array(5).fill('This report contains no data.'));
  for (const [date, type, num, name, memo, lines] of txns) {
    lines.forEach(([acct, d, c, ln, lm], i) => ws.addRow([null, i ? null : date, i ? null : type, i ? null : num, i ? (ln ?? null) : (ln ?? name), i ? (lm ?? null) : memo,
      ACCOUNTS.find(a => a.fullName === acct).fullName, d || null, c || null]));
    const total = lines.reduce((s, l) => s + l[1], 0);
    if (total) ws.addRow([null, null, null, null, null, null, null, total, total]);
    ws.addRow([]);
  }
  await wb.xlsx.writeFile(file);
}
async function writeTrialBalance(file, tb) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('TB');
  ws.addRow(['Test Air']); ws.addRow(['Trial Balance']); ws.addRow(['All Dates']); ws.addRow([]);
  ws.addRow([null, 'Debit', 'Credit']);
  for (const [name, cents] of tb) if (cents) ws.addRow([name, cents > 0 ? cents / 100 : null, cents < 0 ? -cents / 100 : null]);
  ws.addRow(['TOTAL']);
  await wb.xlsx.writeFile(file);
}
export async function writeExport(into, { txns = TXNS, tb = trialBalanceOf(TXNS) } = {}) {
  await mkdir(into, { recursive: true });
  await writeJournal(path.join(into, 'Journal.xlsx'), txns);
  await writeTrialBalance(path.join(into, 'Trial_balance.xlsx'), tb);
  const vb = new ExcelJS.Workbook();
  const vs = vb.addWorksheet('Vendors');
  vs.addRow(['Test Air']); vs.addRow(['Vendor Contact List']); vs.addRow(['']); vs.addRow([]);
  vs.addRow([null, 'Vendor', 'Phone Numbers', 'Email', 'Full Name', 'Address', 'Account #']);
  vs.addRow([null, 'Hangar Co', '555-0100', 'rent@hangar.example; other@x', 'Hank Hangar', '9 Field Rd, Amarillo, TX 79101', 'H-77']);
  await vb.xlsx.writeFile(path.join(into, 'Vendors.xlsx'));
  const cb = new ExcelJS.Workbook();
  const cs = cb.addWorksheet('Customers');
  cs.addRow(['Test Air']); cs.addRow(['Customer Contact List']); cs.addRow(['']); cs.addRow([]);
  cs.addRow([null, 'Customer', 'Phone Numbers', 'Email', 'Full Name', 'Billing Address', 'Shipping Address']);
  cs.addRow([null, 'Flight School', null, 'ap@school.example', null, '1 Runway Dr, Lubbock, TX 79401', null]);
  cs.addRow([null, 'Buyer Ranch', null, null, 'Beatrice Ann Buyer', null, null]);
  await cb.xlsx.writeFile(path.join(into, 'Customers.xlsx'));
  await writeFile(path.join(into, 'accounts.json'), JSON.stringify(ACCOUNTS));
}
