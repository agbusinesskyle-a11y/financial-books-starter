import { timeBuckets, previousYear } from './periods.js';
import { measures } from './kpis.js';
import { openItems, agingBuckets, agingSummary } from './receivables.js';
import { salesSummary } from './sales.js';
import { ledgerLines } from './ledger-data.js';
import { loadNames } from './engine.js';

// Dashboards (stage R5b): headline tiles and charts for a range of months, built from the same measures as the KPI
// scorecard, so the pictures always agree with the reports.

export const DASHBOARDS = [
  ['standard', 'Overview'], ['profitability', 'Profitability'], ['cash_flow', 'Cash flow'], ['balance_sheet', 'Balance sheet'],
  ['receivables', 'Accounts receivable'], ['payables', 'Accounts payable'], ['revenue', 'Revenue'], ['sales', 'Sales performance'],
];

const top = (rows, n = 6) => {
  const list = rows.filter(r => r.value > 0).sort((a, b) => b.value - a.value);
  const rest = list.slice(n).reduce((s, x) => s + x.value, 0);
  return rest ? [...list.slice(0, n), { label: 'Everyone else', value: rest }] : list.slice(0, n);
};

// months: the monthly ranges shown (last 12 months by default). Returns { months, series, tiles, bars } for the view.
export async function dashboardData(db, { orgId, entityId, accounts, basis = 'accrual', from, to, key }) {
  const months = timeBuckets('months', from, to);
  const m = await measures(db, { orgId, entityId, accounts, basis, ranges: months });
  const series = k => m.map(x => x[k]);
  const out = { months, labels: months.map(b => b.label.replace(/ \d{4}$/, (y) => ` ’${y.slice(-2)}`)), measures: m, bars: {}, lines: {} };
  const last = m.at(-1) ?? {}, prev = m.at(-2) ?? {};
  const tile = (k, label, unit = 'money') => ({ key: k, label, unit, value: last[k] ?? null, prior: prev[k] ?? null });
  out.tiles = {
    standard: [tile('revenue', 'Revenue'), tile('net_income', 'Net income'), tile('cash_on_hand', 'Cash on hand'), tile('ar_balance', 'Customers owe you')],
    profitability: [tile('gross_margin', 'Gross margin', 'percent'), tile('net_margin', 'Net profit margin', 'percent'), tile('operating_margin', 'Operating margin', 'percent'), tile('net_income', 'Net income')],
    cash_flow: [tile('cash_on_hand', 'Cash on hand'), tile('operating_cash_flow', 'Operating cash flow'), tile('cash_flow_margin', 'Cash flow margin', 'percent')],
    balance_sheet: [tile('current_ratio', 'Current ratio', 'number'), tile('quick_ratio', 'Quick ratio', 'number'), tile('ar_balance', 'A/R'), tile('ap_balance', 'A/P')],
    receivables: [tile('ar_balance', 'A/R'), tile('days_sales_outstanding', 'Days sales outstanding', 'number')],
    payables: [tile('ap_balance', 'A/P')],
    revenue: [tile('revenue', 'Revenue'), tile('gross_profit', 'Gross profit')],
    sales: [tile('invoice_count', 'Invoices', 'number'), tile('average_invoice', 'Average invoice'), tile('active_customers', 'Active customers', 'number'), tile('new_customers', 'New customers', 'number')],
  }[key] ?? [];
  out.series = { revenue: series('revenue'), expenses: series('total_expenses'), netIncome: series('net_income'), grossProfit: series('gross_profit'), cogs: series('cogs'),
    cash: series('cash_on_hand'), ocf: series('operating_cash_flow'), ar: series('ar_balance'), ap: series('ap_balance'),
    grossMargin: series('gross_margin'), netMargin: series('net_margin'), currentRatio: series('current_ratio'), quickRatio: series('quick_ratio'),
    dso: series('days_sales_outstanding'), invoices: series('invoice_count'), invoiceValue: series('invoice_value'), activeCustomers: series('active_customers'),
    newCustomers: series('new_customers') };
  if (['revenue', 'standard'].includes(key)) {
    const py = await measures(db, { orgId, entityId, accounts, basis, ranges: months.map(b => previousYear(b)) });
    out.series.revenuePy = py.map(x => x.revenue);
  }
  if (['receivables', 'payables', 'standard'].includes(key)) {
    const buckets = agingBuckets();
    for (const side of key === 'standard' ? ['ar'] : [key === 'receivables' ? 'ar' : 'ap']) {
      const items = await openItems(db, { orgId, entityId, side, asOf: to });
      const sum = agingSummary(items, { buckets });
      out.bars[`${side}Aging`] = sum.columns.slice(0, -1).map((label, i) => ({ label, value: sum.total[i] }));
      out.bars[`${side}Top`] = top(sum.rows.filter(r => r.partyId).map(r => ({ label: r.label, value: r.values.at(-1) })));
    }
  }
  if (['revenue', 'standard', 'profitability'].includes(key)) {
    const lines = await ledgerLines(db, { orgId, entityId, to, basis });
    const byId = new Map(accounts.map(a => [a.account_id, a]));
    const names = await loadNames(db, { orgId, entityId });
    const range = [{ key: 'total', from, to }];
    const byCustomer = salesSummary({ lines, accountsById: byId, columns: range, groupBy: 'customer', names });
    out.bars.topCustomers = top(byCustomer.rows.filter(r => r.kind === 'account' && r.groupId !== null).map(r => ({ label: r.label, value: r.values[0] })));
    const byProduct = salesSummary({ lines, accountsById: byId, columns: range, groupBy: 'item', names });
    out.bars.topProducts = top(byProduct.rows.filter(r => r.kind === 'account' && r.groupId !== null).map(r => ({ label: r.label, value: r.values[0] })));
    const expense = new Map();
    for (const l of lines) {
      const a = byId.get(l.accountId);
      if (!a || !['expense', 'other_expense', 'cost_of_goods_sold'].includes(a.type) || l.date < from || l.date > to) continue;
      expense.set(a.name, (expense.get(a.name) ?? 0) + l.amount);
    }
    out.bars.topExpenses = top([...expense].map(([label, value]) => ({ label, value })));
  }
  return out;
}
