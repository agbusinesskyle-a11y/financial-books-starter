// lib/tax/catalog/2025/form1065.js — 2025 Form 1065 (clean-room from the public form). TaxAct labels are the CSV key only.
import { income, deduction, computed, statement, stated, asset, contra, liability, info, sum, minus, sumMinus, withK1Members } from './shared.js';

const P1 = [
  income('f1065.p1.1a', 'Gross receipts or sales', { taxact: 'Income: Gross receipts or sales' }),
  income('f1065.p1.1b', 'Less returns and allowances', { ledgerPolarity: 'debit', semantic: 'reduction', operator: 'subtract', taxact: 'Income: Returns and allowances' }),
  computed('f1065.p1.1c', 'Balance', minus('f1065.p1.1a', 'f1065.p1.1b'), { cls: 'income' }),
  computed('f1065.p1.2', 'Cost of goods sold (Form 1125-A, line 8)', sum('f1125a.main.8'), { aggregates: ['activity'], operator: 'subtract', cls: 'deduction' }),
  computed('f1065.p1.3', 'Gross profit', minus('f1065.p1.1c', 'f1065.p1.2'), { cls: 'income' }),
  // Line 4 exists only for K-1 amounts: one member per K-1 received, keyed by k1_source (required), summed into the line once.
  stated('f1065.p1.4', 'Ordinary income (loss) from other partnerships, estates, and trusts', { kind: 'statement', type: 'statement', sourceDims: ['k1_source'], sourceRequired: true }),
  stated('f1065.p1.5', 'Net farm profit (loss) (Schedule F)', { kind: 'manual' }),
  stated('f1065.p1.6', 'Net gain (loss) from Form 4797, Part II, line 17', { kind: 'manual' }),
  statement('f1065.p1.7', 'Other income (loss)', { cls: 'income', ledgerPolarity: 'credit', taxact: 'Income: Other Income' }),
  computed('f1065.p1.8', 'Total income (loss)', sum('f1065.p1.3', 'f1065.p1.4', 'f1065.p1.5', 'f1065.p1.6', 'f1065.p1.7'), { cls: 'income' }),
  deduction('f1065.p1.9', 'Salaries and wages (other than to partners)', { taxact: 'Deductions: Salaries and wages (other than to partners)' }),
  deduction('f1065.p1.10', 'Guaranteed payments to partners', { instanceDims: ['interest'] }),
  deduction('f1065.p1.11', 'Repairs and maintenance', { taxact: 'Deductions: Repairs and maintenance' }),
  deduction('f1065.p1.12', 'Bad debts', { taxact: 'Deductions: Bad debts' }),
  deduction('f1065.p1.13', 'Rent', { taxact: 'Deductions: Rents' }),
  statement('f1065.p1.14', 'Taxes and licenses', { cls: 'deduction', ledgerPolarity: 'debit' }),
  deduction('f1065.p1.15', 'Interest', { taxact: 'Deductions: Interest expense' }),
  deduction('f1065.p1.16a', 'Depreciation', { kind: 'manual', sourceDims: ['asset'] }),
  deduction('f1065.p1.16b', 'Less depreciation reported on Form 1125-A and elsewhere', { kind: 'manual', semantic: 'reduction', operator: 'subtract' }),
  computed('f1065.p1.16c', 'Depreciation net', minus('f1065.p1.16a', 'f1065.p1.16b'), { cls: 'deduction' }),
  deduction('f1065.p1.17', 'Depletion', { taxact: 'Deductions: Depletion' }),
  deduction('f1065.p1.18', 'Retirement plans, etc.', { taxact: 'Deductions: Retirement plans/etc.' }),
  deduction('f1065.p1.19', 'Employee benefit programs', { taxact: 'Deductions: Employee benefit programs' }),
  deduction('f1065.p1.20', 'Energy efficient commercial buildings deduction (Form 7205)', { kind: 'manual' }),
  statement('f1065.p1.21', 'Other deductions', { cls: 'deduction', ledgerPolarity: 'debit', taxact: 'Other Deductions: Other deductions' }),
  computed('f1065.p1.22', 'Total deductions', sum('f1065.p1.9', 'f1065.p1.10', 'f1065.p1.11', 'f1065.p1.12', 'f1065.p1.13', 'f1065.p1.14', 'f1065.p1.15', 'f1065.p1.16c', 'f1065.p1.17', 'f1065.p1.18', 'f1065.p1.19', 'f1065.p1.20', 'f1065.p1.21'), { aggregates: ['interest'], operator: 'subtract', cls: 'deduction' }),
  computed('f1065.p1.23', 'Ordinary business income (loss)', minus('f1065.p1.8', 'f1065.p1.22'), { cls: 'income' }),
];
// Named statement rows TaxAct accepts behind line 21 (interchange only; our rows are named by the account).
export const OTHER_DEDUCTION_TAXACT = ['Accounting', 'Advertising', 'Bank charges', 'Business gifts', 'Commissions', 'Credit & collection fees', 'Independent contractors', 'Insurance',
  'Janitorial & cleaning', 'Legal & professional fees', 'Postage & delivery', 'Professional dues & subscriptions', 'Reimbursed employee expenses', 'Supplies', 'Telephone/Internet',
  'Travel/Meals and entertainment(subj to 50% limitation)', 'Travel/Meals and entertainment(100% deductible)', 'Utilities'].map(x => `Other Deductions: ${x}`);

