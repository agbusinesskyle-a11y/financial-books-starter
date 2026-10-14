import { transactionList } from './lists.js';
import { TYPE_LABELS } from '../domain/status.js';

// The report builder (stage R4b): start from a kind of transaction, pick the columns, group and sort — saved and
// scheduled like any other report. Columns are chosen with b_<key>=1 parameters.

export const SOURCES = [
  ['transactions', 'All transactions', null],
  ['invoices', 'Invoices', ['invoice']],
  ['sales', 'Sales (invoices, sales receipts, credit memos)', ['invoice', 'sales_receipt', 'credit_memo']],
  ['expenses', 'Expenses (expenses, checks, bills, vendor credits)', ['expense', 'check', 'bill', 'vendor_credit']],
  ['bills', 'Bills', ['bill']],
  ['journal', 'Journal entries', ['journal_entry']],
  ['banking', 'Banking (anything in a bank account)', 'bank'],
];
export const COLUMNS = [
  ['date', 'Date'], ['type', 'Transaction type'], ['num', 'No.'], ['name', 'Customer/Vendor'], ['memo', 'Memo/Description'], ['account', 'Account'],
  ['split', 'Split account'], ['due', 'Due date'], ['terms', 'Terms'], ['status', 'Status'], ['method', 'Payment method'], ['class', 'Class'],
  ['location', 'Location'], ['project', 'Project'], ['tags', 'Tags'], ['currency', 'Currency'], ['approval', 'Approval'], ['created', 'Created'],
  ['amount', 'Amount'], ['open', 'Open balance'],
];
const DEFAULTS = {
  transactions: ['date', 'type', 'num', 'name', 'memo', 'account', 'amount'],
  invoices: ['date', 'num', 'name', 'due', 'status', 'amount', 'open'],
  sales: ['date', 'type', 'num', 'name', 'memo', 'amount'],
  expenses: ['date', 'type', 'num', 'name', 'account', 'split', 'amount'],
  bills: ['date', 'num', 'name', 'due', 'approval', 'status', 'amount', 'open'],
  journal: ['date', 'num', 'memo', 'account', 'split', 'amount'],
  banking: ['date', 'type', 'num', 'name', 'account', 'memo', 'amount'],
};
export const GROUP_BY = [['none', 'No grouping'], ['name', 'Customer/Vendor'], ['type', 'Transaction type'], ['account', 'Account'], ['month', 'Month'],
  ['status', 'Status'], ['class', 'Class'], ['location', 'Location'], ['project', 'Project']];
export const SORT_BY = [['date', 'Date'], ['amount', 'Amount'], ['name', 'Customer/Vendor'], ['num', 'No.']];
export const BUILDER_EXTRA = ['b_source', 'b_group', 'b_sort', 'b_dir', ...COLUMNS.map(([k]) => `b_${k}`)];
const OPEN_TYPES = ['invoice', 'late_fee', 'bill', 'item_receipt', 'payment', 'credit_memo', 'vendor_credit', 'bill_payment'];
const CHARGES = ['invoice', 'late_fee', 'bill', 'item_receipt'];
const ESTIMATE = { pending: 'Pending', accepted: 'Accepted', rejected: 'Rejected', closed: 'Closed' };

export function builderChoices(extra) {
  const source = SOURCES.some(([k]) => k === extra.b_source) ? extra.b_source : 'transactions';
  const chosen = COLUMNS.map(([k]) => k).filter(k => extra[`b_${k}`] === '1');
  return { source, columns: chosen.length ? chosen : DEFAULTS[source], group: GROUP_BY.some(([k]) => k === extra.b_group) ? extra.b_group : 'none',
    sort: SORT_BY.some(([k]) => k === extra.b_sort) ? extra.b_sort : 'date', dir: extra.b_dir === 'desc' ? 'desc' : 'asc' };
}

