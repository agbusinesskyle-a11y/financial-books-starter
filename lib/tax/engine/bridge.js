// lib/tax/engine/bridge.js
// The M-1 bridge (spec §5.5, §13.1 T3): net income per books plus every classified difference must equal the return's own income
// reconciliation, computed independently from Schedule K (1065: Analysis of Net Income line 1; 1120-S: Schedule K line 18). Each difference is
// produced from its source, never from the residual:
//   for every destination slot   E = c·T + B, where c is the slot's coefficient in the endpoint (lib/tax/engine/formulas.js coefficient: +1
//                                for income, -1 for a deduction, 0 for a line outside the reconciliation), T the provider's amount before
//                                adjustments, and B the income and expense booked into it (debits positive, so minus its share of book net
//                                income) — zero for a books line whose amount IS the books; the method timing of the cash layer; book vs tax
//                                depreciation of a typed line beside book depreciation; tax-exempt and nondeductible book items on the lines
//                                that keep them out of the reconciliation;
//   per COGS activity           the workpaper's lines against the book cost of goods sold (cogs_tieout) and COGS inputs booked as expense;
//   not on the return           an income or expense account routed "not on the return": its whole book amount;
//   each adjustment line        c·amount, by its M-1 class.
// E > 0 adds to the M-1 (line 2 for an income line, line 4 for a deduction — 4a depreciation, 4b meals and entertainment), E < 0 subtracts
// (line 6b for an income line, line 7 for a deduction — 7a depreciation). Tax-exempt interest has ONE treatment whoever provides it: the
// reconciliation leaves the tax-exempt lines out (c = 0), so the books' own tax-exempt interest — whatever account records it, whatever
// period the return recognizes it in — is M-1 line 6a (1120-S 5a: bridge.m1.exempt_books), and nothing more: an amount only the return
// carries (recognized in another period, or added by an adjustment) is not book income and is no M-1 difference. An adjustment of class
// tax_exempt that takes book income out of the reconciliation to the tax-exempt INTEREST line lands on 6a too; other tax-exempt income (1065 K
// 18b, 1120-S K 16b) — booked there, or moved there by an adjustment — is the other-income statement (6b / 5b), never the interest line. A reclass nets to zero. Whatever is left is the residual: an
// error, never a plug. A passing bridge is not evidence of deductibility.
import { coefficient, polarityOf } from './formulas.js';
import { parseSlotKey } from '../providers.js';

// The M-1 cells of each return type: the statement lines the engine fills, the engine inputs its formulas read, the reconciliation endpoint.
export const M1 = {
  form_1065: { endpoint: 'f1065.anal.1', result: 'f1065.m1.9', rows: { '2': 'f1065.m1.2', '4c': 'f1065.m1.4c', '6b': 'f1065.m1.6b', '7b': 'f1065.m1.7b' },
    exempt: ['f1065.k.18a'], otherExempt: ['f1065.k.18b'], nondeductible: ['f1065.k.18c'], depreciation: ['f1065.p1.16a', 'f1065.p1.16b', 'f8825.main.14'] },
  form_1120s: { endpoint: 'f1120s.k.18', result: 'f1120s.m1.8', rows: { '2': 'f1120s.m1.2', '4c': 'f1120s.m1.3c', '6b': 'f1120s.m1.5b', '7b': 'f1120s.m1.6b' },
    exempt: ['f1120s.k.16a'], otherExempt: ['f1120s.k.16b'], nondeductible: ['f1120s.k.16c'], depreciation: ['f1120s.p1.14', 'f8825.main.14'] },
};
export const M1_ENGINE = { '4a': 'bridge.m1.dep_addback', '4b': 'bridge.m1.meals_addback', '7a': 'bridge.m1.dep_deduct', '6a': 'bridge.m1.exempt_books' };

