// lib/tax/catalog/2025/form1120s.js — 2025 Form 1120-S (clean-room from the public form). Separate result type from the 1065. TaxAct labels are the CSV key only.
// Numbered as the TY2025 form is (checked against the IRS PDF with scripts/tax-catalog-check.py): Schedule K line 12 runs 12a-12e, line 18
// subtracts lines 11 through 12e and 16f, and Schedule M-2 has four columns (AAA, PTI, AE&P, OAA) that carry different cells (see M2 below).
import { income, deduction, computed, statement, stated, asset, contra, liability, info, sum, minus, sumMinus, withK1Members } from './shared.js';

const P1 = [
  income('f1120s.p1.1a', 'Gross receipts or sales', { taxact: 'Income: Gross receipts or sales' }),
  income('f1120s.p1.1b', 'Less returns and allowances', { ledgerPolarity: 'debit', semantic: 'reduction', operator: 'subtract', taxact: 'Income: Returns and allowances' }),
  computed('f1120s.p1.1c', 'Balance', minus('f1120s.p1.1a', 'f1120s.p1.1b'), { cls: 'income' }),
  computed('f1120s.p1.2', 'Cost of goods sold (Form 1125-A, line 8)', sum('f1125a.main.8'), { aggregates: ['activity'], operator: 'subtract', cls: 'deduction' }),
  computed('f1120s.p1.3', 'Gross profit', minus('f1120s.p1.1c', 'f1120s.p1.2'), { cls: 'income' }),
  stated('f1120s.p1.4', 'Net gain (loss) from Form 4797, Part II, line 17', { kind: 'manual' }),
  // Line 5 is the S corporation's only "Other income (loss)" line: trade interest, bad-debt recoveries, insurance proceeds and section 481(a)
  // adjustments are the corporation's own statement rows (a member with no source dimension, spec §4.5 statement_row), and a K-1 payer's ordinary
  // income also reaches it (spec §4.9) as one more member per K-1, keyed by k1_source. k1_source is an ALLOWED source dimension here, not a
  // required one (Codex t1-r1 B2): each member keeps its own provider. The 1065 differs: its line 4 exists only for K-1 amounts and requires it.
  statement('f1120s.p1.5', 'Other income (loss)', { sourceDims: ['k1_source'], cls: 'income', ledgerPolarity: 'credit', taxact: 'Income: Other Income' }),
  computed('f1120s.p1.6', 'Total income (loss)', sum('f1120s.p1.3', 'f1120s.p1.4', 'f1120s.p1.5'), { cls: 'income' }),
  deduction('f1120s.p1.7', 'Compensation of officers (Form 1125-E)', { instanceDims: ['interest'] }),
  deduction('f1120s.p1.8', 'Salaries and wages (less employment credits)'), deduction('f1120s.p1.9', 'Repairs and maintenance'), deduction('f1120s.p1.10', 'Bad debts'),
  deduction('f1120s.p1.11', 'Rents'), statement('f1120s.p1.12', 'Taxes and licenses', { cls: 'deduction', ledgerPolarity: 'debit' }), deduction('f1120s.p1.13', 'Interest'),
  deduction('f1120s.p1.14', 'Depreciation not claimed on Form 1125-A or elsewhere (Form 4562)', { kind: 'manual', sourceDims: ['asset'] }), deduction('f1120s.p1.15', 'Depletion'),
  deduction('f1120s.p1.16', 'Advertising'), deduction('f1120s.p1.17', 'Pension, profit-sharing, etc., plans'), deduction('f1120s.p1.18', 'Employee benefit programs'),
  deduction('f1120s.p1.19', 'Energy efficient commercial buildings deduction (Form 7205)', { kind: 'manual' }),
  statement('f1120s.p1.20', 'Other deductions', { cls: 'deduction', ledgerPolarity: 'debit' }),
  computed('f1120s.p1.21', 'Total deductions', sum('f1120s.p1.7', 'f1120s.p1.8', 'f1120s.p1.9', 'f1120s.p1.10', 'f1120s.p1.11', 'f1120s.p1.12', 'f1120s.p1.13', 'f1120s.p1.14', 'f1120s.p1.15', 'f1120s.p1.16', 'f1120s.p1.17', 'f1120s.p1.18', 'f1120s.p1.19', 'f1120s.p1.20'), { aggregates: ['interest'], operator: 'subtract', cls: 'deduction' }),
  computed('f1120s.p1.22', 'Ordinary business income (loss)', minus('f1120s.p1.6', 'f1120s.p1.21'), { cls: 'income' }),
  stated('f1120s.p1.23a', 'Excess net passive income or LIFO recapture tax', { kind: 'manual' }), stated('f1120s.p1.23b', 'Tax from Schedule D (Form 1120-S)', { kind: 'manual' }),
];

