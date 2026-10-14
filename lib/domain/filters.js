import { addDays, isIsoDate, monthRange } from './dates.js';

// The customer page's Type and Status filters, in QBO's order.
export const TYPE_OPTIONS = [
  ['all', 'All transactions'], ['all_deposits', 'All plus deposits'], ['invoice', 'Invoices'], ['credit_memo', 'Credit memos'],
  ['sales_receipt', 'Sales receipts'], ['money_received', 'Money received'], ['recently_paid', 'Recently paid'], ['payment', 'Payments'],
  ['estimate', 'Estimates'], ['late_fee', 'Late fees'],
];
export const STATUS_OPTIONS = [['all', 'All'], ['open', 'Open'], ['overdue', 'Overdue'], ['paid', 'Paid'], ['pending', 'Pending'], ['accepted', 'Accepted'],
  ['converted', 'Converted'], ['declined', 'Declined'], ['expired', 'Expired'], ['voided', 'Voided']];
// QuickBooks' date ranges (plus the last four calendar years, added per request in dateOptions()).
export const DATE_OPTIONS = [
  ['all', 'All'], ['custom', 'Custom dates'], ['today', 'Today'], ['yesterday', 'Yesterday'], ['this_week', 'This week'],
  ['last_week', 'Last week'], ['this_month', 'This month'], ['last_month', 'Last month'], ['last_30', 'Last 30 days'],
  ['this_quarter', 'This quarter'], ['last_quarter', 'Last quarter'], ['last_3_months', 'Last 3 months'],
  ['last_6_months', 'Last 6 months'], ['last_12_months', 'Last 12 months'], ['ytd', 'Year to date'], ['this_year', 'This year'],
  ['last_year', 'Last year'], ['last_365', 'Last 365 days'],
];
// The options shown in a Date select: the fixed ranges, then the four years before this one ("2025", "2024", …).
export const dateOptions = today => {
  const year = Number(today.slice(0, 4));
  return [...DATE_OPTIONS.filter(([v]) => v !== 'last_year' && v !== 'last_365'), ...[1, 2, 3, 4].map(k => [`y${year - k}`, String(year - k)])];
};

// A date range key to { from, to } (null = no limit). Weeks run Sunday to Saturday.
export function dateRange(key, today) {
  const year = Number(today.slice(0, 4)), month = Number(today.slice(5, 7));
  const iso = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.toISOString().slice(0, 10); };
  const monthsBack = n => iso(year, month - n, 1);
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const q = Math.floor((month - 1) / 3);
  const y = /^y(\d{4})$/.exec(key);
  if (y) return { from: `${y[1]}-01-01`, to: `${y[1]}-12-31` };
  switch (key) {
    case 'today': return { from: today, to: today };
    case 'yesterday': return { from: addDays(today, -1), to: addDays(today, -1) };
    case 'this_week': return { from: addDays(today, -weekday), to: addDays(today, 6 - weekday) };
    case 'last_week': return { from: addDays(today, -weekday - 7), to: addDays(today, -weekday - 1) };
    case 'this_month': return monthRange(today);
    case 'last_month': return monthRange(addDays(monthRange(today).from, -1));
    case 'last_30': return { from: addDays(today, -29), to: today };
    case 'this_quarter': return { from: iso(year, q * 3 + 1, 1), to: addDays(iso(year, q * 3 + 4, 1), -1) };
    case 'last_quarter': return { from: iso(year, q * 3 - 2, 1), to: addDays(iso(year, q * 3 + 1, 1), -1) };
    case 'last_3_months': return { from: monthsBack(3), to: addDays(monthRange(today).from, -1) };
    case 'last_6_months': return { from: monthsBack(6), to: addDays(monthRange(today).from, -1) };
    case 'last_12_months': return { from: monthsBack(12), to: addDays(monthRange(today).from, -1) };
    case 'ytd': return { from: `${year}-01-01`, to: today };
    case 'this_year': return { from: `${year}-01-01`, to: `${year}-12-31` };
    case 'last_year': return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` };
    case 'last_365': return { from: addDays(today, -364), to: today };
    default: return { from: null, to: null };
  }
}
const isDateKey = (key, today) => DATE_OPTIONS.some(([v]) => v === key) || dateOptions(today).some(([v]) => v === key);
const SORTS = ['date', 'number', 'amount'];

const pickFrom = (options, value) => (options.some(([v]) => v === value) ? value : 'all');

// Whitelists every Transaction List query parameter. Nothing from `query` reaches SQL unvalidated.
export function parseTxnFilters(query, today) {
  const type = pickFrom(TYPE_OPTIONS, query.type);
  const status = pickFrom(STATUS_OPTIONS, query.status);
  const date = isDateKey(query.date, today) ? query.date : 'all';
  let { from, to } = dateRange(date, today);
  let dateProblem = null;
  if (date === 'custom') {
    ({ from, to } = { from: null, to: null });
    if (isIsoDate(query.from) && isIsoDate(query.to) && query.from <= query.to) { from = query.from; to = query.to; }
    else if (isIsoDate(query.from) && isIsoDate(query.to)) dateProblem = 'The From date is after the To date, so all dates are shown.';
  }
  const sort = SORTS.includes(query.sort) ? query.sort : 'date';
  const dir = query.dir === 'asc' ? 'asc' : 'desc';
  const n = Number.parseInt(query.page, 10);
  const page = Number.isInteger(n) && n >= 1 && n <= 100000 ? n : 1;
  const tag = /^\d{1,18}$/.test(String(query.tag ?? '')) ? Number(query.tag) : null;
  return { type, status, date, from, to, sort, dir, page, tag, dateProblem };
}

// Filter state back to a query string (for links that keep the current filters).
export function filtersToQuery(filters, overrides = {}) {
  const f = { ...filters, ...overrides };
  const params = new URLSearchParams();
  if (f.tag) params.set('tag', String(f.tag));
  for (const key of ['type', 'status', 'date', 'sort', 'dir']) {
    const defaults = { type: 'all', status: 'all', date: 'all', sort: 'date', dir: 'desc' };
    if (f[key] !== defaults[key]) params.set(key, f[key]);
  }
  if (f.date === 'custom' && f.from && f.to) { params.set('from', f.from); params.set('to', f.to); }
  if (f.page > 1) params.set('page', String(f.page));
  return params.toString();
}
