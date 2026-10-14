import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCents } from '../lib/domain/money.js';
import { todayIn, addDays, daysBetween, formatShortDate, monthRange } from '../lib/domain/dates.js';
import { txnStatus } from '../lib/domain/status.js';
import { parseTxnFilters } from '../lib/domain/filters.js';

test('formatCents', () => {
  assert.equal(formatCents(123456), '$1,234.56');
  assert.equal(formatCents(0), '$0.00');
  assert.equal(formatCents(-500), '-$5.00');
  assert.equal(formatCents(5), '$0.05');
  assert.equal(formatCents(100000000), '$1,000,000.00');
});

test('dates', () => {
  assert.equal(formatShortDate('2026-10-09'), '10/9/26');
  assert.equal(formatShortDate('2025-01-31'), '1/31/25');
  assert.equal(daysBetween('2026-10-01', '2026-10-12'), 11);
  assert.equal(daysBetween('2026-10-12', '2026-10-01'), -11);
  assert.equal(daysBetween('2026-03-07', '2026-03-09'), 2); // across a DST change
  assert.equal(addDays('2026-02-27', 2), '2026-03-01');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(todayIn('America/Chicago', new Date('2026-10-12T03:00:00Z')), '2026-10-11');
  assert.equal(todayIn('America/Chicago', new Date('2026-10-12T06:00:00Z')), '2026-10-12');
  assert.deepEqual(monthRange('2026-02-14'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(monthRange('2024-02-14'), { from: '2024-02-01', to: '2024-02-29' });
});

test('txnStatus', () => {
  const today = '2026-10-12';
  const inv = (o) => ({ type: 'invoice', total_cents: 10000, open_cents: 10000, due_date: '2026-10-20', voided_at: null, ...o });
  const cases = [
    [inv({ voided_at: '2026-10-01T00:00:00Z', total_cents: 0, open_cents: 0 }), 'Voided', 'muted'],
    [inv({ open_cents: 0 }), 'Paid', 'good'],
    [inv({ open_cents: 4000 }), 'Partially paid, $40.00 due', 'warn'],
    [inv({ due_date: '2026-10-12' }), 'Due today', 'warn'],
    [inv({ due_date: '2026-10-13' }), 'Due tomorrow', 'neutral'],
    [inv({ due_date: '2026-10-16' }), 'Due in 4 days', 'neutral'],
    [inv({ due_date: '2026-09-28' }), 'Overdue 14 days', 'bad'],
    [inv({ due_date: '2026-10-11' }), 'Overdue 1 day', 'bad'],
    [inv({ due_date: '2026-09-28', open_cents: 2500 }), 'Overdue 14 days · $25.00 due', 'bad'],
    [{ type: 'late_fee', total_cents: 2500, open_cents: 2500, due_date: '2026-10-30', voided_at: null }, 'Due in 18 days', 'neutral'],
    [{ type: 'payment', total_cents: 5000, open_cents: 0, voided_at: null }, 'Closed', 'good'],
    [{ type: 'payment', total_cents: 5000, open_cents: 1200, voided_at: null }, 'Unapplied $12.00', 'warn'],
    [{ type: 'credit_memo', total_cents: 5000, open_cents: 0, voided_at: null }, 'Closed', 'good'],
    [{ type: 'sales_receipt', total_cents: 5000, open_cents: 0, voided_at: null }, 'Paid', 'good'],
    [{ type: 'payment', total_cents: 0, open_cents: 0, voided_at: '2026-10-01T00:00:00Z' }, 'Voided', 'muted'],
  ];
  for (const [txn, text, tone] of cases) {
    assert.deepEqual(txnStatus(txn, today), { text, tone }, JSON.stringify(txn));
  }
});

test('parseTxnFilters', () => {
  const today = '2026-10-12';
  const base = parseTxnFilters({}, today);
  assert.deepEqual(base, { type: 'all', status: 'all', date: 'all', from: null, to: null, sort: 'date', dir: 'desc', page: 1, tag: null, dateProblem: null });
  const junk = parseTxnFilters({ type: 'x', status: "'; drop", sort: 'evil', dir: 'sideways', page: 'abc' }, today);
  assert.deepEqual([junk.type, junk.status, junk.sort, junk.dir, junk.page], ['all', 'all', 'date', 'desc', 1]);
  assert.equal(parseTxnFilters({ page: '0' }, today).page, 1);
  assert.equal(parseTxnFilters({ page: '3' }, today).page, 3);
  const pick = (date, extra = {}) => { const f = parseTxnFilters({ date, ...extra }, today); return [f.from, f.to]; };
  assert.deepEqual(pick('this_month'), ['2026-10-01', '2026-10-31']);
  assert.deepEqual(pick('last_month'), ['2026-09-01', '2026-09-30']);
  assert.deepEqual(pick('this_year'), ['2026-01-01', '2026-12-31']);
  assert.deepEqual(pick('last_year'), ['2025-01-01', '2025-12-31']);
  assert.deepEqual(pick('last_365'), ['2025-10-13', '2026-10-12']);
  assert.deepEqual(pick('custom', { from: '2026-01-05', to: '2026-02-01' }), ['2026-01-05', '2026-02-01']);
  assert.deepEqual(pick('custom', { from: 'nope', to: '2026-02-30' }), [null, null]);
  assert.deepEqual(pick('custom', { from: '2026-03-01', to: '2026-02-01' }), [null, null]);
  assert.equal(parseTxnFilters({ type: 'payment', status: 'overdue', sort: 'amount', dir: 'asc' }, today).type, 'payment');
  const ok = parseTxnFilters({ type: 'payment', status: 'overdue', sort: 'amount', dir: 'asc' }, today);
  assert.deepEqual([ok.status, ok.sort, ok.dir], ['overdue', 'amount', 'asc']);
});