export async function builderReport(db, { orgId, entityId, accounts, from, to, filters, numbers, extra }) {
  const ch = builderChoices(extra);
  const types = SOURCES.find(([k]) => k === ch.source)[2];
  const list = await transactionList(db, { orgId, entityId, accounts, from, to, filters, numbers, types: Array.isArray(types) ? types : null, bankOnly: types === 'bank' });
  const ids = list.rows.map(r => r.txnId);
  const { rows: more } = ids.length ? await db.query(
    `SELECT t.txn_id, t.type, t.due_date::text AS due, t.payment_method, t.currency, t.approval_status, t.estimate_status, t.created_at::date::text AS created,
            t.voided_at, t.total_cents::bigint AS total, tm.name AS terms, cl.name AS class, lo.name AS location, p.name AS project,
            (SELECT string_agg(g.name, ', ' ORDER BY g.name) FROM txn_tag x JOIN tag g ON g.tag_id = x.tag_id WHERE x.txn_id = t.txn_id) AS tags,
            t.total_cents - coalesce((SELECT sum(a.amount_cents) FROM application a WHERE (a.charge_txn_id = t.txn_id OR a.credit_txn_id = t.txn_id) AND a.applied_on <= $3::date), 0) AS open,
            EXISTS (SELECT 1 FROM posting ps JOIN account ac ON ac.account_id = ps.account_id WHERE ps.txn_id = t.txn_id AND ac.type = 'bank') AS banking
       FROM txn t LEFT JOIN terms tm ON tm.terms_id = t.terms_id LEFT JOIN class cl ON cl.class_id = t.class_id LEFT JOIN location lo ON lo.location_id = t.location_id
       LEFT JOIN project p ON p.project_id = t.project_id
      WHERE t.org_id = $1 AND t.txn_id = ANY($2::bigint[])`, [orgId, ids, to]) : { rows: [] };
  const info = new Map(more.map(r => [Number(r.txn_id), r]));
  const keep = r => {
    const t = info.get(r.txnId);
    return types === null || (types === 'bank' ? t?.banking : types.includes(r.txnType));
  };
  const status = (r, t) => {
    if (t.voided_at) return 'Voided';
    if (t.estimate_status) return ESTIMATE[t.estimate_status];
    if (!OPEN_TYPES.includes(r.txnType)) return '';
    if (Number(t.open) === 0) return CHARGES.includes(r.txnType) ? 'Paid' : 'Closed';
    return CHARGES.includes(r.txnType) && t.due && t.due < to ? 'Overdue' : 'Open';
  };
  let rows = list.rows.filter(keep).map(r => {
    const t = info.get(r.txnId) ?? {};
    return { ...r, month: r.cells.date.slice(0, 7), cells: { ...r.cells, due: t.due ?? '', terms: t.terms ?? '', status: status(r, t), method: t.payment_method ?? '',
      class: t.class ?? '', location: t.location ?? '', project: t.project ?? '', tags: t.tags ?? '', currency: t.currency ?? '',
      approval: t.approval_status ? { awaiting: 'Awaiting', approved: 'Approved', rejected: 'Rejected' }[t.approval_status] : '', created: t.created ?? '',
      open: OPEN_TYPES.includes(r.txnType) && !t.voided_at ? Number(t.open) : null } };
  });
  const dir = ch.dir === 'desc' ? -1 : 1;
  const sortKey = { date: r => r.cells.date + String(r.txnId).padStart(12, '0'), amount: r => r.cells.amount, name: r => r.cells.name.toLowerCase(), num: r => r.cells.num }[ch.sort];
  rows.sort((a, b) => { const x = sortKey(a), y = sortKey(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
  const columns = ch.columns.map(k => ({ key: k, label: COLUMNS.find(([c]) => c === k)[1], money: k === 'amount' || k === 'open' }));
  // Money columns go last so totals line up under them.
  columns.sort((a, b) => Number(a.money) - Number(b.money));
  const totals = rs => Object.fromEntries(columns.filter(c => c.money).map(c => [c.key, rs.reduce((s, r) => s + (r.cells[c.key] ?? 0), 0)]));
  const out = [];
  if (ch.group === 'none') out.push(...rows);
  else {
    const keyOf = r => (ch.group === 'month' ? new Date(`${r.month}-01T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' })
      : ch.group === 'type' ? r.cells.type : ch.group === 'account' ? r.cells.account : r.cells[ch.group]) || 'Not specified';
    const groups = [...new Set(rows.map(keyOf))];
    if (ch.group !== 'month') groups.sort((a, b) => (a === 'Not specified') - (b === 'Not specified') || a.localeCompare(b));
    for (const g of groups) {
      const mine = rows.filter(r => keyOf(r) === g);
      out.push({ kind: 'section', label: `${g} (${mine.length})` }, ...mine, { kind: 'total', label: `Total for ${g}`, cells: totals(mine) });
    }
  }
  if (rows.length && columns.some(c => c.money)) out.push({ kind: 'total', label: `Total (${rows.length} transactions)`, grand: true, cells: totals(rows) });
  return { columns, rows: out, truncated: list.truncated, choices: ch, typeLabels: TYPE_LABELS };
}