// Schedule K. allocBasis is how T4 carries each line to the K-1s (spec §5.7): income-type lines, credits and tax-exempt income by
// profit share, deduction-type lines by loss share. Owner-specific lines (guaranteed payments 4a-4c, self-employment 14a,
// distributions 19a-19b) carry 'none': they come from guaranteed_payment, se_workpaper and capital_event, never pro rata.
// The bases of 17a-17f, 18c, 20b and 20c follow each item's character; the partnership agreement may dictate otherwise.
const K = withK1Members([
  computed('f1065.k.1', 'Ordinary business income (loss)', sum('f1065.p1.23'), { cls: 'income', allocBasis: 'profit' }),
  stated('f1065.k.2', 'Net rental real estate income (loss) (Form 8825)', { kind: 'computed', formula: sum('f8825.main.23'), allocBasis: 'profit' }),
  stated('f1065.k.3a', 'Other gross rental income (loss)', { allocBasis: 'profit' }),
  stated('f1065.k.3b', 'Expenses from other rental activities', { operator: 'subtract', ledgerPolarity: 'debit', allocBasis: 'loss' }),
  computed('f1065.k.3c', 'Other net rental income (loss)', minus('f1065.k.3a', 'f1065.k.3b'), { cls: 'separately_stated', allocBasis: 'profit' }),
  stated('f1065.k.4a', 'Guaranteed payments: services', { allocBasis: 'none', instanceDims: ['interest'] }),
  stated('f1065.k.4b', 'Guaranteed payments: capital', { allocBasis: 'none', instanceDims: ['interest'] }),
  computed('f1065.k.4c', 'Guaranteed payments: total', sum('f1065.k.4a', 'f1065.k.4b'), { aggregates: ['interest'], cls: 'separately_stated', allocBasis: 'none' }),
  stated('f1065.k.5', 'Interest income', { allocBasis: 'profit', taxact: "Schedule K-Portfolio Inc(Loss): Interest income-CD's/etc." }),
  stated('f1065.k.6a', 'Ordinary dividends', { allocBasis: 'profit', taxact: 'Schedule K-Portfolio Inc(Loss): Interest income-Dividend income' }),
  stated('f1065.k.6b', 'Qualified dividends (subset of 6a)', { allocBasis: 'profit' }),
  stated('f1065.k.6c', 'Dividend equivalents', { allocBasis: 'profit' }),
  stated('f1065.k.7', 'Royalties', { allocBasis: 'profit', taxact: 'Schedule K-Portfolio Inc(Loss): Interest income-Royalty income' }),
  stated('f1065.k.8', 'Net short-term capital gain (loss)', { kind: 'manual', allocBasis: 'profit' }),
  stated('f1065.k.9a', 'Net long-term capital gain (loss)', { kind: 'manual', allocBasis: 'profit' }),
  stated('f1065.k.9b', 'Collectibles (28%) gain (loss)', { kind: 'manual', allocBasis: 'profit' }),
  stated('f1065.k.9c', 'Unrecaptured section 1250 gain', { kind: 'manual', allocBasis: 'profit' }),
  stated('f1065.k.10', 'Net section 1231 gain (loss) (Form 4797)', { kind: 'manual', allocBasis: 'profit' }),
  statement('f1065.k.11', 'Other income (loss)', { cls: 'separately_stated', allocBasis: 'profit', taxact: 'Schedule K-Other Income(loss): Other income' }),
  // The investment-income component of line 11, classified on its own (a subset of line 11, like 6b of 6a): line 20a reads it, never the
  // whole other-income line, and nothing adds it to the income reconciliation a second time.
  stated('f1065.k.11_inv', 'Investment income included on line 11 (classified component; feeds line 20a)', { allocBasis: 'profit' }),
  stated('f1065.k.12', 'Section 179 deduction (Form 4562)', { operator: 'subtract', kind: 'manual', ledgerPolarity: 'debit', allocBasis: 'loss' }),
  stated('f1065.k.13a', 'Cash contributions', { operator: 'subtract', ledgerPolarity: 'debit', allocBasis: 'loss' }),
  stated('f1065.k.13b', 'Noncash contributions', { operator: 'subtract', ledgerPolarity: 'debit', allocBasis: 'loss' }),
  stated('f1065.k.13c', 'Investment interest expense', { operator: 'subtract', ledgerPolarity: 'debit', allocBasis: 'loss', taxact: 'Schedule K-Investment Interest: Interest exp.-investment debts' }),
  stated('f1065.k.13d_amt', 'Section 59(e)(2) expenditures: amount', { operator: 'subtract', ledgerPolarity: 'debit', allocBasis: 'loss', taxact: 'Schedule K-Other Items: Sec. 59(e) expenses' }),
  info('f1065.k.13d_type', 'Section 59(e)(2) expenditures: type'),
  statement('f1065.k.13e', 'Other deductions', { operator: 'subtract', cls: 'separately_stated', ledgerPolarity: 'debit', allocBasis: 'loss', taxact: 'Schedule K-Deductions: Other deductions' }),
  stated('f1065.k.14a', 'Net earnings (loss) from self-employment', { kind: 'computed', formula: sum('se.wp.total'), allocBasis: 'none' }),
  stated('f1065.k.14b', 'Gross farming or fishing income', { kind: 'manual', allocBasis: 'profit' }),
  // Gross nonfarm income is the SE workpaper's reviewed figure (2025 Form 1065 instructions, line 14c), never net receipts plus page 1 lines:
  // receipts less COGS, the character of lower-tier ordinary income and of Form 4797 gains all bear on it. T4's SE workpaper fills the input.
  stated('f1065.k.14c', 'Gross nonfarm income', { kind: 'computed', formula: sum('se.wp.gross_nonfarm'), allocBasis: 'profit' }),
  stated('f1065.k.15a', 'Low-income housing credit (section 42(j)(5))', { kind: 'manual', allocBasis: 'profit' }),
  stated('f1065.k.15b', 'Low-income housing credit (other)', { kind: 'manual', allocBasis: 'profit' }),
  stated('f1065.k.15c', 'Qualified rehabilitation expenditures (rental real estate)', { kind: 'manual', allocBasis: 'profit' }),
  stated('f1065.k.15d', 'Other rental real estate credits', { kind: 'manual', allocBasis: 'profit' }),
  stated('f1065.k.15e', 'Other rental credits', { kind: 'manual', allocBasis: 'profit' }),
  stated('f1065.k.15f', 'Other credits', { kind: 'manual', allocBasis: 'profit' }),
  info('f1065.k.16a', 'Schedule K-2 attached', { type: 'checkbox' }), info('f1065.k.16b', 'Qualified for exception to filing Schedule K-2', { type: 'checkbox' }),
  // AMT items follow the regular-tax item they adjust: depreciation, depletion and oil-and-gas deductions by loss share; gain and gross income by profit share.
  stated('f1065.k.17a', 'Post-1986 depreciation adjustment', { kind: 'manual', allocBasis: 'loss' }),
  stated('f1065.k.17b', 'Adjusted gain or loss', { kind: 'manual', allocBasis: 'profit' }),
  stated('f1065.k.17c', 'Depletion (other than oil and gas)', { kind: 'manual', allocBasis: 'loss' }),
  stated('f1065.k.17d', 'Oil, gas, and geothermal properties: gross income', { kind: 'manual', allocBasis: 'profit' }),
  stated('f1065.k.17e', 'Oil, gas, and geothermal properties: deductions', { kind: 'manual', allocBasis: 'loss' }),
  statement('f1065.k.17f', 'Other AMT items', { cls: 'separately_stated', allocBasis: 'profit' }),
  // 18a-18c also drive tax capital (spec §5.6: + tax-exempt income allocated - nondeductible items allocated).
  stated('f1065.k.18a', 'Tax-exempt interest income', { allocBasis: 'profit', taxact: 'Schedule K-Other Items: Tax-exempt interest income (federal)' }),
  stated('f1065.k.18b', 'Other tax-exempt income', { allocBasis: 'profit', taxact: 'Schedule K-Other Items: Other tax-exempt income' }),
  stated('f1065.k.18c', 'Nondeductible expenses', { ledgerPolarity: 'debit', allocBasis: 'loss', taxact: 'Schedule K-Other Items: Nondeductible expenses' }),
  stated('f1065.k.19a', 'Distributions of cash and marketable securities', { ledgerPolarity: 'debit', allocBasis: 'none', instanceDims: ['interest'] }),
  stated('f1065.k.19b', 'Distributions of other property', { ledgerPolarity: 'debit', allocBasis: 'none', instanceDims: ['interest'] }),
  stated('f1065.k.20a', 'Investment income', { kind: 'computed', formula: sum('f1065.k.5', 'f1065.k.6a', 'f1065.k.7', 'f1065.k.11_inv'), allocBasis: 'profit' }),
  stated('f1065.k.20b', 'Investment expenses', { ledgerPolarity: 'debit', allocBasis: 'loss' }),
  statement('f1065.k.20c', 'Other items and amounts', { cls: 'separately_stated', allocBasis: 'profit' }),
  stated('f1065.k.21', 'Total foreign taxes paid or accrued', { operator: 'subtract', ledgerPolarity: 'debit', allocBasis: 'loss', taxact: 'Schedule K-Foreign Tax: Foreign taxes paid' }),
]);
// Analysis of Net Income (Loss) per Return, line 1 — the M-1 bridge endpoint (spec §5.5).
const ANALYSIS = [computed('f1065.anal.1', 'Net income (loss) per return', sumMinus(['f1065.k.1', 'f1065.k.2', 'f1065.k.3c', 'f1065.k.4c', 'f1065.k.5', 'f1065.k.6a', 'f1065.k.7', 'f1065.k.8', 'f1065.k.9a', 'f1065.k.10', 'f1065.k.11'],
  ['f1065.k.12', 'f1065.k.13a', 'f1065.k.13b', 'f1065.k.13c', 'f1065.k.13d_amt', 'f1065.k.13e', 'f1065.k.21']), { cls: 'income' })];

