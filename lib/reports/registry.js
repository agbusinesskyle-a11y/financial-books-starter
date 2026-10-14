// Every report: where it is listed, what it shows and its default options. The engine (engine.js) runs them.
// kind: 'period' (income and expenses over a range), 'asof' (balances on a date), 'tb' (trial balance), 'detail' (lines).

import { BUILDER_EXTRA } from './builder.js';
import { FORECAST_EXTRA } from './forecast.js';

const PL = ['income', 'cost_of_goods_sold', 'expense', 'other_income', 'other_expense'];
const BS = ['bank', 'accounts_receivable', 'other_current_asset', 'inventory', 'fixed_asset', 'other_asset', 'accounts_payable', 'credit_card',
  'other_current_liability', 'long_term_liability', 'equity'];

export const GROUPS = [
  ['business_overview', 'Business overview'],
  ['performance', 'Performance'],
  ['builder', 'Custom report builder'],
  ['who_owes_you', 'Who owes you'],
  ['sales_customers', 'Sales and customers'],
  ['what_you_owe', 'What you owe'],
  ['expenses_vendors', 'Expenses and vendors'],
  ['projects', 'Projects'],
  ['inventory', 'Inventory'],
  ['employees', 'Employees'],
  ['time', 'Time'],
  ['accountant', 'For my accountant'],
  ['lists', 'Lists'],
];

export const REPORTS = [
  { key: 'profit_and_loss', group: 'business_overview', title: 'Profit and Loss', kind: 'period', about: 'Income and expenses and the net income they leave.' },
  { key: 'pl_by_month', group: 'business_overview', title: 'Profit and Loss by Month', kind: 'period', defaults: { columnsBy: 'months' }, about: 'The Profit and Loss with a column for each month.' },
  { key: 'quarterly_pl', group: 'business_overview', title: 'Quarterly Profit and Loss Summary', kind: 'period', defaults: { columnsBy: 'quarters', period: 'this_year' }, about: 'The Profit and Loss with a column for each quarter.' },
  { key: 'pl_comparison', group: 'business_overview', title: 'Profit and Loss Comparison', kind: 'period', defaults: { compare: ['py'], change: true, pctChange: true }, about: 'This period next to the same period last year, with the change.' },
  { key: 'pl_ytd_comparison', group: 'business_overview', title: 'Profit and Loss year-to-date comparison', kind: 'period', defaults: { period: 'this_month', compare: ['ytd'] }, about: 'This month next to the fiscal year so far.' },
  { key: 'pl_percent_income', group: 'business_overview', title: 'Profit and Loss as % of total income', kind: 'period', defaults: { percents: ['income'] }, about: 'Each line as a share of total income.' },
  { key: 'pl_by_customer', group: 'business_overview', title: 'Profit and Loss by Customer', kind: 'period', defaults: { columnsBy: 'customer' }, about: 'A column for each customer the income and expenses belong to.' },
  { key: 'pl_by_class', group: 'business_overview', title: 'Profit and Loss by Class', kind: 'period', defaults: { columnsBy: 'class' }, about: 'A column for each class.' },
  { key: 'pl_by_location', group: 'business_overview', title: 'Profit and Loss by Location', kind: 'period', defaults: { columnsBy: 'location' }, about: 'A column for each location.' },
  { key: 'pl_by_tag', group: 'business_overview', title: 'Profit and Loss by Tag', kind: 'period', defaults: { columnsBy: 'tag' }, about: 'A column for each tag.' },
  { key: 'pl_detail', group: 'business_overview', title: 'Profit and Loss Detail', kind: 'detail', types: PL, about: 'Every transaction behind the Profit and Loss.' },
  { key: 'balance_sheet', group: 'business_overview', title: 'Balance Sheet', kind: 'asof', about: 'What the company owns and owes, and its equity, on a date.' },
  { key: 'balance_sheet_comparison', group: 'business_overview', title: 'Balance Sheet Comparison', kind: 'asof', defaults: { compare: ['py'], change: true, pctChange: true }, about: 'The Balance Sheet next to a year earlier.' },
  { key: 'balance_sheet_summary', group: 'business_overview', title: 'Balance Sheet Summary', kind: 'asof', summary: true, about: 'The Balance Sheet by group, without individual accounts.' },
  { key: 'balance_sheet_detail', group: 'business_overview', title: 'Balance Sheet Detail', kind: 'detail', types: BS, beginning: 'all', defaults: { period: 'this_month' }, about: 'Every transaction behind the Balance Sheet, with beginning balances.' },
  { key: 'statement_of_cash_flows', group: 'business_overview', title: 'Statement of Cash Flows', kind: 'cashflow', about: 'Where cash came from and went: operating, investing and financing.' },
  { key: 'business_snapshot', group: 'business_overview', title: 'Business Snapshot', kind: 'snapshot', defaults: { period: 'this_fiscal_year_to_date' }, about: 'Income and expenses at a glance, this year against last.' },
  { key: 'account_list', group: 'accountant', title: 'Account List', kind: 'accounts', defaults: { period: 'today' }, about: 'The chart of accounts with types, descriptions and balances.' },
  { key: 'trial_balance', group: 'accountant', title: 'Trial Balance', kind: 'tb', columns: false, about: 'Every account’s debit or credit balance; the two totals match.' },
  { key: 'adjusted_trial_balance', group: 'accountant', title: 'Adjusted Trial Balance', kind: 'atb', defaults: { period: 'this_fiscal_year_to_date' }, about: 'The trial balance with adjusting journal entries in their own columns.' },
  { key: 'general_ledger', group: 'accountant', title: 'General Ledger', kind: 'detail', beginning: 'all', defaults: { period: 'this_month' }, about: 'Every account with its beginning balance and each transaction.' },
  { key: 'journal', group: 'accountant', title: 'Journal', kind: 'journal', defaults: { period: 'this_month' }, about: 'Every transaction’s debits and credits, in date order.' },
  { key: 'transaction_list_by_date', group: 'accountant', title: 'Transaction List by Date', kind: 'txnlist', defaults: { period: 'this_month' }, about: 'Every transaction in the period, one line each.' },
  { key: 'transaction_list_with_splits', group: 'accountant', title: 'Transaction List with Splits', kind: 'splits', defaults: { period: 'this_month' }, about: 'Every transaction with each of its account lines.' },
  { key: 'transaction_detail_by_account', group: 'accountant', title: 'Transaction Detail by Account', kind: 'detail', defaults: { period: 'this_month' }, about: 'Transactions grouped by account, with a running balance.' },
];

