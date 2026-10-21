import ExcelJS from 'exceljs';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Stage B7: reads a QuickBooks Online "Export data" folder (Settings → Export data, All dates: Journal, Trial balance,
// Profit and loss, Balance sheet, General ledger, Customers, Vendors, Employees) plus accounts.json — the chart of
// accounts (name, type, detail type, parent) read off QuickBooks' Chart of accounts page, which the export leaves out.

const cellValue = v => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    if ('result' in v) return v.result ?? (typeof v.formula === 'string' && /^-?[\d.]+$/.test(v.formula) ? Number(v.formula) : null);
    if ('formula' in v) return /^-?[\d.]+$/.test(String(v.formula)) ? Number(v.formula) : null;
    if ('richText' in v) return v.richText.map(r => r.text).join('');
    if ('text' in v) return v.text;
    if (v instanceof Date) return v;
  }
  return v;
};
const str = v => { const x = cellValue(v); return x === null || x === undefined ? null : String(x).trim() || null; };
const cents = v => {
  const x = cellValue(v);
  if (x === null || x === undefined || x === '') return 0;
  const n = typeof x === 'number' ? x : Number(String(x).replace(/[$,]/g, ''));
  if (!Number.isFinite(n)) throw new Error(`Not an amount: ${x}`);
  return Math.round(n * 100);
};
const isoDate = v => {
  const x = cellValue(v);
  if (x instanceof Date) return x.toISOString().slice(0, 10);
  const t = String(x ?? '').trim();
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[1]}-${m[2]}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(t) && !Number.isNaN(Date.parse(t)) ? t : null;
};
const NO_DATA = 'This report contains no data.';

async function sheet(dir, file) {
  const p = path.join(dir, file);
  if (!existsSync(p)) return null;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(p);
  const ws = wb.worksheets[0];
  const rows = [];
  ws.eachRow({ includeEmpty: true }, (row, i) => { rows[i - 1] = row.values.slice(1); });
  return rows.map(r => r ?? []);
}
// The header row (the one holding `first`) and a reader for the rows below it by column name.
function table(rows, first) {
  const h = rows.findIndex(r => r.some(v => str(v) === first));
  if (h < 0) throw new Error(`No “${first}” column found.`);
  const cols = new Map(rows[h].map((v, i) => [str(v), i]).filter(([k]) => k));
  return { start: h + 1, get: (r, name) => (cols.has(name) ? r[cols.get(name)] : null), has: name => cols.has(name) };
}

// The Journal: one block per transaction — a first row with date, type, number and name, more rows for its other lines,
// then a total row. Lines: { account (full "Parent:Child" name), name, memo, debit, credit } in cents.
export function parseJournal(rows) {
  const t = table(rows, 'Transaction Type');
  for (const c of ['Date', 'Num', 'Name', 'Memo/Description', 'Account', 'Debit', 'Credit']) if (!t.has(c)) throw new Error(`The Journal has no “${c}” column.`);
  const head = rows[t.start - 1].map(v => str(v) ?? '');
  if (head.some(c => /currenc|exchange|foreign/i.test(c))) throw new Error('This company uses more than one currency; importing foreign-currency QuickBooks books isn’t supported yet.');
  const txns = [];
  let cur = null;
  for (let i = t.start; i < rows.length; i++) {
    const r = rows[i];
    const cells = r.map(v => str(v)).filter(Boolean);
    if (cells.length && cells.every(c => c === NO_DATA)) continue; // an empty report
    if (cells.length && cells.every(c => c === cells[0]) && /GMT[+-]\d/.test(cells[0])) continue; // the report's run-time footer
    const date = isoDate(t.get(r, 'Date'));
    if (!date && str(t.get(r, 'Date'))) throw new Error(`Journal row ${i + 1}: “${str(t.get(r, 'Date'))}” isn’t a date QuickBooks writes (MM/DD/YYYY).`);
    const account = str(t.get(r, 'Account'));
    if (date) {
      cur = { row: i + 1, date, type: str(t.get(r, 'Transaction Type')), num: str(t.get(r, 'Num')), name: str(t.get(r, 'Name')), memo: str(t.get(r, 'Memo/Description')), lines: [] };
      txns.push(cur);
    }
    if (!cur) {
      // (Debits and credits with no account are the report's grand total.)
      if (account) throw new Error(`Journal row ${i + 1} has an account line that isn’t part of any transaction (is its date missing?).`);
      continue;
    }
    if (account) {
      cur.lines.push({ account, name: str(t.get(r, 'Name')), memo: str(t.get(r, 'Memo/Description')), debit: cents(t.get(r, 'Debit')), credit: cents(t.get(r, 'Credit')) });
    } else if (!date && (cellValue(t.get(r, 'Debit')) !== null || cellValue(t.get(r, 'Credit')) !== null)) {
      cur.total = { debit: cents(t.get(r, 'Debit')), credit: cents(t.get(r, 'Credit')) };
      cur = null;
    }
  }
  for (const x of txns) {
    const d = x.lines.reduce((s, l) => s + l.debit, 0), c = x.lines.reduce((s, l) => s + l.credit, 0);
    if (d !== c) throw new Error(`Journal row ${x.row} (${x.type} ${x.date}) doesn’t balance: ${d} vs ${c}.`);
    if (x.total && (x.total.debit !== d || x.total.credit !== c)) throw new Error(`Journal row ${x.row}: lines don’t add to its total.`);
  }
  return txns;
}