// Schedule K. allocBasis is how the allocator carries each line to the K-1s (spec §5.7). S corporation items allocate per share per day, the
// same fraction for every shareholder, but the catalog marks each line's character as the 1065 catalog does (income, credits and tax-exempt
// income by 'profit', deductions by 'loss') so a pro rata line is never read as 'none' and left off every K-1. 'none' marks what is not pro rata:
// distributions (16d) and loan repayments (16e) belong to one shareholder (capital_event, shareholder_loan rows), 17c is the corporate total of
// the distributions the AAA ordering assigns to accumulated E&P (no K-1 box carries it), and 18 is the corporate reconciliation M-1 line 8 must equal.
const K = withK1Members([
  computed('f1120s.k.1', 'Ordinary business income (loss)', sum('f1120s.p1.22'), { cls: 'income', allocBasis: 'profit' }),
  stated('f1120s.k.2', 'Net rental real estate income (loss) (Form 8825)', { kind: 'computed', formula: sum('f8825.main.23'), allocBasis: 'profit' }),
  stated('f1120s.k.3a', 'Other gross rental income (loss)', { allocBasis: 'profit' }), stated('f1120s.k.3b', 'Expenses from other rental activities', { operator: 'subtract', ledgerPolarity: 'debit', allocBasis: 'loss' }),
  computed('f1120s.k.3c', 'Other net rental income (loss)', minus('f1120s.k.3a', 'f1120s.k.3b'), { cls: 'separately_stated', allocBasis: 'profit' }),
  stated('f1120s.k.4', 'Interest income', { allocBasis: 'profit' }), stated('f1120s.k.5a', 'Ordinary dividends', { allocBasis: 'profit' }),
  stated('f1120s.k.5b', 'Qualified dividends (subset of 5a)', { allocBasis: 'profit' }), stated('f1120s.k.6', 'Royalties', { allocBasis: 'profit' }),
  stated('f1120s.k.7', 'Net short-term capital gain (loss)', { kind: 'manual', allocBasis: 'profit' }), stated('f1120s.k.8a', 'Net long-term capital gain (loss)', { kind: 'manual', allocBasis: 'profit' }),
  stated('f1120s.k.8b', 'Collectibles (28%) gain (loss)', { kind: 'manual', allocBasis: 'profit' }), stated('f1120s.k.8c', 'Unrecaptured section 1250 gain', { kind: 'manual', allocBasis: 'profit' }),
  stated('f1120s.k.9', 'Net section 1231 gain (loss)', { kind: 'manual', allocBasis: 'profit' }), statement('f1120s.k.10', 'Other income (loss)', { cls: 'separately_stated', allocBasis: 'profit' }),
  // The investment-income component of line 10, classified on its own (a subset of line 10): line 17a reads it, never the whole line.
  stated('f1120s.k.10_inv', 'Investment income included on line 10 (classified component; feeds line 17a)', { allocBasis: 'profit' }),
  stated('f1120s.k.11', 'Section 179 deduction', { operator: 'subtract', kind: 'manual', ledgerPolarity: 'debit', allocBasis: 'loss' }),
  stated('f1120s.k.12a', 'Cash charitable contributions', { operator: 'subtract', ledgerPolarity: 'debit', allocBasis: 'loss' }), stated('f1120s.k.12b', 'Noncash charitable contributions', { operator: 'subtract', ledgerPolarity: 'debit', allocBasis: 'loss' }),
  stated('f1120s.k.12c', 'Investment interest expense', { operator: 'subtract', ledgerPolarity: 'debit', allocBasis: 'loss' }), stated('f1120s.k.12d', 'Section 59(e)(2) expenditures', { operator: 'subtract', ledgerPolarity: 'debit', allocBasis: 'loss' }),
  statement('f1120s.k.12e', 'Other deductions', { operator: 'subtract', cls: 'separately_stated', ledgerPolarity: 'debit', allocBasis: 'loss' }),
  stated('f1120s.k.13a', 'Low-income housing credit (section 42(j)(5))', { kind: 'manual', allocBasis: 'profit' }), stated('f1120s.k.13b', 'Low-income housing credit (other)', { kind: 'manual', allocBasis: 'profit' }),
  stated('f1120s.k.13c', 'Qualified rehabilitation expenditures (rental real estate)', { kind: 'manual', allocBasis: 'profit' }), stated('f1120s.k.13d', 'Other rental real estate credits', { kind: 'manual', allocBasis: 'profit' }),
  stated('f1120s.k.13e', 'Other rental credits', { kind: 'manual', allocBasis: 'profit' }), stated('f1120s.k.13f', 'Biofuel producer credit', { kind: 'manual', allocBasis: 'profit' }),
  stated('f1120s.k.13g', 'Other credits', { kind: 'manual', allocBasis: 'profit' }),
  info('f1120s.k.14a', 'Schedule K-2 attached', { type: 'checkbox' }), info('f1120s.k.14b', 'Qualified for exception to filing Schedule K-2', { type: 'checkbox' }),
  // AMT items follow the regular-tax item they adjust: depreciation, depletion and oil-and-gas deductions by loss; gain and gross income by profit.
  stated('f1120s.k.15a', 'Post-1986 depreciation adjustment', { kind: 'manual', allocBasis: 'loss' }), stated('f1120s.k.15b', 'Adjusted gain or loss', { kind: 'manual', allocBasis: 'profit' }),
  stated('f1120s.k.15c', 'Depletion (other than oil and gas)', { kind: 'manual', allocBasis: 'loss' }),
  stated('f1120s.k.15d', 'Oil, gas, and geothermal properties: gross income', { kind: 'manual', allocBasis: 'profit' }),
  stated('f1120s.k.15e', 'Oil, gas, and geothermal properties: deductions', { kind: 'manual', allocBasis: 'loss' }), statement('f1120s.k.15f', 'Other AMT items', { cls: 'separately_stated', allocBasis: 'profit' }),
  stated('f1120s.k.16a', 'Tax-exempt interest income', { allocBasis: 'profit' }), stated('f1120s.k.16b', 'Other tax-exempt income', { allocBasis: 'profit' }),
  stated('f1120s.k.16c', 'Nondeductible expenses', { ledgerPolarity: 'debit', allocBasis: 'loss' }),
  stated('f1120s.k.16d', 'Distributions', { ledgerPolarity: 'debit', instanceDims: ['interest'] }), stated('f1120s.k.16e', 'Repayment of loans from shareholders', { ledgerPolarity: 'debit', instanceDims: ['interest'] }),
  stated('f1120s.k.16f', 'Foreign taxes paid or accrued', { operator: 'subtract', ledgerPolarity: 'debit', allocBasis: 'loss' }),
  stated('f1120s.k.17a', 'Investment income', { kind: 'computed', formula: sum('f1120s.k.4', 'f1120s.k.5a', 'f1120s.k.6', 'f1120s.k.10_inv'), allocBasis: 'profit' }),
  stated('f1120s.k.17b', 'Investment expenses', { ledgerPolarity: 'debit', allocBasis: 'loss' }),
  stated('f1120s.k.17c', 'Dividend distributions paid from accumulated earnings and profits', { ledgerPolarity: 'debit' }),
  statement('f1120s.k.17d', 'Other items and amounts', { cls: 'separately_stated', allocBasis: 'profit' }),
  // Line 17 ends at 17d. Section 199A information (code V) is a K-1 box 17 code (k1_1120s.box.17V) that T4 produces per trade or business
  // (spec §13.1: Statement A components, W-2 wages, UBIA, lower-tier items). It is not a Schedule K line computed from line 1: QBI is not ordinary
  // business income once a K-1 payer's income reaches line 1 through page 1 line 5 (§4.9), a computed line is never an adjustment destination (§4.6),
  // and T1 computes no tax.
  computed('f1120s.k.18', 'Income (loss) reconciliation', sumMinus(['f1120s.k.1', 'f1120s.k.2', 'f1120s.k.3c', 'f1120s.k.4', 'f1120s.k.5a', 'f1120s.k.6', 'f1120s.k.7', 'f1120s.k.8a', 'f1120s.k.9', 'f1120s.k.10'],
    ['f1120s.k.11', 'f1120s.k.12a', 'f1120s.k.12b', 'f1120s.k.12c', 'f1120s.k.12d', 'f1120s.k.12e', 'f1120s.k.16f']), { cls: 'income' }),
]);

