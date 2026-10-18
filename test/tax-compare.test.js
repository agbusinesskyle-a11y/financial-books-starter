// test/tax-compare.test.js — a computed return beside a filed one (the golden comparison of spec §12), by COMPLETE fact identity (Codex
// t3-plan-r1 B13): same, a rounding-only difference (the filed return is in whole dollars), a real difference; a missing, unknown or
// stage-T4 result is "not computed", never zero — only a known zero the engine emitted compares as zero; an activity's line is matched
// through the explicit identity map, never by its field alone; statement rows at the grain the baseline declares; a baseline of another
// form or period refused; and the comparison of real figures is never written inside the repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { compareWithBaseline, checkBaseline, dollarsRounded, outsideOf } from '../lib/tax/engine/compare.js';

const fact = (fact_kind, field_id, measurement, amount_cents, extra = {}) => ({ fact_kind, field_id, measurement, amount_cents, state: amount_cents === null ? 'unknown' : 'known', ...extra });
const field = (key, cents, reasons = []) => ({ key, cents, reasons });
const ctx = { returnType: 'form_1065', edition: 2025 };
const byKey = (rows, key) => rows.find(r => r.key === key);

test('field by field: same, rounding, differs; a result that is absent, unknown or waits for stage T4 is not computed — never a zero; only an emitted known zero compares as zero; a filed unknown is said', () => {
  const results = { fields: [field('f1065.p1.1a|activity', '1234550'), field('f1065.p1.9|activity', '50049'), field('f1065.L.1|end', '700'), field('f1065.p1.13|activity', '0'),
    field('f1065.p1.23|activity', null, ['Depreciation is not entered.']), field('f1065.p1.10|interest=i:t4|activity', null, ['Guaranteed payments are computed in stage T4.'])] };
  const { rows, counts } = compareWithBaseline(results, [fact('form_line', 'f1065.p1.1a', 'activity', '1234600'), fact('form_line', 'f1065.p1.9', 'activity', '50000'), fact('schedule_l_end', 'f1065.L.1', 'end', '800'),
    fact('form_line', 'f1065.p1.23', 'activity', '0'), fact('form_line', 'f1065.p1.11', 'activity', null), fact('form_line', 'f1065.p1.13', 'activity', '0'), fact('form_line', 'f1065.p1.12', 'activity', '0'),
    fact('form_line', 'f1065.p1.10', 'activity', '0', { interest_key: 'partner-1' }), fact('form_line', 'f1065.p1.10', 'activity', '0'), fact('form_line', 'hist.f1065.item_f_total_assets', 'end', '5')], { ...ctx, resolve: { interest: { 'partner-1': 'i:t4' } } });
  assert.deepEqual(byKey(rows, 'f1065.L.1|end'), { key: 'f1065.L.1|end', fieldId: 'f1065.L.1', measurement: 'end', grain: 'total', computed: '700', filed: '800', difference: '-100', status: 'differs', reasons: [] });
  assert.equal(byKey(rows, 'f1065.p1.13|activity').status, 'same', 'a known zero the engine emitted');
  assert.deepEqual([byKey(rows, 'f1065.p1.12|activity').status, byKey(rows, 'f1065.p1.12|activity').computed], ['not_computed', null], 'absent is not zero');
  assert.equal(byKey(rows, 'f1065.p1.23|activity').status, 'not_computed', 'unknown against a filed zero');
  assert.equal(byKey(rows, 'f1065.p1.23|activity').reasons[0], 'Depreciation is not entered.');
  assert.equal(byKey(rows, 'f1065.p1.10|interest=i:t4|activity').status, 'not_computed', 'a stage-T4 owner line against a filed zero');
  assert.equal(rows.find(r => r.key === null && r.fieldId === 'f1065.p1.10').status, 'not_compared', 'a filed total of a line kept per owner is not set against one owner');
  assert.deepEqual(counts, { same: 1, rounding: 2, differs: 1, not_computed: 3, unknown_filed: 1, unmatched: 0, not_compared: 1 });
  assert.deepEqual([dollarsRounded(1234550n), dollarsRounded(-1234550n), dollarsRounded(149n)], [1234600n, -1234600n, 100n]);
});

