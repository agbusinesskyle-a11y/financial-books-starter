// lib/tax/catalog/2025/f1040.js — the 2025 Form 1040 schedules a set of books can feed (clean-room), numbered as the TY2025 forms are (checked against the IRS PDFs with
// scripts/tax-catalog-check.py). Schedules C, E Part I and F are kept per activity, Schedule E Part II per K-1 source, and computed lines are formulas over those
// instances. Identity lines (business name, EIN, address) come from the party and activity records, so they are not lines here.
import { income, deduction, computed, statement, stated, info, sum, minus, sumMinus } from './shared.js';
const A = { instanceDims: ['activity'] };
const inc = (id, l, o = {}) => income(id, l, { ...A, ...o }), ded = (id, l, o = {}) => deduction(id, l, { ...A, ...o });
// A per-activity result: the formula PRESERVES the activity (one Schedule C/E/F result per activity, Codex t1-r1 B2); a total across activities
// is a separate line that declares it aggregates them (Schedule 1 line 3 below).
const comp = (id, l, f, o = {}) => computed(id, l, f, { ...A, ...o });

export const SCHEDULE_C = [
  info('f1040.c.A', 'Principal business or profession', A), info('f1040.c.B', 'Business code', A), info('f1040.c.F', 'Accounting method', A), info('f1040.c.G', 'Materially participated', { ...A, type: 'checkbox' }),
  info('f1040.c.I', 'Payments requiring Form(s) 1099', { ...A, type: 'checkbox' }), info('f1040.c.J', 'Filed required Form(s) 1099', { ...A, type: 'checkbox' }),
  inc('f1040.c.1', 'Gross receipts or sales'), inc('f1040.c.2', 'Returns and allowances', { ledgerPolarity: 'debit', semantic: 'reduction', operator: 'subtract' }),
  comp('f1040.c.3', 'Subtract line 2 from line 1', minus('f1040.c.1', 'f1040.c.2'), { cls: 'income' }), comp('f1040.c.4', 'Cost of goods sold (line 42)', sum('f1040.c.42'), { operator: 'subtract', cls: 'deduction' }),
  comp('f1040.c.5', 'Gross profit', minus('f1040.c.3', 'f1040.c.4'), { cls: 'income' }), statement('f1040.c.6', 'Other income', { cls: 'income', ...A }),
  comp('f1040.c.7', 'Gross income', sum('f1040.c.5', 'f1040.c.6'), { cls: 'income' }),
  ded('f1040.c.8', 'Advertising'), ded('f1040.c.9', 'Car and truck expenses', { kind: 'manual' }), ded('f1040.c.10', 'Commissions and fees'), ded('f1040.c.11', 'Contract labor'), ded('f1040.c.12', 'Depletion'),
  ded('f1040.c.13', 'Depreciation and section 179 (Form 4562)', { sourceDims: ['asset'], kind: 'manual' }), ded('f1040.c.14', 'Employee benefit programs'), ded('f1040.c.15', 'Insurance (other than health)'),
  ded('f1040.c.16a', 'Interest: mortgage (paid to banks)'), ded('f1040.c.16b', 'Interest: other'), ded('f1040.c.17', 'Legal and professional services'), ded('f1040.c.18', 'Office expense'),
  ded('f1040.c.19', 'Pension and profit-sharing plans'), ded('f1040.c.20a', 'Rent or lease: vehicles, machinery, equipment'), ded('f1040.c.20b', 'Rent or lease: other business property'),
  ded('f1040.c.21', 'Repairs and maintenance'), ded('f1040.c.22', 'Supplies'), ded('f1040.c.23', 'Taxes and licenses'), ded('f1040.c.24a', 'Travel'), ded('f1040.c.24b', 'Deductible meals'),
  ded('f1040.c.25', 'Utilities'), ded('f1040.c.26', 'Wages (less employment credits)'),
  // TY2025 line 27: 27a is the Form 7205 deduction and 27b the other expenses (Part V, line 48); line 28 adds lines 8 through 27b.
  ded('f1040.c.27a', 'Energy efficient commercial buildings deduction (Form 7205)', { kind: 'manual' }),
  statement('f1040.c.27b', 'Other expenses (line 48)', { cls: 'deduction', ledgerPolarity: 'debit', ...A }),
  comp('f1040.c.28', 'Total expenses', sum('f1040.c.8', 'f1040.c.9', 'f1040.c.10', 'f1040.c.11', 'f1040.c.12', 'f1040.c.13', 'f1040.c.14', 'f1040.c.15', 'f1040.c.16a', 'f1040.c.16b', 'f1040.c.17', 'f1040.c.18', 'f1040.c.19', 'f1040.c.20a', 'f1040.c.20b', 'f1040.c.21', 'f1040.c.22', 'f1040.c.23', 'f1040.c.24a', 'f1040.c.24b', 'f1040.c.25', 'f1040.c.26', 'f1040.c.27a', 'f1040.c.27b'), { operator: 'subtract', cls: 'deduction' }),
  comp('f1040.c.29', 'Tentative profit or (loss)', minus('f1040.c.7', 'f1040.c.28'), { cls: 'income' }), ded('f1040.c.30', 'Expenses for business use of your home', { operator: 'subtract', kind: 'manual' }),
  comp('f1040.c.31', 'Net profit or (loss)', minus('f1040.c.29', 'f1040.c.30'), { cls: 'income' }),
  info('f1040.c.32a', 'All investment is at risk', { ...A, type: 'checkbox' }), info('f1040.c.32b', 'Some investment is not at risk', { ...A, type: 'checkbox' }),
  info('f1040.c.33', 'Method used to value closing inventory', A), ded('f1040.c.35', 'Inventory at beginning of year'), ded('f1040.c.36', 'Purchases less cost of items withdrawn for personal use'),
  ded('f1040.c.37', 'Cost of labor'), ded('f1040.c.38', 'Materials and supplies'), ded('f1040.c.39', 'Other costs'),
  comp('f1040.c.40', 'Add lines 35 through 39', sum('f1040.c.35', 'f1040.c.36', 'f1040.c.37', 'f1040.c.38', 'f1040.c.39'), { cls: 'deduction' }),
  ded('f1040.c.41', 'Inventory at end of year', { semantic: 'reduction', operator: 'subtract' }), comp('f1040.c.42', 'Cost of goods sold', minus('f1040.c.40', 'f1040.c.41'), { cls: 'deduction' }),
];
export const SCHEDULE_E1 = [ // Part I, one property per activity
  info('f1040.e1.1a', 'Physical address of property', A), info('f1040.e1.1b', 'Type of property', A), info('f1040.e1.2_fair', 'Fair rental days', A), info('f1040.e1.2_personal', 'Personal use days', A),
  inc('f1040.e1.3', 'Rents received'), inc('f1040.e1.4', 'Royalties received'),
  ded('f1040.e1.5', 'Advertising'), ded('f1040.e1.6', 'Auto and travel'), ded('f1040.e1.7', 'Cleaning and maintenance'), ded('f1040.e1.8', 'Commissions'), ded('f1040.e1.9', 'Insurance'),
  ded('f1040.e1.10', 'Legal and other professional fees'), ded('f1040.e1.11', 'Management fees'), ded('f1040.e1.12', 'Mortgage interest paid to banks, etc.'), ded('f1040.e1.13', 'Other interest'),
  ded('f1040.e1.14', 'Repairs'), ded('f1040.e1.15', 'Supplies'), ded('f1040.e1.16', 'Taxes'), ded('f1040.e1.17', 'Utilities'), ded('f1040.e1.18', 'Depreciation expense or depletion', { sourceDims: ['asset'], kind: 'manual' }),
  statement('f1040.e1.19', 'Other', { cls: 'deduction', ledgerPolarity: 'debit', ...A }),
  comp('f1040.e1.20', 'Total expenses', sum('f1040.e1.5', 'f1040.e1.6', 'f1040.e1.7', 'f1040.e1.8', 'f1040.e1.9', 'f1040.e1.10', 'f1040.e1.11', 'f1040.e1.12', 'f1040.e1.13', 'f1040.e1.14', 'f1040.e1.15', 'f1040.e1.16', 'f1040.e1.17', 'f1040.e1.18', 'f1040.e1.19'), { operator: 'subtract', cls: 'deduction' }),
  comp('f1040.e1.21', 'Income or (loss) before the loss limitation', sumMinus(['f1040.e1.3', 'f1040.e1.4'], ['f1040.e1.20']), { cls: 'income' }),
  stated('f1040.e1.22', 'Deductible rental real estate loss after limitation (Form 8582)', { ledgerPolarity: 'debit', semantic: 'reduction', operator: 'subtract', printedPolarity: 'negative', kind: 'manual', ...A }),
];
const K = { instanceDims: ['k1_source'] };
export const SCHEDULE_E2 = [ // Part II, one row per K-1 received
  info('f1040.e2.28a', 'Name', K), info('f1040.e2.28b', 'Partnership or S corporation', K), info('f1040.e2.28e', 'Basis computation required', { ...K, type: 'checkbox' }), info('f1040.e2.28f', 'Not at risk', { ...K, type: 'checkbox' }),
  stated('f1040.e2.28g', 'Passive loss allowed (Form 8582)', { kind: 'manual', ledgerPolarity: 'debit', ...K }), stated('f1040.e2.28h', 'Passive income', K),
  stated('f1040.e2.28i', 'Nonpassive loss allowed', { kind: 'manual', ledgerPolarity: 'debit', ...K }), stated('f1040.e2.28j', 'Section 179 expense deduction', { ledgerPolarity: 'debit', ...K }), stated('f1040.e2.28k', 'Nonpassive income', K),
  // Lines 29a and 29b are the column-totals rows; 30 and 31 add them across (31 prints in parentheses, so the losses are stored positive and 32 subtracts it).
  computed('f1040.e2.30', 'Add columns (h) and (k) of line 29a', sum('f1040.e2.28h', 'f1040.e2.28k'), { aggregates: ['k1_source'], cls: 'income' }),
  computed('f1040.e2.31', 'Add columns (g), (i), and (j) of line 29b', sum('f1040.e2.28g', 'f1040.e2.28i', 'f1040.e2.28j'), { aggregates: ['k1_source'], operator: 'subtract', semantic: 'reduction', printedPolarity: 'negative', cls: 'deduction' }),
  computed('f1040.e2.32', 'Total partnership and S corporation income or (loss)', minus('f1040.e2.30', 'f1040.e2.31'), { cls: 'income' }),
];
export const SCHEDULE_F = [
  info('f1040.f.A', 'Principal crop or activity', A), info('f1040.f.B', 'Activity code', A), info('f1040.f.C', 'Accounting method', A), info('f1040.f.E', 'Materially participated', { ...A, type: 'checkbox' }),
  inc('f1040.f.1a', 'Sales of purchased livestock and other resale items'), ded('f1040.f.1b', 'Cost or other basis of purchased livestock or other items', { semantic: 'reduction', operator: 'subtract' }),
  comp('f1040.f.1c', 'Subtract line 1b from line 1a', minus('f1040.f.1a', 'f1040.f.1b'), { cls: 'income' }), inc('f1040.f.2', 'Sales of livestock, produce, grains, and other products you raised'),
  inc('f1040.f.3a', 'Cooperative distributions'), inc('f1040.f.3b', 'Cooperative distributions: taxable amount', { kind: 'manual' }), inc('f1040.f.4a', 'Agricultural program payments'), inc('f1040.f.4b', 'Agricultural program payments: taxable amount', { kind: 'manual' }),
  inc('f1040.f.5a', 'CCC loans reported under election'), inc('f1040.f.5b', 'CCC loans forfeited'), inc('f1040.f.5c', 'CCC loans forfeited: taxable amount', { kind: 'manual' }),
  inc('f1040.f.6a', 'Crop insurance proceeds and federal crop disaster payments'), inc('f1040.f.6b', 'Crop insurance: taxable amount', { kind: 'manual' }), inc('f1040.f.6d', 'Amount deferred from the prior year', { kind: 'manual' }),
  inc('f1040.f.7', 'Custom hire (machine work) income'), statement('f1040.f.8', 'Other income', { cls: 'income', ...A }),
  // Line 9: the cash-method lines, or for an accrual-method farm "the amount from Part III, line 50". A farm uses one method, so the other side's slots must be marked
  // not_applicable, never zero (spec §4.7): Part III for a cash-method farm, Part I lines 1a-8 (with the typed 3b, 4b, 5c, 6b, 6d) for an accrual one (T3/T8; like c.4 reading c.42).
  comp('f1040.f.9', 'Gross income', sum('f1040.f.1c', 'f1040.f.2', 'f1040.f.3b', 'f1040.f.4b', 'f1040.f.5a', 'f1040.f.5c', 'f1040.f.6b', 'f1040.f.6d', 'f1040.f.7', 'f1040.f.8', 'f1040.f.50'), { cls: 'income' }),
  ded('f1040.f.10', 'Car and truck expenses', { kind: 'manual' }), ded('f1040.f.11', 'Chemicals'), ded('f1040.f.12', 'Conservation expenses'), ded('f1040.f.13', 'Custom hire (machine work)'), ded('f1040.f.14', 'Depreciation and section 179', { sourceDims: ['asset'], kind: 'manual' }),
  ded('f1040.f.15', 'Employee benefit programs'), ded('f1040.f.16', 'Feed'), ded('f1040.f.17', 'Fertilizers and lime'), ded('f1040.f.18', 'Freight and trucking'), ded('f1040.f.19', 'Gasoline, fuel, and oil'), ded('f1040.f.20', 'Insurance (other than health)'),
  ded('f1040.f.21a', 'Interest: mortgage (paid to banks)'), ded('f1040.f.21b', 'Interest: other'), ded('f1040.f.22', 'Labor hired (less employment credits)'), ded('f1040.f.23', 'Pension and profit-sharing plans'),
  ded('f1040.f.24a', 'Rent or lease: vehicles, machinery, equipment'), ded('f1040.f.24b', 'Rent or lease: other (land, animals, etc.)'), ded('f1040.f.25', 'Repairs and maintenance'), ded('f1040.f.26', 'Seeds and plants'),
  ded('f1040.f.27', 'Storage and warehousing'), ded('f1040.f.28', 'Supplies'), ded('f1040.f.29', 'Taxes'), ded('f1040.f.30', 'Utilities'), ded('f1040.f.31', 'Veterinary, breeding, and medicine'),
  statement('f1040.f.32', 'Other expenses', { cls: 'deduction', ledgerPolarity: 'debit', ...A }),
  comp('f1040.f.33', 'Total expenses', sum('f1040.f.10', 'f1040.f.11', 'f1040.f.12', 'f1040.f.13', 'f1040.f.14', 'f1040.f.15', 'f1040.f.16', 'f1040.f.17', 'f1040.f.18', 'f1040.f.19', 'f1040.f.20', 'f1040.f.21a', 'f1040.f.21b', 'f1040.f.22', 'f1040.f.23', 'f1040.f.24a', 'f1040.f.24b', 'f1040.f.25', 'f1040.f.26', 'f1040.f.27', 'f1040.f.28', 'f1040.f.29', 'f1040.f.30', 'f1040.f.31', 'f1040.f.32'), { operator: 'subtract', cls: 'deduction' }),
  comp('f1040.f.34', 'Net farm profit or (loss)', minus('f1040.f.9', 'f1040.f.33'), { cls: 'income' }),
  info('f1040.f.36a', 'All investment is at risk', { ...A, type: 'checkbox' }), info('f1040.f.36b', 'Some investment is not at risk', { ...A, type: 'checkbox' }),
  // Part III, accrual method. Line 44 adds the income lines 37, 38b, 39b, 40a, 40c, 41, 42 and 43; line 50 is 44 less the cost of products sold (49). Under the
  // unit-livestock-price or farm-price method the form prints 48 less 47 on line 49 when 48 is larger and adds it on line 50: line 44 less a negative 49, the same total.
  inc('f1040.f.37', 'Accrual: sales of livestock, produce, grains, and other products'),
  inc('f1040.f.38a', 'Accrual: cooperative distributions'), inc('f1040.f.38b', 'Accrual: cooperative distributions: taxable amount', { kind: 'manual' }),
  inc('f1040.f.39a', 'Accrual: agricultural program payments'), inc('f1040.f.39b', 'Accrual: agricultural program payments: taxable amount', { kind: 'manual' }),
  inc('f1040.f.40a', 'Accrual: CCC loans reported under election'), inc('f1040.f.40b', 'Accrual: CCC loans forfeited'), inc('f1040.f.40c', 'Accrual: CCC loans forfeited: taxable amount', { kind: 'manual' }),
  inc('f1040.f.41', 'Accrual: crop insurance proceeds'), inc('f1040.f.42', 'Accrual: custom hire (machine work) income'), statement('f1040.f.43', 'Accrual: other income', { cls: 'income', ...A }),
  comp('f1040.f.44', 'Accrual: add lines 37 through 43', sum('f1040.f.37', 'f1040.f.38b', 'f1040.f.39b', 'f1040.f.40a', 'f1040.f.40c', 'f1040.f.41', 'f1040.f.42', 'f1040.f.43'), { cls: 'income' }),
  ded('f1040.f.45', 'Accrual: inventory at beginning of year'), ded('f1040.f.46', 'Accrual: cost of livestock, produce, grains purchased'),
  comp('f1040.f.47', 'Accrual: add lines 45 and 46', sum('f1040.f.45', 'f1040.f.46'), { cls: 'deduction' }), ded('f1040.f.48', 'Accrual: inventory at end of year', { semantic: 'reduction', operator: 'subtract' }),
  comp('f1040.f.49', 'Accrual: cost of products sold', minus('f1040.f.47', 'f1040.f.48'), { operator: 'subtract', cls: 'deduction' }), comp('f1040.f.50', 'Accrual: gross income', minus('f1040.f.44', 'f1040.f.49'), { cls: 'income' }),
];
// Schedule B, Schedule D and Form 4797 summaries (the household's own and what K-1s route here). Mixed-source lines (Codex t1-r1 B2, ruling (a)):
// Schedule B lines 1 and 5 and Form 4797 line 2 take the household's or a portfolio activity's own amounts as a member with no source dimension
// (books or manual, one provider) and each K-1's amount as a further member keyed by k1_source (its own provider), so one destination holds
// both without one provider owning the other's amount. k1_source is an ALLOWED source dimension there, not a required one; Schedule D lines
// 5 and 12 exist only for K-1 amounts, so every member there must name its K-1 (sourceRequired). A disregarded portfolio activity binds its
// books here too (spec §4.2, §4.4: the disregarded catalog carries PORTFOLIO).
export const PORTFOLIO = [
  stated('f1040.b.1', 'Interest income (by payer)', { sourceDims: ['k1_source'], kind: 'statement', type: 'statement' }), computed('f1040.b.2', 'Total interest', sum('f1040.b.1'), { cls: 'income' }),
  stated('f1040.b.5', 'Ordinary dividends (by payer)', { sourceDims: ['k1_source'], kind: 'statement', type: 'statement' }), computed('f1040.b.6', 'Total ordinary dividends', sum('f1040.b.5'), { cls: 'income' }),
  // Schedule D. Broker detail (Form 1099-B and Form 8949) is a typed summary (spec §2): d.1b stands for the totals of lines 1a, 1b, 2 and 3 and d.8b for 8a, 8b, 9 and 10.
  // Every feeder the household types (1b, 4, 6, 8b, 11, 13, 14) is a manual item; only lines 5 and 12 take K-1 amounts. Lines 7 and 15 combine every feeder the catalog
  // carries; the loss carryovers (6, 14) are printed in parentheses, so they are stored as positive reductions and subtracted.
  stated('f1040.d.1b', 'Short-term transactions: Form 1099-B and Form 8949 totals (lines 1a, 1b, 2 and 3)', { kind: 'manual' }),
  stated('f1040.d.4', 'Short-term gain from Form 6252 and short-term gain or (loss) from Forms 4684, 6781, and 8824', { kind: 'manual' }),
  stated('f1040.d.5', 'Net short-term gain or (loss) from partnerships, S corporations, estates, and trusts', { sourceDims: ['k1_source'], sourceRequired: true }),
  stated('f1040.d.6', 'Short-term capital loss carryover', { printedPolarity: 'negative', kind: 'manual', ledgerPolarity: 'debit', semantic: 'reduction', operator: 'subtract' }),
  computed('f1040.d.7', 'Net short-term capital gain or (loss)', sumMinus(['f1040.d.1b', 'f1040.d.4', 'f1040.d.5'], ['f1040.d.6']), { cls: 'income' }),
  stated('f1040.d.8b', 'Long-term transactions: Form 1099-B and Form 8949 totals (lines 8a, 8b, 9 and 10)', { kind: 'manual' }),
  stated('f1040.d.11', 'Gain from Form 4797, Part I; long-term gain from Forms 2439 and 6252; long-term gain or (loss) from Forms 4684, 6781, and 8824', { kind: 'manual' }),
  stated('f1040.d.12', 'Net long-term gain or (loss) from partnerships, S corporations, estates, and trusts', { sourceDims: ['k1_source'], sourceRequired: true }),
  stated('f1040.d.13', 'Capital gain distributions', { kind: 'manual' }),
  stated('f1040.d.14', 'Long-term capital loss carryover', { printedPolarity: 'negative', kind: 'manual', ledgerPolarity: 'debit', semantic: 'reduction', operator: 'subtract' }),
  computed('f1040.d.15', 'Net long-term capital gain or (loss)', sumMinus(['f1040.d.8b', 'f1040.d.11', 'f1040.d.12', 'f1040.d.13'], ['f1040.d.14']), { cls: 'income' }),
  stated('f4797.main.2', 'Section 1231 gains from K-1s and dispositions', { sourceDims: ['k1_source', 'asset'] }),
];
// Schedule 1 (Form 1040) line 3: business income or (loss), the explicit total of every activity's Schedule C line 31 (one result per activity).
export const SCHEDULE_1 = [computed('f1040.s1.3', 'Business income or (loss) (Schedule C line 31, all activities)', sum('f1040.c.31'), { cls: 'income', aggregates: ['activity'] })];
export const INFO_8995 = [stated('f8995.info.qbi', 'Qualified business income by activity', { instanceDims: ['activity'] }), stated('f8995.info.w2', 'W-2 wages by activity', { instanceDims: ['activity'] }), stated('f8995.info.ubia', 'UBIA of qualified property by activity', { instanceDims: ['activity'] })];