// Schedule L — balance sheets per books. Each line has begin and end measurements (the engine asks for both).
const L = [
  asset('f1120s.L.1', 'Cash'), asset('f1120s.L.2a', 'Trade notes and accounts receivable'), contra('f1120s.L.2b', 'Less allowance for bad debts', { printedPolarity: 'negative' }), asset('f1120s.L.3', 'Inventories'),
  asset('f1120s.L.4', 'U.S. Government obligations'), asset('f1120s.L.5', 'Tax-exempt securities'), statement('f1120s.L.6', 'Other current assets', { cls: 'balance', ledgerPolarity: 'debit' }),
  asset('f1120s.L.7', 'Loans to shareholders', { instanceDims: ['interest'] }), asset('f1120s.L.8', 'Mortgage and real estate loans'), statement('f1120s.L.9', 'Other investments', { cls: 'balance', ledgerPolarity: 'debit' }),
  asset('f1120s.L.10a', 'Buildings and other depreciable assets'), contra('f1120s.L.10b', 'Less accumulated depreciation', { printedPolarity: 'negative' }), asset('f1120s.L.11a', 'Depletable assets'), contra('f1120s.L.11b', 'Less accumulated depletion', { printedPolarity: 'negative' }),
  asset('f1120s.L.12', 'Land (net of any amortization)'), asset('f1120s.L.13a', 'Intangible assets (amortizable only)'), contra('f1120s.L.13b', 'Less accumulated amortization', { printedPolarity: 'negative' }),
  statement('f1120s.L.14', 'Other assets', { cls: 'balance', ledgerPolarity: 'debit' }),
  computed('f1120s.L.15', 'Total assets', sumMinus(['f1120s.L.1', 'f1120s.L.2a', 'f1120s.L.3', 'f1120s.L.4', 'f1120s.L.5', 'f1120s.L.6', 'f1120s.L.7', 'f1120s.L.8', 'f1120s.L.9', 'f1120s.L.10a', 'f1120s.L.11a', 'f1120s.L.12', 'f1120s.L.13a', 'f1120s.L.14'],
    ['f1120s.L.2b', 'f1120s.L.10b', 'f1120s.L.11b', 'f1120s.L.13b']), { aggregates: ['interest'], cls: 'balance' }),
  liability('f1120s.L.16', 'Accounts payable'), liability('f1120s.L.17', 'Mortgages, notes, bonds payable in less than 1 year'), statement('f1120s.L.18', 'Other current liabilities', { cls: 'balance', ledgerPolarity: 'credit' }),
  liability('f1120s.L.19', 'Loans from shareholders', { instanceDims: ['interest'] }), liability('f1120s.L.20', 'Mortgages, notes, bonds payable in 1 year or more'), statement('f1120s.L.21', 'Other liabilities', { cls: 'balance', ledgerPolarity: 'credit' }),
  liability('f1120s.L.22', 'Capital stock', { taxact: 'B/S-Liabs/Eq.: Capital Stock' }), liability('f1120s.L.23', 'Additional paid-in capital'),
  // Line 24 is book retained earnings bound from the equity accounts, never total assets less everything else (spec §5.2 "equity is never
  // plugged"). L.15 and L.27 are computed from different inputs, so the engine's "Schedule L unbalanced" error (§5.8) can fire and an unbound
  // balance account cannot hide in retained earnings. No TaxAct key: its 1120S import marks retained earnings "requires manual entry".
  liability('f1120s.L.24', 'Retained earnings (per books)'),
  liability('f1120s.L.25', 'Adjustments to shareholders’ equity'),
  // Treasury stock is a contra-equity account, so it normally carries a debit balance (contra()'s default side is the credit of a contra asset).
  contra('f1120s.L.26', 'Less cost of treasury stock', { printedPolarity: 'negative', ledgerPolarity: 'debit' }),
  computed('f1120s.L.27', 'Total liabilities and shareholders’ equity', sumMinus(['f1120s.L.16', 'f1120s.L.17', 'f1120s.L.18', 'f1120s.L.19', 'f1120s.L.20', 'f1120s.L.21', 'f1120s.L.22', 'f1120s.L.23', 'f1120s.L.24', 'f1120s.L.25'], ['f1120s.L.26']), { aggregates: ['interest'], cls: 'balance' }),
];

