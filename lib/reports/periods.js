import { addDays } from '../domain/dates.js';

// Report periods: the 52 presets QuickBooks offers, worked out from "today" and the first month of the fiscal year.
// Every preset returns { from, to } as YYYY-MM-DD (from = null for "All Dates").

const pad = n => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const parts = iso => iso.split('-').map(Number);
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const monthStart = (y, m) => ymd(y + Math.floor((m - 1) / 12), ((m - 1) % 12 + 12) % 12 + 1, 1);
const monthEnd = (y, m) => { const yy = y + Math.floor((m - 1) / 12), mm = ((m - 1) % 12 + 12) % 12 + 1; return ymd(yy, mm, lastDay(yy, mm)); };
const weekStartOf = iso => { const d = new Date(`${iso}T00:00:00Z`); return addDays(iso, -d.getUTCDay()); }; // weeks start Sunday, like QBO

// The fiscal year containing `iso`: { start, end }.
export function fiscalYearOf(iso, startMonth = 1) {
  const [y, m] = parts(iso);
  const sy = m >= startMonth ? y : y - 1;
  return { start: ymd(sy, startMonth, 1), end: addDays(ymd(sy + 1, startMonth, 1), -1) };
}

function quarterOf(iso, startMonth = 1) {
  const [y, m] = parts(iso);
  const offset = ((m - startMonth) % 12 + 12) % 12;
  const qStartMonth = m - (offset % 3);
  return { start: monthStart(y, qStartMonth), end: monthEnd(y, qStartMonth + 2) };
}

const shiftYear = (iso, n) => { const [y, m, d] = parts(iso); return ymd(y + n, m, Math.min(d, lastDay(y + n, m))); };
const shiftMonth = (iso, n) => {
  const [y, m, d] = parts(iso);
  const t = y * 12 + (m - 1) + n, yy = Math.floor(t / 12), mm = t % 12 + 1;
  return ymd(yy, mm, Math.min(d, lastDay(yy, mm)));
};

// [key, label]
export const PERIODS = [
  ['all', 'All Dates'], ['custom', 'Custom dates'], ['today', 'Today'], ['this_week', 'This week'], ['this_week_to_date', 'This week to date'],
  ['this_fiscal_week', 'This fiscal week'], ['this_month', 'This month'], ['this_month_to_date', 'This month to date'], ['this_quarter', 'This quarter'],
  ['this_quarter_to_date', 'This quarter to date'], ['this_fiscal_quarter', 'This fiscal quarter'], ['this_fiscal_quarter_to_date', 'This fiscal quarter to date'],
  ['this_year', 'This year'], ['this_year_to_date', 'This year to date'], ['this_year_to_last_month', 'This year to last month'],
  ['this_fiscal_year', 'This fiscal year'], ['this_fiscal_year_to_date', 'This fiscal year to date'], ['this_fiscal_year_to_last_month', 'This fiscal year to last month'],
  ['last_6_months', 'Last 6 months'], ['yesterday', 'Yesterday'], ['recent', 'Recent'], ['last_week', 'Last week'], ['last_week_to_date', 'Last week to date'],
  ['last_week_to_today', 'Last week to today'], ['last_month', 'Last month'], ['last_month_to_date', 'Last month to date'], ['last_month_to_today', 'Last month to today'],
  ['last_quarter', 'Last quarter'], ['last_quarter_to_date', 'Last quarter to date'], ['last_quarter_to_today', 'Last quarter to today'],
  ['last_fiscal_quarter', 'Last fiscal quarter'], ['last_fiscal_quarter_to_date', 'Last fiscal quarter to date'], ['last_year', 'Last year'],
  ['last_year_to_date', 'Last year to date'], ['last_year_to_today', 'Last year to today'], ['last_fiscal_year', 'Last fiscal year'],
  ['last_fiscal_year_to_date', 'Last fiscal year to date'], ['last_7_days', 'Last 7 days'], ['last_30_days', 'Last 30 days'], ['last_90_days', 'Last 90 days'],
  ['last_12_months', 'Last 12 months'], ['since_30_days_ago', 'Since 30 days ago'], ['since_60_days_ago', 'Since 60 days ago'],
  ['since_90_days_ago', 'Since 90 days ago'], ['since_365_days_ago', 'Since 365 days ago'], ['next_week', 'Next week'], ['next_4_weeks', 'Next 4 weeks'],
  ['next_month', 'Next month'], ['next_quarter', 'Next quarter'], ['next_fiscal_quarter', 'Next fiscal quarter'], ['next_year', 'Next year'],
  ['next_fiscal_year', 'Next fiscal year'],
];
export const PERIOD_LABELS = Object.fromEntries(PERIODS);