// Schedule L — balance sheets per books. Each line has begin and end measurements (the engine asks for both).
const L = [
  asset('f1065.L.1', 'Cash', { taxact: 'B/S-Assets: Cash' }), asset('f1065.L.2a', 'Trade notes and accounts receivable', { taxact: 'B/S-Assets: Accts. Rec. and trade notes' }),
  contra('f1065.L.2b', 'Less allowance for bad debts', { taxact: 'B/S-Assets: Allowance for bad debts' }), asset('f1065.L.3', 'Inventories', { taxact: 'B/S-Assets: Inventories' }),
  asset('f1065.L.4', 'U.S. Government obligations', { taxact: 'B/S-Assets: U.S. government obligations' }), asset('f1065.L.5', 'Tax-exempt securities', { taxact: 'B/S-Assets: Tax-exempt securities' }),
  statement('f1065.L.6', 'Other current assets', { cls: 'balance', ledgerPolarity: 'debit', taxact: 'B/S-Assets: Other current assets' }),
  asset('f1065.L.7a', 'Loans to partners (or persons related to partners)', { taxact: 'B/S-Assets: Loans to partners' }),
  asset('f1065.L.7b', 'Mortgage and real estate loans', { taxact: 'B/S-Assets: Mortgage and real estate loans' }),
  statement('f1065.L.8', 'Other investments', { cls: 'balance', ledgerPolarity: 'debit', taxact: 'B/S-Assets: Other investments' }),
  asset('f1065.L.9a', 'Buildings and other depreciable assets', { taxact: 'B/S-Assets: Building/oth. depr. assets' }),
  contra('f1065.L.9b', 'Less accumulated depreciation', { taxact: 'B/S-Assets: Building/oth. Accumulated deprec.' }),
  asset('f1065.L.10a', 'Depletable assets', { taxact: 'B/S-Assets: Depletable assets' }), contra('f1065.L.10b', 'Less accumulated depletion', { taxact: 'B/S-Assets: Depletable assets Accum. deprec.' }),
  asset('f1065.L.11', 'Land (net of any amortization)'), asset('f1065.L.12a', 'Intangible assets (amortizable only)', { taxact: 'B/S-Assets: Intangible assets' }),
  contra('f1065.L.12b', 'Less accumulated amortization', { taxact: 'B/S-Assets: Intangible assets Accum. deprec.' }),
  statement('f1065.L.13', 'Other assets', { cls: 'balance', ledgerPolarity: 'debit', taxact: 'B/S-Assets: Other assets' }),
  computed('f1065.L.14', 'Total assets', sumMinus(['f1065.L.1', 'f1065.L.2a', 'f1065.L.3', 'f1065.L.4', 'f1065.L.5', 'f1065.L.6', 'f1065.L.7a', 'f1065.L.7b', 'f1065.L.8', 'f1065.L.9a', 'f1065.L.10a', 'f1065.L.11', 'f1065.L.12a', 'f1065.L.13'],
    ['f1065.L.2b', 'f1065.L.9b', 'f1065.L.10b', 'f1065.L.12b']), { cls: 'balance' }),
  liability('f1065.L.15', 'Accounts payable', { taxact: 'B/S-Liabs/Eq.: Accounts payable' }),
  liability('f1065.L.16', 'Mortgages, notes, bonds payable in less than 1 year', { taxact: 'B/S-Liabs/Eq.: S-T Mortgage/note/bonds payable' }),
  statement('f1065.L.17', 'Other current liabilities', { cls: 'balance', ledgerPolarity: 'credit', taxact: 'B/S-Liabs/Eq.: Other current liabilities' }),
  liability('f1065.L.18', 'All nonrecourse loans', { taxact: 'B/S-Liabs/Eq.: All nonrecourse loans' }),
  liability('f1065.L.19a', 'Loans from partners (or persons related to partners)', { taxact: 'B/S-Liabs/Eq.: Loans from partners' }),
  liability('f1065.L.19b', 'Mortgages, notes, bonds payable in 1 year or more', { taxact: 'B/S-Liabs/Eq.: L-T Mortgage/note/bonds payable' }),
  statement('f1065.L.20', 'Other liabilities', { cls: 'balance', ledgerPolarity: 'credit', taxact: 'B/S-Liabs/Eq.: Other liabilities' }),
  // Line 21 is book capital bound from the equity accounts, never total assets less liabilities (spec §5.2 "equity is never plugged",
  // §5.6). L.14 and L.22 are computed from different inputs, so the engine's "Schedule L unbalanced" error (§5.8) can fire and an
  // unbound balance account cannot hide in capital. No TaxAct key: its 1065 import takes partners' capital by hand.
  liability('f1065.L.21', 'Partners’ capital accounts (per books)'),
  computed('f1065.L.22', 'Total liabilities and capital', sum('f1065.L.15', 'f1065.L.16', 'f1065.L.17', 'f1065.L.18', 'f1065.L.19a', 'f1065.L.19b', 'f1065.L.20', 'f1065.L.21'), { cls: 'balance' }),
];
// Schedule M-1 — the bridge classes are produced by the engine (spec §5.5); these are the presentation lines.
const M1 = [
  stated('f1065.m1.1', 'Net income (loss) per books', { kind: 'computed', formula: sum('books.ni.total') }),
  statement('f1065.m1.2', 'Income on Schedule K not recorded on books this year', { cls: 'separately_stated' }),
  stated('f1065.m1.3', 'Guaranteed payments (other than health insurance)', { kind: 'computed', formula: sum('gp.wp.m1') }),
  stated('f1065.m1.4a', 'Expenses on books not on Schedule K: depreciation', { kind: 'computed', formula: sum('bridge.m1.dep_addback') }),
  stated('f1065.m1.4b', 'Expenses on books not on Schedule K: travel and entertainment', { kind: 'computed', formula: sum('bridge.m1.meals_addback') }),
  statement('f1065.m1.4c', 'Expenses on books not on Schedule K: other', { cls: 'separately_stated' }),
  computed('f1065.m1.5', 'Add lines 1 through 4', sum('f1065.m1.1', 'f1065.m1.2', 'f1065.m1.3', 'f1065.m1.4a', 'f1065.m1.4b', 'f1065.m1.4c'), { cls: 'income' }),
  stated('f1065.m1.6a', 'Income on books not on Schedule K: tax-exempt interest', { kind: 'computed', formula: sum('f1065.k.18a') }),
  statement('f1065.m1.6b', 'Income on books not on Schedule K: other', { cls: 'separately_stated' }),
  stated('f1065.m1.7a', 'Deductions on Schedule K not charged against book income: depreciation', { kind: 'computed', formula: sum('bridge.m1.dep_deduct') }),
  statement('f1065.m1.7b', 'Deductions on Schedule K not charged against book income: other', { cls: 'separately_stated' }),
  computed('f1065.m1.8', 'Add lines 6 and 7', sum('f1065.m1.6a', 'f1065.m1.6b', 'f1065.m1.7a', 'f1065.m1.7b'), { operator: 'subtract', cls: 'income' }),
  computed('f1065.m1.9', 'Income (loss) (Analysis of Net Income, line 1)', minus('f1065.m1.5', 'f1065.m1.8'), { cls: 'income' }),
];
// Schedule M-2 — tax-basis partners' capital (spec §5.6); amounts come from the capital ledger in T4.
const M2 = [
  stated('f1065.m2.1', 'Balance at beginning of year', { kind: 'computed', formula: sum('cap.wp.begin') }),
  stated('f1065.m2.2a', 'Capital contributed: cash', { kind: 'computed', formula: sum('cap.wp.contrib_cash') }),
  stated('f1065.m2.2b', 'Capital contributed: property', { kind: 'computed', formula: sum('cap.wp.contrib_property') }),
  stated('f1065.m2.3', 'Net income (loss)', { kind: 'computed', formula: sum('cap.wp.net_income') }),
  statement('f1065.m2.4', 'Other increases', { cls: 'separately_stated' }),
  computed('f1065.m2.5', 'Add lines 1 through 4', sum('f1065.m2.1', 'f1065.m2.2a', 'f1065.m2.2b', 'f1065.m2.3', 'f1065.m2.4'), { cls: 'balance' }),
  stated('f1065.m2.6a', 'Distributions: cash', { kind: 'computed', formula: sum('cap.wp.dist_cash') }),
  stated('f1065.m2.6b', 'Distributions: property', { kind: 'computed', formula: sum('cap.wp.dist_property') }),
  statement('f1065.m2.7', 'Other decreases', { cls: 'separately_stated' }),
  computed('f1065.m2.8', 'Add lines 6 and 7', sum('f1065.m2.6a', 'f1065.m2.6b', 'f1065.m2.7'), { operator: 'subtract', cls: 'balance' }),
  computed('f1065.m2.9', 'Balance at end of year', minus('f1065.m2.5', 'f1065.m2.8'), { cls: 'balance' }),
];
// Engine-owned inputs the formulas above name (filled by T3/T4 workpapers; declared here so the catalog is closed).
const ENGINE = [
  stated('se.wp.total', 'Self-employment workpaper total', { kind: 'manual' }), stated('se.wp.gross_nonfarm', 'Self-employment workpaper: gross nonfarm income (reviewed)', { kind: 'manual' }), stated('gp.wp.m1', 'Guaranteed payments other than health insurance', { kind: 'manual' }),
  stated('books.ni.total', 'Net income per books', { kind: 'manual' }), stated('bridge.m1.dep_addback', 'Book depreciation over tax', { kind: 'manual' }),
  stated('bridge.m1.meals_addback', 'Nondeductible meals and entertainment', { kind: 'manual' }), stated('bridge.m1.dep_deduct', 'Tax depreciation over book', { kind: 'manual' }),
  stated('cap.wp.begin', 'Tax capital, beginning', { kind: 'manual' }), stated('cap.wp.contrib_cash', 'Contributions: cash', { kind: 'manual' }),
  stated('cap.wp.contrib_property', 'Contributions: property (tax basis)', { kind: 'manual' }), stated('cap.wp.net_income', 'Net income allocated', { kind: 'manual' }),
  stated('cap.wp.dist_cash', 'Distributions: cash', { kind: 'manual' }), stated('cap.wp.dist_property', 'Distributions: property (tax basis)', { kind: 'manual' }),
];
export const LINES = [...P1, ...K, ...ANALYSIS, ...L, ...M1, ...M2, ...ENGINE];