// Schedule M-1 — the bridge classes are produced by the engine (spec §5.5); these are the presentation lines. Line 8 must equal Schedule K line 18.
const M1 = [
  stated('f1120s.m1.1', 'Net income (loss) per books', { kind: 'computed', formula: sum('books.ni.total') }),
  statement('f1120s.m1.2', 'Income on Schedule K lines 1–10 not recorded on books this year', { cls: 'separately_stated' }),
  stated('f1120s.m1.3a', 'Expenses on books not on Schedule K: depreciation', { kind: 'computed', formula: sum('bridge.m1.dep_addback') }),
  stated('f1120s.m1.3b', 'Expenses on books not on Schedule K: travel and entertainment', { kind: 'computed', formula: sum('bridge.m1.meals_addback') }),
  statement('f1120s.m1.3c', 'Expenses on books not on Schedule K: other', { cls: 'separately_stated' }),
  computed('f1120s.m1.4', 'Add lines 1 through 3', sum('f1120s.m1.1', 'f1120s.m1.2', 'f1120s.m1.3a', 'f1120s.m1.3b', 'f1120s.m1.3c'), { cls: 'income' }),
  // The tax-exempt interest the BOOKS record this year (the engine's bridge, T3), not Schedule K line 16a (see the 1065's line 6a).
  stated('f1120s.m1.5a', 'Income on books not on Schedule K: tax-exempt interest', { kind: 'computed', formula: sum('bridge.m1.exempt_books') }), statement('f1120s.m1.5b', 'Income on books not on Schedule K: other', { cls: 'separately_stated' }),
  stated('f1120s.m1.6a', 'Deductions on Schedule K not charged against book income: depreciation', { kind: 'computed', formula: sum('bridge.m1.dep_deduct') }), statement('f1120s.m1.6b', 'Deductions on Schedule K not charged against book income: other', { cls: 'separately_stated' }),
  computed('f1120s.m1.7', 'Add lines 5 and 6', sum('f1120s.m1.5a', 'f1120s.m1.5b', 'f1120s.m1.6a', 'f1120s.m1.6b'), { operator: 'subtract', cls: 'income' }),
  computed('f1120s.m1.8', 'Income (loss) (Schedule K, line 18)', minus('f1120s.m1.4', 'f1120s.m1.7'), { cls: 'income' }),
];

