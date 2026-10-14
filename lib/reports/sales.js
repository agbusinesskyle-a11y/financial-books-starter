import { TYPE_LABELS } from '../domain/status.js';
import { formatShortDate } from '../domain/dates.js';
import { accountLabel } from './statements.js';

// Customer-side reports built from ledger lines (sales, income by customer — so cash basis works) or from documents
// (invoice lists, statements, unbilled charges and time, deposits, estimates).

export const SALES_DOCS = ['invoice', 'sales_receipt', 'credit_memo'];
const INCOME = ['income'];
const ALL_INCOME = ['income', 'other_income'], EXPENSES = ['cost_of_goods_sold', 'expense', 'other_expense'];
const GROUP_KEY = { customer: 'customerId', vendor: 'vendorId', item: 'itemId', class: 'classId', location: 'locationId' };
const NAME_SET = { customer: 'customers', vendor: 'vendors', item: 'items', class: 'classes', location: 'locations' };
const sorted = (keys, names) => [...keys].sort((a, b) => (a === null) - (b === null) || String(names.get(a) ?? '').localeCompare(String(names.get(b) ?? '')));
const inRange = (l, c) => (!c.from || l.date >= c.from) && l.date <= c.to;

// Sales lines: income-account lines of invoices, sales receipts and credit memos (credit-normal, so sales are positive).
export function salesLines(lines, accountsById) {
  return lines.filter(l => SALES_DOCS.includes(l.type) && INCOME.includes(accountsById.get(l.accountId)?.type));
}

// Purchase lines: what bills, expenses, checks, vendor credits and item receipts bought (every leg except A/P, bank and
// card), with the sign flipped so the sales functions below show purchases as positive amounts.
export const PURCHASE_DOCS = ['bill', 'expense', 'check', 'vendor_credit', 'item_receipt'];
const PAY_SIDE = ['accounts_payable', 'bank', 'credit_card'];
export function purchaseLines(lines, accountsById) {
  return lines.filter(l => PURCHASE_DOCS.includes(l.type) && !PAY_SIDE.includes(accountsById.get(l.accountId)?.type)).map(l => ({ ...l, amount: -l.amount }));
}

// Sales by Customer / Product / Class / Location Summary: a row per group, a column per data column (total or months…).
// For products: quantity (accrual), % of sales, average price, cost of goods sold and gross margin as well.
export function salesSummary({ lines, accountsById, columns, groupBy, names, quantities = null, cogsByItem = null, select = salesLines }) {
  const sales = select(lines, accountsById);
  const key = GROUP_KEY[groupBy];
  const groups = new Map();
  for (const l of sales) {
    const g = l[key] ?? null;
    if (!groups.has(g)) groups.set(g, Array(columns.length).fill(0));
    columns.forEach((c, i) => { if (inRange(l, c)) groups.get(g)[i] -= l.amount; });
  }
  const set = names[NAME_SET[groupBy]];
  const rows = sorted(groups.keys(), set).filter(g => groups.get(g).some(Boolean))
    .map(g => ({ kind: 'account', label: g === null ? 'Not specified' : set.get(g) ?? `#${g}`, depth: 0, groupId: g, values: groups.get(g) }));
  const total = rows.reduce((t, r) => t.map((x, i) => x + r.values[i]), Array(columns.length).fill(0));
  if (groupBy === 'item' && columns.length === 1 && quantities) {
    // Product summary columns: Qty, Amount, % of Sales, Avg. Price, COGS, Gross Margin, Gross Margin %.
    const all = total[0];
    let qty = 0, cogs = 0;
    for (const r of rows) {
      const amount = r.values[0], q = quantities.get(r.groupId) ?? 0, cost = cogsByItem.get(r.groupId) ?? 0;
      qty += q; cogs += cost;
      r.values = [null, amount, null, null, cost, amount - cost, null];
      r.cells = [{ qty: q }, { v: amount }, { pct: all ? amount / all : null }, { v: q ? Math.round(amount / q) : null }, { v: cost }, { v: amount - cost }, { pct: amount ? (amount - cost) / amount : null }];
    }
    rows.push({ kind: 'computed', label: 'Total', depth: 0, grand: true, values: [null, all, null, null, cogs, all - cogs, null],
      cells: [{ qty }, { v: all }, { pct: all ? 1 : null }, { v: null }, { v: cogs }, { v: all - cogs }, { pct: all ? (all - cogs) / all : null }] });
    return { rows, total: [all], product: true };
  }
  rows.push({ kind: 'computed', label: 'Total', depth: 0, values: total, grand: true });
  return { rows, total };
}