// A contact list (Customers / Vendors / Employees): { name, email, phone, fullName, address }.
function parseContacts(rows, first) {
  if (!rows) return [];
  const t = table(rows, first);
  const out = [];
  for (let i = t.start; i < rows.length; i++) {
    const r = rows[i];
    const name = str(t.get(r, first));
    if (!name || /GMT[+-]\d/.test(name) || /^This report contains no data/.test(name)) continue;
    out.push({ name, email: str(t.get(r, 'Email')), phone: str(t.get(r, 'Phone Numbers')) ?? str(t.get(r, 'Phone')), fullName: str(t.get(r, 'Full Name')),
      address: str(t.get(r, 'Billing Address')) ?? str(t.get(r, 'Address')), shipping: str(t.get(r, 'Shipping Address')), account: str(t.get(r, 'Account #')) });
  }
  return out;
}

// Two-column report rows (Trial balance: name, debit, credit; P&L / Balance sheet: name, amount) for the parity check.
export function parseTrialBalance(rows) {
  if (!rows) return null;
  const h = rows.findIndex(r => r.some(v => str(v) === 'Debit'));
  if (h < 0 || !rows[h].some(v => str(v) === 'Credit')) throw new Error('Trial_balance.xlsx has no Debit/Credit header.');
  const out = Object.create(null);
  for (let i = h + 1; i < rows.length; i++) {
    const name = str(rows[i][0]);
    if (!name || name === 'TOTAL' || /GMT[+-]\d/.test(name)) continue;
    if (Object.hasOwn(out,name)) throw new Error('Trial_balance.xlsx has duplicate account identities.');
    const amount = cents(rows[i][1]) - cents(rows[i][2]);
    if (!Number.isSafeInteger(amount)) throw new Error('Trial_balance.xlsx amount exceeds exact integer cents.');
    out[name] = amount;
  }
  return out;
}

export async function readTrialBalance(dir) {
  const rows = await sheet(dir, 'Trial_balance.xlsx');
  if (!rows) throw new Error('Trial_balance.xlsx is required.');
  return parseTrialBalance(rows);
}

// CSV text → records of fields (quoted fields may hold commas, doubled quotes and line breaks).
export function csvRecords(text) {
  const s = String(text).replace(/^﻿/, '');
  const out = [];
  let rec = [], cur = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { rec.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      rec.push(cur); out.push(rec); rec = []; cur = '';
    } else cur += ch;
  }
  if (cur || rec.length) { rec.push(cur); out.push(rec); }
  return out;
}
// One CSV line → fields.
export const csvFields = line => csvRecords(line)[0] ?? [''];