// M-2: four columns numbered 1-8 as the form prints them (page 5), each carrying only the cells the form has; the others are grey-filled on the
// IRS PDF. Ordinary income (2) and loss (4) from page 1, line 22 reach only column (a) AAA; other additions (3) and other reductions (5) reach
// (a) and (d) OAA; the opening balance (1), line 6, distributions (7) and the closing balance (8) are in all four. A slot for a cell the form
// lacks would be a required manual item no page prints, and an amount entered there would flow through line 6 into a balance the form never
// shows. Line 6 combines the lines its column has. The ordered AAA rule (spec §5.6) is computed in T4; here only the presentation.
const M2_ENTERED = { 1: 'balance at beginning of tax year', 2: 'ordinary income from page 1, line 22', 3: 'other additions', 4: 'loss from page 1, line 22', 5: 'other reductions', 7: 'distributions' };
// Sign facts (spec §5.1), as the TY2025 page prints them: the loss (4) and other reductions (5) are stored as positive reductions that line 6
// subtracts, and their cells print in parentheses; distributions (7) are a positive reduction line 8 subtracts, printed without parentheses.
const M2_SIGN = { 4: { semantic: 'reduction', operator: 'subtract', printedPolarity: 'negative' }, 5: { semantic: 'reduction', operator: 'subtract', printedPolarity: 'negative' },
  7: { semantic: 'reduction', operator: 'subtract' } };