// Stage R2a: who owes you, sales and customers.
const TODAY = { period: 'today' };
REPORTS.push(
  { key: 'ar_aging_summary', group: 'who_owes_you', title: 'A/R Aging Summary', kind: 'aging', side: 'ar', aging: true, drillTo: 'ar_aging_detail', defaults: TODAY, about: 'What each customer owes, by how overdue it is.' },
  { key: 'ar_aging_detail', group: 'who_owes_you', title: 'A/R Aging Detail', kind: 'aging_detail', side: 'ar', aging: true, extra: ['aging_bucket'], defaults: TODAY, about: 'Every open invoice and credit, grouped by how overdue it is.' },
  { key: 'open_invoices', group: 'who_owes_you', title: 'Open Invoices', kind: 'open_items', side: 'ar', defaults: TODAY, about: 'Unpaid invoices and unapplied credits, by customer.' },
  { key: 'collections_report', group: 'who_owes_you', title: 'Collections Report', kind: 'collections', side: 'ar', defaults: TODAY, about: 'Overdue invoices with each customer’s phone and email.' },
  { key: 'customer_balance_summary', group: 'who_owes_you', title: 'Customer Balance Summary', kind: 'balance_summary', side: 'ar', drillTo: 'customer_balance_detail', defaults: TODAY, about: 'Each customer’s balance on a date.' },
  { key: 'customer_balance_detail', group: 'who_owes_you', title: 'Customer Balance Detail', kind: 'open_items', side: 'ar', running: true, defaults: TODAY, about: 'The open invoices and credits behind each customer’s balance.' },
  { key: 'invoice_list', group: 'who_owes_you', title: 'Invoice List', kind: 'invoice_list', defaults: { period: 'this_month' }, about: 'Invoices dated in the period, with what is still open.' },
  { key: 'invoices_and_received_payments', group: 'who_owes_you', title: 'Invoices and Received Payments', kind: 'invoices_payments', about: 'Each invoice with the payments and credits applied to it.' },
  { key: 'statement_list', group: 'who_owes_you', title: 'Statement List', kind: 'statement_list', about: 'Customer statements made in the period.' },
  { key: 'unbilled_charges', group: 'who_owes_you', title: 'Unbilled Charges', kind: 'unbilled_charges', defaults: TODAY, about: 'Billable expenses not yet on an invoice.' },
  { key: 'unbilled_time', group: 'who_owes_you', title: 'Unbilled Time', kind: 'unbilled_time', defaults: TODAY, about: 'Billable hours not yet on an invoice.' },
  { key: 'sales_by_customer_summary', group: 'sales_customers', title: 'Sales by Customer Summary', kind: 'sales', groupBy: 'customer', timeColumns: true, drillTo: 'sales_by_customer_detail', about: 'Sales to each customer.' },
  { key: 'sales_by_customer_detail', group: 'sales_customers', title: 'Sales by Customer Detail', kind: 'sales_detail', groupBy: 'customer', about: 'Every sale, by customer.' },
  { key: 'sales_by_product_summary', group: 'sales_customers', title: 'Sales by Product/Service Summary', kind: 'sales', groupBy: 'item', timeColumns: true, drillTo: 'sales_by_product_detail', about: 'Quantity, sales, cost and margin for each product or service.' },
  { key: 'sales_by_product_detail', group: 'sales_customers', title: 'Sales by Product/Service Detail', kind: 'sales_detail', groupBy: 'item', about: 'Every sale, by product or service.' },
  { key: 'sales_by_class_summary', group: 'sales_customers', title: 'Sales by Class Summary', kind: 'sales', groupBy: 'class', timeColumns: true, drillTo: 'sales_by_class_detail', about: 'Sales for each class.' },
  { key: 'sales_by_class_detail', group: 'sales_customers', title: 'Sales by Class Detail', kind: 'sales_detail', groupBy: 'class', about: 'Every sale, by class.' },
  { key: 'sales_by_location_summary', group: 'sales_customers', title: 'Sales by Location Summary', kind: 'sales', groupBy: 'location', timeColumns: true, drillTo: 'sales_by_location_detail', about: 'Sales for each location.' },
  { key: 'sales_by_location_detail', group: 'sales_customers', title: 'Sales by Location Detail', kind: 'sales_detail', groupBy: 'location', about: 'Every sale, by location.' },
  { key: 'income_by_customer_summary', group: 'sales_customers', title: 'Income by Customer Summary', kind: 'income_by_customer', about: 'Income, expenses and net income for each customer.' },
  { key: 'deposit_detail', group: 'sales_customers', title: 'Deposit Detail', kind: 'deposit_detail', about: 'Each bank deposit and the payments in it.' },
  { key: 'estimates_by_customer', group: 'sales_customers', title: 'Estimates by Customer', kind: 'estimates', about: 'Estimates in the period with their status.' },
  { key: 'estimates_progress_invoicing', group: 'sales_customers', title: 'Estimates & Progress Invoicing Summary', kind: 'estimates', progress: true, about: 'How much of each estimate has been invoiced.' },
  { key: 'transaction_list_by_customer', group: 'sales_customers', title: 'Transaction List by Customer', kind: 'txnlist_by', party: 'customer', defaults: { period: 'this_month' }, about: 'Every customer transaction, grouped by customer.' },
);