// Sales by … Detail: each sales line in the period under its customer/product/class/location, with a running balance.
export function salesDetail({ lines, accountsById, from, to, groupBy, names, info, select = salesLines, party = 'customer' }) {
  const partyNames = party === 'vendor' ? names.vendors : names.customers;
  const sales = select(lines, accountsById).filter(l => inRange(l, { from, to }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.txnId - b.txnId));
  const key = GROUP_KEY[groupBy];
  const set = names[NAME_SET[groupBy]];
  const rows = [];
  let grand = 0;
  for (const g of sorted(new Set(sales.map(l => l[key] ?? null)), set)) {
    const label = g === null ? 'Not specified' : set.get(g) ?? `#${g}`;
    rows.push({ kind: 'section', label });
    let bal = 0;
    for (const l of sales.filter(x => (x[key] ?? null) === g)) {
      const t = info.get(l.txnId);
      bal -= l.amount;
      rows.push({ kind: 'line', txnId: l.txnId, txnType: l.type, cells: { date: l.date, type: t?.type ?? '', num: t?.num ?? '',
        name: partyNames.get(party === 'vendor' ? l.vendorId : l.customerId) ?? t?.name ?? '', product: names.items.get(l.itemId) ?? '', memo: t?.memo ?? '',
        account: accountLabel(accountsById.get(l.accountId)), amount: -l.amount, balance: bal } });
    }
    rows.push({ kind: 'total', label: `Total for ${label}`, cells: { amount: bal, balance: null } });
    grand += bal;
  }
  if (rows.length) rows.push({ kind: 'total', label: 'Total', grand: true, cells: { amount: grand } });
  const columns = [{ key: 'date', label: 'Date' }, { key: 'type', label: 'Transaction type' }, { key: 'num', label: 'No.' },
    groupBy === party ? { key: 'product', label: 'Product/Service' } : { key: 'name', label: party === 'vendor' ? 'Vendor' : 'Customer' }, { key: 'memo', label: 'Memo/Description' },
    { key: 'account', label: 'Account' }, { key: 'amount', label: 'Amount', money: true }, { key: 'balance', label: 'Balance', money: true }];
  return { rows, columns, total: grand };
}

// Income by Customer Summary: income, expenses and net income for each customer (expenses tagged to a customer count).
export function incomeByCustomer({ lines, accountsById, from, to, names }) {
  const by = new Map();
  for (const l of lines) {
    if (!inRange(l, { from, to })) continue;
    const type = accountsById.get(l.accountId)?.type;
    const kind = ALL_INCOME.includes(type) ? 0 : EXPENSES.includes(type) ? 1 : -1;
    if (kind < 0) continue;
    const g = l.customerId ?? null;
    if (!by.has(g)) by.set(g, [0, 0]);
    by.get(g)[kind] += kind === 0 ? -l.amount : l.amount;
  }
  const rows = sorted(by.keys(), names.customers).filter(g => by.get(g).some(Boolean)).map(g => {
    const [inc, exp] = by.get(g);
    return { kind: 'account', depth: 0, label: g === null ? 'Not specified' : names.customers.get(g), groupId: g, values: [inc, exp, inc - exp] };
  });
  const total = rows.reduce((t, r) => t.map((x, i) => x + r.values[i]), [0, 0, 0]);
  rows.push({ kind: 'computed', label: 'Total', depth: 0, values: total, grand: true });
  return { rows, total };
}

const docLine = (t, cells) => ({ kind: 'line', txnId: Number(t.txn_id), txnType: t.type, cells });
const appliedSql = `coalesce((SELECT sum(a.amount_cents) FROM application a WHERE (a.charge_txn_id = t.txn_id OR a.credit_txn_id = t.txn_id) AND a.applied_on <= $4::date), 0)`;

