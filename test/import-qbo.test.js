import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { startApp } from './app-harness.js';
import { readQboExport, parseJournal, parseAccountList, parseAgingDetail, csvRecords } from '../lib/import/qbo-read.js';
import { importQboCompany, ImportError } from '../lib/import/qbo-import.js';

// Stage B7: a QuickBooks Online export (made-up books, same layout as QuickBooks' files) imported into a new company,
// with the independent review's findings covered: locked history, rebuilt payment links that leave exactly QuickBooks'
// open amounts open, parity checked before saving, nothing dropped silently.
let app, dir, orgId;
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
const TXNS = [
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
];
const OPEN = [{ side: 'ar', type: 'Invoice', date: '2024-04-05', num: '1003', name: 'Flight School', open: 70000, due: '2024-05-05' },
  { side: 'ap', type: 'Bill', date: '2024-04-20', num: 'B-2', name: 'Hangar Co', open: 25000, due: '2024-05-20' }];

// Every account's net (debit − credit) in cents, as QuickBooks' Trial Balance shows it.
const trialBalanceOf = txns => {
  const tb = new Map();
  for (const [, , , , , lines] of txns) for (const [acct, d, c] of lines) tb.set(acct, (tb.get(acct) ?? 0) + Math.round(d * 100) - Math.round(c * 100));
  return tb;
};
async function writeJournal(file, txns, title = 'All Dates') {
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
async function writeExport(into, { txns = TXNS, tb = trialBalanceOf(TXNS) } = {}) {
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

before(async () => {
  app = await startApp();
  orgId = app.ids.orgId;
  dir = await mkdtemp(path.join(tmpdir(), 'qbo-'));
  await writeExport(dir);
});
after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });

const q = async (sql, params) => (await app.db.pool.query(sql, params)).rows;
const withOpen = async (d = dir) => ({ ...await readQboExport(d), openItems: OPEN.map(o => ({ ...o })), hasAging: { ar: true, ap: true } });

test('the export is read strictly: journal blocks, required columns, one currency, CSV records', async () => {
  const d = await readQboExport(dir);
  assert.equal(d.txns.length, TXNS.length);
  assert.deepEqual(d.txns[3].lines.map(l => [l.account, l.debit, l.credit, l.memo]), [['Visa', 0, 25055, null], ['Fuel', 20055, 0, null], ['Repairs', 5000, 0, null], ['Fuel', 0, 0, 'Free coffee']]);
  assert.deepEqual(d.vendors.map(v => [v.name, v.fullName, v.address]), [['Hangar Co', 'Hank Hangar', '9 Field Rd, Amarillo, TX 79101']]);
  const head = [null, 'Date', 'Transaction Type', 'Num', 'Name', 'Memo/Description', 'Account', 'Debit', 'Credit'];
  assert.throws(() => parseJournal([head, [null, '01/01/2024', 'Check', null, null, null, 'Operating', 10, null], [null, null, null, null, null, null, 'Fuel', null, 9]]), /doesn’t balance/);
  assert.throws(() => parseJournal([[null, 'Transaction Date', 'Transaction Type', 'Num', 'Name', 'Memo/Description', 'Account', 'Debit', 'Credit']]), /no “Date” column/);
  assert.throws(() => parseJournal([[...head, 'Currency']]), /more than one currency/);
  assert.throws(() => parseJournal([[...head, 'Exchange rate']]), /more than one currency/);
  assert.equal(parseJournal([head, [null, '2024-01-01', 'Check', null, null, null, 'Operating', null, 10], [null, null, null, null, null, null, 'Fuel', 10, null]])[0].date, '2024-01-01');
  assert.throws(() => parseJournal([head, [null, 'Jan 1 2024', 'Check', null, null, null, 'Operating', null, 10]]), /isn’t a date QuickBooks writes/);
  // A quoted description with a line break is one record.
  assert.deepEqual(csvRecords('a,"b\nc",d\r\ne,f,g'), [['a', 'b\nc', 'd'], ['e', 'f', 'g']]);
  const list = parseAccountList('X,,\nAccount #,Account Name,Type,Detail type,Description\n1010,Operating,Bank,Checking,"Main\naccount"\n,Old Loan (deleted),Long Term Liabilities,Notes Payable,\nTOTAL,,,,\n');
  assert.deepEqual(list.map(a => [a.number, a.fullName, a.description, a.deleted]), [['1010', 'Operating', 'Main\naccount', false], [null, 'Old Loan (deleted)', null, true]]);
  // Aging reports keep which side they came from; an empty one is no open items.
  const aging = parseAgingDetail('R,,\n,Date,Transaction type,Num,Vendor display name,Due date,Amount,Open balance\n,04/20/2024,Bill,0464,Hangar Co,05/20/2024,250.00,"1,250.00"\n', 'ap');
  assert.deepEqual(aging, [{ side: 'ap', type: 'Bill', date: '2024-04-20', num: '0464', name: 'Hangar Co', due: '2024-05-20', open: 125000 }]);
  assert.deepEqual(parseAgingDetail('A/R Aging Detail\nThis report contains no data.\n', 'ar'), []);
});