// Stage R2b: what you owe, expenses and vendors, lists.
REPORTS.push(
  { key: 'ap_aging_summary', group: 'what_you_owe', title: 'A/P Aging Summary', kind: 'aging', side: 'ap', aging: true, drillTo: 'ap_aging_detail', defaults: TODAY, about: 'What you owe each vendor, by how overdue it is.' },
  { key: 'ap_aging_detail', group: 'what_you_owe', title: 'A/P Aging Detail', kind: 'aging_detail', side: 'ap', aging: true, extra: ['aging_bucket'], defaults: TODAY, about: 'Every unpaid bill and unused credit, grouped by how overdue it is.' },
  { key: 'unpaid_bills', group: 'what_you_owe', title: 'Unpaid Bills', kind: 'open_items', side: 'ap', defaults: TODAY, about: 'Bills not yet paid, by vendor.' },
  { key: 'vendor_balance_summary', group: 'what_you_owe', title: 'Vendor Balance Summary', kind: 'balance_summary', side: 'ap', drillTo: 'vendor_balance_detail', defaults: TODAY, about: 'What you owe each vendor on a date.' },
  { key: 'vendor_balance_detail', group: 'what_you_owe', title: 'Vendor Balance Detail', kind: 'open_items', side: 'ap', running: true, defaults: TODAY, about: 'The bills and credits behind each vendor’s balance.' },
  { key: 'bill_payment_list', group: 'what_you_owe', title: 'Bill Payment List', kind: 'bill_payments', about: 'Bill payments in the period, by the account they came from.' },
  { key: 'bills_and_applied_payments', group: 'what_you_owe', title: 'Bills and Applied Payments', kind: 'bills_payments', about: 'Each bill with the payments and credits applied to it.' },
  { key: 'contractor_1099_summary', group: 'what_you_owe', title: '1099 Contractor Balance Summary', kind: 'ten99', defaults: { period: 'this_year' }, about: 'What each 1099 vendor was paid from bank accounts.' },
  { key: 'contractor_1099_detail', group: 'what_you_owe', title: '1099 Contractor Balance Detail', kind: 'ten99', detail: true, defaults: { period: 'this_year' }, about: 'Each payment that counts toward a 1099.' },
  { key: 'expenses_by_vendor_summary', group: 'expenses_vendors', title: 'Expenses by Vendor Summary', kind: 'sales', expenses: true, groupBy: 'vendor', timeColumns: true, drillTo: 'expenses_by_vendor_detail', about: 'Expenses for each vendor.' },
  { key: 'expenses_by_vendor_detail', group: 'expenses_vendors', title: 'Expenses by Vendor Detail', kind: 'sales_detail', expenses: true, groupBy: 'vendor', about: 'Every expense line, by vendor.' },
  { key: 'purchases_by_vendor_summary', group: 'expenses_vendors', title: 'Purchases by Vendor Summary', kind: 'sales', purchases: true, groupBy: 'vendor', timeColumns: true, drillTo: 'purchases_by_vendor_detail', about: 'What was bought from each vendor (expenses and stock).' },
  { key: 'purchases_by_vendor_detail', group: 'expenses_vendors', title: 'Purchases by Vendor Detail', kind: 'sales_detail', purchases: true, groupBy: 'vendor', about: 'Every purchase line, by vendor.' },
  { key: 'purchases_by_product_summary', group: 'expenses_vendors', title: 'Purchases by Product/Service Summary', kind: 'sales', purchases: true, groupBy: 'item', timeColumns: true, drillTo: 'purchases_by_product_detail', about: 'What was spent on each product or service.' },
  { key: 'purchases_by_product_detail', group: 'expenses_vendors', title: 'Purchases by Product/Service Detail', kind: 'sales_detail', purchases: true, groupBy: 'item', about: 'Every purchase line, by product or service.' },
  { key: 'purchases_by_class_detail', group: 'expenses_vendors', title: 'Purchases by Class Detail', kind: 'sales_detail', purchases: true, groupBy: 'class', about: 'Every purchase line, by class.' },
  { key: 'purchases_by_location_detail', group: 'expenses_vendors', title: 'Purchases by Location Detail', kind: 'sales_detail', purchases: true, groupBy: 'location', about: 'Every purchase line, by location.' },
  { key: 'purchase_list', group: 'expenses_vendors', title: 'Purchase List', kind: 'purchase_list', defaults: { period: 'this_month' }, about: 'Bills, expenses, checks, credits and purchase orders in the period.' },
  { key: 'check_detail', group: 'expenses_vendors', title: 'Check Detail', kind: 'check_detail', defaults: { period: 'this_month' }, about: 'Checks written, with what each one paid for.' },
  { key: 'transaction_list_by_vendor', group: 'expenses_vendors', title: 'Transaction List by Vendor', kind: 'txnlist_by', party: 'vendor', defaults: { period: 'this_month' }, about: 'Every vendor transaction, grouped by vendor.' },
  { key: 'vendor_contact_list', group: 'expenses_vendors', title: 'Vendor Contact List', kind: 'contacts', party: 'vendor', about: 'Vendors with their phone, email and address.' },
  { key: 'vendor_phone_list', group: 'expenses_vendors', title: 'Vendor Phone List', kind: 'contacts', party: 'vendor', phones: true, about: 'Vendors with their phone numbers.' },
  { key: 'employee_contact_list', group: 'employees', title: 'Employee Contact List', kind: 'simple_list', list: 'employees', about: 'Everyone who signs in, with their role.' },
  { key: 'customer_contact_list', group: 'lists', title: 'Customer Contact List', kind: 'contacts', party: 'customer', about: 'Customers with their phone, email and address.' },
  { key: 'customer_phone_list', group: 'lists', title: 'Customer Phone List', kind: 'contacts', party: 'customer', phones: true, about: 'Customers with their phone numbers.' },
  { key: 'product_service_list', group: 'lists', title: 'Product/Service List', kind: 'products', about: 'Products and services with prices, cost and quantity on hand.' },
  { key: 'payment_method_list', group: 'lists', title: 'Payment Method List', kind: 'simple_list', list: 'payment_methods', about: 'Payment methods used, how often and when last.' },
  { key: 'terms_list', group: 'lists', title: 'Terms List', kind: 'simple_list', list: 'terms', about: 'Payment terms and their due days.' },
  { key: 'class_list', group: 'lists', title: 'Class List', kind: 'simple_list', list: 'classes', about: 'Classes and whether they are active.' },
  { key: 'location_list', group: 'lists', title: 'Location List', kind: 'simple_list', list: 'locations', about: 'Locations and whether they are active.' },
  { key: 'transaction_list_by_tag_group', group: 'accountant', title: 'Transaction List by Tag Group', kind: 'txnlist_by_tag', defaults: { period: 'this_month' }, about: 'Transactions grouped by tag.' },
);