const m2 = (col, label, lines) => {
  const id = n => `f1120s.m2.${col}.${n}`;
  const adds = [1, 2, 3].filter(n => lines.includes(n)).map(id), subs = [4, 5].filter(n => lines.includes(n)).map(id);
  // Measured once per year like the amounts they combine (Tax Books T3 formula validation), not as beginning and ending balances.
  return lines.map(n => n === 6 ? computed(id(6), `${label}: combine lines 1 through 5`, subs.length ? sumMinus(adds, subs) : sum(...adds), { cls: 'separately_stated' })
    : n === 8 ? computed(id(8), `${label}: balance at end of tax year`, minus(id(6), id(7)), { cls: 'separately_stated' })
    : stated(id(n), `${label}: ${M2_ENTERED[n]}`, { kind: 'manual', ...M2_SIGN[n] }));
};
const M2 = [...m2('aaa', 'Accumulated adjustments account', [1, 2, 3, 4, 5, 6, 7, 8]), ...m2('pti', 'Shareholders’ undistributed taxable income previously taxed', [1, 6, 7, 8]),
  ...m2('aep', 'Accumulated earnings and profits', [1, 6, 7, 8]), ...m2('oaa', 'Other adjustments account', [1, 3, 5, 6, 7, 8])];

// Engine-owned inputs the formulas above name (filled by T3/T4 workpapers; declared here so the catalog is closed).
const ENGINE = [stated('books.ni.total', 'Net income per books', { kind: 'manual' }), stated('bridge.m1.dep_addback', 'Book depreciation over tax', { kind: 'manual' }),
  stated('bridge.m1.meals_addback', 'Nondeductible meals and entertainment', { kind: 'manual' }), stated('bridge.m1.dep_deduct', 'Tax depreciation over book', { kind: 'manual' }),
  stated('bridge.m1.exempt_books', 'Tax-exempt interest recorded on the books', { kind: 'manual' })];
export const LINES = [...P1, ...K, ...L, ...M1, ...M2, ...ENGINE];