test('Journal parts: a manifest, every half year once, each titled and holding only its own dates', async () => {
  const parts = await mkdtemp(path.join(tmpdir(), 'qbo-parts-'));
  try {
    await writeExport(parts);
    await rm(path.join(parts, 'Journal.xlsx'));
    const half = (from, to) => TXNS.filter(t => { const [m, d, y] = t[0].split('/'); const iso = `${y}-${m}-${d}`; return iso >= from && iso <= to; });
    const part = async (name, txns, title) => {
      await mkdir(path.join(parts, 'journal', name), { recursive: true });
      await writeJournal(path.join(parts, 'journal', name, 'Journal.xlsx'), txns, title);
    };
    // A memo saying "no data" is just a memo.
    const first = half('2024-01-01', '2024-06-30').map(t => (t[2] === '101' && t[4] === 'Rent' ? [...t.slice(0, 4), 'No data received from customer', t[5]] : t));
    await part('2023-07', [], 'July - December, 2023');
    await part('2024-01', first, 'January - June, 2024');
    await part('2024-07', half('2024-07-01', '2024-12-31'), 'July - December, 2024');
    await assert.rejects(readQboExport(parts), /needs manifest\.json/);
    await writeFile(path.join(parts, 'journal', 'manifest.json'), JSON.stringify({ from: '2023-07', to: '2024-07' }));
    assert.equal((await readQboExport(parts)).txns.length, TXNS.length);
    // The manifest says where the export starts and ends; a missing first half is caught.
    await writeFile(path.join(parts, 'journal', 'manifest.json'), JSON.stringify({ from: '2023-01', to: '2024-07' }));
    await assert.rejects(readQboExport(parts), /manifest\.json says 2023-01/);
    await writeFile(path.join(parts, 'journal', 'manifest.json'), JSON.stringify({ from: '2023-07', to: '2025-07' }));
    await part('2025-07', [], 'July - December, 2025');
    await assert.rejects(readQboExport(parts), /skip from 2024-07 to 2025-07/);
    await rm(path.join(parts, 'journal', '2025-07'), { recursive: true });
    await writeFile(path.join(parts, 'journal', 'manifest.json'), JSON.stringify({ from: '2023-07', to: '2024-07' }));
    // A file that isn't the half year its folder says (by QuickBooks' own title, or by its dates) is refused.
    await part('2024-07', half('2024-07-01', '2024-12-31'), 'January - June, 2024');
    await assert.rejects(readQboExport(parts), /is titled “January - June, 2024”/);
    await part('2024-07', half('2024-01-01', '2024-12-31'), 'July - December, 2024');
    await assert.rejects(readQboExport(parts), /outside 2024-07-01 – 2024-12-31/);
  } finally {
    await rm(parts, { recursive: true, force: true });
  }
});

