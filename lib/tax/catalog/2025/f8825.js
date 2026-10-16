// lib/tax/catalog/2025/f8825.js — Form 8825 (Rev. December 2025) Rental Real Estate Income and Expenses of a Partnership or an S Corporation. One instance per property.
// Numbered as the TY2025 form is: income 2a-2c, expenses 3-14 and 17 (15 and 16 are reserved for future use, so they are not lines here),
// per-property result 19, totals 20a/20b, net result 23 (the amount Schedule K line 2 reads).
import { income, deduction, stated, computed, info, statement, sum, minus, sumMinus } from './shared.js';
const dims = { instanceDims: ['activity'] };
export const LINES = [
  info('f8825.main.1a', 'Physical address of the property', dims), info('f8825.main.1b', 'Type of property (code 1-8)', dims), info('f8825.main.1c', 'Other information (code A-I)', dims),
  info('f8825.main.1d', 'Fair rental days', dims), info('f8825.main.1e', 'Personal-use days', dims),
  income('f8825.main.2a', 'Gross rents', dims), income('f8825.main.2b', 'Other income related to rental real estate activity', dims),
  computed('f8825.main.2c', 'Total rental real estate income for each property', sum('f8825.main.2a', 'f8825.main.2b'), { instanceDims: ['activity'], cls: 'income' }),
  deduction('f8825.main.3', 'Advertising', dims), deduction('f8825.main.4', 'Auto and travel', dims), deduction('f8825.main.5', 'Cleaning and maintenance', dims),
  deduction('f8825.main.6', 'Commissions', dims), deduction('f8825.main.7', 'Insurance', dims), deduction('f8825.main.8', 'Interest', dims),
  deduction('f8825.main.9', 'Legal and other professional fees', dims), deduction('f8825.main.10', 'Real estate taxes', dims), deduction('f8825.main.11', 'Repairs', dims),
  deduction('f8825.main.12', 'Utilities', dims), deduction('f8825.main.13', 'Wages and salaries', dims), deduction('f8825.main.14', 'Depreciation (Form 4562)', { ...dims, kind: 'manual', sourceDims: ['asset'] }),
  statement('f8825.main.17', 'Other deductions (Schedule A (Form 8825))', { cls: 'deduction', ledgerPolarity: 'debit', ...dims }),
  computed('f8825.main.18', 'Total rental real estate expenses for each property', sum('f8825.main.3', 'f8825.main.4', 'f8825.main.5', 'f8825.main.6', 'f8825.main.7', 'f8825.main.8', 'f8825.main.9', 'f8825.main.10', 'f8825.main.11', 'f8825.main.12', 'f8825.main.13', 'f8825.main.14', 'f8825.main.17'), { instanceDims: ['activity'], operator: 'subtract', cls: 'deduction' }),
  computed('f8825.main.19', 'Income or (loss) from each rental real estate property', minus('f8825.main.2c', 'f8825.main.18'), { instanceDims: ['activity'], cls: 'income' }),
  computed('f8825.main.20a', 'Total rental real estate income', sum('f8825.main.2c'), { aggregates: ['activity'], cls: 'income' }),
  computed('f8825.main.20b', 'Total rental real estate expenses', sum('f8825.main.18'), { aggregates: ['activity'], operator: 'subtract', semantic: 'reduction', printedPolarity: 'negative', cls: 'deduction' }),
  // Line 21 is a signed gain or (loss) that line 23 adds in, so it is typed like the other Form 4797 lines (f1065.p1.6, f1120s.p1.4: stated, either), not as a deduction.
  stated('f8825.main.21', 'Net gain (loss) from Form 4797 on the disposition of rental real estate property', { kind: 'manual' }),
  statement('f8825.main.22a', 'Net income (loss) from rental real estate of other partnerships, estates and trusts', { sourceDims: ['k1_source'], sourceRequired: true, cls: 'separately_stated' }),
  computed('f8825.main.23', 'Net rental real estate income (loss)', sumMinus(['f8825.main.20a', 'f8825.main.21', 'f8825.main.22a'], ['f8825.main.20b']), { cls: 'income' }),
];