// Stage R3a: projects, inventory, time, approvals, accountant checks.
REPORTS.push(
  { key: 'project_profitability_summary', group: 'projects', title: 'Project Profitability Summary', kind: 'project_profit', about: 'Income, costs and net income for each project.' },
  { key: 'work_in_progress_by_project', group: 'projects', title: 'Work in Progress by Project', kind: 'wip', defaults: TODAY, about: 'Estimated, invoiced, costs and unbilled costs for each project.' },
  { key: 'open_po_by_project', group: 'projects', title: 'Open Purchase Order by Project', kind: 'open_po', mode: 'project', defaults: TODAY, about: 'What is still to come on purchase orders, by project.' },
  { key: 'inventory_valuation_summary', group: 'inventory', title: 'Inventory Valuation Summary', kind: 'inv_valuation', defaults: TODAY, about: 'Quantity, value and average cost of each stock item on a date.' },
  { key: 'inventory_valuation_detail', group: 'inventory', title: 'Inventory Valuation Detail', kind: 'inv_valuation_detail', about: 'Every stock movement with running quantity and value.' },
  { key: 'inventory_status', group: 'inventory', title: 'Inventory Status', kind: 'inv_status', defaults: TODAY, about: 'On hand, on purchase orders and what needs reordering.' },
  { key: 'physical_inventory_worksheet', group: 'inventory', title: 'Physical Inventory Worksheet', kind: 'inv_status', worksheet: true, defaults: TODAY, about: 'A count sheet with quantities on hand.' },
  { key: 'open_purchase_order_list', group: 'inventory', title: 'Open Purchase Order List', kind: 'open_po', mode: 'list', defaults: TODAY, about: 'Purchase orders not yet fully received.' },
  { key: 'open_purchase_order_detail', group: 'inventory', title: 'Open Purchase Order Detail', kind: 'open_po', mode: 'detail', defaults: TODAY, about: 'Each purchase order line with what is backordered.' },
  { key: 'time_activities_by_customer', group: 'time', title: 'Time Activities by Customer Detail', kind: 'time', by: 'customer', about: 'Hours worked for each customer.' },
  { key: 'time_activities_by_employee', group: 'time', title: 'Time Activities by Employee Detail', kind: 'time', by: 'employee', about: 'Hours each person worked.' },
  { key: 'timesheet_detail_by_employee', group: 'time', title: 'Timesheet Detail by Employee', kind: 'time', by: 'timesheet', defaults: { period: 'this_week' }, about: 'Each person’s hours day by day.' },
  { key: 'recent_time_activities', group: 'time', title: 'Recent Time Activities', kind: 'time', recent: true, defaults: { period: 'last_7_days' }, about: 'Time entered recently, whatever day the work was done.' },
  { key: 'bill_approval_status', group: 'what_you_owe', title: 'Bill Approval Status', kind: 'bill_approval', about: 'Bills and where each stands in approval.' },
  { key: 'reconciliation_reports', group: 'accountant', title: 'Reconciliation Reports', kind: 'reconciliations', defaults: { period: 'all' }, about: 'Every finished reconciliation, with its report.' },
  { key: 'recurring_template_list', group: 'accountant', title: 'Recurring Template List', kind: 'recurring_list', about: 'Every recurring template with its schedule.' },
  { key: 'invalid_journal_transactions', group: 'accountant', title: 'Invalid Journal Transactions', kind: 'invalid_txns', defaults: { period: 'all' }, about: 'Transactions that don’t balance or post somewhere they shouldn’t (should be empty).' },
);