// A CSV report's header record (the one with every `required` column) and a reader for the records under it.
function csvTable(text, required, what) {
  const recs = csvRecords(text);
  const h = recs.findIndex(r => required.every(c => r.includes(c)));
  if (h < 0) throw new Error(`${what} doesn’t have the columns ${required.map(c => `“${c}”`).join(', ')}.`);
  const cols = recs[h];
  return { rows: recs.slice(h + 1), get: (r, name) => (cols.indexOf(name) >= 0 ? (r[cols.indexOf(name)] ?? '').trim() : ''), cols };
}

// QuickBooks' Account List report (Reports → Account list, with the "Deleted" filter removed), exported as CSV: every
// account, deleted ones too, with its full "Parent:Child" name, type and detail type.
export function parseAccountList(text) {
  const t = csvTable(text, ['Account Name', 'Type', 'Detail type'], 'The Account List CSV');
  const out = [];
  for (const r of t.rows) {
    const fullName = t.get(r, 'Account Name'), type = t.get(r, 'Type');
    if (!fullName || !type || fullName === 'TOTAL') continue;
    const parts = fullName.split(':');
    out.push({ fullName, name: parts.at(-1), parent: parts.length > 1 ? parts.slice(0, -1).join(':') : null, type, detail: t.get(r, 'Detail type') || null,
      description: t.get(r, 'Description') || null, number: t.get(r, 'Account #') || null, deleted: /\(deleted\)$/.test(fullName) });
  }
  if (!out.length) throw new Error('The Account List CSV has no accounts.');
  return out;
}

// QuickBooks' A/R or A/P Aging Detail report (Reports → "Accounts receivable/payable aging detail", Export as CSV): every
// open invoice, bill, credit and unapplied payment — { side, type, date, num, name, due, open (cents, as QuickBooks signs it) }.
export function parseAgingDetail(text, side) {
  if (/This report contains no data|No data available/i.test(text) && !/Open balance/.test(text)) return [];
  const t = csvTable(text, ['Date', 'Transaction type', 'Num', 'Open balance'], `The ${side === 'ap' ? 'A/P' : 'A/R'} aging report`);
  const nameCol = t.cols.find(c => /^(Customer|Vendor)\b/.test(c));
  if (!nameCol) throw new Error('The aging report has no customer or vendor column.');
  const date = v => isoDate(v);
  const money = v => {
    const n = Number(String(v).replace(/[$,]/g, ''));
    if (!Number.isFinite(n)) throw new Error(`The aging report has an amount that isn’t a number: ${v}`);
    return Math.round(n * 100);
  };
  const out = [];
  for (const r of t.rows) {
    const d = date(t.get(r, 'Date'));
    if (!d) {
      // The report ends with its run time (“Tuesday, October 20, 2026 04:32 PM GMT-07:00”) — the only row after the data.
      if (/^\s*[A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}, \d{4} .*(AM|PM)/.test(t.get(r, 'Date'))) break;
      if (t.get(r, 'Date')) throw new Error(`The aging report has “${t.get(r, 'Date')}” where a date should be.`);
      if (t.get(r, 'Transaction type')) throw new Error(`The aging report has a ${t.get(r, 'Transaction type')} with no date.`);
      continue; // a heading, total or blank row
    }
    out.push({ side, type: t.get(r, 'Transaction type'), date: d, num: t.get(r, 'Num') || null, name: t.get(r, nameCol) || null,
      due: date(t.get(r, 'Due date')), open: money(t.get(r, 'Open balance')) });
  }
  return out;
}

