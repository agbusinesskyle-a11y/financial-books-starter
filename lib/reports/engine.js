import { isIsoDate, formatShortDate, formatLongDate, addDays } from '../domain/dates.js';
import { PERIOD_LABELS, resolvePeriod, previousPeriod, previousYear, timeBuckets, fiscalYearOf, fitBuckets } from './periods.js';
import { ledgerLines } from './ledger-data.js';
import { profitAndLoss, balanceSheet, trialBalance, cashFlows, adjustedTrialBalance, sumByAccount, accountLabel, PL_TYPES } from './statements.js';
import { journalReport, transactionList, accountList } from './lists.js';
import { runPartyReport, PARTY_KINDS, ASOF_KINDS } from './engine-parties.js';
import { auditReport, auditUsers, AREAS } from './audit.js';
import { realizedGains, unrealizedGains } from './fx.js';
import { periodStart } from '../data/budgets.js';
import { parseCustom, customQuery, applyCustom, LOOK_KEYS } from './customize.js';
import { kpiScorecard, listKpis } from './kpis.js';
import { forecastReport, forecastChoices } from './forecast.js';
import { builderReport, SOURCES, COLUMNS as BUILDER_COLUMNS, GROUP_BY, SORT_BY } from './builder.js';
import { detailReport, DETAIL_COLUMNS } from './detail.js';
import { REPORTS } from './registry.js';
import { ACCOUNT_TYPES, TYPE_LABEL, normalSign } from '../domain/ledger.js';

// Runs a report: reads options from the query string, works out its columns, pulls ledger lines once and builds rows.
// Output: { def, opts, title, subtitle, columns: [{ label, kind }], rows, drill(row, i) -> query | null, ... }.

export const COLUMNS_BY = [
  ['total', 'Total only'], ['days', 'Days'], ['weeks', 'Weeks'], ['months', 'Months'], ['quarters', 'Quarters'], ['years', 'Years'],
  ['customer', 'Customers'], ['vendor', 'Vendors'], ['item', 'Products/Services'], ['class', 'Classes'], ['location', 'Locations'], ['tag', 'Tags'],
];
// Reports whose columns can be by period or dimension, with comparisons; the rest are fixed tables.
export const hasColumns = def => ['period', 'asof', 'cashflow'].includes(def.kind);
const TIME_UNITS = new Set(['days', 'weeks', 'months', 'quarters', 'years']);
const DIMS = { customer: 'customerId', vendor: 'vendorId', item: 'itemId', class: 'classId', location: 'locationId', project: 'projectId' };
export const FILTERS = ['customer', 'vendor', 'project', 'item', 'class', 'location', 'tag', 'account'];
export const COMPARE = [['pp', 'Previous period (PP)'], ['py', 'Previous year (PY)'], ['ytd', 'Year-to-date (YTD)'], ['pyytd', 'Previous year-to-date (PY YTD)']];
export const PERCENTS = [['row', '% of Row'], ['col', '% of Column'], ['income', '% of Income'], ['expense', '% of Expense']];
const COMPARE_SUFFIX = { pp: 'PP', py: 'PY', ytd: 'YTD', pyytd: 'PY YTD' };

const ids = text => [...new Set(String(text ?? '').split(',').map(s => s.trim()).filter(s => /^\d{1,18}$/.test(s) || s === 'none'))]
  .map(s => (s === 'none' ? null : Number(s)));