export function resolvePeriod(key, today, startMonth = 1) {
  const [y, m] = parts(today);
  const week = weekStartOf(today);
  const q = quarterOf(today, 1), fq = quarterOf(today, startMonth);
  const fy = fiscalYearOf(today, startMonth);
  const lastMonthEnd = addDays(monthStart(y, m), -1);
  const prevQ = quarterOf(addDays(q.start, -1), 1), prevFq = quarterOf(addDays(fq.start, -1), startMonth);
  const prevFy = fiscalYearOf(addDays(fy.start, -1), startMonth);
  const lastWeekStart = addDays(week, -7);
  const r = (from, to) => ({ from, to });
  switch (key) {
    case 'all': return r(null, today);
    case 'today': return r(today, today);
    case 'this_week': case 'this_fiscal_week': return r(week, addDays(week, 6));
    case 'this_week_to_date': return r(week, today);
    case 'this_month': return r(monthStart(y, m), monthEnd(y, m));
    case 'this_month_to_date': return r(monthStart(y, m), today);
    case 'this_quarter': return r(q.start, q.end);
    case 'this_quarter_to_date': return r(q.start, today);
    case 'this_fiscal_quarter': return r(fq.start, fq.end);
    case 'this_fiscal_quarter_to_date': return r(fq.start, today);
    case 'this_year': return r(ymd(y, 1, 1), ymd(y, 12, 31));
    case 'this_year_to_date': return r(ymd(y, 1, 1), today);
    // In the first month there is no "last month" yet: an empty range (the start after the end).
    case 'this_year_to_last_month': return r(ymd(y, 1, 1), lastMonthEnd);
    case 'this_fiscal_year': return r(fy.start, fy.end);
    case 'this_fiscal_year_to_date': return r(fy.start, today);
    case 'this_fiscal_year_to_last_month': return r(fy.start, lastMonthEnd);
    case 'last_6_months': return r(monthStart(y, m - 6), lastMonthEnd);
    case 'yesterday': return r(addDays(today, -1), addDays(today, -1));
    case 'recent': return r(addDays(today, -4), today);
    case 'last_week': return r(lastWeekStart, addDays(lastWeekStart, 6));
    case 'last_week_to_date': return r(lastWeekStart, addDays(today, -7));
    case 'last_week_to_today': return r(lastWeekStart, today);
    case 'last_month': return r(monthStart(y, m - 1), lastMonthEnd);
    case 'last_month_to_date': return r(monthStart(y, m - 1), shiftMonth(today, -1));
    case 'last_month_to_today': return r(monthStart(y, m - 1), today);
    case 'last_quarter': return r(prevQ.start, prevQ.end);
    case 'last_quarter_to_date': return r(prevQ.start, shiftMonth(today, -3));
    case 'last_quarter_to_today': return r(prevQ.start, today);
    case 'last_fiscal_quarter': return r(prevFq.start, prevFq.end);
    case 'last_fiscal_quarter_to_date': return r(prevFq.start, shiftMonth(today, -3));
    case 'last_year': return r(ymd(y - 1, 1, 1), ymd(y - 1, 12, 31));
    case 'last_year_to_date': return r(ymd(y - 1, 1, 1), shiftYear(today, -1));
    case 'last_year_to_today': return r(ymd(y - 1, 1, 1), today);
    case 'last_fiscal_year': return r(prevFy.start, prevFy.end);
    case 'last_fiscal_year_to_date': return r(prevFy.start, shiftYear(today, -1));
    case 'last_7_days': return r(addDays(today, -6), today);
    case 'last_30_days': return r(addDays(today, -29), today);
    case 'last_90_days': return r(addDays(today, -89), today);
    case 'last_12_months': return r(monthStart(y, m - 12), lastMonthEnd);
    case 'since_30_days_ago': return r(addDays(today, -30), null);
    case 'since_60_days_ago': return r(addDays(today, -60), null);
    case 'since_90_days_ago': return r(addDays(today, -90), null);
    case 'since_365_days_ago': return r(addDays(today, -365), null);
    case 'next_week': return r(addDays(week, 7), addDays(week, 13));
    case 'next_4_weeks': return r(addDays(week, 7), addDays(week, 34));
    case 'next_month': return r(monthStart(y, m + 1), monthEnd(y, m + 1));
    case 'next_quarter': { const n = quarterOf(addDays(q.end, 1), 1); return r(n.start, n.end); }
    case 'next_fiscal_quarter': { const n = quarterOf(addDays(fq.end, 1), startMonth); return r(n.start, n.end); }
    case 'next_year': return r(ymd(y + 1, 1, 1), ymd(y + 1, 12, 31));
    case 'next_fiscal_year': { const n = fiscalYearOf(addDays(fy.end, 1), startMonth); return r(n.start, n.end); }
    default: return null;
  }
}