test('import: native documents, QuickBooks’ open amounts, rebuilt links, every account exactly as QuickBooks', async () => {
  const data = await withOpen();
  const { entityId, summary, docClash, omitted } = await importQboCompany(app.db.pool, { orgId, companyName: 'Test Air', data, actor: 'tester' });
  assert.deepEqual(summary.byType, { deposit: 2, check: 3, expense: 1, journal_entry: 7, transfer: 1, invoice: 5, payment: 2, bill: 2, bill_payment: 1 });
  assert.deepEqual(summary.savedAsJournalEntries, { 'Credit Card Credit': 1, 'Journal Entry': 4, Deposit: 1 });
  assert.deepEqual(docClash, ['Check 2024-01-11 no. 101']);
  // Nothing dropped silently: the voided check is listed, and a line's words with no amount stay in the memo.
  assert.deepEqual(omitted.map(o => [o.type, o.num, o.memo]), [['Check', '104', 'Voided']]);
  const [exp] = await q(`SELECT memo FROM txn WHERE entity_id = $1 AND source_type = 'Expense'`, [entityId]);
  assert.match(exp.memo, /Also on it: Free coffee/);
  // Every account's total equals the Journal's (the three-level account sits under Planes as "Cub: Engine").
  const want = trialBalanceOf(TXNS);
  const got = await q(`SELECT a.name, p.name AS parent, coalesce(sum(x.amount_cents), 0)::bigint AS s FROM account a LEFT JOIN account p ON p.account_id = a.parent_id
    LEFT JOIN posting x ON x.account_id = a.account_id WHERE a.entity_id = $1 GROUP BY a.name, p.name`, [entityId]);
  const label = { 'Planes:Cub:Engine': 'Planes:Cub: Engine' };
  for (const [acct, v] of want) assert.equal(Number(got.find(g => (g.parent ? `${g.parent}:${g.name}` : g.name) === (label[acct] ?? acct))?.s ?? 0), v, acct);
  assert.ok(!(await q(`SELECT 1 FROM account c JOIN account p ON p.account_id = c.parent_id WHERE c.entity_id = $1 AND p.parent_id IS NOT NULL`, [entityId])).length, 'one level deep');
  // Special accounts, contacts.
  const sys = await q(`SELECT name, system_key FROM account WHERE entity_id = $1 AND system_key IN ('ar', 'undeposited', 'retained', 'sales')`, [entityId]);
  assert.deepEqual(Object.fromEntries(sys.map(s => [s.system_key, s.name])), { ar: 'Accounts Receivable', undeposited: 'Undeposited Funds', retained: 'Retained Earnings', sales: 'Sales' });
  const [v] = await q(`SELECT email, account_no, billing_address, notes FROM vendor WHERE entity_id = $1 AND display_name = 'Hangar Co'`, [entityId]);
  assert.deepEqual([v.email, v.account_no, v.billing_address, v.notes], ['rent@hangar.example', 'H-77', { line1: '9 Field Rd', city: 'Amarillo', state: 'TX', postal: '79101' }, 'Full name: Hank Hangar']);
  // Documents: QuickBooks' open amounts and due dates; everything else settled by rebuilt links.
  const docs = await q(`SELECT txn_id, type, doc_number, total_cents, open_cents, due_date, account_id, payment_method, approval_status FROM txn
    WHERE entity_id = $1 AND type IN ('invoice', 'payment', 'bill', 'bill_payment') ORDER BY txn_date, txn_id`, [entityId]);
  assert.deepEqual(docs.map(d => [d.type, d.doc_number, Number(d.open_cents), d.due_date]), [
    ['invoice', '1001', 0, '2024-02-01'], ['payment', null, 0, null], ['invoice', '1002', 0, '2024-04-01'], ['payment', null, 0, null], ['invoice', '1003', 70000, '2024-05-05'],
    ['bill', 'B-1', 0, '2024-04-10'], ['bill_payment', '103', 0, null], ['bill', 'B-2', 25000, '2024-05-20'], ['invoice', '1004', 0, '2024-05-01'], ['invoice', '1005', 0, '2024-05-03']]);
  assert.notEqual(docs[3].account_id, null, 'a payment deposited straight to the bank');
  assert.equal(docs[6].payment_method, 'Check');
  assert.equal(docs[5].approval_status, 'approved');
  // Every document's open amount is its total less what's applied, and the links are marked as rebuilt.
  for (const d of docs) {
    const [a] = await q(`SELECT coalesce(sum(amount_cents), 0)::bigint AS s FROM application WHERE ${['invoice', 'bill'].includes(d.type) ? 'charge_txn_id' : 'credit_txn_id'} = $1`, [d.txn_id]);
    assert.equal(Number(d.total_cents) - Number(a.s), Number(d.open_cents), `${d.type} ${d.doc_number}`);
  }
  assert.ok((await q(`SELECT 1 FROM application a JOIN txn t ON t.txn_id = a.charge_txn_id WHERE t.entity_id = $1 AND a.source IS DISTINCT FROM 'qbo_import'`, [entityId])).length === 0);
  // The write-offs: one by name, one (unnamed in QuickBooks' export) by its exact amount — listed for review.
  assert.equal(summary.openItems.linksToOtherTransactions, 1);
  assert.equal(summary.openItems.linksByAmount, 1);
  assert.deepEqual([summary.openItems.ar.open, summary.openItems.ar.qbo, summary.openItems.ap.open, summary.openItems.ap.qbo], [70000, 70000, 25000, 25000]);
  // The sale's cost of goods is its own journal entry, tied to the sale.
  const [inv1002] = docs.filter(d => d.doc_number === '1002');
  const [cogs] = await q(`SELECT memo, total_cents, companion_of_txn_id FROM txn WHERE entity_id = $1 AND memo LIKE 'Cost of goods sold for%'`, [entityId]);
  assert.deepEqual([cogs.memo, Number(cogs.total_cents), Number(cogs.companion_of_txn_id)], ['Cost of goods sold for Invoice 1002', 20000, Number(inv1002.txn_id)]);
  // The record of the import, with the omissions.
  const [batch] = await q('SELECT summary, parity FROM import_batch WHERE entity_id = $1', [entityId]);
  assert.equal(batch.summary.transactions, TXNS.length - 1 + 1, 'all but the voided check, plus the cost-of-goods entry');
  assert.equal(batch.summary.omittedTransactions.length, 1);
  assert.equal(batch.parity.trialBalance, 'all accounts match');
  // Importing the same company again is refused.
  await assert.rejects(importQboCompany(app.db.pool, { orgId, companyName: 'test air', data, actor: 'tester' }), ImportError);
});