// Stage R3b: budgets, exchange gains and losses, audit log.
REPORTS.push(
  { key: 'budget_overview', group: 'business_overview', title: 'Budget Overview', kind: 'budget_overview', extra: ['budget'], about: 'A budget by month, laid out like the Profit and Loss.' },
  { key: 'budget_vs_actuals', group: 'business_overview', title: 'Budget vs. Actuals', kind: 'budget_vs_actuals', extra: ['budget'], timeColumns: true, defaults: { period: 'this_fiscal_year_to_date' }, about: 'Actual income and expenses against the budget, with what is over or under.' },
  { key: 'realized_gains_losses', group: 'business_overview', title: 'Realized Gains & Losses', kind: 'fx_realized', defaults: { period: 'this_year_to_date' }, about: 'Exchange gains and losses from foreign invoices and bills settled at a different rate.' },
  { key: 'unrealized_gains_losses', group: 'business_overview', title: 'Unrealized Gains & Losses', kind: 'fx_unrealized', defaults: TODAY, about: 'What open foreign balances would gain or lose at the rate on a date.' },
  { key: 'audit_log', group: 'business_overview', title: 'Audit Log', kind: 'audit', adminOnly: true, extra: ['audit_user', 'audit_area'], defaults: { period: 'last_7_days' }, about: 'Who added, changed or deleted what, and when, with before and after values; sign-ins too.' },
);