// The same-length period just before, and the same period a year earlier (for comparisons).
export function previousPeriod({ from, to }) {
  if (!from || !to) return null;
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  // Whole months compare to the previous whole months.
  const [fy, fm, fd] = parts(from), [ty, tm] = parts(to);
  if (fd === 1 && to === monthEnd(ty, tm)) {
    const months = (ty - fy) * 12 + (tm - fm) + 1;
    return { from: monthStart(fy, fm - months), to: addDays(from, -1) };
  }
  return { from: addDays(from, -days), to: addDays(from, -1) };
}
// A period ending on a month's last day compares with that month's last day a year earlier (Feb 28, 2025 → Feb 29, 2024).
const yearBack = iso => { const [y, m] = parts(iso); return iso === monthEnd(y, m) ? monthEnd(y - 1, m) : shiftYear(iso, -1); };
export const previousYear = ({ from, to }) => ({ from: from ? shiftYear(from, -1) : null, to: to ? yearBack(to) : null });

// Column buckets that fit: the unit asked for, or the next coarser one when there would be more than `max` columns.
const UNITS = ['days', 'weeks', 'months', 'quarters', 'years'];
export function fitBuckets(unit, from, to, max = 120, startMonth = 1) {
  for (const u of UNITS.slice(Math.max(0, UNITS.indexOf(unit)))) {
    const buckets = timeBuckets(u, from, to, startMonth);
    if (buckets.length <= max || u === 'years') return { unit: u, buckets: buckets.slice(-max), changed: u !== unit };
  }
  return { unit, buckets: [], changed: false };
}
export const UNIT_LABEL = { days: 'days', weeks: 'weeks', months: 'months', quarters: 'quarters', years: 'years' };

// Column buckets for "Display columns by" a period: [{ key, label, from, to }].
// Quarters and years follow the fiscal year (startMonth); labels say FY when it doesn't start in January.
export function timeBuckets(unit, from, to, startMonth = 1) {
  if (!from || !to || from > to) return [];
  const out = [];
  const label = (a, b) => {
    const f = new Date(`${a}T00:00:00Z`);
    if (unit === 'months') return f.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', year: 'numeric' });
    if (unit === 'quarters') return startMonth === 1 ? `Q${Math.floor(f.getUTCMonth() / 3) + 1} ${f.getUTCFullYear()}`
      : `Q${Math.floor((((f.getUTCMonth() + 1 - startMonth) % 12) + 12) % 12 / 3) + 1} FY${fiscalYearOf(a, startMonth).end.slice(0, 4)}`;
    if (unit === 'years') return startMonth === 1 ? String(f.getUTCFullYear()) : `FY${fiscalYearOf(a, startMonth).end.slice(0, 4)}`;
    if (unit === 'days') return f.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
    return `${f.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' })} - ${new Date(`${b}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' })}`;
  };
  let cur = from;
  for (let guard = 0; cur <= to && guard < 20000; guard++) {
    const [y, m] = parts(cur);
    let end;
    if (unit === 'days') end = cur;
    else if (unit === 'weeks') end = addDays(weekStartOf(cur), 6);
    else if (unit === 'months') end = monthEnd(y, m);
    else if (unit === 'quarters') end = quarterOf(cur, startMonth).end;
    else end = fiscalYearOf(cur, startMonth).end;
    if (end > to) end = to;
    out.push({ key: cur, from: cur, to: end, label: label(cur, end) });
    cur = addDays(end, 1);
  }
  return out;
}
