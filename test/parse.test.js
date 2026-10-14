import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMoney } from '../lib/domain/money.js';
import { parseQuantity, lineAmount, formatQuantity } from '../lib/domain/lines.js';

test('parseMoney', () => {
  const cases = [
    ['12', 1200], ['12.5', 1250], ['12.05', 1205], ['$1,234.56', 123456], [' 0.99 ', 99], ['0', 0], ['.5', 50],
    ['', null], ['-5', null], ['1.234', null], ['abc', null], ['1,2,3', 12300], ['12.', 1200], ['1e5', null],
    ['99999999999.99', null], [undefined, null],
  ];
  for (const [input, want] of cases) assert.equal(parseMoney(input), want, String(input));
});

test('parseQuantity and lineAmount', () => {
  assert.equal(parseQuantity('3'), 30000n);
  assert.equal(parseQuantity('2.5'), 25000n);
  assert.equal(parseQuantity('0.0001'), 1n);
  assert.equal(parseQuantity('1.00001'), null);
  assert.equal(parseQuantity('0'), null);
  assert.equal(parseQuantity('-1'), null);
  assert.equal(parseQuantity('x'), null);
  assert.equal(parseQuantity('1000000'), null);
  assert.equal(lineAmount(30000n, 48500), 145500);
  assert.equal(lineAmount(25000n, 1995), 4988); // 49.875 rounds half-up
  assert.equal(lineAmount(3333n, 100), 33);      // 0.3333 × $1.00
  assert.equal(formatQuantity(25000n), '2.5');
  assert.equal(formatQuantity(30000n), '3');
});