// Invoice List: invoices dated in the period, with what is still open at the period's end.
export async function invoiceList(db, { orgId, entityId, from, to, customers }) {
  const { rows } = await db.query(
    `SELECT t.txn_id, t.type, t.txn_date::text AS date, t.due_date::text AS due, t.doc_number, t.memo, t.total_cents::bigint AS total, c.display_name, t.customer_id, tm.name AS terms,
            t.total_cents - ${appliedSql} AS open
       FROM txn t JOIN customer c ON c.customer_id = t.customer_id LEFT JOIN terms tm ON tm.terms_id = t.terms_id
      WHERE t.org_id = $1 AND t.entity_id = $2 AND t.type = 'invoice' AND t.voided_at IS NULL AND ($3::date IS NULL OR t.txn_date >= $3::date) AND t.txn_date <= $4::date
      ORDER BY t.txn_date, t.txn_id`, [orgId, entityId, from, to]);
  const list = rows.filter(r => !customers.length || customers.includes(Number(r.customer_id)));
  const out = list.map(t => docLine(t, { date: t.date, num: t.doc_number ?? '', name: t.display_name, memo: t.memo ?? '', due: t.due ?? '', terms: t.terms ?? '',
    amount: Number(t.total), open: Number(t.open) }));
  if (out.length) out.push({ kind: 'total', label: 'Total', grand: true, cells: { amount: list.reduce((s, t) => s + Number(t.total), 0), open: list.reduce((s, t) => s + Number(t.open), 0) } });
  return { rows: out, columns: [{ key: 'date', label: 'Date' }, { key: 'num', label: 'No.' }, { key: 'name', label: 'Customer' }, { key: 'memo', label: 'Memo/Description' },
    { key: 'due', label: 'Due date' }, { key: 'terms', label: 'Terms' }, { key: 'amount', label: 'Amount', money: true }, { key: 'open', label: 'Open balance', money: true }] };
}

// Invoices and Received Payments: each invoice dated in the period followed by the payments and credits applied to it.
export async function invoicesAndPayments(db, { orgId, entityId, from, to, customers }) {
  const { rows: invoices } = await db.query(
    `SELECT t.txn_id, t.type, t.txn_date::text AS date, t.doc_number, t.memo, t.total_cents::bigint AS total, t.customer_id, c.display_name
       FROM txn t JOIN customer c ON c.customer_id = t.customer_id
      WHERE t.org_id = $1 AND t.entity_id = $2 AND t.type IN ('invoice', 'late_fee') AND t.voided_at IS NULL AND ($3::date IS NULL OR t.txn_date >= $3::date) AND t.txn_date <= $4::date
      ORDER BY c.display_name, t.txn_date, t.txn_id`, [orgId, entityId, from, to]);
  const list = invoices.filter(r => !customers.length || customers.includes(Number(r.customer_id)));
  const { rows: apps } = list.length ? await db.query(
    `SELECT a.charge_txn_id, a.amount_cents::bigint AS amount, a.applied_on::text AS date, c.txn_id, c.type, coalesce(c.doc_number, c.payment_ref) AS num, c.memo
       FROM application a JOIN txn c ON c.txn_id = a.credit_txn_id WHERE a.org_id = $1 AND a.charge_txn_id = ANY($2::bigint[]) AND a.applied_on <= $3::date
      ORDER BY a.applied_on, c.txn_id`, [orgId, list.map(t => t.txn_id), to]) : { rows: [] };
  const rows = [];
  let grand = 0;
  for (const id of [...new Set(list.map(t => Number(t.customer_id)))]) {
    const mine = list.filter(t => Number(t.customer_id) === id);
    rows.push({ kind: 'section', label: mine[0].display_name });
    let net = 0;
    for (const t of mine) {
      rows.push(docLine(t, { date: t.date, type: TYPE_LABELS[t.type], num: t.doc_number ?? '', memo: t.memo ?? '', amount: Number(t.total) }));
      net += Number(t.total);
      for (const a of apps.filter(x => Number(x.charge_txn_id) === Number(t.txn_id))) {
        rows.push({ kind: 'line', sub: true, txnId: Number(a.txn_id), txnType: a.type, cells: { date: a.date, type: TYPE_LABELS[a.type], num: a.num ?? '', memo: a.memo ?? '', amount: -Number(a.amount) } });
        net -= Number(a.amount);
      }
    }
    rows.push({ kind: 'total', label: `Still open for ${mine[0].display_name}`, cells: { amount: net } });
    grand += net;
  }
  if (rows.length) rows.push({ kind: 'total', label: 'Total still open', grand: true, cells: { amount: grand } });
  return { rows, total: grand, columns: [{ key: 'date', label: 'Date' }, { key: 'type', label: 'Transaction type' }, { key: 'num', label: 'No.' },
    { key: 'memo', label: 'Memo/Description' }, { key: 'amount', label: 'Amount', money: true }] };
}