// journal/<YYYY-MM>/Journal.xlsx parts (a company too big to export at once): each part is the half year starting that
// month. They must cover every half year from the first to the last, once each, and hold only their own dates.
async function readJournalParts(dir) {
  const manifestFile = path.join(dir, 'manifest.json');
  if (!existsSync(manifestFile)) throw new Error(`${dir} needs manifest.json naming the first and last half year exported, like {"from": "2012-01", "to": "2026-07"}.`);
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  const parts = (await readdir(dir)).filter(p => p !== 'manifest.json').sort();
  if (!parts.length) throw new Error(`${dir} has no Journal parts.`);
  if (parts[0] !== manifest.from || parts.at(-1) !== manifest.to) throw new Error(`The Journal parts run ${parts[0]} – ${parts.at(-1)}, but manifest.json says ${manifest.from} – ${manifest.to}.`);
  const halves = parts.map(p => {
    const m = /^(\d{4})-(01|07)$/.exec(p);
    if (!m) throw new Error(`Journal part folder “${p}” isn’t named YYYY-01 or YYYY-07 (a half year).`);
    return { p, from: `${m[1]}-${m[2]}-01`, to: m[2] === '01' ? `${m[1]}-06-30` : `${m[1]}-12-31` };
  });
  for (let i = 1; i < halves.length; i++) {
    const prev = halves[i - 1].to.slice(0, 4), want = halves[i - 1].from.slice(5, 7) === '01' ? `${prev}-07-01` : `${Number(prev) + 1}-01-01`;
    if (halves[i].from !== want) throw new Error(`Journal parts skip from ${halves[i - 1].p} to ${halves[i].p}: every half year is needed.`);
  }
  const txns = [];
  for (const h of halves) {
    const rows = await sheet(path.join(dir, h.p), 'Journal.xlsx');
    if (!rows) throw new Error(`Journal part ${h.p} has no Journal.xlsx.`);
    // QuickBooks' title row says which months the file holds ("January - June, 2005").
    const months = h.from.slice(5, 7) === '01' ? 'January - June' : 'July - December';
    const title = rows.slice(0, 4).map(r => str(r[0]) ?? '').find(x => /\d{4}$/.test(x));
    if (title !== `${months}, ${h.from.slice(0, 4)}`) throw new Error(`Journal part ${h.p} is titled “${title ?? '(none)'}”, not ${months}, ${h.from.slice(0, 4)}.`);
    const part = parseJournal(rows);
    const stray = part.find(x => x.date < h.from || x.date > h.to);
    if (stray) throw new Error(`Journal part ${h.p} has a transaction dated ${stray.date}, outside ${h.from} – ${h.to}.`);
    txns.push(...part);
  }
  return txns;
}

export async function readJournal(dir) {
  // One Journal.xlsx, or — for a company too big for QuickBooks to export at once — journal/<YYYY-MM>/Journal.xlsx parts.
  const journalRows = await sheet(dir, 'Journal.xlsx');
  let txns;
  if (journalRows) txns = parseJournal(journalRows);
  else if (existsSync(path.join(dir, 'journal'))) txns = await readJournalParts(path.join(dir, 'journal'));
  else throw new Error(`No Journal.xlsx (or journal/*/Journal.xlsx) in ${dir}.`);
  return txns;
}

export async function readQboExport(dir) {
  const txns = await readJournal(dir);
  const listFile = path.join(dir, 'Account_list.csv'), accountsFile = path.join(dir, 'accounts.json');
  let accounts;
  if (existsSync(listFile)) accounts = parseAccountList(await readFile(listFile, 'utf8'));
  else if (existsSync(accountsFile)) accounts = JSON.parse(await readFile(accountsFile, 'utf8'));
  else throw new Error(`No Account_list.csv (or accounts.json) — the chart of accounts — in ${dir}.`);
  const aging = async (file, side) => (existsSync(path.join(dir, file)) ? parseAgingDetail(await readFile(path.join(dir, file), 'utf8'), side) : []);
  return {
    accounts,
    txns,
    customers: parseContacts(await sheet(dir, 'Customers.xlsx'), 'Customer'),
    vendors: parseContacts(await sheet(dir, 'Vendors.xlsx'), 'Vendor'),
    employees: parseContacts(await sheet(dir, 'Employees.xlsx'), 'Employee'),
    trialBalance: parseTrialBalance(await sheet(dir, 'Trial_balance.xlsx')),
    openItems: [...await aging('Accounts_receivable_aging_detail.csv', 'ar'), ...await aging('Accounts_payable_aging_detail.csv', 'ap')],
    hasAging: { ar: existsSync(path.join(dir, 'Accounts_receivable_aging_detail.csv')), ap: existsSync(path.join(dir, 'Accounts_payable_aging_detail.csv')) },
  };
}
