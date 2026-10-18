// test/tax-formulas.test.js — the catalog formula graph is validated before anything is evaluated (operator, arity, operands, measurement,
// cycles); evaluation is exact BigInt, per instance, with unknown never zero; coefficients toward the income reconciliation; the four sign
// facts applied once (no abs()).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogFor, RETURN_TYPES } from '../lib/tax/catalog/index.js';
import { line, sum, minus, sumMinus } from '../lib/tax/catalog/2025/shared.js';
import { formulaProblems, formulaOrder, evaluate, coefficient, semanticOf, polarityOf } from '../lib/tax/engine/formulas.js';

const catalogOf = lines => ({ returnType: 'test', edition: 0, lines, byId: new Map(lines.map(l => [l.id, l])) });

test('every shipped catalog has a sound formula graph (M-2 lines are measured once a year, like their operands)', () => {
  for (const t of RETURN_TYPES) assert.deepEqual(formulaProblems(catalogFor(t, 2025)), [], t);
  assert.ok(formulaOrder(catalogFor('form_1065', 2025)).length > 40);
  // M-1's tax-exempt interest line is the books' amount (the engine's bridge), never Schedule K's (Codex t3-plan-r1 B6).
  assert.deepEqual(catalogFor('form_1065', 2025).byId.get('f1065.m1.6a').formula, ['sum', 'bridge.m1.exempt_books']);
  assert.deepEqual(catalogFor('form_1120s', 2025).byId.get('f1120s.m1.5a').formula, ['sum', 'bridge.m1.exempt_books']);
});

test('a malformed graph is refused before evaluation: operator, arity, unknown operand, answer operand, measurement, cycle', () => {
  const a = line('t.x.a', 'A'), b = line('t.x.b', 'B'), info = line('t.x.i', 'Info', { type: 'text', cls: 'info', operator: 'none' });
  const bal = line('t.x.bal', 'Balance', { cls: 'balance' });
  const cases = [
    [[a, { ...line('t.x.c', 'C', { kind: 'computed', formula: sum('t.x.a') }), formula: ['times', 't.x.a'] }], /not sum, minus or sumMinus/],
    [[a, { ...line('t.x.c', 'C', { kind: 'computed', formula: sum('t.x.a') }), formula: ['minus', 't.x.a'] }], /not sum, minus or sumMinus/],
    [[a, line('t.x.c', 'C', { kind: 'computed', formula: sum('t.x.zz') })], /unknown line t\.x\.zz/],
    [[a, info, line('t.x.c', 'C', { kind: 'computed', formula: sum('t.x.a', 't.x.i') })], /is an answer/],
    [[a, bal, line('t.x.c', 'C', { kind: 'computed', formula: sum('t.x.a', 't.x.bal') })], /measured differently/],
    [[a, b, line('t.x.c', 'C', { kind: 'computed', formula: sum('t.x.d') }), line('t.x.d', 'D', { kind: 'computed', formula: minus('t.x.c', 't.x.b') })], /formula cycle/],
  ];
  for (const [lines, want] of cases) {
    assert.match(formulaProblems(catalogOf(lines)).join('; '), want);
    assert.throws(() => formulaOrder(catalogOf(lines)), /unsound/);
  }
});