// Statement List: the statements made in the period.
export async function statementList(db, { orgId, entityId, from, to, customers }) {
  const { rows } = await db.query(
    `SELECT s.statement_id, s.statement_date::text AS date, s.kind, s.start_date::text AS start, s.end_date::text AS end, s.total_due_cents::bigint AS due,
            s.sent_at, s.sent_to, s.customer_id, c.display_name
       FROM statement s JOIN customer c ON c.customer_id = s.customer_id
      WHERE s.org_id = $1 AND s.entity_id = $2 AND ($3::date IS NULL OR s.statement_date >= $3::date) AND s.statement_date <= $4::date
      ORDER BY s.statement_date, s.statement_id`, [orgId, entityId, from, to]);
  const KIND = { balance_forward: 'Balance forward', open_item: 'Open item', transaction: 'Transaction' };
  const out = rows.filter(r => !customers.length || customers.includes(Number(r.customer_id))).map(s => ({ kind: 'line', href: `/statements/${s.statement_id}`, cells: {
    date: s.date, name: s.display_name, type: KIND[s.kind], range: s.start ? `${formatShortDate(s.start)} - ${formatShortDate(s.end)}` : '',
    sent: s.sent_at ? `${new Date(s.sent_at).toISOString().slice(0, 10)}${s.sent_to ? ` to ${s.sent_to}` : ''}` : 'Not sent', amount: Number(s.due) } }));
  return { rows: out, columns: [{ key: 'date', label: 'Statement date' }, { key: 'name', label: 'Customer' }, { key: 'type', label: 'Statement type' },
    { key: 'range', label: 'Dates covered' }, { key: 'sent', label: 'Sent' }, { key: 'amount', label: 'Balance due', money: true }] };
}

// Unbilled Charges: billable expense lines (bills, expenses, checks) dated on or before the date and not yet invoiced.
export async function unbilledCharges(db, { orgId, entityId, to, customers }) {
  const { rows } = await db.query(
    `SELECT l.txn_id, t.type, t.txn_date::text AS date, t.doc_number, l.description, l.amount_cents::bigint AS amount, l.customer_id, c.display_name, v.display_name AS vendor
       FROM txn_line l JOIN txn t ON t.txn_id = l.txn_id JOIN customer c ON c.customer_id = l.customer_id LEFT JOIN vendor v ON v.vendor_id = t.vendor_id
      WHERE l.org_id = $1 AND t.entity_id = $2 AND l.billable AND t.voided_at IS NULL AND t.type IN ('bill', 'expense', 'check') AND t.txn_date <= $3::date
        AND NOT EXISTS (SELECT 1 FROM txn_line b JOIN txn i ON i.txn_id = b.txn_id
                         WHERE b.billable_txn_id = l.txn_id AND b.billable_line_no = l.line_no AND i.voided_at IS NULL AND i.txn_date <= $3::date)
      ORDER BY c.display_name, t.txn_date, l.txn_id, l.line_no`, [orgId, entityId, to]);
  return grouped(rows.filter(r => !customers.length || customers.includes(Number(r.customer_id))), r => r.display_name,
    r => docLine(r, { date: r.date, type: TYPE_LABELS[r.type], num: r.doc_number ?? '', vendor: r.vendor ?? '', memo: r.description ?? '', amount: Number(r.amount) }),
    [{ key: 'date', label: 'Date' }, { key: 'type', label: 'Transaction type' }, { key: 'num', label: 'No.' }, { key: 'vendor', label: 'Vendor' },
      { key: 'memo', label: 'Description' }, { key: 'amount', label: 'Amount', money: true }]);
}