test('imported history is locked, but its open invoices and bills can still be paid', async () => {
  const [inv] = await q(`SELECT t.txn_id, t.customer_id, t.entity_id FROM txn t JOIN entity e ON e.entity_id = t.entity_id WHERE e.name = 'Test Air' AND t.doc_number = '1003'`);
  // The database refuses changes (migration 049) …
  await assert.rejects(app.db.pool.query(`UPDATE txn SET memo = 'changed' WHERE txn_id = $1`, [inv.txn_id]), /Imported from QuickBooks/);
  await assert.rejects(app.db.pool.query(`DELETE FROM txn WHERE txn_id = $1`, [inv.txn_id]), /Imported from QuickBooks/);
  await assert.rejects(app.db.pool.query(`UPDATE txn_line SET amount_cents = 1 WHERE txn_id = $1`, [inv.txn_id]), /Imported from QuickBooks/);
  await assert.rejects(app.db.pool.query(`DELETE FROM application WHERE source = 'qbo_import'`), /Imported from QuickBooks/);
  // … and the app explains instead of offering Edit, Void or Delete.
  await app.post('/company/switch', { entity_id: String(inv.entity_id) });
  const page = await (await app.get(`/txns/${inv.txn_id}`)).text();
  assert.match(page, /Imported from QuickBooks \(Invoice\)/);
  assert.doesNotMatch(page, new RegExp(`href="/txns/${inv.txn_id}/edit"`));
  const r = await app.post(`/txns/${inv.txn_id}/void`, {});
  assert.equal(r.status, 303);
  const after = await (await app.get(r.headers.get('location'))).text();
  assert.match(after, /can’t be edited, voided or deleted/);
  // Receive payment on the open imported invoice: it closes.
  const pay = await app.post('/txns', { type: 'payment', customer_id: String(inv.customer_id), txn_date: '2024-06-01', amount: '700', [`apply_${inv.txn_id}`]: '700' });
  assert.equal(pay.status, 303, await pay.clone().text());
  assert.equal(Number((await q('SELECT open_cents FROM txn WHERE txn_id = $1', [inv.txn_id]))[0].open_cents), 0);
  await app.post('/company/switch', { entity_id: String(app.ids.entityId) });
});

test('a Trial Balance or aging difference stops the import, unless that difference is accepted by name', async () => {
  const off = await mkdtemp(path.join(tmpdir(), 'qbo-off-'));
  try {
    const tb = trialBalanceOf(TXNS);
    tb.set('Fuel', tb.get('Fuel') + 1234); tb.set('Owner Equity', tb.get('Owner Equity') - 1234);
    await writeExport(off, { tb });
    await assert.rejects(importQboCompany(app.db.pool, { orgId, companyName: 'Off TB', data: await withOpen(off), actor: 'tester' }), /Trial Balance for 2 account\(s\).*Fuel: QuickBooks/s);
    assert.equal((await q(`SELECT 1 FROM entity WHERE name = 'Off TB'`)).length, 0, 'nothing left behind');
    const ok = await importQboCompany(app.db.pool, { orgId, companyName: 'Off TB', data: await withOpen(off), actor: 'tester', acceptMismatches: ['Fuel', 'Owner Equity'] });
    assert.equal(ok.summary.acceptedMismatches.length, 2);
  } finally {
    await rm(off, { recursive: true, force: true });
  }
  // QuickBooks' aging must be matched, document by document and party by party.
  const wrong = await withOpen();
  wrong.openItems[0].open = 60000;
  await assert.rejects(importQboCompany(app.db.pool, { orgId, companyName: 'Off Aging', data: wrong, actor: 'tester' }), /A\/R open items: 700\.00 open here vs 600\.00.*ar Flight School: 700\.00 open here, 600\.00 in QuickBooks/s);
  const none = { ...await readQboExport(dir), openItems: [], hasAging: { ar: false, ap: false } };
  await assert.rejects(importQboCompany(app.db.pool, { orgId, companyName: 'No Aging', data: none, actor: 'tester' }), /aging detail report is needed/);
  // A bill number the Journal writes without its leading zeros (464) still finds its aging row (0464).
  const zero = await withOpen();
  zero.txns.find(t => t.num === 'B-2').num = '464';
  zero.openItems[1].num = '0464';
  const r = await importQboCompany(app.db.pool, { orgId, companyName: 'Zeros', data: zero, actor: 'tester' });
  assert.equal(r.summary.openItems.unmatched, 0);
});

test('accounts the Journal uses must be in the chart', async () => {
  const data = await withOpen();
  data.accounts = data.accounts.filter(a => a.name !== 'Fuel');
  await assert.rejects(importQboCompany(app.db.pool, { orgId, companyName: 'Test Air 2', data, actor: 'tester' }), /aren’t in the chart of accounts.*Fuel/);
  assert.equal((await q(`SELECT 1 FROM entity WHERE name = 'Test Air 2'`)).length, 0, 'nothing left behind');
});

