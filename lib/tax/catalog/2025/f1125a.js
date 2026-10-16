// lib/tax/catalog/2025/f1125a.js — Form 1125-A Cost of Goods Sold (Nov 2024 revision, used for TY2025). One instance per activity.
import { deduction, computed, info, sum, minus } from './shared.js';
export const LINES = [
  // No TaxAct key: its only inventory tax line, 'B/S-Assets: Inventories', is the ending balance (carried by f1065.L.3), so beginning inventory is entered by hand.
  deduction('f1125a.main.1', 'Inventory at beginning of year', { instanceDims: ['activity'] }),
  deduction('f1125a.main.2', 'Purchases', { instanceDims: ['activity'], taxact: 'COGS: Purchases' }),
  deduction('f1125a.main.3', 'Cost of labor', { instanceDims: ['activity'], taxact: 'COGS: Cost of labor' }),
  deduction('f1125a.main.4', 'Additional section 263A costs', { instanceDims: ['activity'], taxact: 'COGS: Additional section 263A costs' }),
  deduction('f1125a.main.5', 'Other costs', { instanceDims: ['activity'], kind: 'statement', type: 'statement', taxact: 'COGS: Other costs' }),
  computed('f1125a.main.6', 'Total', sum('f1125a.main.1', 'f1125a.main.2', 'f1125a.main.3', 'f1125a.main.4', 'f1125a.main.5'), { instanceDims: ['activity'], cls: 'deduction' }),
  deduction('f1125a.main.7', 'Inventory at end of year', { instanceDims: ['activity'], semantic: 'reduction', operator: 'subtract' }),
  computed('f1125a.main.8', 'Cost of goods sold', minus('f1125a.main.6', 'f1125a.main.7'), { instanceDims: ['activity'], cls: 'deduction' }),
  info('f1125a.main.9a', 'Inventory method (cost / lower of cost or market / other)'), info('f1125a.main.9e', 'Section 263A rules apply', { type: 'checkbox' }),
];