// slots: [{ key, fieldId, provider, value (T, bigint | null), plCents (B), plKnown, activityId }]; notTax: [{ label, cents }]; tieouts: Map
// activityId → { cents, known, name }; deltas: [{ slotKey, cents, m1Class, label }]; unknown: reasons that leave the bridge unresolved.
// → { rows: [{ line, label, cents, cls }], cells: { '2': [rows], '4a': cents, ... }, unclassified: [...], unknown: [...] }
export function bridgeRows({ catalog, returnType, slots, notTax, tieouts, deltas, unknown = [] }) {
  const spec = M1[returnType], memo = new Map(), coef = id => coefficient(catalog, spec.endpoint, id, memo);
  const rows = [], unclassified = [], why = [...unknown];
  const incomeLike = line => polarityOf(line) === 'credit';
  const place = (E, line, label, cls, { interest = false } = {}) => {
    if (E === 0n) return;
    let cell;
    if (cls === 'book_tax_depreciation') cell = E > 0n ? '4a' : '7a';
    else if (cls === 'meals_50' && E > 0n) cell = '4b';
    else if (cls === 'tax_exempt' && interest && E < 0n) cell = '6a';
    else cell = E > 0n ? (line && incomeLike(line) ? '2' : '4c') : (line && incomeLike(line) ? '6b' : '7b');
    rows.push({ line: cell, label, cents: E > 0n ? E : -E, cls });
  };
  const byActivity = new Map();
  for (const s of slots) {
    const line = catalog.byId.get(s.fieldId), c = BigInt(coef(s.fieldId));
    if (s.provider === 'cogs_workpaper') {
      const a = byActivity.get(s.activityId) ?? { E: 0n, known: true };
      if (s.value === null || !s.plKnown) a.known = false; else a.E += c * s.value + s.plCents;
      byActivity.set(s.activityId, a);
      continue;
    }
    // Tax-exempt interest: the book amount recorded into the line, M-1 line 6a; the line's tax amount is no M-1 difference (c = 0).
    if (spec.exempt.includes(s.fieldId)) {
      if (!s.plKnown) why.push(`${line.label}: its book amount is not known yet.`);
      else if (s.plCents !== 0n) rows.push({ line: '6a', label: line.label, cents: -s.plCents, cls: 'tax_exempt' });
      continue;
    }
    if (s.value === null || !s.plKnown) { if (s.plCents !== 0n || !s.plKnown || c !== 0n) why.push(`${line.label}: its amount is not known yet.`); continue; }
    const E = c * s.value + s.plCents;
    if (E === 0n) continue;
    // Other tax-exempt income and nondeductible expenses: kept out of the reconciliation (c = 0), so E is their book amount, whoever owns them.
    if (c === 0n && (spec.otherExempt.includes(s.fieldId) || spec.nondeductible.includes(s.fieldId))) { place(E, line, line.label, spec.nondeductible.includes(s.fieldId) ? 'nondeductible' : 'tax_exempt'); continue; }
    if (s.provider === 'books') { unclassified.push({ slotKey: s.key, label: line.label, cents: E }); continue; }
    if (s.provider === 'cash_layer') { place(E, line, `Cash method timing: ${line.label}`, 'method_timing'); continue; }
    place(E, line, `${spec.depreciation.includes(s.fieldId) ? 'Depreciation' : 'Book and tax amounts'}: ${line.label}`, spec.depreciation.includes(s.fieldId) ? 'book_tax_depreciation' : 'other');
  }
  for (const [id, t] of tieouts) {
    const a = byActivity.get(id) ?? { E: 0n, known: true };
    if (!t.known) a.known = false; else a.E += t.cents;
    byActivity.set(id, a);
  }
  for (const [id, a] of byActivity) {
    if (!a.known) { why.push(`The cost of goods sold of ${tieouts.get(id)?.name ?? `activity ${id}`} is not known yet.`); continue; }
    place(a.E, null, `Cost of goods sold, book vs tax: ${tieouts.get(id)?.name ?? `activity ${id}`}`, 'inventory');
  }
  for (const n of notTax) place(n.cents, null, n.label, 'other');
  for (const d of deltas) {
    const fieldId = parseSlotKey(d.slotKey).fieldId, line = catalog.byId.get(fieldId), c = BigInt(coef(fieldId));
    if (d.m1Class === 'reclass') continue;
    // A tax-exempt adjustment is interest when its group moves the amount to the tax-exempt interest line.
    const interest = d.m1Class === 'tax_exempt' && deltas.some(x => x.groupId !== undefined && x.groupId === d.groupId && spec.exempt.includes(parseSlotKey(x.slotKey).fieldId));
    place(c * d.cents, line, d.label, d.m1Class, { interest });
  }
  // Cells: statement rows by label, engine sums.
  const cells = { '2': new Map(), '4c': new Map(), '6b': new Map(), '7b': new Map(), '4a': 0n, '4b': 0n, '7a': 0n, '6a': 0n };
  for (const r of rows) {
    if (cells[r.line] instanceof Map) cells[r.line].set(r.label, (cells[r.line].get(r.label) ?? 0n) + r.cents);
    else cells[r.line] += r.cents;
  }
  return { rows, cells, unclassified, unknown: [...new Set(why)] };
}