// ---- review round 2 ----

test('the cash-basis ledger balances with rebuilt links to journal entries (write-offs) and checks', async () => {
  const { ledgerLines } = await import('../lib/reports/ledger-data.js');
  const [e] = await q(`SELECT entity_id FROM entity WHERE name = 'Test Air'`);
  const cash = await ledgerLines(app.db.pool, { orgId, entityId: Number(e.entity_id), to: '2026-12-31', basis: 'cash' });
  assert.equal(cash.reduce((s, l) => s + l.amount, 0), 0, 'debits equal credits on cash basis');
  // The invoices written off by journal entries: income and write-off both land on cash basis, A/R nets to nothing.
  const [ar] = await q(`SELECT account_id FROM account WHERE entity_id = $1 AND system_key = 'ar'`, [e.entity_id]);
  assert.equal(cash.filter(l => l.accountId === Number(ar.account_id)).reduce((s, l) => s + l.amount, 0), 0);
});

// A small company of its own for each case below.
async function importCase(name, txns, openItems, extra = {}) {
  const d = await mkdtemp(path.join(tmpdir(), 'qbo-case-'));
  try {
    await writeExport(d, { txns, tb: trialBalanceOf(txns) });
    const data = { ...await readQboExport(d), openItems, hasAging: { ar: true, ap: true } };
    return await importQboCompany(app.db.pool, { orgId, companyName: name, data, actor: 'tester', ...extra });
  } finally {
    await rm(d, { recursive: true, force: true });
  }
}
const START = ['01/05/2024', 'Deposit', null, 'Owner', null, [['Operating', 5000, 0], ['Owner Equity', 0, 5000]]];

test('a refund check QuickBooks leaves open next to an unapplied payment: the two are set against each other', async () => {
  const txns = [START,
    ['02/01/2024', 'Invoice', '2001', 'Flight School', null, [['Accounts Receivable', 100, 0], ['Rental income', 0, 100]]],
    ['02/05/2024', 'Expense', null, 'Flight School', 'Refund', [['Operating', 0, 50], ['Accounts Receivable', 50, 0]]],
    ['02/06/2024', 'Payment', null, 'Flight School', null, [['Operating', 50, 0], ['Accounts Receivable', 0, 50]]]];
  const open = [{ side: 'ar', type: 'Invoice', date: '2024-02-01', num: '2001', name: 'Flight School', open: 10000 },
    { side: 'ar', type: 'Expense', date: '2024-02-05', num: null, name: 'Flight School', open: 5000 },
    { side: 'ar', type: 'Payment', date: '2024-02-06', num: null, name: 'Flight School', open: -5000 }];
  const r = await importCase('Offset Co', txns, open);
  assert.equal(r.subledger.summary.offsetOpenItems, 1);
  const { ledgerCheck } = await import('../lib/data/ledger.js');
  assert.equal((await ledgerCheck(app.db.pool, { orgId, entityId: r.entityId })).arMatches, true, 'the app’s own A/R reconciliation agrees');
  const [inv] = await q(`SELECT open_cents FROM txn WHERE entity_id = $1 AND type = 'invoice'`, [r.entityId]);
  assert.equal(Number(inv.open_cents), 10000);
  // Left open alone (no payment to set it against), it can't be represented: the import stops.
  await assert.rejects(importCase('Offset Co 2', txns.slice(0, 3), open.slice(0, 2)), /only documents can be here/);
});

test('Undeposited Funds: the payments adding up to exactly what’s still there wait; otherwise the import stops', async () => {
  const pay = (date, amt) => [date, 'Payment', null, 'Flight School', null, [['Undeposited Funds', amt, 0], ['Accounts Receivable', 0, amt]]];
  const txns = [START,
    ['02/01/2024', 'Invoice', '3001', 'Flight School', null, [['Accounts Receivable', 180, 0], ['Rental income', 0, 180]]],
    pay('02/02/2024', 60), pay('02/03/2024', 40), pay('02/04/2024', 80),
    ['02/05/2024', 'Deposit', null, null, null, [['Operating', 80, 0], ['Undeposited Funds', 0, 80]]]];
  // Any money there has to be accepted: QuickBooks' exports say how much, not which payments.
  await assert.rejects(importCase('Waiting Co', txns, []), /Undeposited Funds holds 100\.00: the 2 payment\(s\) adding up to it/);
  const r = await importCase('Waiting Co', txns, [], { acceptMismatches: ['Undeposited Funds'] });
  const waiting = await q(`SELECT total_cents FROM txn WHERE entity_id = $1 AND import_undeposited ORDER BY total_cents`, [r.entityId]);
  assert.deepEqual(waiting.map(w => Number(w.total_cents)), [4000, 6000]);
  const { listUndeposited } = await import('../lib/data/deposits.js');
  assert.equal((await listUndeposited(app.db.pool, { orgId, entityId: r.entityId })).length, 2);
  // 30.00 left that no set of payments adds up to: refused unless accepted (and then recorded).
  const odd = [...txns.slice(0, 5), ['02/05/2024', 'Deposit', null, null, null, [['Operating', 150, 0], ['Undeposited Funds', 0, 150]]]];
  await assert.rejects(importCase('Odd Co', odd, []), /Undeposited Funds holds 30\.00/);
  const ok = await importCase('Odd Co', odd, [], { acceptMismatches: ['Undeposited Funds'] });
  assert.match(ok.summary.acceptedMismatches.join(' '), /Undeposited Funds holds 30\.00/);
});