// Stage R4b: the report builder.
REPORTS.push(
  { key: 'report_builder', group: 'builder', title: 'Custom Report', kind: 'builder', extra: BUILDER_EXTRA, defaults: { period: 'this_month' },
    about: 'Start from invoices, sales, expenses, bills, journal entries, banking or all transactions; choose columns, grouping and sorting; save it.' },
);

// Stage R5a: KPI scorecard (management reports have their own pages).
REPORTS.push(
  { key: 'kpi_scorecard', group: 'performance', title: 'KPI Scorecard', kind: 'kpis', extra: ['kpi_compare'], defaults: { period: 'last_month' },
    about: 'Revenue, margins, cash flow, customers and balance-sheet ratios against the previous period or year; add your own KPIs.' },
);

// Stage R5b: forecasts (dashboards and the cash flow planner have their own pages).
REPORTS.push(
  { key: 'forecast', group: 'performance', title: 'Forecast', kind: 'forecast', extra: FORECAST_EXTRA, about: 'The Profit and Loss for the coming months from the last 12, adjusted up or down.' },
);

// Shown on the page as "the same report as…" so searches find both spellings.
export const ALIASES = { profit_and_loss: 'P&L income statement', balance_sheet: 'statement of financial position', general_ledger: 'GL', statement_of_cash_flows: 'cash flow statement', business_snapshot: 'dashboard', account_list: 'chart of accounts', report_builder: 'create new report builder', kpi_scorecard: 'kpi key performance indicators', forecast: 'projection plan future' };
export const reportByKey = key => REPORTS.find(r => r.key === key) ?? null;