// Unbilled Time: billable time entries on or before the date that aren't on an invoice yet (hours × the service's rate).
export async function unbilledTimeReport(db, { orgId, entityId, to, customers }) {
  const { rows } = await db.query(
    `SELECT e.entry_id, e.entry_date::text AS date, e.person, e.minutes, e.notes, e.customer_id, c.display_name, i.name AS item, coalesce(i.rate_cents, 0)::bigint AS rate
       FROM time_entry e JOIN customer c ON c.customer_id = e.customer_id LEFT JOIN item i ON i.item_id = e.item_id
      WHERE e.org_id = $1 AND e.entity_id = $2 AND e.billable AND e.entry_date <= $3::date
        AND NOT EXISTS (SELECT 1 FROM txn_line l JOIN txn t ON t.txn_id = l.txn_id WHERE l.time_entry_id = e.entry_id AND t.voided_at IS NULL AND t.txn_date <= $3::date)
      ORDER BY c.display_name, e.entry_date, e.entry_id`, [orgId, entityId, to]);
  return grouped(rows.filter(r => !customers.length || customers.includes(Number(r.customer_id))), r => r.display_name,
    r => ({ kind: 'line', href: '/time', cells: { date: r.date, person: r.person, item: r.item ?? '', memo: r.notes ?? '', hours: (r.minutes / 60).toFixed(2),
      rate: Number(r.rate), amount: Math.round((Number(r.rate) * r.minutes) / 60) } }),
    [{ key: 'date', label: 'Date' }, { key: 'person', label: 'Employee' }, { key: 'item', label: 'Product/Service' }, { key: 'memo', label: 'Notes' },
      { key: 'hours', label: 'Hours' }, { key: 'rate', label: 'Rate', money: true, noTotal: true }, { key: 'amount', label: 'Amount', money: true }]);
}

function grouped(rows, groupOf, toLine, columns) {
  const out = [];
  let grand = 0;
  for (const g of [...new Set(rows.map(groupOf))]) {
    out.push({ kind: 'section', label: g });
    let sum = 0;
    for (const r of rows.filter(x => groupOf(x) === g)) { const l = toLine(r); sum += l.cells.amount; out.push(l); }
    out.push({ kind: 'total', label: `Total for ${g}`, cells: { amount: sum } });
    grand += sum;
  }
  if (out.length) out.push({ kind: 'total', label: 'Total', grand: true, cells: { amount: grand } });
  return { rows: out, columns, total: grand };
}

