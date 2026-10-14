import ExcelJS from 'exceljs';
import { TYPE_LABELS } from '../domain/status.js';
import { TYPE_LABEL } from '../domain/ledger.js';
import { formatAddress } from '../views/format.js';
import { zipFiles } from '../zip.js';


// Tools → Export (one workbook with every list and every transaction), All recurring, All attachments.

const date = d => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00Z`) : null);
const dollars = c => (c === null || c === undefined ? null : Number(c) / 100);

function sheet(wb, name, columns, rows) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map(([header, key, width = 16, fmt = null]) => ({ header, key, width, ...(fmt ? { style: { numFmt: fmt } } : {}) }));
  ws.getRow(1).font = { bold: true };
  for (const r of rows) ws.addRow(r);
  return ws;
}
const MONEY = '$#,##0.00', DAY = 'm/d/yyyy';

export async function exportWorkbook(db, { orgId, entityId }) {
  const q = async (sql) => (await db.query(sql, [orgId, entityId])).rows;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Financial Books';
  const customers = await q(`SELECT c.*, t.name AS terms_name FROM customer c LEFT JOIN terms t ON t.terms_id = c.terms_id
                              WHERE c.org_id = $1 AND c.entity_id = $2 ORDER BY lower(c.display_name)`);
  sheet(wb, 'Customers', [['Name', 'name', 30], ['Company', 'company', 24], ['Email', 'email', 28], ['Phone', 'phone'], ['Mobile', 'mobile'],
    ['Billing address', 'address', 40], ['Terms', 'terms'], ['Active', 'active', 8]],
  customers.map(c => ({ name: c.display_name, company: c.company_name, email: c.email, phone: c.phone, mobile: c.mobile, address: formatAddress(c.billing_address),
    terms: c.terms_name, active: c.active ? 'Yes' : 'No' })));
  const vendors = await q(`SELECT v.*, t.name AS terms_name FROM vendor v LEFT JOIN terms t ON t.terms_id = v.terms_id
                            WHERE v.org_id = $1 AND v.entity_id = $2 ORDER BY lower(v.display_name)`);
  sheet(wb, 'Vendors', [['Name', 'name', 30], ['Company', 'company', 24], ['Email', 'email', 28], ['Phone', 'phone'], ['Address', 'address', 40],
    ['Terms', 'terms'], ['Account no.', 'acct'], ['Track 1099', 't1099', 10], ['Active', 'active', 8]],
  vendors.map(v => ({ name: v.display_name, company: v.company_name, email: v.email, phone: v.phone, address: formatAddress(v.billing_address),
    terms: v.terms_name, acct: v.account_no, t1099: v.track_1099 ? 'Yes' : 'No', active: v.active ? 'Yes' : 'No' })));
  const items = await q(`SELECT i.*, ia.name AS income_name, ea.name AS expense_name FROM item i LEFT JOIN account ia ON ia.account_id = i.income_account_id
                          LEFT JOIN account ea ON ea.account_id = i.expense_account_id WHERE i.org_id = $1 AND i.entity_id = $2 AND i.kind <> 'system' ORDER BY lower(i.name)`);
  sheet(wb, 'Products and services', [['Name', 'name', 30], ['Type', 'kind', 12], ['SKU', 'sku'], ['Price', 'price', 12, MONEY], ['Cost', 'cost', 12, MONEY],
    ['Income account', 'income', 24], ['Expense account', 'expense', 24], ['On hand', 'qty', 10], ['Active', 'active', 8]],
  items.map(i => ({ name: i.name, kind: i.kind, sku: i.sku, price: dollars(i.rate_cents), cost: dollars(i.purchase_cost_cents), income: i.income_name,
    expense: i.expense_name, qty: i.kind === 'inventory' ? Number(i.qty_on_hand) : null, active: i.active ? 'Yes' : 'No' })));
  const accounts = await q(`SELECT a.*, p.name AS parent_name, coalesce((SELECT sum(amount_cents) FROM posting x WHERE x.account_id = a.account_id), 0)::bigint AS balance
                             FROM account a LEFT JOIN account p ON p.account_id = a.parent_id WHERE a.org_id = $1 AND a.entity_id = $2 ORDER BY a.number NULLS LAST, a.name`);
  sheet(wb, 'Chart of accounts', [['Number', 'number', 10], ['Name', 'name', 32], ['Type', 'type', 26], ['Parent', 'parent', 24], ['Balance (debit +)', 'balance', 16, MONEY],
    ['Active', 'active', 8]],
  accounts.map(a => ({ number: a.number, name: a.name, type: TYPE_LABEL[a.type], parent: a.parent_name, balance: dollars(a.balance), active: a.active ? 'Yes' : 'No' })));
  const lines = await q(
    `SELECT t.txn_id, t.type, t.doc_number, t.payment_ref, t.txn_date, t.due_date, t.memo, t.total_cents, t.open_cents, t.voided_at,
            coalesce(c.display_name, v.display_name) AS party, l.line_no, coalesce(i.name, a.name) AS line_what, l.description, l.quantity::float8 AS qty,
            l.rate_cents, l.amount_cents
       FROM txn t LEFT JOIN customer c ON c.customer_id = t.customer_id LEFT JOIN vendor v ON v.vendor_id = t.vendor_id
       LEFT JOIN txn_line l ON l.txn_id = t.txn_id LEFT JOIN item i ON i.item_id = l.item_id LEFT JOIN account a ON a.account_id = l.account_id
      WHERE t.org_id = $1 AND t.entity_id = $2 ORDER BY t.txn_date, t.txn_id, l.line_no`);
  sheet(wb, 'Transactions', [['Txn ID', 'id', 9], ['Date', 'date', 12, DAY], ['Type', 'type', 18], ['No.', 'no', 14], ['Name', 'party', 26], ['Due', 'due', 12, DAY],
    ['Total', 'total', 13, MONEY], ['Open', 'open', 13, MONEY], ['Voided', 'voided', 8], ['Line', 'line', 6], ['Product / account', 'what', 26],
    ['Description', 'desc', 30], ['Qty', 'qty', 8], ['Rate', 'rate', 12, MONEY], ['Line amount', 'amount', 13, MONEY], ['Memo', 'memo', 30]],
  lines.map(r => ({ id: r.txn_id, date: date(r.txn_date), type: TYPE_LABELS[r.type], no: r.doc_number ?? r.payment_ref, party: r.party, due: date(r.due_date),
    total: dollars(r.total_cents), open: dollars(r.open_cents), voided: r.voided_at ? 'Yes' : '', line: r.line_no, what: r.line_what, desc: r.description,
    qty: r.line_no ? r.qty : null, rate: r.line_no ? dollars(r.rate_cents) : null, amount: r.line_no ? dollars(r.amount_cents) : null, memo: r.memo })));
  const postings = await q(
    `SELECT p.txn_id, p.txn_date, t.type, t.doc_number, a.number, a.name, p.amount_cents, coalesce(c.display_name, v.display_name) AS party
       FROM posting p JOIN txn t ON t.txn_id = p.txn_id JOIN account a ON a.account_id = p.account_id LEFT JOIN customer c ON c.customer_id = p.customer_id
       LEFT JOIN vendor v ON v.vendor_id = coalesce(p.vendor_id, t.vendor_id) WHERE p.org_id = $1 AND p.entity_id = $2 ORDER BY p.txn_date, p.txn_id, p.posting_id`);
  sheet(wb, 'General ledger', [['Date', 'date', 12, DAY], ['Txn ID', 'id', 9], ['Type', 'type', 18], ['No.', 'no', 14], ['Account no.', 'num', 10], ['Account', 'account', 30],
    ['Name', 'party', 26], ['Debit', 'debit', 13, MONEY], ['Credit', 'credit', 13, MONEY]],
  postings.map(p => ({ date: date(p.txn_date), id: p.txn_id, type: TYPE_LABELS[p.type], no: p.doc_number, num: p.number, account: p.name, party: p.party,
    debit: p.amount_cents > 0 ? dollars(p.amount_cents) : null, credit: p.amount_cents < 0 ? dollars(-p.amount_cents) : null })));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---- all attachments ----

// filters: { q (file name / note / who), party ('customers' | 'vendors' | '') }.
export async function listAllDocuments(db, { orgId, entityId, q = '', party = '' }) {
  const { rows } = await db.query(
    `SELECT d.document_id, d.filename, d.size_bytes, d.note, d.uploaded_at, d.uploaded_by, d.txn_id, t.type AS txn_type, t.doc_number, t.payment_ref,
            d.customer_id, c.display_name AS customer_name, d.vendor_id, v.display_name AS vendor_name
       FROM document d LEFT JOIN customer c ON c.customer_id = d.customer_id LEFT JOIN vendor v ON v.vendor_id = d.vendor_id
       LEFT JOIN txn t ON t.txn_id = d.txn_id
      WHERE d.org_id = $1 AND coalesce(c.entity_id, v.entity_id) = $2
        AND ($3 = '' OR d.filename ILIKE '%' || $3 || '%' OR d.note ILIKE '%' || $3 || '%' OR c.display_name ILIKE '%' || $3 || '%' OR v.display_name ILIKE '%' || $3 || '%')
        AND ($4 = '' OR ($4 = 'customers' AND d.customer_id IS NOT NULL) OR ($4 = 'vendors' AND d.vendor_id IS NOT NULL))
      ORDER BY d.uploaded_at DESC, d.document_id DESC LIMIT 1000`, [orgId, entityId, String(q).slice(0, 100), party]);
  return rows;
}

// Every document, one at a time (contents fetched one by one, so memory stays small), for streamZip: a folder per
// customer / vendor.
export async function* documentFiles(db, { orgId, entityId }) {
  const { rows } = await db.query(
    `SELECT d.document_id, d.filename, d.uploaded_at, coalesce(c.display_name, v.display_name, 'Other') AS owner
       FROM document d LEFT JOIN customer c ON c.customer_id = d.customer_id LEFT JOIN vendor v ON v.vendor_id = d.vendor_id
      WHERE d.org_id = $1 AND coalesce(c.entity_id, v.entity_id) = $2 ORDER BY owner, d.uploaded_at, d.document_id`, [orgId, entityId]);
  for (const r of rows) {
    const { rows: [doc] } = await db.query('SELECT content FROM document WHERE org_id = $1 AND document_id = $2', [orgId, r.document_id]);
    if (doc) yield { name: `${r.owner.replace(/[\\/]+/g, '-')}/${r.filename}`, data: doc.content, date: r.uploaded_at };
  }
}

// Every document as one ZIP in memory (small archives and tests).
export async function documentsZip(db, { orgId, entityId }) {
  const { rows } = await db.query(
    `SELECT d.filename, d.content, d.uploaded_at, coalesce(c.display_name, v.display_name, 'Other') AS owner
       FROM document d LEFT JOIN customer c ON c.customer_id = d.customer_id LEFT JOIN vendor v ON v.vendor_id = d.vendor_id
      WHERE d.org_id = $1 AND coalesce(c.entity_id, v.entity_id) = $2 ORDER BY owner, d.uploaded_at`, [orgId, entityId]);
  return zipFiles(rows.map(r => ({ name: `${r.owner.replace(/[\\/]+/g, '-')}/${r.filename}`, data: r.content, date: r.uploaded_at })));
}

// ---- all recurring ----

export async function listAllRecurring(db, { orgId, entityId }) {
  const { rows } = await db.query(
    `SELECT r.template_id, r.name, r.txn_type, r.mode, r.interval_unit, r.interval_count, r.next_run_date, r.active, r.customer_id, r.vendor_id,
            c.display_name AS customer_name, v.display_name AS vendor_name,
            coalesce((SELECT sum(amount_cents) FROM recurring_template_line l WHERE l.template_id = r.template_id), 0)::bigint AS total_cents
       FROM recurring_template r LEFT JOIN customer c ON c.customer_id = r.customer_id LEFT JOIN vendor v ON v.vendor_id = r.vendor_id
      WHERE r.org_id = $1 AND r.entity_id = $2 ORDER BY r.active DESC, lower(r.name)`, [orgId, entityId]);
  return rows;
}