test('an accepted open-item difference is recorded on the import', async () => {
  const wrong = await withOpen();
  wrong.openItems[0].open = 60000;
  const r = await importQboCompany(app.db.pool, { orgId, companyName: 'Accepted Aging', data: wrong, actor: 'tester', acceptMismatches: ['A/R open items'] });
  assert.ok(r.summary.acceptedMismatches.some(m => /^A\/R open items: .*Flight School/.test(m)));
  const [batch] = await q('SELECT summary FROM import_batch WHERE entity_id = $1', [r.entityId]);
  assert.deepEqual(batch.summary.acceptedNames, ['A/R open items']);
});

test('history stays locked: no line can be added to an imported transaction', async () => {
  const [inv] = await q(`SELECT t.txn_id, t.org_id FROM txn t JOIN entity e ON e.entity_id = t.entity_id WHERE e.name = 'Test Air' AND t.doc_number = '1001'`);
  await assert.rejects(app.db.pool.query(`INSERT INTO txn_line (org_id, txn_id, line_no, description, quantity, rate_cents, amount_cents) VALUES ($1, $2, 99, 'x', 1, 100, 100)`,
    [inv.org_id, inv.txn_id]), /Imported from QuickBooks/);
});

test('rebuilt links say so and go to the right page; imported checks aren’t waiting to print; lists don’t offer Void or Delete', async () => {
  const [e] = await q(`SELECT entity_id FROM entity WHERE name = 'Test Air'`);
  await app.post('/company/switch', { entity_id: String(e.entity_id) });
  const [inv] = await q(`SELECT txn_id, customer_id FROM txn WHERE entity_id = $1 AND doc_number = '1004'`, [e.entity_id]);
  const page = await (await app.get(`/txns/${inv.txn_id}`)).text();
  assert.match(page, /rebuilt from QuickBooks/);
  assert.match(page, /href="\/ledger\/\d+">Journal Entry JE-3/, 'the write-off is a journal entry, linked where journal entries live');
  assert.doesNotMatch(await (await app.get('/checks')).text(), /Hangar Co/, 'old checks are history, not checks to print');
  const list = await (await app.get(`/customers/${inv.customer_id}?tab=transactions`)).text();
  assert.doesNotMatch(list, new RegExp(`/txns/${inv.txn_id}/(void|delete)`));
  const [b] = await q(`SELECT first_name, last_name FROM customer WHERE entity_id = $1 AND display_name = 'Buyer Ranch'`, [e.entity_id]);
  assert.deepEqual([b.first_name, b.last_name], ['Beatrice', 'Ann Buyer'], 'QuickBooks’ full name');
  await app.post('/company/switch', { entity_id: String(app.ids.entityId) });
});

// ---- review round 3 ----

test('aging as of any date equals the A/R ledger, counting journal-entry write-offs until they happen', async () => {
  const { openItems } = await import('../lib/reports/receivables.js');
  const [e] = await q(`SELECT entity_id FROM entity WHERE name = 'Test Air'`);
  const entityId = Number(e.entity_id);
  for (const asOf of ['2024-04-30', '2024-05-01', '2024-05-02', '2024-05-03', '2024-05-04', '2026-12-31']) {
    const aging = (await openItems(app.db.pool, { orgId, entityId, side: 'ar', asOf })).reduce((t, i) => t + i.open, 0);
    const [l] = await q(`SELECT coalesce(sum(p.amount_cents), 0)::bigint AS s FROM posting p JOIN account a ON a.account_id = p.account_id AND a.system_key = 'ar'
      WHERE p.entity_id = $1 AND p.txn_date <= $2::date`, [entityId, asOf]);
    assert.equal(aging, Number(l.s), asOf);
  }
  // On 5/1 invoice 1004 is open; the next day its write-off closes it.
  const on = async d => (await openItems(app.db.pool, { orgId, entityId, side: 'ar', asOf: d })).filter(i => i.num === '1004').reduce((t, i) => t + i.open, 0);
  assert.equal(await on('2024-05-01'), 30000);
  assert.equal(await on('2024-05-02'), 0);
});