// query (from the URL) + the report's defaults -> options. When the options form was submitted (run=1), unticked boxes are off.
export function parseOptions(query, def, { today, fiscalStartMonth = 1 }) {
  const d = { period: 'this_year_to_date', basis: 'accrual', columnsBy: 'total', compare: [], change: false, pctChange: false, percents: [], show: 'active', ...def.defaults };
  const ran = query.run === '1';
  const pick = (key, allowed, fallback) => (allowed.includes(query[key]) ? query[key] : fallback);
  const opts = {
    period: Object.hasOwn(PERIOD_LABELS, query.period) ? query.period : d.period,
    basis: pick('basis', ['accrual', 'cash'], d.basis),
    columnsBy: hasColumns(def) ? pick('columns', COLUMNS_BY.map(c => c[0]), d.columnsBy)
      : def.timeColumns ? pick('columns', ['total', ...TIME_UNITS], d.columnsBy) : 'total',
    compare: ran ? COMPARE.map(c => c[0]).filter(k => query[`cmp_${k}`] === '1') : d.compare,
    change: ran ? query.chg === '1' : d.change,
    pctChange: ran ? query.pchg === '1' : d.pctChange,
    percents: ran ? PERCENTS.map(c => c[0]).filter(k => query[`pct_${k}`] === '1') : d.percents,
    show: pick('show', ['active', 'all', 'non_zero'], d.show),
    filters: Object.fromEntries(FILTERS.map(f => [f, query[f] ? ids(query[f]) : []])),
    accountTypes: String(query.account_type ?? '').split(',').filter(t => ACCOUNT_TYPES.some(([k]) => k === t)),
  };
  opts.notices = [];
  // A preset decides the dates; "Custom dates" uses the From/To boxes. The form also sends the dates it showed
  // (shown_from/shown_to), so a date typed without JavaScript switches to custom dates too.
  if (opts.period !== 'custom' && query.shown_to !== undefined && (String(query.from ?? '') !== String(query.shown_from ?? '') || String(query.to ?? '') !== String(query.shown_to ?? ''))) {
    opts.period = 'custom';
  }
  const goodDate = v => isIsoDate(v) && v >= '1900-01-01' && v <= '2199-12-31';
  for (const k of ['from', 'to']) {
    if (opts.period === 'custom' && query[k] && !goodDate(query[k])) opts.notices.push(`“${String(query[k]).slice(0, 20)}” isn’t a date, so the ${k === 'from' ? 'start' : 'end'} date was left out.`);
  }
  const range = opts.period === 'custom'
    ? { from: goodDate(query.from) ? query.from : null, to: goodDate(query.to) ? query.to : today }
    : resolvePeriod(opts.period, today, fiscalStartMonth);
  opts.from = range.from;
  opts.to = range.to ?? today;
  // Swap typed dates that are back to front; a preset can be empty (This year to last month, in January).
  if (opts.period === 'custom' && opts.from && opts.from > opts.to) [opts.from, opts.to] = [opts.to, opts.from];
  opts.fiscalStartMonth = fiscalStartMonth;
  // Aging: days per period and number of periods (QuickBooks' defaults: 30 and 4).
  if (def.aging) {
    const n = (v, lo, hi, dflt) => (/^\d{1,3}$/.test(String(v ?? '')) && Number(v) >= lo && Number(v) <= hi ? Number(v) : dflt);
    opts.aging = { days: n(query.aging_days, 1, 365, 30), periods: n(query.aging_periods, 1, 12, 4) };
  }
  // Report-specific choices (which budget, which person in the audit log…): short plain values only.
  opts.custom = parseCustom(query);
  if (query.c_calc_formula && !opts.custom.calc_formula) opts.notices.push(`The calculated column’s formula “${String(query.c_calc_formula).slice(0, 60)}” doesn’t work, so it was left out. Use C1, C2… with + − * / and brackets.`);
  opts.extra = Object.fromEntries((def.extra ?? []).map(k => [k, /^[\w .@'&,-]{0,100}$/.test(String(query[k] ?? '')) ? String(query[k] ?? '') : '']));
  if (def.kind === 'asof') opts.compare = opts.compare.filter(c => c === 'pp' || c === 'py');
  if (!hasColumns(def)) { opts.compare = []; opts.percents = []; opts.change = false; opts.pctChange = false; }
  return opts;
}

// The query string for these options (links, exports, drill-down). more: overrides.
export function optionsQuery(opts, more = {}) {
  const q = { period: opts.period, from: opts.from ?? '', to: opts.to, basis: opts.basis, columns: opts.columnsBy, show: opts.show, run: '1' };
  for (const c of opts.compare) q[`cmp_${c}`] = '1';
  if (opts.change) q.chg = '1';
  if (opts.pctChange) q.pchg = '1';
  for (const p of opts.percents) q[`pct_${p}`] = '1';
  for (const f of FILTERS) if (opts.filters[f].length) q[f] = opts.filters[f].map(v => v ?? 'none').join(',');
  if (opts.accountTypes.length) q.account_type = opts.accountTypes.join(',');
  if (opts.aging) { q.aging_days = opts.aging.days; q.aging_periods = opts.aging.periods; }
  for (const [k, v] of Object.entries(opts.extra ?? {})) if (v) q[k] = v;
  Object.assign(q, customQuery(opts.custom));
  return new URLSearchParams(Object.entries({ ...q, ...more }).filter(([, v]) => v !== null && v !== undefined)).toString();
}

export function rangeLabel(from, to, kind) {
  if (ASOF_KINDS.has(kind)) return `As of ${formatLongDate(to)}`;
  return from ? `${formatLongDate(from)} - ${formatLongDate(to)}` : `All dates through ${formatLongDate(to)}`;
}

// Names for customers, vendors, items, classes, locations and tags (column headings, filters, detail rows).
export async function loadNames(db, { orgId, entityId }) {
  const q = (sql, params = [orgId]) => db.query(sql, params).then(r => new Map(r.rows.map(x => [Number(x.id), x.name])));
  const [customers, vendors, items, classes, locations, tags, projects] = await Promise.all([
    q('SELECT customer_id AS id, display_name AS name FROM customer WHERE org_id = $1 AND entity_id = $2', [orgId, entityId]),
    q('SELECT vendor_id AS id, display_name AS name FROM vendor WHERE org_id = $1 AND entity_id = $2', [orgId, entityId]),
    q('SELECT item_id AS id, name FROM item WHERE org_id = $1 AND entity_id = $2', [orgId, entityId]),
    q('SELECT class_id AS id, name FROM class WHERE org_id = $1 AND entity_id = $2', [orgId, entityId]),
    q('SELECT location_id AS id, name FROM location WHERE org_id = $1 AND entity_id = $2', [orgId, entityId]),
    q('SELECT tag_id AS id, name FROM tag WHERE org_id = $1 AND entity_id = $2', [orgId, entityId]),
    q(`SELECT p.project_id AS id, c.display_name || ': ' || p.name AS name FROM project p JOIN customer c ON c.customer_id = p.customer_id WHERE p.org_id = $1 AND c.entity_id = $2`, [orgId, entityId]),
  ]);
  return { customers, vendors, items, classes, locations, tags, projects };
}
const NAME_SET = { customer: 'customers', vendor: 'vendors', item: 'items', class: 'classes', location: 'locations', tag: 'tags' };

async function tagsByTxn(db, orgId, txnIds) {
  if (!txnIds.length) return new Map();
  const { rows } = await db.query('SELECT txn_id, tag_id FROM txn_tag WHERE org_id = $1 AND txn_id = ANY($2::bigint[])', [orgId, txnIds]);
  const out = new Map();
  for (const r of rows) { const t = Number(r.txn_id); if (!out.has(t)) out.set(t, new Set()); out.get(t).add(Number(r.tag_id)); }
  return out;
}

// A line filter from the options (customer, vendor, … tag, account, account type).
function lineFilter(opts, accountsById, tags) {
  const tests = [];
  for (const [f, key] of Object.entries(DIMS)) {
    const want = opts.filters[f];
    if (want?.length) tests.push(l => want.includes(l[key] ?? null));
  }
  if (opts.filters.tag.length) {
    const want = opts.filters.tag;
    tests.push(l => { const t = tags.get(l.txnId); return want.some(id => (id === null ? !t?.size : t?.has(id))); });
  }
  if (opts.filters.account.length) { const want = new Set(opts.filters.account); tests.push(l => want.has(l.accountId)); }
  if (opts.accountTypes.length) tests.push(l => opts.accountTypes.includes(accountsById.get(l.accountId)?.type));
  return l => tests.every(t => t(l));
}

// Base columns: one total, time buckets (+ a total for period reports), or one per customer/class/… seen (+ not specified, total).
function baseColumns(opts, def, lines, names, tags) {
  const { from, to, columnsBy } = opts;
  const asof = def.kind === 'asof';
  if (columnsBy === 'total') return [{ key: 'total', label: asof ? formatShortDate(to) : 'Total', from, to }];
  if (TIME_UNITS.has(columnsBy)) {
    const start = from ?? lines.reduce((m, l) => (l.date < m ? l.date : m), to);
    const fit = fitBuckets(columnsBy, start, to, 120, opts.fiscalStartMonth);
    if (fit.changed) opts.notices.push(`That is too many ${columnsBy} for columns, so the report shows ${fit.unit} instead.`);
    const buckets = fit.buckets;
    if (asof) return buckets.map(b => ({ key: b.key, label: formatShortDate(b.to), from: null, to: b.to, span: { from: b.from, to: b.to } }));
    return [...buckets.map(b => ({ ...b })), { key: 'total', label: 'Total', from, to, total: true }];
  }
  const inRange = lines.filter(l => (asof || !from || l.date >= from) && l.date <= to);
  const seen = new Set();
  if (columnsBy === 'tag') for (const l of inRange) for (const t of tags.get(l.txnId) ?? []) seen.add(t);
  else for (const l of inRange) if (l[DIMS[columnsBy]] !== null) seen.add(l[DIMS[columnsBy]]);
  const set = names[NAME_SET[columnsBy]];
  const all = [...seen].sort((a, b) => String(set.get(a) ?? '').localeCompare(String(set.get(b) ?? '')));
  const sorted = all.slice(0, 60), rest = new Set(all.slice(60));
  const matchOf = id => (columnsBy === 'tag'
    ? (id === null ? l => !tags.get(l.txnId)?.size : l => tags.get(l.txnId)?.has(id) ?? false)
    : l => (l[DIMS[columnsBy]] ?? null) === id);
  if (rest.size) opts.notices.push(`Showing the first 60 of ${all.length} ${columnsBy === 'item' ? 'products' : `${columnsBy}s`} as columns; the rest are together under “Others”.`);
  const others = rest.size ? [{ key: 'others', label: 'Others', from, to, match: columnsBy === 'tag' ? l => [...(tags.get(l.txnId) ?? [])].some(t => rest.has(t)) : l => rest.has(l[DIMS[columnsBy]]) }] : [];
  return [...sorted.map(id => ({ key: `d${id}`, label: set.get(id) ?? `#${id}`, from, to, match: matchOf(id), dim: [columnsBy, id] })), ...others,
    { key: 'none', label: 'Not specified', from, to, match: matchOf(null), dim: [columnsBy, null] },
    { key: 'total', label: 'Total', from, to, total: true }];
}

// Every base column plus its comparison columns -> the data columns the statement is computed over.
function dataColumns(base, opts, def, fiscalStartMonth) {
  const out = [];
  for (const b of base) {
    const at = out.push({ ...b, of: null }) - 1;
    for (const c of opts.compare) {
      let r;
      if (def.kind === 'asof') {
        // Previous period: as of the day before this column's own period began (the report's start for a single column).
        r = c === 'py' ? previousYear({ from: null, to: b.to }) : { from: null, to: addDays(b.span?.from ?? opts.from ?? b.to, -1) };
        if (c === 'pp' && !b.span && !opts.from) continue;
      } else if (c === 'pp') r = previousPeriod({ from: b.from ?? opts.from, to: b.to });
      else if (c === 'py') r = previousYear({ from: b.from, to: b.to });
      else if (c === 'ytd') r = { from: fiscalYearOf(b.to, fiscalStartMonth).start, to: b.to };
      else r = previousYear({ from: fiscalYearOf(b.to, fiscalStartMonth).start, to: b.to });
      if (!r || !r.to) continue;
      out.push({ ...b, key: `${b.key}_${c}`, from: r.from, to: r.to, of: at, cmp: c, label: `${b.label} (${COMPARE_SUFFIX[c]})` });
    }
  }
  return out;
}

// Display columns from the data columns: each value, then for each comparison its value, $ change and % change, then
// the percent-of columns.
function displayColumns(data, opts) {
  const totalAt = data.findIndex(c => c.total && c.of === null);
  const out = [];
  data.forEach((c, i) => {
    if (c.of === null) {
      out.push({ label: c.label, kind: 'value', i, base: c });
      for (const p of opts.percents) {
        if (p === 'row' && totalAt < 0) continue;
        out.push({ label: PERCENTS.find(x => x[0] === p)[1], kind: `pct_${p}`, i, total: totalAt });
      }
    } else {
      out.push({ label: c.label, kind: 'value', i, base: c });
      if (opts.change) out.push({ label: '$ Change', kind: 'change', i: c.of, j: i });
      if (opts.pctChange) out.push({ label: '% Change', kind: 'pct_change', i: c.of, j: i });
    }
  });
  return out;
}

const ratio = (a, b) => (b ? a / b : null);

// Fills each row's `cells` (one per display column): { v: cents } or { pct: fraction | null }.
function fillCells(rows, display, refs) {
  for (const r of rows) {
    if (!r.values) { r.cells = null; continue; }
    r.cells = display.map(d => {
      const v = r.values[d.i];
      switch (d.kind) {
        case 'value': return { v, col: d.i };
        case 'change': return { v: r.values[d.i] - r.values[d.j] };
        case 'pct_change': return { pct: r.values[d.j] ? (r.values[d.i] - r.values[d.j]) / Math.abs(r.values[d.j]) : null };
        case 'pct_row': return { pct: ratio(v, r.values[d.total]) };
        case 'pct_col': return { pct: ratio(v, refs.column?.[d.i]) };
        case 'pct_income': return { pct: ratio(v, refs.income?.[d.i]) };
        case 'pct_expense': return { pct: ratio(v, refs.expense?.[d.i]) };
        case 'pct_of': return { pct: ratio(r.values[d.i], r.values[d.j]) };
        default: return { v };
      }
    });
  }
}

// Runs a report and applies its Customize settings (renamed titles, calculated column, custom title).
export async function runReport(db, args) {
  const report = await buildRows(db, args);
  return report ? applyCustom(report) : null;
}

async function buildRows(db, { orgId, entityId, key, query, today, accounting, accounts, retainedAccountId, timeZone = 'UTC' }) {
  const def = REPORTS.find(r => r.key === key);
  if (!def) return null;
  const fiscalStartMonth = accounting.fiscalStartMonth ?? 1;
  const opts = parseOptions(query, { ...def, defaults: { basis: accounting.method === 'cash' ? 'cash' : 'accrual', ...def.defaults } }, { today, fiscalStartMonth });
  const numbers = accounting.showAccountNumbers !== false;
  const accountsById = new Map(accounts.map(a => [a.account_id, a]));
  // Lines reach back to the beginning (balances, retained earnings, comparisons) and up to the latest date needed.
  const lines = await ledgerLines(db, { orgId, entityId, from: null, to: opts.to, basis: opts.basis });
  const [names, tags] = await Promise.all([loadNames(db, { orgId, entityId }), tagsByTxn(db, orgId, [...new Set(lines.map(l => l.txnId))])]);
  const keep = lineFilter(opts, accountsById, tags);
  const filtered = lines.filter(keep);
  const out = { def, opts, title: def.title, subtitle: rangeLabel(opts.from, opts.to, def.kind), basisLabel: opts.basis === 'cash' ? 'Cash basis' : 'Accrual basis', names };

  if (def.kind === 'detail') {
    const types = def.types ?? ACCOUNT_TYPES.map(([k]) => k);
    const res = await detailReport(db, { orgId, accounts, lines: filtered, from: opts.from, to: opts.to, types,
      accountIds: opts.filters.account.length ? opts.filters.account.filter(Boolean) : null, beginning: def.beginning ?? 'none', fiscalStartMonth, names, numbers });
    return { ...out, detail: true, columns: DETAIL_COLUMNS, rows: res.rows, truncated: res.truncated };
  }

  if (def.kind === 'audit') {
    const res = await auditReport(db, { orgId, entityId, from: opts.from, to: opts.to, timeZone, user: opts.extra.audit_user, area: opts.extra.audit_area });
    const users = await auditUsers(db, { orgId });
    return { ...out, detail: true, ...res, basisLabel: 'Audit log',
      extraFields: [{ name: 'audit_user', label: 'User', options: [['', 'Everyone'], ...users.map(u => [u, u])], value: opts.extra.audit_user },
        { name: 'audit_area', label: 'Showing', options: AREAS.map(([k, l]) => [k, l]), value: opts.extra.audit_area }] };
  }
  if (def.kind === 'forecast') {
    const ch = forecastChoices(opts.extra);
    const { columns, res, history, future } = forecastReport({ accounts, lines: filtered, today, choices: ch, numbers });
    const display = columns.map((c, i) => ({ label: c.label, kind: 'value', i }));
    fillCells(res.rows, display, {});
    const pct = [['-20', '−20%'], ['-10', '−10%'], ['-5', '−5%'], ['0', 'No change'], ['5', '+5%'], ['10', '+10%'], ['20', '+20%'], ['50', '+50%']];
    return { ...out, columns: display, rows: res.rows, totals: res.totals,
      subtitle: `${rangeLabel(future[0].from, future.at(-1).to, 'period')} · from ${rangeLabel(history.from, history.to, 'period')}`,
      basisLabel: `Forecast (${{ average: 'monthly average', trend: 'trend', last_year: 'same month last year' }[ch.method]}${ch.income ? `, income ${ch.income > 0 ? '+' : ''}${ch.income}%` : ''}${ch.expense ? `, expenses ${ch.expense > 0 ? '+' : ''}${ch.expense}%` : ''})`,
      extraFields: [{ name: 'fc_months', label: 'Months ahead', options: [['3', '3'], ['6', '6'], ['12', '12'], ['24', '24']], value: String(ch.months) },
        { name: 'fc_method', label: 'Based on', options: [['average', 'Monthly average'], ['trend', 'Trend'], ['last_year', 'Same month last year']], value: ch.method },
        { name: 'fc_income', label: 'Adjust income', options: pct, value: String(ch.income) },
        { name: 'fc_expense', label: 'Adjust expenses', options: pct, value: String(ch.expense) }] };
  }
  if (def.kind === 'kpis') {
    const compare = opts.extra.kpi_compare === 'py' ? 'py' : 'pp';
    const res = await kpiScorecard(db, { orgId, entityId, accounts, basis: opts.basis, from: opts.from, to: opts.to, compare });
    const priorLabel = `${compare === 'py' ? 'Previous year' : 'Previous period'} (${rangeLabel(res.prior.from, res.prior.to, 'period')})`;
    return { ...out, rows: res.rows, measures: res.measures, customKpis: await listKpis(db, { orgId, entityId }),
      columns: [{ label: 'This period', kind: 'value', i: 0 }, { label: priorLabel, kind: 'value', i: 1 }, { label: 'Change', kind: 'change' }, { label: '% Change', kind: 'pct_change' }],
      extraFields: [{ name: 'kpi_compare', label: 'Compare with', options: [['pp', 'Previous period'], ['py', 'Previous year']], value: compare }],
      links: [{ href: '/reports/kpis/new', label: 'Create KPI' }],
      drill: (row, d) => (['revenue', 'net_income', 'gross_profit', 'operating_expenses', 'cogs', 'total_expenses', 'net_operating_income'].includes(row.kpi) && d.i === 0
        ? { report: 'profit_and_loss', from: opts.from, to: opts.to } : null) };
  }
  if (def.kind === 'builder') {
    const res = await builderReport(db, { orgId, entityId, accounts, from: opts.from, to: opts.to, filters: opts.filters, numbers, extra: opts.extra });
    const ch = res.choices;
    return { ...out, detail: true, ...res, basisLabel: 'Custom report',
      extraFields: [{ name: 'b_source', label: 'Start from', options: SOURCES.map(([k, l]) => [k, l]), value: ch.source },
        { name: 'b_group', label: 'Group by', options: GROUP_BY, value: ch.group },
        { name: 'b_sort', label: 'Sort by', options: SORT_BY, value: ch.sort },
        { name: 'b_dir', label: 'Order', options: [['asc', 'Oldest / smallest first'], ['desc', 'Newest / largest first']], value: ch.dir }],
      extraChecks: { label: 'Columns', options: BUILDER_COLUMNS.map(([k, l]) => [`b_${k}`, l]), checked: new Set(ch.columns.map(k => `b_${k}`)) } };
  }
  if (def.kind === 'fx_realized') {
    const fx = accounts.find(a => a.system_key === 'fx_gain_loss');
    return { ...out, detail: true, ...(await realizedGains(db, { orgId, entityId, lines: filtered, from: opts.from, to: opts.to, fxAccountId: fx?.account_id, names })) };
  }
  if (def.kind === 'fx_unrealized') return { ...out, detail: true, ...(await unrealizedGains(db, { orgId, entityId, to: opts.to })), basisLabel: 'Open foreign balances' };
  if (def.kind === 'budget_overview' || def.kind === 'budget_vs_actuals') return { ...out, ...(await budgetReport(db, { def, opts, orgId, entityId, accounts, lines: filtered, numbers })) };
  if (PARTY_KINDS.has(def.kind)) {
    const res = await runPartyReport(db, { def, opts, orgId, entityId, accounts, accountsById, lines: filtered, names, numbers });
    return { ...out, ...res };
  }
  if (def.kind === 'journal' || def.kind === 'splits') {
    const res = await journalReport(db, { orgId, accounts, lines: filtered, from: opts.from, to: opts.to, names, numbers, variant: def.kind });
    return { ...out, detail: true, ...res };
  }
  if (def.kind === 'txnlist') {
    const res = await transactionList(db, { orgId, entityId, accounts, from: opts.from, to: opts.to, filters: opts.filters, numbers });
    return { ...out, detail: true, ...res, basisLabel: 'All transactions' };
  }
  if (def.kind === 'accounts') {
    const res = accountList({ accounts: opts.accountTypes.length ? accounts.filter(a => opts.accountTypes.includes(a.type)) : accounts,
      lines: filtered, asOf: opts.to, show: opts.show, numbers, typeLabel: t => TYPE_LABEL[t] });
    return { ...out, detail: true, ...res };
  }
  if (def.kind === 'atb') {
    const { rows: adj } = await db.query('SELECT txn_id FROM txn WHERE org_id = $1 AND entity_id = $2 AND is_adjusting', [orgId, entityId]);
    const adjusting = new Set(adj.map(r => Number(r.txn_id)));
    const res = adjustedTrialBalance({ accounts, lines: filtered, from: opts.from, asOf: opts.to, isAdjusting: id => adjusting.has(id), fiscalStartMonth,
      retainedAccountId, show: opts.show, numbers });
    const display = ['Unadjusted Debit', 'Unadjusted Credit', 'Adjustments Debit', 'Adjustments Credit', 'Adjusted Debit', 'Adjusted Credit']
      .map((label, i) => ({ label, kind: 'value', i }));
    fillCells(res.rows, display, {});
    return { ...out, subtitle: `${rangeLabel(opts.from, opts.to, 'period')} (adjusting entries in the period)`, columns: display, rows: res.rows, totals: res.totals };
  }
  if (def.kind === 'snapshot') return { ...out, ...snapshot({ accounts, lines: filtered, opts, fiscalStartMonth, numbers }) };

  if (def.kind === 'tb') {
    const res = trialBalance({ accounts, lines: filtered, asOf: opts.to, fiscalStartMonth, retainedAccountId, show: opts.show, numbers });
    const display = [{ label: 'Debit', kind: 'value', i: 0 }, { label: 'Credit', kind: 'value', i: 1 }];
    fillCells(res.rows, display, {});
    const fy = fiscalYearOf(opts.to, fiscalStartMonth).start;
    return { ...out, columns: display, rows: res.rows, totals: { debit: res.debit, credit: res.credit },
      drill: (row, d) => (row.accountIds ? { report: 'transaction_detail_by_account', account: row.accountIds, from: PL_TYPES.includes(accountsById.get(row.accountId)?.type) ? fy : null, to: opts.to } : null) };
  }

  const base = baseColumns(opts, def, filtered, names, tags);
  const data = dataColumns(base, opts, def, fiscalStartMonth);
  const display = displayColumns(data, opts);
  let res, refs;
  if (def.kind === 'asof') {
    res = balanceSheet({ accounts, lines: filtered, columns: data, fiscalStartMonth, retainedAccountId, show: opts.show, numbers, summary: def.summary });
    refs = { column: res.totals.assets };
  } else if (def.kind === 'cashflow') {
    res = cashFlows({ accounts, lines: filtered, columns: data, show: opts.show, numbers });
    refs = {};
  } else {
    res = profitAndLoss({ accounts, lines: filtered, columns: data, show: opts.show, numbers, summary: def.summary });
    refs = { column: res.totals.income, income: res.totals.income, expense: res.totals.expenses };
  }
  fillCells(res.rows, display, refs);
  const drill = (row, d) => {
    if (!row.accountIds?.length || d.kind !== 'value') return null;
    const c = data[d.i];
    const q = { report: 'transaction_detail_by_account', account: row.accountIds, from: def.kind === 'asof' ? null : c.from, to: c.to };
    if (c.dim) q[c.dim[0]] = [c.dim[1]];
    return q;
  };
  return { ...out, columns: display, rows: res.rows, totals: res.totals, retained: res.retained, netIncome: res.netIncome, drill };
}

// A drill-down link: the detail report over the same basis and filters, narrowed to the row's accounts and the column.
export function drillHref(report, q) {
  const opts = report.opts;
  const filters = { ...opts.filters, account: q.account ?? [] };
  for (const f of FILTERS) if (q[f]) filters[f] = q[f];
  const look = Object.fromEntries(Object.entries(opts.custom ?? {}).filter(([k]) => LOOK_KEYS.includes(k)));
  const sub = { ...opts, period: 'custom', from: q.from, to: q.to, columnsBy: 'total', compare: [], percents: [], change: false, pctChange: false, filters, accountTypes: [],
    extra: { ...(q.extra ?? {}) }, custom: look };
  return `/reports/r/${q.report}?${optionsQuery(sub)}`;
}

// Business Snapshot: income and expenses by month this fiscal year against last year, and the biggest income and
// expense accounts for the report period (drawn as bar charts on the page).
const INCOME = ['income', 'other_income'], EXPENSE = ['cost_of_goods_sold', 'expense', 'other_expense'];
function snapshot({ accounts, lines, opts, fiscalStartMonth, numbers }) {
  const fy = fiscalYearOf(opts.to, fiscalStartMonth);
  const months = timeBuckets('months', fy.start, opts.to);
  const cols = [...months, ...months.map(m => previousYear(m))];
  const { sums } = sumByAccount(lines, cols);
  const total = (types, i) => accounts.filter(a => types.includes(a.type)).reduce((s, a) => s + (sums.get(a.account_id)?.[i] ?? 0) * normalSign(a.type), 0);
  const k = months.length;
  const rows = months.map((m, i) => ({ kind: 'account', depth: 0, label: m.label,
    values: [total(INCOME, i), total(INCOME, k + i), total(EXPENSE, i), total(EXPENSE, k + i)] }));
  const sum = rows.reduce((acc, r) => acc.map((x, i) => x + r.values[i]), [0, 0, 0, 0]);
  rows.push({ kind: 'computed', label: 'Total', depth: 0, values: sum, grand: true });
  const display = ['Income', 'Income last year', 'Expenses', 'Expenses last year'].map((label, i) => ({ label, kind: 'value', i }));
  fillCells(rows, display, {});
  const period = sumByAccount(lines, [{ from: opts.from, to: opts.to }]).sums;
  const top = types => {
    const list = accounts.filter(a => types.includes(a.type))
      .map(a => ({ label: accountLabel(a, numbers), value: (period.get(a.account_id)?.[0] ?? 0) * normalSign(a.type) }))
      .filter(x => x.value > 0).sort((a, b) => b.value - a.value);
    const head = list.slice(0, 6), rest = list.slice(6).reduce((s, x) => s + x.value, 0);
    return rest ? [...head, { label: 'Everything else', value: rest }] : head;
  };
  return { columns: display, rows, charts: { income: top(INCOME), expenses: top(EXPENSE) } };
}

// Budget Overview (the budget by month, laid out like the P&L) and Budget vs. Actuals (actual, budget, over budget and
// % of budget for the period, or for each month). Budget amounts become ledger-like lines dated on the first of each
// fiscal month, so they go through the same statement builder as the actual figures.
async function budgetReport(db, { def, opts, orgId, entityId, accounts, lines, numbers }) {
  const { rows: budgets } = await db.query(
    'SELECT budget_id, name, fiscal_year, start_month, subdivide FROM budget WHERE org_id = $1 AND entity_id = $2 ORDER BY fiscal_year DESC, budget_id DESC', [orgId, entityId]);
  const b = budgets.find(x => String(x.budget_id) === opts.extra.budget) ?? budgets[0];
  const extraFields = [{ name: 'budget', label: 'Budget', options: budgets.map(x => [String(x.budget_id), `${x.name} (FY${x.fiscal_year})`]), value: b ? String(b.budget_id) : '' }];
  if (!b) return { columns: [], rows: [], extraFields, emptyText: 'There are no budgets yet. Make one in Tools → Budgets.' };
  const byId = new Map(accounts.map(a => [a.account_id, a]));
  const dimFilter = { class: 'class', location: 'location', customer: 'customer' }[b.subdivide];
  const dimIds = dimFilter ? (opts.filters[dimFilter] ?? []).filter(x => x !== null) : [];
  const { rows: amounts } = await db.query(
    'SELECT account_id, period, sum(amount_cents)::bigint AS cents FROM budget_line WHERE budget_id = $1 AND ($2::bigint[] IS NULL OR dim_id = ANY($2::bigint[])) GROUP BY account_id, period',
    [b.budget_id, dimIds.length ? dimIds : null]);
  const otherFilters = Object.entries(opts.filters).filter(([k, v]) => v.length && k !== dimFilter && k !== 'account');
  if (def.kind === 'budget_vs_actuals' && otherFilters.length) opts.notices.push(`The budget isn’t split by ${otherFilters.map(([k]) => k).join(' or ')}, so the budget column is for the whole company while the actuals are filtered.`);
  const budgetLines = amounts.filter(r => byId.has(Number(r.account_id))).map(r => ({ accountId: Number(r.account_id), date: periodStart(b.fiscal_year, b.start_month, r.period),
    amount: Number(r.cents) * normalSign(byId.get(Number(r.account_id)).type), budget: true, txnId: 0, customerId: null, vendorId: null, classId: null, locationId: null, itemId: null, projectId: null }));
  const fyStart = periodStart(b.fiscal_year, b.start_month, 1), fyEnd = addDays(periodStart(b.fiscal_year + 1, b.start_month, 1), -1);
  const show = opts.show === 'active' ? 'non_zero' : opts.show;
  if (def.kind === 'budget_overview') {
    const months = timeBuckets('months', fyStart, fyEnd);
    const columns = [...months, { key: 'total', label: 'Total', from: fyStart, to: fyEnd }];
    const res = profitAndLoss({ accounts, lines: budgetLines, columns, show, numbers });
    const display = columns.map((c, i) => ({ label: c.label, kind: 'value', i }));
    fillCells(res.rows, display, {});
    return { columns: display, rows: res.rows, totals: res.totals, extraFields, subtitle: `${b.name} · ${rangeLabel(fyStart, fyEnd, 'period')}`, basisLabel: 'Budget' };
  }
  const from = opts.from ?? fyStart, to = opts.to;
  const fit = TIME_UNITS.has(opts.columnsBy) ? fitBuckets(opts.columnsBy, from, to, 30) : null;
  if (fit?.changed) opts.notices.push(`That is too many ${opts.columnsBy} for columns, so the report shows ${fit.unit} instead.`);
  const buckets = fit ? [...fit.buckets, { key: 'total', label: 'Total', from, to }] : [{ key: 'total', label: 'Total', from, to }];
  const data = buckets.flatMap(c => [{ ...c, match: l => !l.budget }, { ...c, match: l => Boolean(l.budget) }]);
  const res = profitAndLoss({ accounts, lines: [...lines, ...budgetLines], columns: data, show, numbers });
  const display = buckets.flatMap((c, k) => {
    const many = buckets.length > 1, p = many ? `${c.label} ` : '';
    return [{ label: `${p}Actual`, kind: 'value', i: 2 * k }, { label: `${p}Budget`, kind: 'value', i: 2 * k + 1 },
      { label: `${p}Over budget`, kind: 'change', i: 2 * k, j: 2 * k + 1 }, { label: `${p}% of budget`, kind: 'pct_of', i: 2 * k, j: 2 * k + 1 }];
  });
  fillCells(res.rows, display, {});
  return { columns: display, rows: res.rows, totals: res.totals, extraFields, subtitle: `${b.name} · ${rangeLabel(from, to, 'period')}`,
    drill: (row, d) => (row.accountIds?.length && d.kind === 'value' && d.i % 2 === 0 ? { report: 'transaction_detail_by_account', account: row.accountIds, from: data[d.i].from, to: data[d.i].to } : null) };
}