test('evaluation is exact and per instance; an unknown operand makes the result unknown with its reasons, never zero', () => {
  const c = catalogFor('form_1065', 2025);
  const big = 9007199254740993n; // beyond 2^53: a Number would lose the last cent
  let v = evaluate(c, new Map([['f1065.p1.1a|activity', { cents: big, reasons: [] }], ['f1065.p1.1b|activity', { cents: 2n, reasons: [] }]]));
  assert.equal(v.get('f1065.p1.1c|activity').cents, big - 2n);
  // Two 1125-A activities stay two instances; page 1 line 2 sums them.
  v = evaluate(c, new Map([['f1125a.main.2|activity=act:1|activity', { cents: 1000n, reasons: [] }], ['f1125a.main.7|activity=act:1|activity', { cents: 300n, reasons: [] }],
    ['f1125a.main.2|activity=act:2|activity', { cents: 50n, reasons: [] }]]));
  assert.equal(v.get('f1125a.main.8|activity=act:1|activity').cents, 700n);
  assert.equal(v.get('f1125a.main.8|activity=act:2|activity').cents, 50n);
  assert.equal(v.get('f1065.p1.2|activity').cents, 750n);
  v = evaluate(c, new Map([['f1065.p1.1a|activity', { cents: 100n, reasons: [] }], ['f1065.p1.16a|activity', { cents: null, reasons: ['Depreciation is not entered.'] }]]));
  assert.equal(v.get('f1065.p1.23|activity').cents, null);
  assert.deepEqual(v.get('f1065.anal.1|activity').reasons, ['Depreciation is not entered.']);
  assert.equal(v.get('f1065.p1.1c|activity').cents, 100n, 'an independent line keeps its amount');
});

test('coefficients toward the income reconciliation: a deduction -1, income +1, a balance or tax-exempt line 0, ending inventory +1', () => {
  const c = catalogFor('form_1065', 2025), s = catalogFor('form_1120s', 2025);
  assert.equal(coefficient(c, 'f1065.anal.1', 'f1065.p1.9'), -1);
  assert.equal(coefficient(c, 'f1065.anal.1', 'f1065.p1.1a'), 1);
  assert.equal(coefficient(c, 'f1065.anal.1', 'f1065.p1.1b'), -1);
  assert.equal(coefficient(c, 'f1065.anal.1', 'f1065.k.5'), 1);
  assert.equal(coefficient(c, 'f1065.anal.1', 'f1065.k.18a'), 0);
  assert.equal(coefficient(c, 'f1065.anal.1', 'f1065.L.1'), 0);
  assert.equal(coefficient(c, 'f1065.anal.1', 'f1125a.main.7'), 1);
  assert.equal(coefficient(c, 'f1065.anal.1', 'f1125a.main.2'), -1);
  assert.equal(coefficient(s, 'f1120s.k.18', 'f1120s.p1.7'), -1);
  assert.equal(coefficient(s, 'f1120s.k.18', 'f1120s.k.16c'), 0);
});

test('the four sign facts, once: income and liabilities credit-normal, deductions and assets debit-normal, contra lines positive reductions, reversed balances stay negative', () => {
  const c = catalogFor('form_1065', 2025), L = id => c.byId.get(id);
  assert.equal(semanticOf(L('f1065.p1.1a'), -50000n), 50000n, 'sales: a credit is positive income');
  assert.equal(semanticOf(L('f1065.p1.1a'), 2000n), -2000n, 'a debit balance in sales stays negative, never made positive');
  assert.equal(semanticOf(L('f1065.p1.1b'), 3000n), 3000n, 'returns and allowances: a debit is a positive reduction');
  assert.equal(semanticOf(L('f1065.p1.9'), 30000n), 30000n);
  assert.equal(semanticOf(L('f1065.L.9b'), -40000n), 40000n, 'accumulated depreciation: a credit balance is a positive reduction');
  assert.equal(semanticOf(L('f1065.L.9b'), 1000n), -1000n, 'a reversed contra balance stays negative');
  assert.equal(semanticOf(L('f1065.L.19b'), -70000n), 70000n);
  assert.equal(polarityOf(L('f1065.k.5')), 'credit', 'an "either" income line reads as income');
  assert.equal(polarityOf(L('f1065.k.18c')), 'debit');
  // L.14 subtracts the contra line once: 100 of assets less 40 of accumulated depreciation is 60.
  const v = evaluate(c, new Map([['f1065.L.9a|end', { cents: 10000n, reasons: [] }], ['f1065.L.9b|end', { cents: semanticOf(L('f1065.L.9b'), -4000n), reasons: [] }]]));
  assert.equal(v.get('f1065.L.14|end').cents, 6000n);
});