test('aging reports: real dates only, and a document row needs one; a Journal line needs its transaction', async () => {
  const head = 'R,,\n,Date,Transaction type,Num,Customer full name,Due date,Amount,Open balance\n';
  assert.deepEqual(parseAgingDetail(head + ',2024-04-05,Invoice,1003,Flight School,2024-05-05,700.00,700.00\n', 'ar').map(o => [o.date, o.due, o.open]), [['2024-04-05', '2024-05-05', 70000]]);
  assert.throws(() => parseAgingDetail(head + ',April 5,Invoice,1003,Flight School,,700.00,700.00\n', 'ar'), /where a date should be/);
  assert.throws(() => parseAgingDetail(head + ',,Invoice,1003,Flight School,,700.00,700.00\n', 'ar'), /Invoice with no date/);
  assert.deepEqual(parseAgingDetail(head + '1 - 30 days past due,,,,,,,\nTotal for 1 - 30 days past due,,,,,,$0.00,$0.00\n', 'ar'), []);
  const jhead = [null, 'Date', 'Transaction Type', 'Num', 'Name', 'Memo/Description', 'Account', 'Debit', 'Credit'];
  assert.throws(() => parseJournal([jhead, [null, null, null, null, null, null, 'Operating', 100, null], [null, null, null, null, null, null, 'Fuel', null, 100]]), /isn’t part of any transaction/);
});

test('an open item more than one document could be stops the import unless accepted; other currencies are refused', async () => {
  const txns = [START,
    ['02/01/2024', 'Invoice', '4001', 'Flight School', null, [['Accounts Receivable', 100, 0], ['Rental income', 0, 100]]],
    ['02/01/2024', 'Invoice', '4001', 'Flight School', null, [['Accounts Receivable', 100, 0], ['Sales', 0, 100]]],
    ['02/02/2024', 'Payment', null, 'Flight School', null, [['Operating', 100, 0], ['Accounts Receivable', 0, 100]]]];
  const open = [{ side: 'ar', type: 'Invoice', date: '2024-02-01', num: '4001', name: 'Flight School', open: 10000 }];
  await assert.rejects(importCase('Twins Co', txns, open), /Ambiguous open items that more than one document could be/);
  const ok = await importCase('Twins Co', txns, open, { acceptMismatches: ['Ambiguous open items'] });
  assert.match(ok.summary.acceptedMismatches.join(' '), /Ambiguous open items/);
  const d = await withOpen();
  d.txns[0] = { ...d.txns[0], currency: 'EUR', exchangeRate: 1.1 };
  await assert.rejects(importQboCompany(app.db.pool, { orgId, companyName: 'Euro Co', data: d, actor: 'tester' }), /more than one currency/);
});

test('the Deposits list shows a payment deposited straight to the bank; vendor lists say View for imported rows', async () => {
  const [e] = await q(`SELECT entity_id FROM entity WHERE name = 'Test Air'`);
  await app.post('/company/switch', { entity_id: String(e.entity_id) });
  const deposits = await (await app.get('/deposits')).text();
  assert.match(deposits, /Payment straight to the bank/, 'the 4/2 payment deposited to Operating');
  const [v] = await q(`SELECT vendor_id FROM vendor WHERE entity_id = $1 AND display_name = 'Hangar Co'`, [e.entity_id]);
  const vendor = await (await app.get(`/vendors/${v.vendor_id}?tab=transactions`)).text();
  assert.doesNotMatch(vendor, />View\/Edit</);
  await app.post('/company/switch', { entity_id: String(app.ids.entityId) });
});

// ---- review round 4 ----

const openOn = async (entityId, side, asOf) => (await import('../lib/reports/receivables.js')).openItems(app.db.pool, { orgId, entityId, side, asOf });

test('an entry on A/R and A/P and its exact reversal: each link settles its own side, and nothing is left open', async () => {
  const txns = [START,
    ['01/10/2024', 'Journal Entry', 'J1', null, null, [['Accounts Receivable', 100, 0, 'Flight School'], ['Accounts Payable', 0, 100, 'Hangar Co']]],
    ['01/11/2024', 'Journal Entry', 'J2', null, 'Reversal', [['Accounts Payable', 100, 0, 'Hangar Co'], ['Accounts Receivable', 0, 100, 'Flight School']]]];
  const r = await importCase('Both Sides Co', txns, []);
  const on10 = await openOn(r.entityId, 'ar', '2024-01-10');
  assert.deepEqual(on10.map(i => [i.partyName, i.open]), [['Flight School', 10000]]);
  assert.deepEqual((await openOn(r.entityId, 'ap', '2024-01-10')).map(i => [i.partyName, i.open]), [['Hangar Co', 10000]]);
  for (const side of ['ar', 'ap']) assert.deepEqual(await openOn(r.entityId, side, '2024-01-11'), [], `${side} settled`);
  const links = await q(`SELECT credit_line_no, charge_line_no FROM application a JOIN txn t ON t.txn_id = a.charge_txn_id WHERE t.entity_id = $1`, [r.entityId]);
  assert.equal(links.length, 2);
  assert.ok(links.every(l => l.credit_line_no && l.charge_line_no), 'each link names the lines it settles');
});