// Deposit Detail: each deposit in the period and what went into it (payments and sales receipts, or other accounts).
export async function depositDetail(db, { orgId, entityId, from, to, accountsById, customers }) {
  const { rows } = await db.query(
    `SELECT false AS direct, d.txn_id AS deposit_id, d.txn_date::text AS date, d.doc_number, d.memo AS deposit_memo, d.total_cents::bigint AS total, d.account_id AS bank_id,
            d.cash_back_cents::bigint AS cash_back, d.cash_back_account_id, d.cash_back_memo,
            l.line_no, l.amount_cents::bigint AS amount, l.account_id, l.description, s.txn_id AS source_id, s.type AS source_type,
            coalesce(s.doc_number, s.payment_ref) AS source_num, coalesce(sc.display_name, lc.display_name) AS customer, coalesce(s.customer_id, l.customer_id) AS customer_id
       FROM txn d JOIN deposit_line l ON l.deposit_txn_id = d.txn_id LEFT JOIN txn s ON s.txn_id = l.source_txn_id
       LEFT JOIN customer sc ON sc.customer_id = s.customer_id LEFT JOIN customer lc ON lc.customer_id = l.customer_id
      WHERE d.org_id = $1 AND d.entity_id = $2 AND d.type = 'deposit' AND d.voided_at IS NULL AND ($3::date IS NULL OR d.txn_date >= $3::date) AND d.txn_date <= $4::date
     UNION ALL
     -- A payment or sales receipt deposited straight to a bank account (Receive payment's "Deposit to") is its own deposit.
     -- What reached the bank (after a processor's fee, plus a surcharge), from its own posting; it came from A/R (a payment)
     -- or straight from sales (a sales receipt).
     SELECT true, s.txn_id, s.txn_date::text, s.doc_number, s.memo, bank.cents, s.account_id, 0, NULL, NULL,
            1, bank.cents, CASE WHEN s.type = 'payment' THEN ar.account_id END, CASE WHEN s.type = 'sales_receipt' THEN 'Sales receipt' END,
            s.txn_id, s.type, coalesce(s.doc_number, s.payment_ref), c.display_name, s.customer_id
       FROM txn s JOIN account a ON a.account_id = s.account_id AND a.type = 'bank' JOIN customer c ON c.customer_id = s.customer_id
       CROSS JOIN LATERAL (SELECT coalesce(sum(p.amount_cents), 0)::bigint AS cents FROM posting p WHERE p.txn_id = s.txn_id AND p.account_id = s.account_id) bank
       LEFT JOIN account ar ON ar.org_id = s.org_id AND ar.entity_id = s.entity_id AND ar.system_key = 'ar'
      WHERE s.org_id = $1 AND s.entity_id = $2 AND s.type IN ('payment', 'sales_receipt') AND s.voided_at IS NULL
        AND ($3::date IS NULL OR s.txn_date >= $3::date) AND s.txn_date <= $4::date
      ORDER BY 3, 2, 11`, [orgId, entityId, from, to]);
  const out = [];
  let grand = 0;
  for (const id of [...new Set(rows.map(r => Number(r.deposit_id)))]) {
    const mine = rows.filter(r => Number(r.deposit_id) === id);
    if (customers.length && !mine.some(r => customers.includes(Number(r.customer_id)))) continue;
    const d = mine[0];
    const bank = accountsById.get(Number(d.bank_id));
    out.push({ kind: 'line', txnId: id, txnType: d.direct ? d.source_type : 'deposit', cells: { date: d.date, type: d.direct ? `${TYPE_LABELS[d.source_type]} (straight to the bank)` : 'Deposit', num: d.doc_number ?? '', name: '', memo: d.deposit_memo ?? '',
      account: bank ? accountLabel(bank) : '', amount: Number(d.total) } });
    for (const l of mine) {
      const acct = accountsById.get(Number(l.account_id));
      out.push({ kind: 'line', sub: true, txnId: l.source_id ? Number(l.source_id) : null, txnType: l.source_type, cells: { date: '',
        type: l.source_type ? TYPE_LABELS[l.source_type] : '', num: l.source_num ?? '', name: l.customer ?? '', memo: l.description ?? '',
        account: acct ? accountLabel(acct) : d.direct ? '' : 'Undeposited Funds', amount: -Number(l.amount) } });
    }
    // Cash back (stage F5): kept out of the bank, so the rows still add up to the deposit.
    if (Number(d.cash_back)) {
      const cb = accountsById.get(Number(d.cash_back_account_id));
      out.push({ kind: 'line', sub: true, txnId: null, txnType: null, cells: { date: '', type: 'Cash back', num: '', name: '', memo: d.cash_back_memo ?? '',
        account: cb ? accountLabel(cb) : '', amount: Number(d.cash_back) } });
    }
    grand += Number(d.total);
  }
  if (out.length) out.push({ kind: 'total', label: 'Total deposits', grand: true, cells: { amount: grand } });
  return { rows: out, total: grand, columns: [{ key: 'date', label: 'Date' }, { key: 'type', label: 'Transaction type' }, { key: 'num', label: 'No.' },
    { key: 'name', label: 'Customer' }, { key: 'memo', label: 'Memo/Description' }, { key: 'account', label: 'Account' }, { key: 'amount', label: 'Amount', money: true, noTotal: true }] };
}

