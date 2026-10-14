import { ValidationError } from '../data/writes.js';
import { daysBetween, addDays } from '../domain/dates.js';
import { normalSign } from '../domain/ledger.js';
import { ledgerLines } from './ledger-data.js';
import { profitAndLoss, cashFlows, sumByAccount } from './statements.js';
import { previousPeriod, previousYear } from './periods.js';
import { evalFormula, formulaError } from './customize.js';

// KPI scorecard (stage R5a): built-in measures from the books for a period and the one it is compared with, plus the
// company's own KPIs as formulas over them. Units: money (cents), percent (a fraction), number.

export const BUILT_IN = [
  ['revenue', 'Revenue', 'Growth', 'money', 'up', 'Total income'],
  ['cogs', 'Cost of goods sold', 'Growth', 'money', 'down', 'What the goods that were sold cost'],
  ['total_expenses', 'Total expenses', 'Growth', 'money', 'down', 'Cost of goods sold, expenses and other expenses'],
  ['invoice_count', 'Number of invoices', 'Growth', 'number', 'up', 'Invoices dated in the period'],
  ['invoice_value', 'Value of invoices', 'Growth', 'money', 'up', 'Total of the invoices dated in the period'],
  ['average_invoice', 'Average invoice', 'Growth', 'money', 'up', 'Value of invoices ÷ number of invoices'],
  ['gross_profit', 'Gross profit', 'Profitability', 'money', 'up', 'Revenue − cost of goods sold'],
  ['gross_margin', 'Gross margin', 'Profitability', 'percent', 'up', 'Gross profit ÷ revenue'],
  ['operating_expenses', 'Operating expenses', 'Profitability', 'money', 'down', 'Expenses (not cost of goods sold or other expenses)'],
  ['operating_expense_ratio', 'Operating expense ratio', 'Profitability', 'percent', 'down', 'Operating expenses ÷ revenue'],
  ['expense_pct_revenue', 'Expenses as % of revenue', 'Profitability', 'percent', 'down', 'Total expenses ÷ revenue'],
  ['net_operating_income', 'Net operating income', 'Profitability', 'money', 'up', 'Gross profit − operating expenses'],
  ['operating_margin', 'Operating margin', 'Profitability', 'percent', 'up', 'Net operating income ÷ revenue'],
  ['net_income', 'Net income', 'Profitability', 'money', 'up', 'The bottom line of the Profit and Loss'],
  ['net_margin', 'Net profit margin', 'Profitability', 'percent', 'up', 'Net income ÷ revenue'],
  ['operating_cash_flow', 'Operating cash flow', 'Cash flow', 'money', 'up', 'Net cash from operating activities'],
  ['cash_flow_margin', 'Cash flow margin', 'Cash flow', 'percent', 'up', 'Operating cash flow ÷ revenue'],
  ['cash_on_hand', 'Cash on hand', 'Cash flow', 'money', 'up', 'Bank balances at the end of the period'],
  ['active_customers', 'Active customers', 'Sales', 'number', 'up', 'Customers with income in the period'],
  ['new_customers', 'New customers', 'Sales', 'number', 'up', 'Customers whose first sale was in the period'],
  ['revenue_per_customer', 'Average revenue per customer', 'Sales', 'money', 'up', 'Revenue ÷ active customers'],
  ['ar_balance', 'Accounts receivable', 'Balance sheet', 'money', 'down', 'What customers owe at the end of the period'],
  ['ap_balance', 'Accounts payable', 'Balance sheet', 'money', 'down', 'What is owed to vendors at the end of the period'],
  ['days_sales_outstanding', 'Days sales outstanding', 'Balance sheet', 'number', 'down', 'A/R ÷ revenue × days in the period'],
  ['current_ratio', 'Current ratio', 'Balance sheet', 'number', 'up', 'Current assets ÷ current liabilities'],
  ['quick_ratio', 'Quick ratio', 'Balance sheet', 'number', 'up', '(Cash + A/R) ÷ current liabilities'],
];
export const BUILT_IN_KEYS = BUILT_IN.map(k => k[0]);
const div = (a, b) => (b ? a / b : null);