test('a two-name entry and its reversal: each name’s line settles its own line, no phantom rows', async () => {
  const txns = [START,
    ['01/10/2024', 'Journal Entry', 'J1', null, null, [['Accounts Receivable', 60, 0, 'Flight School'], ['Accounts Receivable', 40, 0, 'Buyer Ranch'], ['Rental income', 0, 100]]],
    ['01/11/2024', 'Journal Entry', 'J2', null, 'Reversal', [['Rental income', 100, 0], ['Accounts Receivable', 0, 60, 'Flight School'], ['Accounts Receivable', 0, 40, 'Buyer Ranch']]]];
  const r = await importCase('Two Names Co', txns, []);
  assert.deepEqual((await openOn(r.entityId, 'ar', '2024-01-10')).map(i => [i.partyName, i.open]).sort(), [['Buyer Ranch', 4000], ['Flight School', 6000]]);
  for (const d of ['2024-01-11', '2024-02-01', '2026-12-31']) assert.deepEqual(await openOn(r.entityId, 'ar', d), [], d);
});

test('thirteen equal receipts waiting in Undeposited Funds are found; a set too big to search says so', async () => {
  const txns = [START, ...Array.from({ length: 13 }, (_, i) =>
    [`02/${String(i + 1).padStart(2, '0')}/2024`, 'Sales Receipt', `S${i + 1}`, 'Flight School', null, [['Undeposited Funds', 10, 0], ['Sales', 0, 10]]])];
  await assert.rejects(importCase('Thirteen Co', txns, []), /Undeposited Funds holds 130\.00: the 13 payment\(s\)/);
  const r = await importCase('Thirteen Co', txns, [], { acceptMismatches: ['Undeposited Funds'] });
  assert.equal(r.summary.undeposited.waiting, 13);
});

// ---- review round 5 ----

const openWith = async (db, entityId, side, asOf) => (await import('../lib/reports/receivables.js')).openItems(db, { orgId, entityId, side, asOf });
const MIGRATION_052 = new URL('../migrations/052_application_lines_backfill.sql', import.meta.url);

test('links made before line numbers: 052 names the only line it can be, and stops when it can’t tell', async () => {
  const sql = await (await import('node:fs/promises')).readFile(MIGRATION_052, 'utf8');
  const txns = [START,
    ['01/01/2024', 'Invoice', '5001', 'Flight School', null, [['Accounts Receivable', 100, 0], ['Rental income', 0, 100]]],
    ['01/02/2024', 'Journal Entry', 'W1', null, 'Write-off', [['Bad Debt', 100, 0], ['Accounts Receivable', 0, 100, 'Flight School']]]];
  const r = await importCase('Old Links Co', txns, []);
  const c = await app.db.pool.connect();
  try {
    await c.query('BEGIN'); await c.query("SELECT set_config('fb.import', 'on', true)");
    // Put the links back the way they were stored before 051.
    const { rowCount } = await c.query(`UPDATE application a SET credit_line_no = NULL, charge_line_no = NULL FROM txn t
      WHERE t.txn_id = a.charge_txn_id AND t.entity_id = $1`, [r.entityId]);
    assert.equal(rowCount, 1);
    assert.equal((await openWith(c, r.entityId, 'ar', '2024-01-02')).length, 1, 'without a line number the write-off reopens');
    await c.query(sql);
    assert.deepEqual(await openWith(c, r.entityId, 'ar', '2024-01-02'), [], 'the write-off’s only A/R line is named');
  } finally { await c.query('ROLLBACK'); c.release(); }

  // An entry on A/R and A/P has two lines a link could be: refuse rather than guess.
  const both = await importCase('Old Both Sides Co', [START,
    ['01/10/2024', 'Journal Entry', 'J1', null, null, [['Accounts Receivable', 100, 0, 'Flight School'], ['Accounts Payable', 0, 100, 'Hangar Co']]],
    ['01/11/2024', 'Journal Entry', 'J2', null, 'Reversal', [['Accounts Payable', 100, 0, 'Hangar Co'], ['Accounts Receivable', 0, 100, 'Flight School']]]], []);
  const c2 = await app.db.pool.connect();
  try {
    await c2.query('BEGIN'); await c2.query("SELECT set_config('fb.import', 'on', true)");
    await c2.query(`UPDATE application a SET credit_line_no = NULL, charge_line_no = NULL FROM txn t
      WHERE t.txn_id = a.charge_txn_id AND t.entity_id = $1`, [both.entityId]);
    await assert.rejects(c2.query(sql), /2 links to journal entries, checks or expenses .* re-import those companies/);
  } finally { await c2.query('ROLLBACK'); c2.release(); }
});