test('an activity’s Form 1125-A line is matched by its complete identity through the explicit map: matching, mismatching and unresolved activities; a filed total of a per-activity line is not set against one activity', () => {
  const results = { fields: [field('f1125a.main.8|activity=act:5|activity', '50000'), field('f1125a.main.8|activity=act:6|activity', '20000')] };
  const facts = [fact('form_line', 'f1125a.main.8', 'activity', '50000', { activity_key: 'store' }), fact('form_line', 'f1125a.main.8', 'activity', '25000', { activity_key: 'shop' }),
    fact('form_line', 'f1125a.main.8', 'activity', '1000', { activity_key: 'kiosk' }), fact('form_line', 'f1125a.main.8', 'activity', '70000')];
  const { rows } = compareWithBaseline(results, facts, { ...ctx, resolve: { activity: { store: 'act:5', shop: 'act:6' } } });
  assert.deepEqual(byKey(rows, 'f1125a.main.8|activity=act:5|activity').status, 'same');
  assert.deepEqual([byKey(rows, 'f1125a.main.8|activity=act:6|activity').status, byKey(rows, 'f1125a.main.8|activity=act:6|activity').difference], ['differs', '-5000']);
  assert.match(rows.find(r => r.status === 'unmatched').reasons[0], /activity \(kiosk\) is not resolved/);
  assert.match(rows.find(r => r.status === 'not_compared').reasons[0], /kept per activity; the filed amount is a total/);
  assert.equal(compareWithBaseline(results, facts.slice(0, 1), ctx).rows[0].status, 'unmatched', 'no map, no match: never compared by its field alone');
});

test('statement rows at the declared grain: rows only — one explicit aggregate of the known rows; a filed total — compared at the total, its rows not one by one; an unknown row — the aggregate is unknown', () => {
  const results = { fields: [field('f1065.L.6|end', '1200'), field('f1065.L.17|end', '900')] };
  let { rows } = compareWithBaseline(results, [fact('schedule_l_end', 'f1065.L.6', 'end', '500', { row_key: 'Deposits' }), fact('schedule_l_end', 'f1065.L.6', 'end', '700', { row_key: 'Prepaid rent' })], ctx);
  assert.deepEqual(rows.map(r => [r.key, r.grain, r.filed, r.status, r.rowCount]), [['f1065.L.6|end', 'rows_total', '1200', 'same', 2]]);
  ({ rows } = compareWithBaseline(results, [fact('schedule_l_end', 'f1065.L.17', 'end', '900'), fact('schedule_l_end', 'f1065.L.17', 'end', '400', { row_key: 'Accrued wages' }), fact('schedule_l_end', 'f1065.L.17', 'end', '500', { row_key: 'Sales tax' })], ctx));
  assert.deepEqual(rows.map(r => [r.grain, r.status]).sort(), [['row', 'not_compared'], ['row', 'not_compared'], ['total', 'same']]);
  ({ rows } = compareWithBaseline(results, [fact('schedule_l_end', 'f1065.L.6', 'end', '500', { row_key: 'Deposits' }), fact('schedule_l_end', 'f1065.L.6', 'end', null, { row_key: 'Prepaid rent' })], ctx));
  assert.deepEqual(rows.map(r => r.status), ['unknown_filed']);
});

test('a baseline of another form or another period is refused before anything is compared', () => {
  const ret = { return_type: 'form_1065', period_start: '2025-01-01', period_end: '2025-12-31' };
  assert.doesNotThrow(() => checkBaseline(ret, { return_type: 'form_1065', source_period_start: '2025-01-01', source_period_end: '2025-12-31' }));
  assert.throws(() => checkBaseline(ret, { return_type: 'form_1065', source_period_start: '2024-01-01', source_period_end: '2024-12-31' }), /2024-01-01 – 2024-12-31, this period is 2025-01-01 – 2025-12-31/);
  assert.throws(() => checkBaseline(ret, { return_type: 'form_1120s', source_period_start: '2025-01-01', source_period_end: '2025-12-31' }), /form_1120s return, this period is form_1065/);
});

test('the comparison file is written only outside the repository, by path segments of the resolved paths', () => {
  const repo = mkdtempSync(join(tmpdir(), 'fbrepo-'));
  assert.equal(outsideOf(repo, join(repo, 'tmp', 'out.json')), false);
  assert.equal(outsideOf(repo, join(repo, '..comparison.json')), false, 'a file name that starts with two dots is inside');
  assert.equal(outsideOf(repo, join(repo, 'a', '..', '..', 'out.json')), true);
  assert.equal(outsideOf(repo, join(tmpdir(), 'elsewhere', 'out.json')), true);
  assert.equal(outsideOf(repo, `${repo}2${'/'}out.json`), true, 'a sibling whose name starts like the repository is outside');
});