// The measures for each range ({ from, to }) on one basis.
export async function measures(db, { orgId, entityId, accounts, basis, ranges }) {
  const to = ranges.map(r => r.to).sort().at(-1);
  const lines = await ledgerLines(db, { orgId, entityId, to, basis });
  const pl = profitAndLoss({ accounts, lines, columns: ranges, show: 'all' }).totals;
  const cf = cashFlows({ accounts, lines, columns: ranges, show: 'all' }).totals;
  const { sums } = sumByAccount(lines, ranges.map(r => ({ from: null, to: r.to })));
  const balance = (types, i) => accounts.filter(a => types.includes(a.type)).reduce((s, a) => s + (sums.get(a.account_id)?.[i] ?? 0) * normalSign(a.type), 0);
  const incomeAccounts = new Set(accounts.filter(a => a.type === 'income').map(a => a.account_id));
  const { rows: firstSales } = await db.query(
    `SELECT customer_id, min(txn_date)::text AS first FROM txn WHERE org_id = $1 AND entity_id = $2 AND type IN ('invoice', 'sales_receipt') AND voided_at IS NULL
      GROUP BY customer_id`, [orgId, entityId]);
  const out = [];
  for (const [i, r] of ranges.entries()) {
    const { rows: [inv] } = await db.query(
      `SELECT count(*)::int AS n, coalesce(sum(total_cents), 0)::bigint AS v FROM txn WHERE org_id = $1 AND entity_id = $2 AND type = 'invoice' AND voided_at IS NULL
        AND ($3::date IS NULL OR txn_date >= $3::date) AND txn_date <= $4::date`, [orgId, entityId, r.from, r.to]);
    const revenue = pl.income[i], cogs = pl.cogs[i], opex = pl.expenses[i];
    const totalExp = cogs + opex + pl.other_expenses[i];
    const gp = revenue - cogs, noi = gp - opex;
    const active = new Set(lines.filter(l => incomeAccounts.has(l.accountId) && l.customerId && (!r.from || l.date >= r.from) && l.date <= r.to).map(l => l.customerId)).size;
    const currentAssets = balance(['bank', 'accounts_receivable', 'other_current_asset', 'inventory'], i);
    const currentLiab = balance(['accounts_payable', 'credit_card', 'other_current_liability'], i);
    const ar = balance(['accounts_receivable'], i), cash = balance(['bank'], i);
    const days = r.from ? daysBetween(r.from, r.to) + 1 : 365;
    out.push({
      revenue, cogs, total_expenses: totalExp, invoice_count: inv.n, invoice_value: Number(inv.v), average_invoice: inv.n ? Math.round(Number(inv.v) / inv.n) : null,
      gross_profit: gp, gross_margin: div(gp, revenue), operating_expenses: opex, operating_expense_ratio: div(opex, revenue), expense_pct_revenue: div(totalExp, revenue),
      net_operating_income: noi, operating_margin: div(noi, revenue), net_income: pl.netIncome[i], net_margin: div(pl.netIncome[i], revenue),
      operating_cash_flow: cf.operating[i], cash_flow_margin: div(cf.operating[i], revenue), cash_on_hand: cash,
      active_customers: active, new_customers: firstSales.filter(f => (!r.from || f.first >= r.from) && f.first <= r.to).length,
      revenue_per_customer: active ? Math.round(revenue / active) : null, ar_balance: ar, ap_balance: balance(['accounts_payable'], i),
      days_sales_outstanding: revenue ? Math.round((ar / revenue) * days * 10) / 10 : null, current_ratio: div(currentAssets, currentLiab),
      quick_ratio: div(cash + ar, currentLiab),
    });
  }
  return out;
}

// Formula variables: money in dollars, percents as percentage numbers, counts and ratios as they are.
const asVar = (unit, v) => (v === null || v === undefined ? null : unit === 'money' ? v / 100 : unit === 'percent' ? v * 100 : v);
const fromFormula = (unit, v) => (v === null ? null : unit === 'money' ? Math.round(v * 100) : unit === 'percent' ? v / 100 : Math.round(v * 1000) / 1000);
export function customValue(kpi, m) {
  const vars = Object.fromEntries(BUILT_IN.map(([k, , , unit]) => [k, asVar(unit, m[k])]));
  return fromFormula(kpi.unit, evalFormula(kpi.formula, vars));
}