// Estimates by Customer, and Estimates & Progress Invoicing Summary (how much of each estimate has been invoiced).
export async function estimates(db, { orgId, entityId, from, to, customers, progress = false }) {
  const { rows } = await db.query(
    `SELECT t.txn_id, t.type, t.txn_date::text AS date, t.doc_number, t.memo, t.estimate_status, t.total_cents::bigint AS total, t.open_cents::bigint AS open,
            t.customer_id, c.display_name
       FROM txn t JOIN customer c ON c.customer_id = t.customer_id
      WHERE t.org_id = $1 AND t.entity_id = $2 AND t.type = 'estimate' AND t.voided_at IS NULL AND ($3::date IS NULL OR t.txn_date >= $3::date) AND t.txn_date <= $4::date
      ORDER BY c.display_name, t.txn_date, t.txn_id`, [orgId, entityId, from, to]);
  const STATUS = { pending: 'Pending', accepted: 'Accepted', rejected: 'Rejected', closed: 'Closed' };
  const list = rows.filter(r => !customers.length || customers.includes(Number(r.customer_id)));
  const out = [];
  const tot = { amount: 0, invoiced: 0, open: 0 };
  for (const id of [...new Set(list.map(r => Number(r.customer_id)))]) {
    const mine = list.filter(r => Number(r.customer_id) === id);
    out.push({ kind: 'section', label: mine[0].display_name });
    const sub = { amount: 0, invoiced: 0, open: 0 };
    for (const t of mine) {
      const invoiced = Number(t.total) - Number(t.open);
      out.push(docLine(t, { date: t.date, num: t.doc_number ?? '', status: STATUS[t.estimate_status] ?? '', memo: t.memo ?? '',
        pct: Number(t.total) ? `${((invoiced / Number(t.total)) * 100).toFixed(2)}%` : '', amount: Number(t.total), invoiced, open: Number(t.open) }));
      sub.amount += Number(t.total); sub.invoiced += invoiced; sub.open += Number(t.open);
    }
    out.push({ kind: 'total', label: `Total for ${mine[0].display_name}`, cells: { ...sub } });
    for (const k of Object.keys(tot)) tot[k] += sub[k];
  }
  if (out.length) out.push({ kind: 'total', label: 'Total', grand: true, cells: { ...tot } });
  const columns = [{ key: 'date', label: 'Date' }, { key: 'num', label: 'No.' }, { key: 'status', label: 'Status' }, { key: 'memo', label: 'Memo/Description' },
    ...(progress ? [{ key: 'pct', label: '% invoiced' }] : []), { key: 'amount', label: 'Estimate total', money: true },
    ...(progress ? [{ key: 'invoiced', label: 'Invoiced', money: true }, { key: 'open', label: 'Left to invoice', money: true }] : [])];
  return { rows: out, columns, totals: tot };
}

// Transaction lists grouped by customer or vendor (rows from lists.transactionList, which carry the party ids).
export function groupByParty(list, { party, names }) {
  const key = party === 'customer' ? 'customerId' : 'vendorId';
  const lineKey = party === 'customer' ? 'lineCustomers' : 'lineVendors';
  const set = party === 'customer' ? names.customers : names.vendors;
  const rows = [];
  let grand = 0;
  // A journal entry shows under each name on its lines, with the amount of that name's lines.
  const of = r => (r[key] ? [r[key]] : Object.keys(r[lineKey] ?? {}).map(Number));
  for (const id of sorted(new Set(list.rows.flatMap(of)), set)) {
    rows.push({ kind: 'section', label: set.get(id) });
    let sum = 0;
    for (const r of list.rows.filter(x => of(x).includes(id))) {
      const row = r[key] ? r : { ...r, cells: { ...r.cells, name: set.get(id) ?? r.cells.name, amount: r.cells.amount === 0 ? 0 : r[lineKey][id] } };
      rows.push(row);
      sum += row.cells.amount;
    }
    rows.push({ kind: 'total', label: `Total for ${set.get(id)}`, cells: { amount: sum } });
    grand += sum;
  }
  return { rows, columns: list.columns, truncated: list.truncated, total: grand };
}