export async function listKpis(db, { orgId, entityId }) {
  return (await db.query('SELECT * FROM kpi WHERE org_id = $1 AND entity_id = $2 ORDER BY lower(category), lower(name)', [orgId, entityId])).rows;
}

const fail = message => { throw new ValidationError(message); };
export async function saveKpi(db, { orgId, entityId, fields: f, actor }) {
  const name = String(f.name ?? '').trim().slice(0, 80) || fail('Give the KPI a name.');
  if (BUILT_IN.some(([, label]) => label.toLowerCase() === name.toLowerCase())) fail('A built-in KPI already has that name.');
  const formula = String(f.formula ?? '').trim().slice(0, 300) || fail('Enter a formula, e.g. net_income / revenue * 100.');
  const problem = formulaError(formula, BUILT_IN_KEYS);
  if (problem) fail(`The formula doesn’t work: ${problem}`);
  const unit = ['money', 'percent', 'number'].includes(f.unit) ? f.unit : 'number';
  try {
    await db.query(`INSERT INTO kpi (org_id, entity_id, name, category, description, unit, direction, formula, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [orgId, entityId, name, String(f.category ?? '').trim().slice(0, 40) || 'Custom', String(f.description ?? '').trim().slice(0, 300) || null, unit,
        f.direction === 'down' ? 'down' : 'up', formula, actor]);
  } catch (error) {
    if (error.code === '23505') fail(`There is already a KPI named “${name}”.`);
    throw error;
  }
}
export async function deleteKpi(db, { orgId, entityId, kpiId }) {
  await db.query('DELETE FROM kpi WHERE org_id = $1 AND entity_id = $2 AND kpi_id = $3', [orgId, entityId, kpiId]);
}

const cellOf = (unit, v) => (unit === 'money' ? { v: v === null ? null : v } : unit === 'percent' ? { pct: v } : { qty: v });
const changeOf = (unit, a, b) => (a === null || b === null ? (unit === 'money' ? { v: null } : unit === 'percent' ? { pct: null } : { qty: null })
  : unit === 'money' ? { v: a - b } : unit === 'percent' ? { pct: a - b } : { qty: Math.round((a - b) * 1000) / 1000 });

// The scorecard as report rows: a section per category; each KPI with this period, the comparison, the change and % change.
export async function kpiScorecard(db, { orgId, entityId, accounts, basis, from, to, compare = 'pp', fiscalStartMonth = 1 }) {
  const current = { from, to };
  const prior = compare === 'py' ? previousYear(current) : (previousPeriod(current) ?? { from: null, to: addDays(to, -365) });
  const [m, p] = await measures(db, { orgId, entityId, accounts, basis, ranges: [current, prior] });
  const custom = await listKpis(db, { orgId, entityId });
  const all = [...BUILT_IN.map(([key, label, category, unit, direction, about]) => ({ key, label, category, unit, direction, about, a: m[key], b: p[key] })),
    ...custom.map(k => ({ key: `kpi_${k.kpi_id}`, kpiId: k.kpi_id, label: k.name, category: k.category, unit: k.unit, direction: k.direction, about: k.description ?? k.formula,
      a: customValue(k, m), b: customValue(k, p) }))];
  const rows = [];
  for (const category of [...new Set(all.map(k => k.category))]) {
    rows.push({ kind: 'section', label: category, depth: 0, values: null, cells: null });
    for (const k of all.filter(x => x.category === category)) {
      const better = k.a === null || k.b === null || k.a === k.b ? null : (k.a > k.b) === (k.direction === 'up');
      rows.push({ kind: 'account', depth: 1, label: k.label, kpi: k.key, kpiId: k.kpiId, about: k.about, tone: better === null ? null : better ? 'good' : 'bad',
        values: [k.a, k.b], cells: [cellOf(k.unit, k.a), cellOf(k.unit, k.b), changeOf(k.unit, k.a, k.b),
          { pct: k.a === null || k.b === null || !k.b ? null : (k.a - k.b) / Math.abs(k.b) }] });
    }
  }
  return { rows, prior, measures: { current: m, prior: p } };
}
