// test/tax-catalog.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogFor, validateCatalog, EDITIONS, RETURN_TYPES, MEASUREMENTS, applicability, filingManifest, filingManifestFor, validateManifest, deadlinesFor, conditionNames, LINE_ATTACHMENTS } from '../lib/tax/catalog/index.js';
import { readdirSync, readFileSync } from 'node:fs';
import { line, contra, deduction, SEMANTICS, PRINTED_POLARITIES, printedValue } from '../lib/tax/catalog/2025/shared.js';
import { BOX_CODES } from '../lib/tax/catalog/2025/k1_1065.js';
import { BOX_CODES as BOX_CODES_1120S } from '../lib/tax/catalog/2025/k1_1120s.js';

test('the line() builder fills defaults and refuses an id that does not name form, schedule and line', () => {
  const l = line('f1065.p1.1a', 'Gross receipts or sales', { kind: 'input', cls: 'income' });
  assert.deepEqual([l.type, l.ledgerPolarity, l.semantic, l.operator, l.printedPolarity, l.allocBasis], ['amount', 'credit', 'positive', 'add', 'positive', 'none']);
  assert.throws(() => line('1065.1a', 'x', {}), /id must look like form\.schedule\.line/);
});

test('the id grammar accepts the underscore form segment the Schedule K-1 catalogs use', () => {
  for (const id of ['k1_1065.box.1', 'k1_1065.box.L_end', 'k1_1120s.box.17V']) {
    assert.equal(line(id, 'x', { cls: 'separately_stated', ledgerPolarity: 'either' }).id, id);
  }
});

test('line() refuses a sign fact outside the spec §5.1 vocabulary', () => {
  assert.deepEqual([SEMANTICS, PRINTED_POLARITIES], [['positive', 'reduction'], ['positive', 'negative']]);
  assert.throws(() => line('fx.p1.1', 'x', { semantic: 'reducton' }), /fx\.p1\.1: semantic reducton is not one of positive, reduction/);
  assert.throws(() => line('fx.p1.1', 'x', { printedPolarity: 'bogus' }), /fx\.p1\.1: printedPolarity bogus is not one of positive, negative/);
  // A contra line is a positive reduction in a subtractive field, and that vocabulary is accepted.
  assert.deepEqual([contra('fx.L.9b', 'Less accumulated depreciation').semantic, contra('fx.L.9b', 'x').operator], ['reduction', 'subtract']);
});

test('line() refuses an option key it does not know, so a misspelled sign fact cannot fall through to its default', () => {
  // Vocabulary checks only see the values that arrive under the right key. Without this check { semantc, operatr } built a
  // line that is added as a positive: the wrong-sign hazard spec §5.1 exists to prevent, with no error anywhere.
  assert.throws(() => deduction('f1065.p1.16b', 'Less depreciation reported elsewhere', { semantc: 'reduction', operatr: 'subtract' }),
    /^Error: f1065\.p1\.16b: unknown option\(s\) semantc, operatr$/);
  assert.throws(() => line('fx.p1.1', 'x', { printedPolarty: 'negative' }), /fx\.p1\.1: unknown option\(s\) printedPolarty/);
  // The same call spelled right builds the subtractive reduction it names.
  const l = deduction('f1065.p1.16b', 'Less depreciation reported elsewhere', { semantic: 'reduction', operator: 'subtract' });
  assert.deepEqual([l.semantic, l.operator, l.ledgerPolarity, l.cls], ['reduction', 'subtract', 'debit', 'deduction']);
});

test('editions and return types are the ones the spec names', () => {
  assert.deepEqual(EDITIONS, [2025]);
  assert.deepEqual(RETURN_TYPES, ['form_1065', 'form_1120s', 'disregarded', 'household_1040']);
  assert.deepEqual(MEASUREMENTS, ['activity', 'begin', 'end']);
  assert.throws(() => catalogFor('form_1065', 2026), /no catalog for edition 2026/);
});

test('the 1040-shaped catalogs carry no 1065/1120-S attachment lines: Schedule C and F Part III are their COGS (spec §4.10)', () => {
  // Vacuous until Task 3 fills f1125a.js and f8825.js; from then on it guards the composition in index.js.
  for (const rt of ['household_1040', 'disregarded']) {
    const attachments = catalogFor(rt, 2025).lines.map(l => l.id).filter(id => id.startsWith('f1125a.') || id.startsWith('f8825.'));
    assert.deepEqual(attachments, [], `${rt} carries ${attachments.join(', ')}`);
  }
});

test('validateCatalog refuses duplicate ids, formulas naming unknown ids, and computed lines without a formula', () => {
  const ok = [line('fx.p1.1', 'a', { kind: 'input' }), line('fx.p1.2', 'b', { kind: 'computed', formula: ['sum', 'fx.p1.1'] })];
  assert.deepEqual(validateCatalog(ok), []);
  assert.match(validateCatalog([...ok, line('fx.p1.1', 'dup', { kind: 'input' })]).join(' '), /duplicate id fx\.p1\.1/);
  assert.match(validateCatalog([line('fx.p1.3', 'c', { kind: 'computed', formula: ['sum', 'fx.p1.9'] })]).join(' '), /fx\.p1\.3 names unknown id fx\.p1\.9/);
  assert.match(validateCatalog([line('fx.p1.4', 'd', { kind: 'computed' })]).join(' '), /fx\.p1\.4 is computed but has no formula/);
});

test('the 1065 catalog is sound and carries the lines the spec names', () => {
  const c = catalogFor('form_1065', 2025);
  for (const id of ['f1065.p1.1a', 'f1065.p1.1b', 'f1065.p1.1c', 'f1065.p1.10', 'f1065.p1.16a', 'f1065.p1.16b', 'f1065.p1.16c', 'f1065.p1.21', 'f1065.p1.22', 'f1065.p1.23',
    'f1065.k.1', 'f1065.k.4c', 'f1065.k.13d_amt', 'f1065.k.18c', 'f1065.k.19a', 'f1065.k.21', 'f1065.L.9b', 'f1065.L.21', 'f1065.L.22', 'f1065.m1.3', 'f1065.m1.9', 'f1065.m2.7', 'f1065.m2.9',
    'f1065.anal.1', 'f1125a.main.2', 'f1125a.main.8', 'f8825.main.19', 'f8825.main.23', 'k1_1065.box.1', 'k1_1065.box.19A', 'k1_1065.box.20Z', 'k1_1065.box.L_end']) {
    assert.ok(c.byId.has(id), id);
  }
  // Four sign facts: returns and allowances and accumulated depreciation are positive reductions in subtractive fields.
  assert.deepEqual([c.byId.get('f1065.p1.1b').operator, c.byId.get('f1065.p1.1b').semantic], ['subtract', 'reduction']);
  assert.deepEqual([c.byId.get('f1065.L.9b').operator, c.byId.get('f1065.L.9b').ledgerPolarity], ['subtract', 'credit']);
  // Totals are computed, never slots.
  assert.equal(c.byId.get('f1065.p1.23').kind, 'computed');
  assert.ok(!c.slots.some(l => l.id === 'f1065.p1.23'));
  // Schedule L line 21 is book capital bound from the ledger, never a plug (spec §5.2 "equity is never plugged", §5.6). With total
  // assets (L.14) and total liabilities and capital (L.22) computed from different inputs, the "Schedule L unbalanced" error (§5.8)
  // can fire and a balance account left out of the bindings cannot hide in partners' capital. TaxAct takes this line by hand, so no key.
  const l21 = c.byId.get('f1065.L.21');
  assert.deepEqual([l21.kind, l21.cls, l21.ledgerPolarity, l21.formula, l21.taxact], ['input', 'balance', 'credit', null, null]);
  assert.ok(c.slots.some(l => l.id === 'f1065.L.21'));
  assert.deepEqual(c.byId.get('f1065.L.22').formula, ['sum', 'f1065.L.15', 'f1065.L.16', 'f1065.L.17', 'f1065.L.18', 'f1065.L.19a', 'f1065.L.19b', 'f1065.L.20', 'f1065.L.21']);
  const derivedFromTotalAssets = c.lines.filter(l => l.id.startsWith('f1065.L.') && JSON.stringify(l.formula ?? []).includes('"f1065.L.14"')).map(l => l.id);
  assert.deepEqual(derivedFromTotalAssets, [], `no Schedule L line is derived from total assets (that would be a plug): ${derivedFromTotalAssets.join(', ')}`);
  // Analysis of Net Income line 1 is the 1065 bridge endpoint (spec §5.5).
  assert.deepEqual(c.byId.get('f1065.anal.1').formula, ['sumMinus', ['f1065.k.1', 'f1065.k.2', 'f1065.k.3c', 'f1065.k.4c', 'f1065.k.5', 'f1065.k.6a', 'f1065.k.7', 'f1065.k.8', 'f1065.k.9a', 'f1065.k.10', 'f1065.k.11'],
    ['f1065.k.12', 'f1065.k.13a', 'f1065.k.13b', 'f1065.k.13c', 'f1065.k.13d_amt', 'f1065.k.13e', 'f1065.k.21']]);
  // TaxAct labels (interchange key only) are unique where present.
  const labels = c.lines.map(l => l.taxact).filter(Boolean);
  assert.equal(new Set(labels).size, labels.length);
});

// Which ids a catalog's formulas add and which they subtract: 'sum' adds, 'minus' and 'sumMinus' have a subtracted side.
function formulaSides(c) {
  const added = new Set(), subtracted = new Set();
  for (const { formula: f } of c.lines) {
    if (!f) continue;
    if (f[0] === 'minus') { added.add(f[1]); subtracted.add(f[2]); }
    else if (f[0] === 'sumMinus') { f[1].forEach(id => added.add(id)); f[2].forEach(id => subtracted.add(id)); }
    else f.slice(1).forEach(id => added.add(id));
  }
  return { added, subtracted };
}

test('a 1065 line declared subtractive is only ever consumed in a subtractive position (spec §5.1)', () => {
  // The wrong-sign hazard: a contra balance flagged subtract but summed in would add. Every subtractive line must appear on the
  // subtracted side of some formula and on no added side.
  const c = catalogFor('form_1065', 2025);
  const { added, subtracted } = formulaSides(c);
  // The positive reductions (contra balances, returns, ending inventory, the depreciation already reported elsewhere, Form 8825 line 20b, K-1 item L
  // withdrawals). Deductions and the totals a formula subtracts (page 1 lines 2 and 22, K lines 12-13e and 21, M-1 line 8, M-2 line 8, 8825 line
  // 18) are subtractive too but stay semantic 'positive'; the catalog-wide walk below (Codex t1-r1 B6) checks every subtrahend.
  const reductions = c.lines.filter(l => l.semantic === 'reduction').map(l => l.id);
  assert.deepEqual(reductions.sort(), ['f1065.L.10b', 'f1065.L.12b', 'f1065.L.2b', 'f1065.L.9b', 'f1065.p1.16b', 'f1065.p1.1b', 'f1125a.main.7', 'f8825.main.20b', 'k1_1065.box.L_withdrawals']);
  const subtractiveTotal = id => c.lines.some(p => p.operator === 'subtract' && p.formula?.[0] === 'sum' && p.formula.includes(id));
  for (const id of reductions) {
    assert.equal(c.byId.get(id).operator, 'subtract', `${id} is a positive reduction in a subtractive field`);
    if (id !== 'k1_1065.box.L_withdrawals') assert.ok(subtracted.has(id), `${id} is subtracted by a formula`); // item L is reported, not computed, in T1
    assert.ok(!added.has(id) || subtractiveTotal(id), `${id} is never added by a formula`);
  }
});

test('every Schedule K (1065) line that reaches the K-1 pro rata names its allocation basis; owner-specific lines carry none (spec §5.7)', () => {
  // T4 allocates each Schedule K line by the basis the catalog marks. A line that reaches a K-1 box with allocBasis 'none' would be
  // left off every K-1 (and, for 18a-18c, out of tax capital and M-2, spec §5.6). Only owner-specific lines may carry 'none': they
  // come from guaranteed_payment (4a-4c), se_workpaper (14a) and capital_event (19a-19b), never pro rata.
  const c = catalogFor('form_1065', 2025);
  const ownerSpecific = ['f1065.k.4a', 'f1065.k.4b', 'f1065.k.4c', 'f1065.k.14a', 'f1065.k.19a', 'f1065.k.19b'];
  for (const id of ownerSpecific) assert.equal(c.byId.get(id).allocBasis, 'none', `${id} is owner-specific and is never allocated pro rata`);
  // Every interest-dimensioned Schedule K line is one of them (an interest-dimensioned line is per owner by construction).
  for (const l of c.lines.filter(l => l.id.startsWith('f1065.k.') && l.instanceDims.includes('interest'))) assert.ok(ownerSpecific.includes(l.id), l.id);
  const proRata = c.lines.filter(l => l.id.startsWith('f1065.k.') && l.cls !== 'info' && !ownerSpecific.includes(l.id));
  assert.ok(proRata.length >= 40, `expected the Schedule K amount lines, found ${proRata.length}`);
  for (const l of proRata) assert.notEqual(l.allocBasis, 'none', `${l.id} (${l.label}) reaches the K-1 pro rata and must name profit, loss or capital`);
  // Computed 3c carries the basis its K-1 box 3 already carries.
  assert.equal(c.byId.get('f1065.k.3c').allocBasis, 'profit');
  assert.equal(c.byId.get('f1065.k.3c').allocBasis, c.byId.get('k1_1065.box.3').allocBasis);
  // Income-type lines, credits and tax-exempt income follow profit share; deduction-type lines (nondeductible expenses, investment
  // expenses, the depreciation, depletion and oil-and-gas-deduction AMT items) follow loss share. The agreement may say otherwise.
  const basis = ids => ids.map(id => c.byId.get(id).allocBasis);
  const profitLines = ['f1065.k.9b', 'f1065.k.9c', 'f1065.k.14b', 'f1065.k.14c', 'f1065.k.15a', 'f1065.k.15b', 'f1065.k.15c', 'f1065.k.15d', 'f1065.k.15e', 'f1065.k.15f',
    'f1065.k.17b', 'f1065.k.17d', 'f1065.k.17f', 'f1065.k.18a', 'f1065.k.18b', 'f1065.k.20a', 'f1065.k.20c'];
  const lossLines = ['f1065.k.17a', 'f1065.k.17c', 'f1065.k.17e', 'f1065.k.18c', 'f1065.k.20b'];
  assert.deepEqual(basis(profitLines), profitLines.map(() => 'profit'));
  assert.deepEqual(basis(lossLines), lossLines.map(() => 'loss'));
});

test('Form 8825 and Form 1125-A are numbered as the TY2025 forms are, and Schedule K line 2 reads 8825 line 23', () => {
  // Checked against the IRS PDFs (Form 8825 Rev. December 2025, Form 1125-A Rev. November 2024) with scripts/tax-catalog-check.py.
  // 8825: income 2a-2c, expenses 3-14 and 17 (15 and 16 are "Reserved for future use"), 18 total, 19 per-property result, 20a/20b, 21 Form 4797, 22a, 23 net result.
  const c = catalogFor('form_1065', 2025);
  for (const id of ['f8825.main.2a', 'f8825.main.2b', 'f8825.main.2c', 'f8825.main.8', 'f8825.main.10', 'f8825.main.17', 'f8825.main.18', 'f8825.main.19',
    'f8825.main.20a', 'f8825.main.20b', 'f8825.main.21', 'f8825.main.22a', 'f8825.main.23']) assert.ok(c.byId.has(id), id);
  for (const id of ['f8825.main.2', 'f8825.main.15', 'f8825.main.16']) assert.ok(!c.byId.has(id), `${id} is not a line on the TY2025 form`);
  assert.match(c.byId.get('f8825.main.8').label, /^Interest/);
  assert.match(c.byId.get('f8825.main.10').label, /^Real estate taxes/);
  // The form's own arithmetic: 19 = 2c - 18, and 23 combines 20a through 22a with 20b (parenthesized on the form) subtracted.
  assert.deepEqual(c.byId.get('f8825.main.19').formula, ['minus', 'f8825.main.2c', 'f8825.main.18']);
  assert.deepEqual(c.byId.get('f8825.main.23').formula, ['sumMinus', ['f8825.main.20a', 'f8825.main.21', 'f8825.main.22a'], ['f8825.main.20b']]);
  assert.deepEqual(c.byId.get('f1065.k.2').formula, ['sum', 'f8825.main.23']);
  // Schedule K line 2 is the net rental result in every return type that has one, so the 1065 and the 1120-S catalogs both read line 23:
  // line 21 still exists (the Form 4797 gain), so a stale reference to it would validate and silently report the wrong amount.
  for (const [returnType, id] of [['form_1065', 'f1065.k.2'], ['form_1120s', 'f1120s.k.2']]) {
    const k2 = catalogFor(returnType, 2025).byId.get(id);
    assert.ok(k2, `${id} exists`);
    assert.deepEqual(k2.formula, ['sum', 'f8825.main.23'], `${id} must read Form 8825 line 23 (net rental real estate income); line 21 is the Form 4797 gain`);
  }
  // 1125-A: line 9e is the section 263A question (9f asks about a change in determining quantities, cost, or valuations).
  assert.ok(c.byId.has('f1125a.main.9e'));
  assert.ok(!c.byId.has('f1125a.main.9f'));
});

test('Schedule K-1 (1065) carries the items the TY2025 form prints: beginning and ending liabilities, the TIN, the sale or exchange box, box 19 codes A, B, C, D, F and G', () => {
  const c = catalogFor('form_1065', 2025);
  for (const klass of ['nonrecourse', 'qualified_nonrecourse', 'recourse']) {
    for (const end of ['begin', 'end']) assert.ok(c.byId.has(`k1_1065.box.K1_${klass}_${end}`), `Item K1 ${klass} ${end}`);
  }
  assert.match(c.byId.get('k1_1065.item.E').label, /TIN/);
  assert.ok(c.byId.has('k1_1065.item.J_sale_or_exchange'));
  assert.match(c.byId.get('k1_1065.box.19B').label, /section 737/);
  assert.deepEqual(BOX_CODES[19], ['A', 'B', 'C', 'D', 'F', 'G'], 'an explicit list: code E is reserved, so "A-G" was never a valid enumeration');
  // Every K-1 line is kept per ownership interest.
  assert.ok(c.lines.filter(l => l.id.startsWith('k1_1065.')).every(l => l.instanceDims.includes('interest')));
});

test('the 1120-S catalog is its own result type: M-1 ends at line 8 = Schedule K line 18; M-2 has AAA/PTI/AE&P/OAA columns', () => {
  const c = catalogFor('form_1120s', 2025);
  for (const id of ['f1120s.p1.1a', 'f1120s.p1.7', 'f1120s.p1.20', 'f1120s.p1.21', 'f1120s.p1.22', 'f1120s.k.1', 'f1120s.k.16d', 'f1120s.k.17d', 'f1120s.k.18',
    'f1120s.L.22', 'f1120s.L.23', 'f1120s.L.24', 'f1120s.L.27', 'f1120s.m1.8', 'f1120s.m2.aaa.1', 'f1120s.m2.aaa.7', 'f1120s.m2.aaa.8', 'f1120s.m2.oaa.8', 'f1120s.m2.pti.8', 'f1120s.m2.aep.8',
    'k1_1120s.box.1', 'k1_1120s.box.16D', 'k1_1120s.box.17V', 'k1_1120s.item.G']) assert.ok(c.byId.has(id), id);
  // Line 18 combines lines 1-10 and subtracts lines 11 through 12e and 16f: the TY2025 form has five line-12 sub-lines.
  assert.deepEqual(c.byId.get('f1120s.k.18').formula, ['sumMinus', ['f1120s.k.1', 'f1120s.k.2', 'f1120s.k.3c', 'f1120s.k.4', 'f1120s.k.5a', 'f1120s.k.6', 'f1120s.k.7', 'f1120s.k.8a', 'f1120s.k.9', 'f1120s.k.10'],
    ['f1120s.k.11', 'f1120s.k.12a', 'f1120s.k.12b', 'f1120s.k.12c', 'f1120s.k.12d', 'f1120s.k.12e', 'f1120s.k.16f']]);
  assert.ok(!c.byId.has('f1065.p1.1a'), 'no partnership lines leak into the S corporation catalog');
  // Totals are computed, never slots.
  for (const id of ['f1120s.p1.21', 'f1120s.p1.22', 'f1120s.k.18', 'f1120s.L.15', 'f1120s.L.27', 'f1120s.m1.8', 'f1120s.m2.aaa.6', 'f1120s.m2.aaa.8']) assert.ok(!c.slots.some(l => l.id === id), `${id} is computed`);
  // TaxAct labels (interchange key only) are unique where present.
  const labels = c.lines.map(l => l.taxact).filter(Boolean);
  assert.equal(new Set(labels).size, labels.length);
});

test('Schedule M-2 (1120-S) carries only the cells the TY2025 form prints: lines 2 and 4 in column (a), lines 3 and 5 in (a) and (d), lines 1, 6, 7 and 8 in all four', () => {
  // Checked against the IRS PDF (Form 1120-S 2025, page 5): the cells the form lacks are grey-filled. Ordinary income (2) and loss (4) from page 1,
  // line 22 reach only the AAA; other additions (3) and other reductions (5) reach the AAA and the OAA; PTI and AE&P carry an opening balance,
  // distributions and a closing balance. A slot for a cell the form lacks would be a required manual item no page prints (T6), and an amount
  // entered there would flow through line 6 into a column balance the form never shows.
  const c = catalogFor('form_1120s', 2025);
  const id = (col, n) => `f1120s.m2.${col}.${n}`;
  const cells = { aaa: [1, 2, 3, 4, 5, 6, 7, 8], pti: [1, 6, 7, 8], aep: [1, 6, 7, 8], oaa: [1, 3, 5, 6, 7, 8] };
  for (const [col, lines] of Object.entries(cells)) {
    assert.deepEqual(c.lines.filter(l => l.id.startsWith(`f1120s.m2.${col}.`)).map(l => l.id), lines.map(n => id(col, n)), `${col}: exactly the cells the form prints, in form order`);
    // Every printed cell is a manual slot except the computed lines 6 and 8.
    assert.deepEqual(c.slots.filter(l => l.id.startsWith(`f1120s.m2.${col}.`)).map(l => l.id), lines.filter(n => n !== 6 && n !== 8).map(n => id(col, n)), `${col}: slots are the entered cells`);
    assert.deepEqual(c.byId.get(id(col, 8)).formula, ['minus', id(col, 6), id(col, 7)], `${col}: line 8 is line 6 less line 7`);
  }
  // Line 6 combines the lines its column has: AAA adds 1-3 and subtracts 4-5, PTI and AE&P carry only the opening balance, OAA adds 1 and 3 and subtracts 5.
  assert.deepEqual(c.byId.get('f1120s.m2.aaa.6').formula, ['sumMinus', ['f1120s.m2.aaa.1', 'f1120s.m2.aaa.2', 'f1120s.m2.aaa.3'], ['f1120s.m2.aaa.4', 'f1120s.m2.aaa.5']]);
  for (const col of ['pti', 'aep']) assert.deepEqual(c.byId.get(`f1120s.m2.${col}.6`).formula, ['sum', `f1120s.m2.${col}.1`], `${col}: line 6 carries line 1 forward`);
  assert.deepEqual(c.byId.get('f1120s.m2.oaa.6').formula, ['sumMinus', ['f1120s.m2.oaa.1', 'f1120s.m2.oaa.3'], ['f1120s.m2.oaa.5']]);
  // The row labels are the form's: the entered lines name what reaches the column.
  assert.match(c.byId.get('f1120s.m2.aaa.2').label, /ordinary income from page 1, line 22/);
  assert.match(c.byId.get('f1120s.m2.oaa.5').label, /other reductions/);
});

test('the 1120-S page 1 and Schedule K are numbered as the TY2025 form is: lines 7-20 are deductions, line 12 runs a through e', () => {
  // Checked against the IRS PDF (Form 1120-S 2025) with scripts/tax-catalog-check.py. Page 1: 6 adds lines 3 through 5, 21 adds lines 7 through 20,
  // 22 is 6 less 21. Schedule K line 12 is 12a cash and 12b noncash charitable contributions, 12c investment interest expense, 12d section 59(e)(2)
  // expenditures, 12e other deductions (an older layout stopped at 12d with one charitable line); line 18 and M-1 lines 3 and 6 name "12e".
  const c = catalogFor('form_1120s', 2025);
  assert.deepEqual(c.byId.get('f1120s.p1.6').formula, ['sum', 'f1120s.p1.3', 'f1120s.p1.4', 'f1120s.p1.5']);
  assert.deepEqual(c.byId.get('f1120s.p1.21').formula, ['sum', ...Array.from({ length: 14 }, (_, i) => `f1120s.p1.${i + 7}`)]);
  assert.deepEqual(c.byId.get('f1120s.p1.22').formula, ['minus', 'f1120s.p1.6', 'f1120s.p1.21']);
  assert.deepEqual(c.byId.get('f1120s.k.1').formula, ['sum', 'f1120s.p1.22']);
  const label = n => c.byId.get(`f1120s.k.${n}`)?.label ?? '';
  assert.match(label('12a'), /^Cash charitable contributions/);
  assert.match(label('12b'), /^Noncash charitable contributions/);
  assert.match(label('12c'), /^Investment interest expense/);
  assert.match(label('12d'), /^Section 59\(e\)\(2\) expenditures/);
  assert.match(label('12e'), /^Other deductions/);
  assert.ok(!c.byId.has('f1120s.k.12f'), 'line 12 ends at 12e');
  for (const n of ['11', '12a', '12b', '12c', '12d', '12e']) assert.equal(c.byId.get(`f1120s.k.${n}`).ledgerPolarity, 'debit', `f1120s.k.${n} is a deduction`);
  // Schedule K line 17 is 17a through 17d on the form; code V (section 199A information) is a K-1 box 17 code, carried per interest as
  // k1_1120s.box.17V. A Schedule K "17v" computed as line 1 would hard-wire QBI = ordinary business income with no correction path (§4.6:
  // computed totals are never destinations), count a K-1 payer's ordinary income (line 5 → 22 → line 1, §4.9) a second time once the lower-tier
  // QBI items pass through as such (§13.1 T4), and be one number where Statement A is per trade or business. T1 computes no tax (plan header).
  for (const n of ['17a', '17b', '17c', '17d']) assert.ok(c.byId.has(`f1120s.k.${n}`), `f1120s.k.${n}`);
  assert.ok(!c.byId.has('f1120s.k.17v'), 'code V is a K-1 box 17 code, not a Schedule K line');
  assert.ok(c.byId.has('k1_1120s.box.17V'), 'section 199A information is carried per interest on the K-1');
  // Page 1 line 5 is the S corporation's only "Other income (loss)" line, so a plain statement row (trade interest, a bad-debt recovery, insurance
  // proceeds, a section 481(a) adjustment: spec §4.5 statement_row, no K-1 source) is a legal member and no dimension is required. A K-1 payer's
  // ordinary income also reaches it (spec §4.9 routing) as one more member keyed by k1_source, an ALLOWED source dimension (Codex t1-r1 B2), so
  // each member keeps its own provider. The 1065 differs: its line 4 exists only for K-1 amounts and requires the source.
  const p5 = c.byId.get('f1120s.p1.5');
  assert.deepEqual([p5.kind, p5.cls, p5.instanceDims, p5.sourceDims, p5.sourceRequired], ['statement', 'income', [], ['k1_source'], false]);
  assert.ok(c.slots.some(l => l.id === 'f1120s.p1.5'), 'line 5 is a statement slot');
});

test('1120-S Schedule L retained earnings is book equity bound from the ledger, never a plug (spec §5.2, §5.6)', () => {
  // Line 24 is an input bound from the equity accounts, never total assets less everything else. With total assets (L.15) and total liabilities
  // and shareholders’ equity (L.27) computed from different inputs, the "Schedule L unbalanced" error (§5.8) can fire and a balance account left out
  // of the bindings cannot hide in retained earnings. TaxAct’s 1120S import marks retained earnings "requires manual entry", so no key.
  const c = catalogFor('form_1120s', 2025);
  const l24 = c.byId.get('f1120s.L.24');
  assert.deepEqual([l24.kind, l24.cls, l24.ledgerPolarity, l24.formula, l24.taxact], ['input', 'balance', 'credit', null, null]);
  assert.ok(c.slots.some(l => l.id === 'f1120s.L.24'));
  assert.deepEqual(c.byId.get('f1120s.L.15').formula, ['sumMinus', ['f1120s.L.1', 'f1120s.L.2a', 'f1120s.L.3', 'f1120s.L.4', 'f1120s.L.5', 'f1120s.L.6', 'f1120s.L.7', 'f1120s.L.8', 'f1120s.L.9', 'f1120s.L.10a', 'f1120s.L.11a', 'f1120s.L.12', 'f1120s.L.13a', 'f1120s.L.14'],
    ['f1120s.L.2b', 'f1120s.L.10b', 'f1120s.L.11b', 'f1120s.L.13b']]);
  assert.deepEqual(c.byId.get('f1120s.L.27').formula, ['sumMinus', ['f1120s.L.16', 'f1120s.L.17', 'f1120s.L.18', 'f1120s.L.19', 'f1120s.L.20', 'f1120s.L.21', 'f1120s.L.22', 'f1120s.L.23', 'f1120s.L.24', 'f1120s.L.25'], ['f1120s.L.26']]);
  const derivedFromTotalAssets = c.lines.filter(l => l.id.startsWith('f1120s.L.') && JSON.stringify(l.formula ?? []).includes('"f1120s.L.15"')).map(l => l.id);
  assert.deepEqual(derivedFromTotalAssets, [], `no Schedule L line is derived from total assets (that would be a plug): ${derivedFromTotalAssets.join(', ')}`);
  // Shareholder loans are kept per shareholder (loans from shareholders feed Form 7203 debt basis and K-1 item I).
  assert.deepEqual(['f1120s.L.7', 'f1120s.L.19'].map(id => c.byId.get(id).instanceDims), [['interest'], ['interest']]);
});

test('a 1120-S line declared subtractive is only ever consumed in a subtractive position, on the side its account normally sits (spec §5.1)', () => {
  const c = catalogFor('form_1120s', 2025);
  const { added, subtracted } = formulaSides(c);
  // The positive reductions, including the M-2 loss, other reductions and distributions (Codex t1-r1 B6: line 4 and 5 print in parentheses and
  // line 6 subtracts them; line 8 subtracts line 7). Deductions and subtracted totals stay semantic 'positive'; the walk below checks every subtrahend.
  const reductions = c.lines.filter(l => l.semantic === 'reduction').map(l => l.id);
  assert.deepEqual(reductions.sort(), ['f1120s.L.10b', 'f1120s.L.11b', 'f1120s.L.13b', 'f1120s.L.26', 'f1120s.L.2b', 'f1120s.m2.aaa.4', 'f1120s.m2.aaa.5', 'f1120s.m2.aaa.7',
    'f1120s.m2.aep.7', 'f1120s.m2.oaa.5', 'f1120s.m2.oaa.7', 'f1120s.m2.pti.7', 'f1120s.p1.1b', 'f1125a.main.7', 'f8825.main.20b']);
  for (const id of reductions) {
    assert.equal(c.byId.get(id).operator, 'subtract', `${id} is a positive reduction in a subtractive field`);
    assert.ok(subtracted.has(id), `${id} is subtracted by a formula`);
    assert.ok(!added.has(id), `${id} is never added by a formula`);
  }
  // The contra assets (allowance, accumulated depreciation, depletion, amortization) normally carry credit balances. Treasury stock is a
  // contra-equity account and normally carries a debit balance: contra()'s default side would read an ordinary treasury balance as negative.
  assert.deepEqual(['f1120s.L.2b', 'f1120s.L.10b', 'f1120s.L.11b', 'f1120s.L.13b', 'f1120s.L.26'].map(id => c.byId.get(id).ledgerPolarity), ['credit', 'credit', 'credit', 'credit', 'debit']);
  assert.equal(c.byId.get('f1120s.p1.1b').ledgerPolarity, 'debit', 'returns and allowances normally carry a debit balance');
});

test('every Schedule K (1120-S) line that reaches the K-1 pro rata names its allocation basis; owner-specific and corporate-total lines carry none (spec §5.7)', () => {
  // 1120-S items allocate per share per day, the same fraction for every shareholder (spec §5.7). The catalog still marks each line’s character as
  // the 1065 catalog does, so the allocator needs one rule and a pro rata line is never left off the K-1s with 'none'. 'none' is for what is not
  // pro rata: distributions (16d) and loan repayments (16e) belong to one shareholder (capital_event and shareholder_loan rows); 17c is the corporate
  // total of the distributions the AAA ordering assigns to accumulated E&P, which no K-1 box carries; 18 is the corporate reconciliation M-1 line 8 must equal.
  const c = catalogFor('form_1120s', 2025);
  const ownerSpecific = ['f1120s.k.16d', 'f1120s.k.16e'];
  const corporateTotals = ['f1120s.k.17c', 'f1120s.k.18'];
  for (const id of [...ownerSpecific, ...corporateTotals]) assert.equal(c.byId.get(id).allocBasis, 'none', `${id} is never allocated pro rata`);
  // Every interest-dimensioned Schedule K line is one of the owner-specific ones.
  for (const l of c.lines.filter(l => l.id.startsWith('f1120s.k.') && l.instanceDims.includes('interest'))) assert.ok(ownerSpecific.includes(l.id), l.id);
  const proRata = c.lines.filter(l => l.id.startsWith('f1120s.k.') && l.cls !== 'info' && ![...ownerSpecific, ...corporateTotals].includes(l.id));
  for (const l of proRata) assert.notEqual(l.allocBasis, 'none', `${l.id} (${l.label}) reaches the K-1 pro rata and must name profit or loss`);
  // Income-type lines, credits and tax-exempt income follow the profit basis; deduction-type lines (including nondeductible expenses, investment
  // expenses, foreign taxes and the depreciation, depletion and oil-and-gas-deduction AMT items) follow the loss basis. Together the lists are every pro rata line.
  const basis = ids => ids.map(id => c.byId.get(id).allocBasis);
  const profitLines = ['f1120s.k.1', 'f1120s.k.2', 'f1120s.k.3a', 'f1120s.k.3c', 'f1120s.k.4', 'f1120s.k.5a', 'f1120s.k.5b', 'f1120s.k.6', 'f1120s.k.7', 'f1120s.k.8a', 'f1120s.k.8b', 'f1120s.k.8c', 'f1120s.k.9', 'f1120s.k.10',
    'f1120s.k.13a', 'f1120s.k.13b', 'f1120s.k.13c', 'f1120s.k.13d', 'f1120s.k.13e', 'f1120s.k.13f', 'f1120s.k.13g', 'f1120s.k.15b', 'f1120s.k.15d', 'f1120s.k.15f',
    'f1120s.k.10_inv', 'f1120s.k.16a', 'f1120s.k.16b', 'f1120s.k.17a', 'f1120s.k.17d'];
  const lossLines = ['f1120s.k.3b', 'f1120s.k.11', 'f1120s.k.12a', 'f1120s.k.12b', 'f1120s.k.12c', 'f1120s.k.12d', 'f1120s.k.12e', 'f1120s.k.15a', 'f1120s.k.15c', 'f1120s.k.15e',
    'f1120s.k.16c', 'f1120s.k.16f', 'f1120s.k.17b'];
  assert.deepEqual(basis(profitLines), profitLines.map(() => 'profit'));
  assert.deepEqual(basis(lossLines), lossLines.map(() => 'loss'));
  assert.deepEqual([...profitLines, ...lossLines].sort(), proRata.map(l => l.id).sort());
});

test('Schedule K-1 (1120-S) carries the items the TY2025 form prints: identifying number, name, nominee reporting, entity type, shares, loans and the box 16 and 17 codes', () => {
  const c = catalogFor('form_1120s', 2025);
  // Part II as the TY2025 form prints it (checked against the IRS PDF): E is the shareholder’s identifying number, F1 the name and address, F2 the
  // individual or entity responsible for reporting a disregarded entity, trust, estate or nominee shareholder, F3 the type of entity.
  assert.match(c.byId.get('k1_1120s.item.E').label, /identifying number/);
  assert.match(c.byId.get('k1_1120s.item.F1').label, /name, address/);
  assert.match(c.byId.get('k1_1120s.item.F2').label, /disregarded entity/i);
  assert.match(c.byId.get('k1_1120s.item.F3').label, /type of entity/);
  assert.ok(!c.byId.has('k1_1120s.item.F'), 'item F is F1 through F3 on the TY2025 form');
  for (const id of ['k1_1120s.item.G', 'k1_1120s.item.H_begin', 'k1_1120s.item.H_end', 'k1_1120s.item.14', 'k1_1120s.item.18', 'k1_1120s.item.19']) {
    assert.ok(c.byId.has(id), id);
  }
  // Item I (loans from shareholder) is a dollar amount on the form ("$" on both lines): T4 fills it per interest from the shareholder_loan rows
  // (Schedule L line 19 per shareholder) and Form 7203 debt basis reads it, so its value schema (spec §4.7) is an amount slot, as the K-1 (1065)
  // item K1 and item L boxes are. A text item would carry no amount for the 7203 roll to read. G (a percentage) and H (a share count) stay text.
  for (const end of ['begin', 'end']) {
    const l = c.byId.get(`k1_1120s.box.I_${end}`);
    assert.ok(l, `k1_1120s.box.I_${end}`);
    assert.deepEqual([l.type, l.kind, l.instanceDims], ['amount', 'input', ['interest']], `item I ${end} is an amount kept per interest`);
    assert.notEqual(l.cls, 'info');
    assert.ok(c.slots.some(s => s.id === l.id), `item I ${end} is a slot a provider fills`);
    assert.ok(!c.byId.has(`k1_1120s.item.I_${end}`), `item I ${end} is not a text item`);
  }
  for (const id of ['k1_1120s.item.G', 'k1_1120s.item.H_begin', 'k1_1120s.item.H_end']) assert.deepEqual([c.byId.get(id).type, c.byId.get(id).cls], ['text', 'info'], id);
  // Box 16 codes A-F and the box 17 codes the catalog names (Shareholder’s Instructions for Schedule K-1 (Form 1120-S), 2025).
  for (const code of ['A', 'B', 'C', 'D', 'E', 'F']) assert.ok(c.byId.has(`k1_1120s.box.16${code}`), `box 16 code ${code}`);
  assert.match(c.byId.get('k1_1120s.box.16D').label, /^Distributions/);
  assert.match(c.byId.get('k1_1120s.box.16E').label, /^Repayment of loans from shareholders/);
  assert.match(c.byId.get('k1_1120s.box.17V').label, /199A/);
  assert.match(c.byId.get('k1_1120s.box.17AC').label, /448\(c\)/);
  assert.match(c.byId.get('k1_1120s.box.17AJ').label, /Excess business loss/);
  // Every K-1 line is kept per ownership interest.
  assert.ok(c.lines.filter(l => l.id.startsWith('k1_1120s.')).every(l => l.instanceDims.includes('interest')));
});

test('the household catalog is the union of the 1040 schedules, with one instance dimension per activity', () => {
  const c = catalogFor('household_1040', 2025);
  for (const id of ['f1040.c.1', 'f1040.c.4', 'f1040.c.13', 'f1040.c.24b', 'f1040.c.27a', 'f1040.c.31', 'f1040.c.32a', 'f1040.c.42', 'f1040.e1.3', 'f1040.e1.18', 'f1040.e1.21', 'f1040.e2.28k', 'f1040.e2.32',
    'f1040.f.9', 'f1040.f.14', 'f1040.f.34', 'f1040.f.36a', 'f1040.f.50', 'f1040.b.2', 'f1040.b.6', 'f1040.d.7', 'f1040.d.15', 'f4797.main.2', 'f8995.info.qbi']) assert.ok(c.byId.has(id), id);
  assert.deepEqual(c.byId.get('f1040.c.1').instanceDims, ['activity']);
  assert.deepEqual(c.byId.get('f1040.e2.28k').instanceDims, ['k1_source']);
  assert.equal(c.byId.get('f1040.c.31').kind, 'computed');
  const d = catalogFor('disregarded', 2025);
  assert.ok(d.byId.has('f1040.c.1') && !d.byId.has('f1040.e2.28k'), 'a disregarded company has its own schedules but no Part II');
});

test('every 1040 schedule line that takes an amount from the books is kept per activity; computed lines keep one result per activity', () => {
  const c = catalogFor('household_1040', 2025);
  const perActivity = c.lines.filter(l => /^f1040\.(c|e1|f)\./.test(l.id));
  assert.ok(perActivity.length >= 120, `expected Schedule C, E Part I and F, found ${perActivity.length}`);
  // Computed Schedule C, E Part I and F lines PRESERVE the activity (Codex t1-r1 B2): two activities have two line 31 results, never one merged
  // figure; the total across activities is Schedule 1 line 3, which declares that it aggregates them.
  for (const l of perActivity) assert.deepEqual(l.instanceDims, ['activity'], `${l.id} (${l.label})`);
});

test('Schedule C is numbered as the TY2025 form is: 27a is the Form 7205 deduction, 27b the other expenses from line 48, and line 28 adds lines 8 through 27b', () => {
  // Checked against the IRS PDF (Schedule C (Form 1040) 2025) with scripts/tax-catalog-check.py. Line 27 is 27a "Energy efficient commercial bldgs deduction
  // (attach Form 7205)" and 27b "Other expenses (from line 48)"; Part V lists expenses "not included on lines 8-27a" and line 48 is entered "on line 27b".
  // The pair is easy to transpose, and a transposed pair still validates: the line 48 statement rows would hang on the Form 7205 line.
  const c = catalogFor('household_1040', 2025);
  const a = c.byId.get('f1040.c.27a'), b = c.byId.get('f1040.c.27b');
  assert.match(a.label, /^Energy efficient commercial buildings deduction/);
  assert.deepEqual([a.kind, a.type, a.cls, a.ledgerPolarity], ['manual', 'amount', 'deduction', 'debit']);
  assert.match(b.label, /^Other expenses/);
  assert.deepEqual([b.kind, b.type, b.cls, b.ledgerPolarity, b.instanceDims], ['statement', 'statement', 'deduction', 'debit', ['activity']]);
  assert.ok(c.slots.some(s => s.id === 'f1040.c.27b'), 'line 48 is a statement slot a provider fills');
  const n = ids => ids.map(x => `f1040.c.${x}`);
  assert.deepEqual(c.byId.get('f1040.c.28').formula, ['sum', ...n([8, 9, 10, 11, 12, 13, 14, 15, '16a', '16b', 17, 18, 19, '20a', '20b', 21, 22, 23, '24a', '24b', 25, 26, '27a', '27b'])]);
  // The arithmetic around it: 3 = 1 - 2, 4 takes 42, 5 = 3 - 4, 7 = 5 + 6, 29 = 7 - 28, 31 = 29 - 30; Part III: 40 adds 35 through 39, 42 = 40 - 41.
  assert.deepEqual(['3', '4', '5', '7', '29', '31', '40', '42'].map(x => c.byId.get(`f1040.c.${x}`).formula), [
    ['minus', 'f1040.c.1', 'f1040.c.2'], ['sum', 'f1040.c.42'], ['minus', 'f1040.c.3', 'f1040.c.4'], ['sum', 'f1040.c.5', 'f1040.c.6'], ['minus', 'f1040.c.7', 'f1040.c.28'],
    ['minus', 'f1040.c.29', 'f1040.c.30'], ['sum', ...n([35, 36, 37, 38, 39])], ['minus', 'f1040.c.40', 'f1040.c.41']]);
  // Lines the form splits into a and b keep their letters: there is no bare line 16, 20, 24 or 27.
  for (const x of [16, 20, 24, 27]) assert.ok(!c.byId.has(`f1040.c.${x}`), `f1040.c.${x}`);
  // Returns and allowances (2) and ending inventory (41) are positive reductions in subtractive fields (spec §5.1), like 1065 line 1b and 1125-A line 7.
  for (const id of ['f1040.c.2', 'f1040.c.41']) assert.deepEqual([c.byId.get(id).semantic, c.byId.get(id).operator, c.byId.get(id).ledgerPolarity], ['reduction', 'subtract', 'debit'], id);
});

test('Schedule E Part II totals follow the TY2025 form: line 30 adds columns (h) and (k), line 31 adds (g), (i) and (j), and line 32 combines them', () => {
  // Checked against the IRS PDF (Schedule E (Form 1040) 2025). 29a and 29b are the column-totals rows; the lines that add them across are 30 ("Add columns (h) and
  // (k) of line 29a") and 31 ("Add columns (g), (i), and (j) of line 29b", printed in parentheses), and 32 is "Combine lines 30 and 31". The loss columns are
  // stored as positive losses, so 32 subtracts 31.
  const c = catalogFor('household_1040', 2025);
  assert.deepEqual(c.byId.get('f1040.e2.30').formula, ['sum', 'f1040.e2.28h', 'f1040.e2.28k']);
  assert.deepEqual(c.byId.get('f1040.e2.31').formula, ['sum', 'f1040.e2.28g', 'f1040.e2.28i', 'f1040.e2.28j']);
  assert.deepEqual(c.byId.get('f1040.e2.32').formula, ['minus', 'f1040.e2.30', 'f1040.e2.31']);
  for (const id of ['f1040.e2.29a_income', 'f1040.e2.29b_loss']) assert.ok(!c.byId.has(id), `${id} is not a line on the TY2025 form`);
  // Columns (g), (i) and (j) are losses and deductions, on the debit side.
  assert.deepEqual(['g', 'i', 'j'].map(x => c.byId.get(`f1040.e2.28${x}`).ledgerPolarity), ['debit', 'debit', 'debit']);
  // Part I, per property: 20 adds lines 5 through 19, 21 is rents and royalties (3 and 4) less line 20, and 22 is the Form 8582 result, a manual item.
  const e = x => `f1040.e1.${x}`;
  assert.deepEqual(c.byId.get(e(20)).formula, ['sum', ...[5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19].map(e)]);
  assert.deepEqual(c.byId.get(e(21)).formula, ['sumMinus', [e(3), e(4)], [e(20)]]);
  assert.deepEqual([c.byId.get(e(22)).kind, c.byId.get(e(22)).instanceDims], ['manual', ['activity']]);
});

test('Schedule F is the whole TY2025 schedule: Part III line 44 totals lines 37 through 43, line 50 is 44 less 49, and Part I line 9 takes line 50 for an accrual-method farm', () => {
  // Checked against the IRS PDF (Schedule F (Form 1040) 2025). Line 9: "If you use the accrual method, enter the amount from Part III, line 50". Line 44 adds
  // "lines 37, 38b, 39b, 40a, 40c, 41, 42, and 43"; line 50 is "Subtract line 49 from line 44". A line 50 of 37 less 49 would drop an accrual farm's cooperative
  // distributions, program payments, CCC loans, crop insurance, custom hire and other income, and a line 9 without line 50 would drop its gross income whole.
  const c = catalogFor('household_1040', 2025);
  const f = x => `f1040.f.${x}`;
  assert.deepEqual(c.byId.get(f(44)).formula, ['sum', ...[37, '38b', '39b', '40a', '40c', 41, 42, 43].map(f)]);
  assert.deepEqual(c.byId.get(f(50)).formula, ['minus', f(44), f(49)]);
  assert.deepEqual(c.byId.get(f(9)).formula, ['sum', ...['1c', 2, '3b', '4b', '5a', '5c', '6b', '6d', 7, 8, 50].map(f)]);
  assert.deepEqual(c.byId.get(f(34)).formula, ['minus', f(9), f(33)]);
  // Every Part III line the form prints is here; the taxable-amount lines are typed by the preparer, as in Part I, and line 43 is an attach-statement line like line 8.
  for (const x of [37, '38a', '38b', '39a', '39b', '40a', '40b', '40c', 41, 42, 43, 44, 45, 46, 47, 48, 49, 50]) assert.ok(c.byId.has(f(x)), f(x));
  for (const x of ['38b', '39b', '40c']) assert.equal(c.byId.get(f(x)).kind, 'manual', `${f(x)} is a taxable amount typed by the preparer`);
  assert.deepEqual([c.byId.get(f(43)).kind, c.byId.get(f(43)).cls, c.byId.get(f(43)).ledgerPolarity], ['statement', 'income', 'credit']);
  // Line 35 is "Reserved for future use"; 36a and 36b are the at-risk boxes.
  assert.ok(!c.byId.has(f(35)) && c.byId.has(f('36a')) && c.byId.has(f('36b')));
  // Part II adds lines 10 through 32 (21 and 24 split into a and b; 32 is the other-expenses statement).
  assert.deepEqual(c.byId.get(f(33)).formula, ['sum', ...[10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, '21a', '21b', 22, 23, '24a', '24b', 25, 26, 27, 28, 29, 30, 31, 32].map(f)]);
  // Livestock resale (1c = 1a - 1b) and accrual cost of products sold (49 = 47 - 48): lines 1b and 48 are positive reductions in subtractive fields.
  assert.deepEqual(c.byId.get(f('1c')).formula, ['minus', f('1a'), f('1b')]);
  assert.deepEqual(c.byId.get(f(49)).formula, ['minus', f(47), f(48)]);
  for (const id of [f('1b'), f(48)]) assert.deepEqual([c.byId.get(id).semantic, c.byId.get(id).operator], ['reduction', 'subtract'], id);
});

test('Schedule D lines 7 and 15 combine every feeder the catalog carries, with the Form 8949 lines kept as one typed total per term', () => {
  // Checked against the IRS PDF (Schedule D (Form 1040) 2025): 7 is "Combine lines 1a through 6" and 15 "Combine lines 8a through 14"; the carryovers (6 and 14, printed
  // in parentheses) are losses subtracted from the net. Broker detail on Form 8949 is a typed summary (spec §2): d.1b stands for the totals of lines 1a, 1b, 2 and 3,
  // and d.8b for 8a, 8b, 9 and 10.
  const c = catalogFor('household_1040', 2025);
  const d = x => `f1040.d.${x}`;
  assert.deepEqual(c.byId.get(d(7)).formula, ['sumMinus', [d('1b'), d(4), d(5)], [d(6)]]);
  assert.deepEqual(c.byId.get(d(15)).formula, ['sumMinus', [d('8b'), d(11), d(12), d(13)], [d(14)]]);
  for (const id of [d(6), d(14)]) {
    const l = c.byId.get(id);
    assert.deepEqual([l.kind, l.semantic, l.operator, l.ledgerPolarity], ['manual', 'reduction', 'subtract', 'debit'], `${id} is a positive loss carryover subtracted from the net`);
  }
  // Every feeder the household types (broker totals, other-form gains, carryovers, capital gain distributions) is a manual item; only 5 and 12 take K-1 amounts.
  for (const x of ['1b', 4, 6, '8b', 11, 13, 14]) assert.equal(c.byId.get(d(x)).kind, 'manual', `${d(x)} is typed by the preparer`);
  for (const x of [5, 12]) assert.equal(c.byId.get(d(x)).kind, 'input', `${d(x)} is a slot a K-1 fills`);
  assert.match(c.byId.get(d('1b')).label, /lines 1a, 1b, 2 and 3/);
  assert.match(c.byId.get(d('8b')).label, /lines 8a, 8b, 9 and 10/);
  // Schedule B lines 2 and 6 add the payer rows on lines 1 and 5.
  assert.deepEqual([c.byId.get('f1040.b.2').formula, c.byId.get('f1040.b.6').formula], [['sum', 'f1040.b.1'], ['sum', 'f1040.b.5']]);
});

test('a 1040 line declared subtractive is only ever consumed in a subtractive position (spec §5.1)', () => {
  for (const returnType of ['household_1040', 'disregarded']) {
    const c = catalogFor(returnType, 2025);
    const { added, subtracted } = formulaSides(c);
    // The positive reductions; Schedule E line 22 (a limited loss, parenthesized) and Part II line 31 join them (Codex t1-r1 B6). Line 22 feeds Schedule E
    // line 25, which the catalog does not carry, so no formula here subtracts it.
    const reductions = c.lines.filter(l => l.semantic === 'reduction').map(l => l.id);
    assert.deepEqual(reductions.sort(), ['f1040.c.2', 'f1040.c.41', 'f1040.d.14', 'f1040.d.6', 'f1040.e1.22', ...(returnType === 'household_1040' ? ['f1040.e2.31'] : []), 'f1040.f.1b', 'f1040.f.48'], returnType);
    for (const id of reductions) {
      assert.equal(c.byId.get(id).operator, 'subtract', `${id} is a positive reduction in a subtractive field`);
      if (id !== 'f1040.e1.22') assert.ok(subtracted.has(id), `${id} is subtracted by a formula`);
      assert.ok(!added.has(id), `${id} is never added by a formula`);
    }
  }
});

test('k1_source is a required source on lines dedicated to K-1 amounts, an allowed source on mixed lines, and the instance of each Schedule E Part II row', () => {
  // Codex t1-r1 B2 and ruling (a): Schedule D lines 5 and 12 exist only for K-1 amounts, so each member must name its K-1 (a required SOURCE dimension:
  // the members sum into the line once). Schedule B lines 1 and 5 and Form 4797 line 2 also take the household's or a portfolio activity's own
  // amounts, as a member with no source dimension owned by its own provider, and each K-1 as a further member keyed by k1_source.
  for (const returnType of ['household_1040', 'disregarded']) {
    const c = catalogFor(returnType, 2025);
    for (const id of ['f1040.d.5', 'f1040.d.12']) assert.deepEqual([c.byId.get(id).instanceDims, c.byId.get(id).sourceDims, c.byId.get(id).sourceRequired], [[], ['k1_source'], true], `${returnType} ${id}`);
    for (const id of ['f1040.b.1', 'f1040.b.5', 'f4797.main.2']) assert.deepEqual([c.byId.get(id).instanceDims, c.byId.get(id).sourceDims.includes('k1_source'), c.byId.get(id).sourceRequired], [[], true, false], `${returnType} ${id}`);
  }
  const h = catalogFor('household_1040', 2025);
  const part2 = h.lines.filter(l => l.id.startsWith('f1040.e2.28'));
  assert.equal(part2.length, 9);
  // Each Schedule E Part II row is one K-1: there k1_source is the row's INSTANCE, and lines 30 and 31 declare that they aggregate the rows.
  for (const l of part2) assert.deepEqual(l.instanceDims, ['k1_source'], l.id);
  // Schedule B lines 1 and 5 are statement rows (one named row per payer).
  for (const id of ['f1040.b.1', 'f1040.b.5']) assert.deepEqual([h.byId.get(id).kind, h.byId.get(id).type], ['statement', 'statement'], id);
  // Form 8995 here is the per-activity information T4 produces (qualified business income, W-2 wages, UBIA); T8 computes the deduction, so no deduction line exists yet.
  const f8995 = h.lines.filter(l => l.id.startsWith('f8995.'));
  assert.deepEqual(f8995.map(l => l.id), ['f8995.info.qbi', 'f8995.info.w2', 'f8995.info.ubia']);
  for (const l of f8995) assert.deepEqual([l.kind, l.instanceDims], ['input', ['activity']], l.id);
  assert.ok(!catalogFor('disregarded', 2025).lines.some(l => l.id.startsWith('f8995.') || l.id.startsWith('f1040.e2.')), 'a disregarded company has no Form 8995 or Schedule E Part II');
});

test('applicability says which schedules a return requires, and the filing manifest carries the Schedule B, representative and signature rules', () => {
  // Round sample figures, never a filed return's: both over the Schedule B line 4 thresholds, so no relief.
  const four = { k1sFiledAndFurnishedTimely: true, filesOrMustFileScheduleM3: false };
  const a = applicability('form_1065', 2025, { receiptsCents: 1_000_000_00, assetsEndCents: 1_200_000_00, hasRental: false, deductsCogs: true, ...four });
  assert.deepEqual(a.required.sort(), ['analysis', 'f1125a', 'k1', 'm1', 'm2', 'p1', 'schB', 'schK', 'schL'].sort());
  assert.ok(!a.required.includes('f8825'));
  // Schedule B line 4 relief: all four conditions (receipts, assets, K-1s timely, no M-3) → L/M-1/M-2 optional; the workpaper still exists (spec §6).
  const small = applicability('form_1065', 2025, { receiptsCents: 100_000_00, assetsEndCents: 200_000_00, hasRental: false, deductsCogs: false, ...four });
  assert.ok(!small.required.includes('schL') && small.optional.includes('schL'));
  const m = filingManifest('form_1065', 2025);
  for (const k of ['schB.q1_entity_type', 'schB.q16a_1099_required', 'schB.q16b_1099_filed', 'schB.q33_elect_out_bba', 'pr.name', 'pr.designated_individual', 'sign.partner', 'sign.date', 'k1.item_g', 'k1.item_j']) {
    assert.ok(m.some(x => x.key === k), k);
  }
  const s = filingManifest('form_1120s', 2025);
  assert.ok(s.some(x => x.key === 'schB.q14a_1099_required') && s.some(x => x.key === 'sign.officer_title'));
});

test('applicability refuses a missing or non-integral cents fact instead of reading it as zero (spec §0 rule 2)', () => {
  const base = { hasRental: false, deductsCogs: false, k1sFiledAndFurnishedTimely: true, filesOrMustFileScheduleM3: false };
  const period = { periodStart: '2025-01-01', periodEnd: '2025-12-31' };
  // null < 25000000 is true in JS: without the guard a null fact granted the small-partnership relief and made Schedule L optional.
  assert.throws(() => applicability('form_1065', 2025, { ...base, receiptsCents: null, assetsEndCents: null }),
    /^Error: applicability form_1065: receiptsCents must be whole cents \(a bigint, a safe integer or a digit string\), got null; missing is never zero$/);
  assert.throws(() => applicability('form_1065', 2025, { ...base, receiptsCents: 100_000_00, assetsEndCents: undefined }), /assetsEndCents must be whole cents .* got undefined;/);
  assert.throws(() => applicability('form_1065', 2025, { ...base, receiptsCents: '', assetsEndCents: 1 }), /receiptsCents must be whole cents .* got "";/);
  assert.throws(() => applicability('form_1065', 2025, { ...base, receiptsCents: NaN, assetsEndCents: 1 }), /receiptsCents .* got NaN;/);
  assert.throws(() => applicability('form_1065', 2025, { ...base, receiptsCents: '1,000.00', assetsEndCents: 1 }), /receiptsCents .* got "1,000\.00";/);
  assert.throws(() => applicability('form_1065', 2025, { ...base, receiptsCents: 12.5, assetsEndCents: 1 }), /receiptsCents .* got 12\.5;/);
  // A negative gross total is refused in all three accepted representations (bigint, safe integer, digit string): -1 < 25000000
  // is true, so a sign error granted the relief as surely as null did. Zero stays accepted (see officerCompCents '0' below).
  assert.throws(() => applicability('form_1065', 2025, { ...base, receiptsCents: -100_000_000n, assetsEndCents: 1 }),
    /^Error: applicability form_1065: receiptsCents must be whole non-negative cents \(a bigint, a safe integer or a digit string\), got -100000000; a gross total is never negative$/);
  assert.throws(() => applicability('form_1065', 2025, { ...base, receiptsCents: -1, assetsEndCents: 1 }), /receiptsCents must be whole non-negative cents .* got -1; a gross total is never negative$/);
  assert.throws(() => applicability('form_1065', 2025, { ...base, receiptsCents: '-1', assetsEndCents: 1 }), /receiptsCents must be whole non-negative cents .* got "-1"; a gross total is never negative$/);
  assert.throws(() => applicability('form_1065', 2025, { ...base, receiptsCents: 1, assetsEndCents: -1n }), /assetsEndCents must be whole non-negative cents .* got -1; a gross total is never negative$/);
  assert.throws(() => applicability('form_1065', 2025, { ...base, receiptsCents: 1, assetsEndCents: -1 }), /assetsEndCents .* got -1; a gross total is never negative$/);
  assert.throws(() => applicability('form_1065', 2025, { ...base, receiptsCents: 1, assetsEndCents: '-1' }), /assetsEndCents .* got "-1"; a gross total is never negative$/);
  assert.throws(() => applicability('form_1120s', 2025, { ...base, receiptsCents: 600_000_00, assetsEndCents: 300_000_00, officerCompCents: -1n }), /applicability form_1120s: officerCompCents must be whole non-negative cents .* got -1; a gross total is never negative$/);
  assert.throws(() => applicability('form_1120s', 2025, { ...base, receiptsCents: 600_000_00, assetsEndCents: 300_000_00, officerCompCents: -1 }), /officerCompCents .* got -1; a gross total is never negative$/);
  assert.throws(() => applicability('form_1120s', 2025, { ...base, receiptsCents: 600_000_00, assetsEndCents: 300_000_00, officerCompCents: '-1' }), /officerCompCents .* got "-1"; a gross total is never negative$/);
  // Zero in every representation is a fact, not a gap.
  assert.ok(applicability('form_1065', 2025, { ...base, receiptsCents: 0, assetsEndCents: 0n }).optional.includes('schL'));
  // No facts object at all is a missing fact, not "no relief".
  assert.throws(() => applicability('form_1065', 2025), /^Error: applicability form_1065: facts are required; missing is never zero$/);
  assert.throws(() => applicability('household_1040', 2025, null), /facts are required/);
  // Form 1125-E: undefined receipts read as "under $500,000" (undefined >= 50000000 is false) and dropped the form even with officer compensation.
  assert.throws(() => applicability('form_1120s', 2025, { ...base, assetsEndCents: 300_000_00, officerCompCents: 50_000_00 }), /applicability form_1120s: receiptsCents .* got undefined;/);
  assert.throws(() => applicability('form_1120s', 2025, { ...base, receiptsCents: 600_000_00, assetsEndCents: 300_000_00 }), /applicability form_1120s: officerCompCents .* got undefined;/);
  const s = applicability('form_1120s', 2025, { ...base, receiptsCents: 600_000_00, assetsEndCents: 300_000_00, officerCompCents: 50_000_00 });
  assert.ok(s.required.includes('f1125e') && s.required.includes('schL') && s.required.includes('m1'));
  // A bigint or a digit string (cents are strings in JSON envelopes) is whole cents and is accepted; zero officer compensation is a fact, not a gap.
  const small = applicability('form_1120s', 2025, { ...base, receiptsCents: 100_000_00n, assetsEndCents: '20000000', officerCompCents: '0' });
  assert.ok(small.optional.includes('schL') && small.optional.includes('m1') && !small.required.includes('f1125e'));
  assert.deepEqual(applicability('disregarded', 2025, {}), { required: ['owner_return'], optional: [], unresolved: [] });
  assert.ok(deadlinesFor('household_1040', 2025, period).length > 0, 'the deadline rules need no facts');
});

test('applicability refuses a missing or non-boolean flag instead of reading it as "not applicable", and every flag has a positive path (spec §0 rule 2)', () => {
  // Both over the Schedule B thresholds (round sample figures), so the cents facts pass and only the flags are under test.
  const cents = { receiptsCents: 1_000_000_00, assetsEndCents: 1_200_000_00 };
  const four = { k1sFiledAndFurnishedTimely: true, filesOrMustFileScheduleM3: false };
  // The matrix is what creates a period's required items (spec §4.7). Under truthiness an absent flag read as "no" and a caller that
  // omitted one dropped Form 1125-A, Form 8825 or a 1040 schedule with no error anywhere, while the cents facts next to it were refused.
  // Form 1125-A follows a COGS deduction (deductsCogs), not inventory on hand (Codex t1-r1 B4); the line 4 relief reads all four conditions.
  assert.throws(() => applicability('form_1065', 2025, cents), /^Error: applicability form_1065: k1sFiledAndFurnishedTimely must be true or false, got undefined; missing is never false$/);
  assert.throws(() => applicability('form_1065', 2025, { ...cents, ...four }), /^Error: applicability form_1065: deductsCogs must be true or false, got undefined; missing is never false$/);
  assert.throws(() => applicability('form_1065', 2025, { ...cents, ...four, deductsCogs: true }), /applicability form_1065: hasRental must be true or false, got undefined;/);
  assert.throws(() => applicability('form_1120s', 2025, { ...cents, officerCompCents: 0, hasRental: false }), /applicability form_1120s: deductsCogs .* got undefined;/);
  assert.throws(() => applicability('household_1040', 2025, {}), /^Error: applicability household_1040: hasScheduleC must be true or false, got undefined; missing is never false$/);
  // Stand-ins are refused, not coerced: the string 'false' is truthy and required Schedule E Part I; 0 and null are falsy and dropped a schedule.
  const flags = { hasScheduleC: false, hasRental: false, hasK1s: false, hasFarm: false };
  assert.throws(() => applicability('household_1040', 2025, { ...flags, hasRental: 'false' }), /applicability household_1040: hasRental must be true or false, got "false";/);
  assert.throws(() => applicability('household_1040', 2025, { ...flags, hasK1s: 1 }), /hasK1s must be true or false, got 1;/);
  assert.throws(() => applicability('household_1040', 2025, { ...flags, hasFarm: null }), /hasFarm must be true or false, got null;/);
  assert.throws(() => applicability('form_1120s', 2025, { ...cents, officerCompCents: 0, deductsCogs: 'yes', hasRental: false }), /applicability form_1120s: deductsCogs must be true or false, got "yes";/);
  // Every positive path, one flag at a time: each true flag adds exactly its schedule, and all four together add all four.
  assert.deepEqual(applicability('household_1040', 2025, flags), { required: ['f1040'], optional: [], unresolved: [] });
  for (const [flag, schedule] of [['hasScheduleC', 'schC'], ['hasRental', 'schE1'], ['hasK1s', 'schE2'], ['hasFarm', 'schF']]) {
    assert.deepEqual(applicability('household_1040', 2025, { ...flags, [flag]: true }).required, ['f1040', schedule], flag);
  }
  assert.deepEqual(applicability('household_1040', 2025, { hasScheduleC: true, hasRental: true, hasK1s: true, hasFarm: true }).required, ['f1040', 'schC', 'schE1', 'schE2', 'schF']);
  for (const returnType of ['form_1065', 'form_1120s']) {
    const base = returnType === 'form_1120s' ? { ...cents, officerCompCents: 0 } : { ...cents, ...four };
    const neither = applicability(returnType, 2025, { ...base, deductsCogs: false, hasRental: false }).required;
    assert.ok(!neither.includes('f1125a') && !neither.includes('f8825'), `${returnType}: false flags add nothing`);
    const rental = applicability(returnType, 2025, { ...base, deductsCogs: false, hasRental: true }).required;
    assert.ok(rental.includes('f8825') && !rental.includes('f1125a'), `${returnType}: hasRental requires Form 8825`);
    const inventory = applicability(returnType, 2025, { ...base, deductsCogs: true, hasRental: false }).required;
    assert.ok(inventory.includes('f1125a') && !inventory.includes('f8825'), `${returnType}: deductsCogs requires Form 1125-A`);
  }
  // A disregarded company's answer needs no facts: its owner's return carries them.
  assert.deepEqual(applicability('disregarded', 2025, {}), { required: ['owner_return'], optional: [], unresolved: [] });
});

test('an unknown return type is an error from applicability, the filing manifest and the deadlines, never an empty answer', () => {
  // An empty manifest or deadline list for a misspelled key would read as "nothing required" to a completeness check.
  const facts = { receiptsCents: 1, assetsEndCents: 1 };
  const period = { periodStart: '2025-01-01', periodEnd: '2025-12-31' };
  assert.throws(() => applicability('form_1065x', 2025, facts), /^Error: unknown return type form_1065x$/);
  assert.throws(() => filingManifest('form_1065x', 2025), /^Error: unknown return type form_1065x$/);
  assert.throws(() => deadlinesFor('form_1065x', 2025, period), /^Error: no deadline rules for form_1065x \(known: form_1065, form_1120s, household_1040, disregarded, information_returns\)$/);
  // The edition is checked first, as catalogFor does.
  assert.throws(() => applicability('form_1065', 2026, facts), /no catalog for edition 2026/);
  assert.throws(() => filingManifest('form_1065', 2026), /no catalog for edition 2026/);
  assert.throws(() => deadlinesFor('form_1065', 2026, period), /no catalog for edition 2026/);
  // Information returns are not a return type but have due dates; a disregarded company files nothing of its own (an intentional empty list).
  assert.equal(deadlinesFor('information_returns', 2025, period).find(x => x.key === 'w2_1099nec').due, '2026-02-02', 'January 31 2026 is a Saturday');
  assert.deepEqual(deadlinesFor('disregarded', 2025, period), []);
  assert.deepEqual(filingManifest('disregarded', 2025), []);
});

test('deadlines roll forward over weekends and holidays for a calendar 2026 period', () => {
  const d = deadlinesFor('form_1065', 2025, { periodStart: '2026-01-01', periodEnd: '2026-12-31' });
  assert.equal(d.find(x => x.key === 'return').due, '2027-03-15');
  const h = deadlinesFor('household_1040', 2025, { periodStart: '2025-01-01', periodEnd: '2025-12-31' });
  assert.equal(h.find(x => x.key === 'return').due, '2026-04-15');
  assert.equal(h.find(x => x.key === 'es4').due, '2026-01-15');
  assert.equal(h.find(x => x.key === 'es2').due, '2025-06-16', 'June 15 2025 is a Sunday');
});

test('a due date in a year without a federal holiday table is an error, not a weekend-only roll (spec §4.3: never a fallback)', () => {
  // April 15, 2029 is a Sunday and April 16, 2029 is Emancipation Day: with no 2029 table the roll would stop on the 16th and the
  // due date would be a day early. The covered years come from the tables themselves (2025-2027 in the TY2025 folder).
  assert.throws(() => deadlinesFor('household_1040', 2025, { periodStart: '2028-01-01', periodEnd: '2028-12-31' }),
    /^Error: no federal holiday table for 2029 \(rolling 2029-04-15 forward\); the tables cover 2025, 2026, 2027$/);
  assert.throws(() => deadlinesFor('household_1040', 2025, { periodStart: '2024-01-01', periodEnd: '2024-12-31' }), /no federal holiday table for 2024 \(rolling 2024-04-15 forward\)/);
  assert.throws(() => deadlinesFor('form_1065', 2025, { periodStart: '2027-01-01', periodEnd: '2027-12-31' }), /no federal holiday table for 2028/);
  // The last covered year still computes.
  assert.equal(deadlinesFor('form_1065', 2025, { periodStart: '2026-01-01', periodEnd: '2026-12-31' }).find(x => x.key === 'extension').due, '2027-09-15');
});

test('Schedule K line 14c is a reviewed SE-workpaper input, never a formula over receipts (Codex t1-r1 B5)', () => {
  // Gross nonfarm income is not net receipts plus page 1 lines 4, 6 and 7: $100 of receipts and $60 of COGS is $40 of gross income, and
  // lower-tier ordinary income and Form 4797 gains need character treatment (2025 Form 1065 instructions, line 14c). The SE workpaper owns it.
  const c = catalogFor('form_1065', 2025);
  assert.deepEqual(c.byId.get('f1065.k.14c').formula, ['sum', 'se.wp.gross_nonfarm']);
  const wp = c.byId.get('se.wp.gross_nonfarm');
  assert.ok(wp && wp.kind === 'manual' && c.slots.some(s => s.id === 'se.wp.gross_nonfarm'), 'the SE workpaper input is a slot a reviewed provider fills');
  for (const id of ['f1065.p1.1c', 'f1065.p1.1a', 'f1065.p1.4', 'f1065.p1.6', 'f1065.p1.7']) assert.ok(!JSON.stringify(c.byId.get('f1065.k.14c').formula).includes(`"${id}"`), id);
});

test('investment income reads a classified investment component of other income, never the whole line (Codex t1-r1 B5)', () => {
  // 1065 K line 20a and 1120-S K line 17a include the investment income in other income (1065 line 11, 1120-S line 10): a classified input,
  // so a qualifying amount reported there reaches 20a/17a and the rest of the other-income line does not.
  const p = catalogFor('form_1065', 2025), s = catalogFor('form_1120s', 2025);
  assert.deepEqual(p.byId.get('f1065.k.20a').formula, ['sum', 'f1065.k.5', 'f1065.k.6a', 'f1065.k.7', 'f1065.k.11_inv']);
  assert.deepEqual(s.byId.get('f1120s.k.17a').formula, ['sum', 'f1120s.k.4', 'f1120s.k.5a', 'f1120s.k.6', 'f1120s.k.10_inv']);
  for (const [c, id, whole] of [[p, 'f1065.k.11_inv', 'f1065.k.11'], [s, 'f1120s.k.10_inv', 'f1120s.k.10']]) {
    const l = c.byId.get(id);
    assert.deepEqual([l.kind, l.type, l.allocBasis], ['input', 'amount', 'profit'], id);
    assert.ok(c.slots.some(x => x.id === id), `${id} is a slot`);
    assert.ok(!JSON.stringify(c.byId.get(id === 'f1065.k.11_inv' ? 'f1065.k.20a' : 'f1120s.k.17a').formula).includes(`"${whole}"`), `the whole of ${whole} is never investment income`);
    // A subset classification is never added into the income reconciliation a second time.
    const endpoint = c.byId.get(id === 'f1065.k.11_inv' ? 'f1065.anal.1' : 'f1120s.k.18');
    assert.ok(!JSON.stringify(endpoint.formula).includes(`"${id}"`), `${id} is not in ${endpoint.id}`);
  }
});

test('K-1 box codes are explicit TY2025 lists, and every box 19 code has a destination (Codex t1-r1 B5)', () => {
  // Partner's Instructions for Schedule K-1 (Form 1065) (2025), List of Codes: box 19 is A, B, C, D, F and G; E is reserved.
  assert.deepEqual(BOX_CODES[19], ['A', 'B', 'C', 'D', 'F', 'G']);
  for (const codes of Object.values(BOX_CODES)) {
    assert.ok(Array.isArray(codes) && codes.length && codes.every(x => /^[A-Z]{1,2}$/.test(x)), `explicit code list ${codes}`);
    assert.equal(new Set(codes).size, codes.length);
  }
  // Reserved codes are never offered.
  assert.ok(!BOX_CODES[11].includes('G') && !BOX_CODES[11].includes('H') && !BOX_CODES[13].includes('Q') && !BOX_CODES[15].includes('AN'));
  assert.deepEqual([BOX_CODES[14], BOX_CODES[17], BOX_CODES[18]], [['A', 'B', 'C'], ['A', 'B', 'C', 'D', 'E', 'F'], ['A', 'B', 'C']]);
  const c = catalogFor('form_1065', 2025);
  for (const code of BOX_CODES[19]) assert.ok(c.byId.has(`k1_1065.box.19${code}`), `box 19 code ${code}`);
  assert.ok(!c.byId.has('k1_1065.box.19E'), 'code E is reserved');
  assert.match(c.byId.get('k1_1065.box.19D').label, /deemed distributions of money/i);
  assert.match(c.byId.get('k1_1065.box.19F').label, /performing services/);
  assert.match(c.byId.get('k1_1065.box.19G').label, /performing services/);
  // The 1120-S K-1 lists its own codes the same way (Shareholder's Instructions for Schedule K-1 (Form 1120-S) (2025)).
  assert.deepEqual(BOX_CODES_1120S[16], ['A', 'B', 'C', 'D', 'E', 'F']);
  assert.ok(BOX_CODES_1120S[17].includes('V') && !BOX_CODES_1120S[17].includes('S') && !BOX_CODES_1120S[10].includes('H'));
  for (const codes of Object.values(BOX_CODES_1120S)) assert.ok(Array.isArray(codes) && codes.every(x => /^[A-Z]{1,2}$/.test(x)));
  // A generic coded box offers exactly the codes no dedicated box carries.
  for (const [rt, prefix, table] of [['form_1065', 'k1_1065', BOX_CODES], ['form_1120s', 'k1_1120s', BOX_CODES_1120S]]) {
    const cat = catalogFor(rt, 2025);
    for (const l of cat.lines.filter(x => x.id.startsWith(`${prefix}.box.`) && x.type === 'code')) {
      const n = l.id.split('.')[2];
      const dedicated = table[n].filter(code => cat.byId.has(`${prefix}.box.${n}${code}`));
      assert.deepEqual(l.codes, table[n].filter(code => !dedicated.includes(code)), l.id);
      assert.ok(l.instanceDims.includes('code'), `${l.id} keeps one instance per code`);
    }
  }
});

// The cells the official TY2025 forms print in parentheses (checked against the IRS PDFs: Form 1120-S 2025 Schedule L lines 2b, 10b, 11b, 13b
// and 26 and Schedule M-2 lines 4 and 5; Schedule D (Form 1040) lines 6 and 14; Schedule E lines 22 and 31; Form 8825 line 20b; Schedule K-1
// (Form 1065) item L withdrawals and distributions). The 2025 Form 1065 Schedule L prints its contra lines without parentheses, and Schedule
// M-2 (1120-S) line 7 has none either.
const PARENTHESIZED = ['f1120s.L.2b', 'f1120s.L.10b', 'f1120s.L.11b', 'f1120s.L.13b', 'f1120s.L.26', 'f1120s.m2.aaa.4', 'f1120s.m2.aaa.5', 'f1120s.m2.oaa.5',
  'f1040.d.6', 'f1040.d.14', 'f1040.e1.22', 'f1040.e2.31', 'f8825.main.20b', 'k1_1065.box.L_withdrawals'];

// Each use of a line in a formula: { parent, role } where role is 'add' (summed, or the minuend) or 'subtract' (the subtrahend).
function uses(c) {
  const out = new Map();
  const note = (id, parent, role) => { if (!out.has(id)) out.set(id, []); out.get(id).push({ parent, role }); };
  for (const l of c.lines) {
    const f = l.formula;
    if (!f) continue;
    if (f[0] === 'sum') f.slice(1).forEach(id => note(id, l.id, 'add'));
    else if (f[0] === 'minus') { note(f[1], l.id, 'add'); note(f[2], l.id, 'subtract'); }
    else if (f[0] === 'sumMinus') { f[1].forEach(id => note(id, l.id, 'add')); f[2].forEach(id => note(id, l.id, 'subtract')); }
    else throw new Error(`unknown operator ${f[0]} in ${l.id}`);
  }
  return out;
}

test('every catalog states its signs consistently: subtrahends subtract, reductions are never added in, parentheses print negative (Codex t1-r1 B6, spec §5.1)', () => {
  for (const rt of RETURN_TYPES) {
    const c = catalogFor(rt, 2025), u = uses(c);
    for (const l of c.lines) {
      const mine = u.get(l.id) ?? [];
      // A line the form subtracts says so; a line it adds never says subtract (no double negation of a preprinted subtractive field).
      if (mine.some(x => x.role === 'subtract')) assert.equal(l.operator, 'subtract', `${rt}: ${l.id} (${l.label}) is a subtrahend, so its operator is subtract`);
      if (l.operator === 'subtract') {
        // A subtractive line is only ever subtracted, or summed into a total that is itself subtracted (8825 line 18 into 20b, 1065 M-2 6a into 8).
        for (const x of mine) assert.ok(x.role === 'subtract' || c.byId.get(x.parent).operator === 'subtract', `${rt}: ${l.id} is subtractive but ${x.parent} adds it`);
      }
      // A reduction is a positive amount in a subtractive field (accumulated depreciation, a loss carryover), never a negative copied in.
      if (l.semantic === 'reduction') assert.equal(l.operator, 'subtract', `${rt}: ${l.id} is a reduction, so the form subtracts it`);
      // Parenthesized on the form: printed negated, so its stored amount is a positive reduction the form subtracts.
      assert.equal(l.printedPolarity, PARENTHESIZED.includes(l.id) ? 'negative' : 'positive', `${rt}: ${l.id} (${l.label}) printed polarity`);
      if (l.printedPolarity === 'negative') assert.deepEqual([l.semantic, l.operator], ['reduction', 'subtract'], `${rt}: ${l.id} prints in parentheses`);
    }
  }
  // Every parenthesized cell is in some catalog (a misspelled id would make the list above vacuous).
  const all = new Set(RETURN_TYPES.flatMap(rt => catalogFor(rt, 2025).lines.map(l => l.id)));
  for (const id of PARENTHESIZED) assert.ok(all.has(id), id);
  // The cases the review named: 1120-S M-2 lines 4 and 5 are reductions the AAA and OAA columns subtract; line 7 subtracts but prints plain.
  const s = catalogFor('form_1120s', 2025);
  for (const id of ['f1120s.m2.aaa.4', 'f1120s.m2.aaa.5', 'f1120s.m2.oaa.5']) assert.deepEqual([s.byId.get(id).semantic, s.byId.get(id).operator, s.byId.get(id).printedPolarity], ['reduction', 'subtract', 'negative'], id);
  for (const col of ['aaa', 'pti', 'aep', 'oaa']) assert.deepEqual([s.byId.get(`f1120s.m2.${col}.7`).operator, s.byId.get(`f1120s.m2.${col}.7`).printedPolarity], ['subtract', 'positive'], col);
});

test('a printed value negates a parenthesized line exactly once and flags a reversed balance instead of using abs() (Codex t1-r1 B6)', () => {
  const s = catalogFor('form_1120s', 2025), h = catalogFor('household_1040', 2025);
  const treasury = s.byId.get('f1120s.L.26'), cash = s.byId.get('f1120s.L.1'), carry = h.byId.get('f1040.d.6');
  // A stored positive reduction prints negated; the template supplies the parentheses, so the cell carries the stored digits, never "-500" inside "( )".
  assert.deepEqual(printedValue(treasury, 50000n), { printedCents: -50000n, cell: '50000', templateParens: true, reversed: false });
  assert.deepEqual(printedValue(carry, '120000'), { printedCents: -120000n, cell: '120000', templateParens: true, reversed: false });
  // A reversed balance in a parenthesized cell cannot be written without a second negation: it is flagged for review, never made positive by abs().
  assert.deepEqual(printedValue(treasury, -700n), { printedCents: 700n, cell: null, templateParens: true, reversed: true });
  // A plain cell prints its stored amount as it is, a negative included.
  assert.deepEqual(printedValue(cash, -300n), { printedCents: -300n, cell: '-300', templateParens: false, reversed: false });
  assert.throws(() => printedValue(cash, 1.5), /cents/);
  // Nothing on the tax path takes an absolute value.
  for (const dir of ['../lib/tax/', '../lib/tax/catalog/', '../lib/tax/catalog/2025/'].map(d => new URL(d, import.meta.url))) {
    for (const f of readdirSync(dir).filter(x => x.endsWith('.js'))) assert.ok(!/Math\.abs|\babs\(/.test(readFileSync(new URL(f, dir), 'utf8').replace(/\/\/.*$/gm, '')), `${dir}${f} uses abs()`);
  }
});

test('Schedule B line 4 relief needs all four conditions; an unknown condition leaves L, M-1 and M-2 unresolved, never optional (Codex t1-r1 B4)', () => {
  // 2025 Form 1065, Schedule B line 4: receipts under $250,000, assets under $1 million, Schedules K-1 filed and furnished on time, and no
  // Schedule M-3 filed or required. Round sample figures, never a filed return's.
  const small = { receiptsCents: 100_000_00, assetsEndCents: 200_000_00, k1sFiledAndFurnishedTimely: true, filesOrMustFileScheduleM3: false, deductsCogs: false, hasRental: false };
  const all = applicability('form_1065', 2025, small);
  assert.deepEqual([all.required.includes('schL'), all.optional.sort(), all.unresolved], [false, ['m1', 'm2', 'schL'], []]);
  // Late K-1s or a Schedule M-3: no relief, whatever the size.
  for (const late of [{ k1sFiledAndFurnishedTimely: false }, { filesOrMustFileScheduleM3: true }]) {
    const a = applicability('form_1065', 2025, { ...small, ...late });
    assert.ok(['schL', 'm1', 'm2'].every(x => a.required.includes(x)) && a.optional.length === 0, JSON.stringify(late));
  }
  // Whether the K-1s will be furnished on time is often unknown before filing: unresolved, with the reason, never the relief.
  const unknown = applicability('form_1065', 2025, { ...small, k1sFiledAndFurnishedTimely: 'unknown' });
  assert.deepEqual(unknown.unresolved.map(u => u.schedule).sort(), ['m1', 'm2', 'schL']);
  assert.match(unknown.unresolved[0].reason, /k1sFiledAndFurnishedTimely/);
  assert.ok(!unknown.optional.includes('schL') && !unknown.required.includes('schL'));
  // A known failing condition decides even when another is unknown (no relief, so required).
  assert.ok(applicability('form_1065', 2025, { ...small, k1sFiledAndFurnishedTimely: 'unknown', assetsEndCents: 2_000_000_00 }).required.includes('schL'));
  // Missing is still an error, not unknown: the caller must say 'unknown'.
  assert.throws(() => applicability('form_1065', 2025, { ...small, k1sFiledAndFurnishedTimely: undefined }), /k1sFiledAndFurnishedTimely must be true or false/);
  assert.throws(() => applicability('form_1065', 2025, { ...small, filesOrMustFileScheduleM3: 'no' }), /filesOrMustFileScheduleM3 must be true or false, got "no"/);
  // Form 1125-A follows a COGS deduction, not inventory on hand (Form 1125-A: attach when the entity reports a deduction for cost of goods sold).
  assert.ok(applicability('form_1065', 2025, { ...small, deductsCogs: true }).required.includes('f1125a'));
  assert.throws(() => applicability('form_1065', 2025, { ...small, deductsCogs: undefined, hasInventory: true }), /deductsCogs must be true or false/);
  assert.deepEqual(applicability('form_1065', 2025, { ...small, deductsCogs: 'unknown' }).unresolved.map(u => u.schedule), ['f1125a']);
});

const manifestState = (rt, facts) => Object.fromEntries(filingManifestFor(rt, 2025, facts).map(e => [e.key, e.state]));

test('the filing manifest is declarative rules: condition, requiredness and supported or unsupported status, covering every 2025 Schedule B question (Codex t1-r1 B4)', () => {
  for (const rt of ['form_1065', 'form_1120s', 'household_1040']) {
    const m = filingManifest(rt, 2025);
    assert.deepEqual(validateManifest(rt, m), [], rt);
    for (const e of m) {
      assert.ok(e.key && e.label && ['question', 'form', 'statement', 'election', 'signature', 'item'].includes(e.kind), `${rt} ${e.key} kind`);
      assert.ok(['supported', 'unsupported'].includes(e.status), `${rt} ${e.key} status`);
      assert.ok(e.when !== undefined, `${rt} ${e.key} has an applicability condition`);
    }
  }
  // Every question the TY2025 Schedule B prints (reserved lines left out: 1065 10e, 13b, 31; 1120-S 17).
  const b = rt => filingManifest(rt, 2025).filter(e => e.key.startsWith('schB.q')).map(e => e.key.match(/^schB\.q(\d+[a-e]?)_/)[1]);
  const q1065 = new Set(b('form_1065'));
  for (const q of ['1', '2a', '2b', '3a', '3b', '4', '5', '6', '7', '8', '9', '10a', '10b', '10c', '10d', '11', '12', '13a', '14', '15', '16a', '16b', '17', '18', '19', '20', '21', '22', '23', '24',
    '25', '26', '27', '28', '29a', '29b', '30', '32', '33']) assert.ok(q1065.has(q), `1065 Schedule B question ${q}`);
  assert.match(filingManifest('form_1065', 2025).find(e => e.key.startsWith('schB.q30_')).label, /digital asset/);
  const q1120s = new Set(b('form_1120s'));
  for (const q of ['1', '2', '3', '4a', '4b', '5a', '5b', '6', '7', '8', '9', '10', '11', '12', '13', '14a', '14b', '15', '16']) assert.ok(q1120s.has(q), `1120-S Schedule B question ${q}`);
  // A typo in a condition fails validation.
  assert.match(validateManifest('form_1065', [{ key: 'x.y', label: 'x', kind: 'form', source: 'engine', status: 'supported', when: { fact: 'hasRentl' } }]).join(' '), /unknown fact hasRentl/);
});

test('manifest conditions make forms, attachments and representatives required only when their facts hold, unresolved when unknown (Codex t1-r1 B4)', () => {
  const base = { receiptsCents: 1_000_000_00, assetsEndCents: 1_200_000_00, k1sFiledAndFurnishedTimely: true, filesOrMustFileScheduleM3: false, deductsCogs: false, hasRental: false,
    has8825OtherDeductions: false, claimsDepreciationOrAmortization: false, hasBusinessPropertyDispositions: false, hasCapitalGainsOrLosses: false, k2k3Required: false, paidPreparer: false,
    // Forms 4562 and 4797 also follow the lines that report them (Codex t1-r2 B4): none of those lines has an amount here.
    ...Object.fromEntries(['f1065.p1.16a', 'f1065.k.12', 'f8825.main.14', 'f1065.p1.6', 'f1065.k.10', 'f8825.main.21'].map(l => [`amount:${l}`, '0'])) };
  const s = manifestState('form_1065', { ...base, 'schB.q2a_entity_owner_50': false, 'schB.q2b_individual_owner_50': false, 'schB.q33_elect_out_bba': false, prIsEntity: false });
  for (const k of ['form.1125a', 'form.8825', 'form.8825_sch_a', 'form.4562', 'form.4797', 'form.b1_1065', 'pr.designated_individual', 'sign.preparer']) assert.equal(s[k], 'not_required', k);
  for (const k of ['schB.q1_entity_type', 'schB.q30_digital_assets', 'pr.name', 'sign.partner', 'sched.L', 'p1.item_f_total_assets']) assert.equal(s[k], 'required', k);
  const on = manifestState('form_1065', { ...base, deductsCogs: true, hasRental: true, has8825OtherDeductions: true, claimsDepreciationOrAmortization: true, hasBusinessPropertyDispositions: true,
    'schB.q2a_entity_owner_50': true, 'schB.q2b_individual_owner_50': false, 'schB.q33_elect_out_bba': false, prIsEntity: true, paidPreparer: true });
  for (const k of ['form.1125a', 'form.8825', 'form.8825_sch_a', 'form.4562', 'form.4797', 'form.b1_1065', 'pr.name', 'pr.designated_individual', 'sign.preparer']) assert.equal(on[k], 'required', k);
  // Electing out of the centralized audit regime drops the representative and needs Schedule B-2, which Tax Books does not produce: unsupported.
  const out = manifestState('form_1065', { ...base, 'schB.q33_elect_out_bba': true, prIsEntity: true });
  assert.deepEqual([out['pr.name'], out['pr.designated_individual'], out['form.b2_1065']], ['not_required', 'not_required', 'unsupported']);
  // Unknown answers stay unresolved: B-1 when the ownership question is unanswered, the representative when line 33 is unanswered.
  const unk = manifestState('form_1065', base);
  assert.deepEqual([unk['form.b1_1065'], unk['pr.name'], unk['pr.designated_individual']], ['unresolved', 'unresolved', 'unresolved']);
  // Explicitly unsupported forms the matrix reaches: Schedule M-3, K-2/K-3 beyond the exception.
  const big = manifestState('form_1065', { ...base, filesOrMustFileScheduleM3: true, k2k3Required: true });
  assert.deepEqual([big['form.m3'], big['form.k2_k3']], ['unsupported', 'unsupported']);
  assert.equal(manifestState('form_1065', base)['form.m3'], 'not_required');
  // The small-partnership relief drops item F and the K-1 item L only when all four conditions hold.
  const small = manifestState('form_1065', { ...base, receiptsCents: 1, assetsEndCents: 1 });
  assert.deepEqual([small['p1.item_f_total_assets'], small['k1.item_l'], small['sched.L']], ['not_required', 'not_required', 'not_required']);
  assert.equal(manifestState('form_1065', { ...base, receiptsCents: 1, assetsEndCents: 1, k1sFiledAndFurnishedTimely: 'unknown' })['sched.L'], 'unresolved');
  // 1120-S: B-1 follows line 3; 1125-E follows officer compensation with receipts of $500,000 or more.
  const sc = { ...base, officerCompCents: 50_000_00 };
  delete sc.k1sFiledAndFurnishedTimely;
  assert.equal(manifestState('form_1120s', { ...sc, 'schB.q3_nominee_shareholder': true })['form.b1_1120s'], 'required');
  assert.equal(manifestState('form_1120s', { ...sc, 'schB.q3_nominee_shareholder': false })['form.b1_1120s'], 'not_required');
  assert.equal(manifestState('form_1120s', sc)['form.1125e'], 'required');
  assert.equal(manifestState('form_1120s', { ...sc, receiptsCents: 'unknown' })['form.1125e'], 'unresolved');
  // A wrongly typed fact is refused, not coerced.
  assert.throws(() => filingManifestFor('form_1065', 2025, { ...base, hasRental: 'false' }), /hasRental must be true or false/);
  // The label never claims completeness the rules do not have.
  for (const rt of RETURN_TYPES) assert.ok(!filingManifest(rt, 2025).some(e => /every non-dollar answer/i.test(e.label)));
});

test('a line separates REQUIRED instance dimensions from ALLOWED source dimensions; a formula declares what it preserves and what it aggregates (Codex t1-r1 B2)', () => {
  // The builder knows the dimension vocabulary and refuses contradictory declarations.
  assert.throws(() => line('fx.p1.1', 'x', { instanceDims: ['activty'] }), /unknown dimension activty/);
  assert.throws(() => line('fx.p1.1', 'x', { instanceDims: ['activity'], sourceDims: ['activity'] }), /both required and a source/);
  assert.throws(() => line('fx.p1.1', 'x', { sourceRequired: true }), /sourceRequired needs a source dimension/);
  assert.throws(() => line('fx.p1.1', 'x', { aggregates: ['activity'] }), /only a computed line aggregates/);
  // validateCatalog: a formula that drops an operand's dimension must say it aggregates it; one that keeps a dimension needs it on every operand.
  const per = line('fx.p1.1', 'per activity', { instanceDims: ['activity'] });
  assert.match(validateCatalog([per, line('fx.p1.2', 'total', { kind: 'computed', formula: ['sum', 'fx.p1.1'] })]).join(' '), /fx\.p1\.2 drops dimension activity of fx\.p1\.1/);
  assert.deepEqual(validateCatalog([per, line('fx.p1.2', 'total', { kind: 'computed', formula: ['sum', 'fx.p1.1'], aggregates: ['activity'] })]), []);
  assert.deepEqual(validateCatalog([per, line('fx.p1.2', 'each', { kind: 'computed', formula: ['sum', 'fx.p1.1'], instanceDims: ['activity'] })]), []);
  assert.match(validateCatalog([line('fx.p1.3', 'flat'), line('fx.p1.4', 'each', { kind: 'computed', formula: ['sum', 'fx.p1.3'], instanceDims: ['activity'] })]).join(' '), /fx\.p1\.4 keeps dimension activity that fx\.p1\.3 does not have/);
  assert.match(validateCatalog([line('fx.p1.3', 'flat'), line('fx.p1.5', 't', { kind: 'computed', formula: ['sum', 'fx.p1.3'], aggregates: ['interest'] })]).join(' '), /fx\.p1\.5 aggregates interest, which no operand has/);

  // Mixed-source destinations: own (books or manual) amounts are members without a source dimension; each K-1 is one more member keyed by k1_source.
  const h = catalogFor('household_1040', 2025);
  for (const id of ['f1040.b.1', 'f1040.b.5', 'f4797.main.2']) {
    const l = h.byId.get(id);
    assert.deepEqual([l.instanceDims, l.sourceDims.includes('k1_source'), l.sourceRequired], [[], true, false], id);
  }
  // Lines that exist only for K-1 amounts require the source.
  for (const [rt, id] of [['household_1040', 'f1040.d.5'], ['household_1040', 'f1040.d.12'], ['form_1065', 'f1065.p1.4'], ['form_1065', 'f8825.main.22a']]) {
    const l = catalogFor(rt, 2025).byId.get(id);
    assert.deepEqual([l.instanceDims, l.sourceDims, l.sourceRequired], [[], ['k1_source'], true], id);
  }
  const s5 = catalogFor('form_1120s', 2025).byId.get('f1120s.p1.5');
  assert.deepEqual([s5.instanceDims, s5.sourceDims, s5.sourceRequired], [[], ['k1_source'], false]);
  // A lower-tier K-1's separately stated items pass through to Schedule K as members keyed by their K-1 (spec §4.9).
  for (const id of ['f1065.k.5', 'f1065.k.9a', 'f1065.k.13e', 'f1065.k.11_inv']) assert.ok(catalogFor('form_1065', 2025).byId.get(id).sourceDims.includes('k1_source'), id);
  // Depreciation lines take one member per asset (the asset register's packet, T7).
  for (const id of ['f1065.p1.16a', 'f8825.main.14']) assert.ok(catalogFor('form_1065', 2025).byId.get(id).sourceDims.includes('asset'), id);

  // Per-instance results versus return-wide rollups.
  const p = catalogFor('form_1065', 2025);
  for (const id of ['f8825.main.2c', 'f8825.main.18', 'f8825.main.19', 'f1125a.main.6', 'f1125a.main.8']) assert.deepEqual([p.byId.get(id).instanceDims, p.byId.get(id).aggregates], [['activity'], []], `${id} is kept per property or activity`);
  for (const id of ['f8825.main.20a', 'f8825.main.20b', 'f1065.p1.2']) assert.deepEqual([p.byId.get(id).instanceDims, p.byId.get(id).aggregates], [[], ['activity']], `${id} totals the properties or activities`);
  for (const id of ['f1065.p1.22', 'f1065.k.4c']) assert.deepEqual(p.byId.get(id).aggregates, ['interest'], id);
  for (const id of ['f1040.c.29', 'f1040.c.31', 'f1040.e1.21', 'f1040.f.34']) assert.deepEqual(h.byId.get(id).instanceDims, ['activity'], `${id} is one result per activity`);
  for (const id of ['f1040.e2.30', 'f1040.e2.31']) assert.deepEqual(h.byId.get(id).aggregates, ['k1_source'], id);
  // Two activities keep separate Schedule C results; the explicit total is Schedule 1 line 3, which aggregates them.
  assert.deepEqual([h.byId.get('f1040.s1.3').formula, h.byId.get('f1040.s1.3').aggregates, h.byId.get('f1040.s1.3').instanceDims], [['sum', 'f1040.c.31'], ['activity'], []]);
});

// Codex t1-r2 B4 ----------------------------------------------------------------------------------------------------------------------
const entry = (rt, key) => filingManifest(rt, 2025).find(e => e.key === key) ?? assert.fail(`${rt} has no manifest entry ${key}`);
const stateOf = (rt, facts, key) => filingManifestFor(rt, 2025, facts).find(e => e.key === key);

test('Form 7205 is required on both returns when its deduction line has an amount, and the 1065 Schedule F when page 1 line 5 has one (Codex t1-r2 B4)', () => {
  for (const [rt, line] of [['form_1065', 'f1065.p1.20'], ['form_1120s', 'f1120s.p1.19']]) {
    const e = entry(rt, 'form.7205');
    assert.deepEqual([e.kind, e.status, e.when], ['form', 'supported', { amount: line }], rt);
    assert.equal(stateOf(rt, { [`amount:${line}`]: '125000' }, 'form.7205').state, 'required', rt);
    assert.equal(stateOf(rt, { [`amount:${line}`]: '0' }, 'form.7205').state, 'not_required', rt);
    // An amount nobody has supplied yet is unknown, never zero: the attachment waits on it.
    assert.deepEqual([stateOf(rt, {}, 'form.7205').state, stateOf(rt, {}, 'form.7205').waitsOn], ['unresolved', `amount:${line}`], rt);
  }
  const f = entry('form_1065', 'form.sch_f_1065');
  assert.match(f.label, /Schedule F \(Form 1040\)/);
  // A farm loss is an amount too; a farm reported with zero net profit still attaches its Schedule F.
  assert.equal(stateOf('form_1065', { 'amount:f1065.p1.5': '-50000', hasFarm: false }, 'form.sch_f_1065').state, 'required');
  assert.equal(stateOf('form_1065', { 'amount:f1065.p1.5': '0', hasFarm: true }, 'form.sch_f_1065').state, 'required');
  assert.equal(stateOf('form_1065', { 'amount:f1065.p1.5': '0', hasFarm: false }, 'form.sch_f_1065').state, 'not_required');
  // An amount fact is typed: signed whole cents or a boolean "has an amount", never coerced.
  assert.throws(() => filingManifestFor('form_1065', 2025, { 'amount:f1065.p1.20': '12.50' }), /amount:f1065\.p1\.20 must be whole cents/);
  // A condition naming a line the return's catalog does not have is refused when the manifest is validated.
  assert.match(validateManifest('form_1065', [{ key: 'x.y', label: 'x', kind: 'form', source: 'engine', status: 'supported', scope: 'return', when: { amount: 'f1120s.p1.19' } }]).join(' '), /f1120s\.p1\.19 is not a line of form_1065/);
});

test('every amount line whose form text calls for an attachment is tied to the manifest rule that requires it (Codex t1-r2 B4)', () => {
  // The audit: a non-computed amount line that cites a form or schedule is either tied to the rule that requires the attachment (through its
  // amount, or through the named fact that decides it) or declared as needing none, with the reason.
  // (Schedules K and L are the return's own schedules, named by the M-1 lines as references, not attachments.)
  const cites = /\bForm \d{4}|\bSchedule [A-J]\b/;
  for (const rt of ['form_1065', 'form_1120s']) {
    const ties = LINE_ATTACHMENTS[rt];
    for (const l of catalogFor(rt, 2025).lines) {
      if (l.kind === 'computed' || !['amount', 'code', 'statement'].includes(l.type) || !cites.test(l.label)) continue;
      assert.ok(ties.some(t => t.line === l.id), `${rt} ${l.id} "${l.label}" is not tied to a manifest rule`);
    }
    for (const t of ties) {
      assert.ok(catalogFor(rt, 2025).byId.has(t.line), `${rt} ${t.line} is a catalog line`);
      if (t.entry === null) { assert.ok(t.reason, `${rt} ${t.line} says why it needs no attachment`); continue; }
      const names = conditionNames(entry(rt, t.entry).when);
      assert.ok(names.includes(`amount:${t.line}`) || (t.via && names.includes(t.via)), `${rt} ${t.entry} reads ${t.line}'s amount or ${t.via}`);
    }
  }
  // Forms 4562 and 4797 and Schedule D follow the lines that report them as well as their facts: a manual depreciation amount with the fact
  // set to false still requires Form 4562.
  const zero = { claimsDepreciationOrAmortization: false, 'amount:f1065.p1.16a': '0', 'amount:f1065.k.12': '0', 'amount:f8825.main.14': '0' };
  assert.equal(stateOf('form_1065', zero, 'form.4562').state, 'not_required');
  assert.equal(stateOf('form_1065', { ...zero, 'amount:f1065.k.12': '500000' }, 'form.4562').state, 'required');
  assert.equal(stateOf('form_1120s', { hasCapitalGainsOrLosses: false, 'amount:f1120s.k.7': '0', 'amount:f1120s.k.8a': '0', 'amount:f1120s.p1.23b': '9000' }, 'form.sch_d_1120s').state, 'required');
});

test('Schedule B 5a and 5b (Form 1120-S) carry their share counts as typed conditional answers (Codex t1-r2 B4)', () => {
  const counts = filingManifest('form_1120s', 2025).filter(e => /^schB\.q5[ab]_/.test(e.key) && e.answer === 'count');
  assert.deepEqual(counts.map(e => [e.key, e.when]), [
    ['schB.q5a_restricted_shares', { yes: 'schB.q5a_restricted_stock' }], ['schB.q5a_nonrestricted_shares', { yes: 'schB.q5a_restricted_stock' }],
    ['schB.q5b_shares_outstanding', { yes: 'schB.q5b_options' }], ['schB.q5b_shares_if_executed', { yes: 'schB.q5b_options' }]]);
  // The yes/no questions no longer claim to include the counts themselves.
  for (const k of ['schB.q5a_restricted_stock', 'schB.q5b_options']) assert.deepEqual([entry('form_1120s', k).answer, /share counts/.test(entry('form_1120s', k).label)], ['yesno', false]);
  const st = facts => Object.fromEntries(filingManifestFor('form_1120s', 2025, facts).filter(e => counts.some(c => c.key === e.key)).map(e => [e.key, e.state]));
  assert.deepEqual(Object.values(st({ 'schB.q5a_restricted_stock': true, 'schB.q5b_options': false })), ['required', 'required', 'not_required', 'not_required']);
  assert.deepEqual(Object.values(st({})), ['unresolved', 'unresolved', 'unresolved', 'unresolved']);
  // A count answer read by a condition is a whole number.
  assert.deepEqual(validateManifest('form_1120s', [...filingManifest('form_1120s', 2025), { key: 'z.z', label: 'z', kind: 'form', source: 'engine', status: 'supported', scope: 'return', when: { gt: ['schB.q5a_restricted_shares', 0] } }]), []);
});

test('K-1 items are per owner: H2 (Form 1065) is required only for a partner flagged as a disregarded entity, F2 (Form 1120-S) only for its shareholders (Codex t1-r2 B4)', () => {
  const h2 = entry('form_1065', 'k1.item_h2');
  assert.deepEqual([h2.scope, h2.answer, h2.when], ['owner', 'text', { yes: 'k1.item_h2_is_de' }]);
  // Codex t1-r3 N3: H2 names the disregarded entity itself; items E/F name its owner. Two identities, never the same field.
  assert.match(h2.label, /disregarded entity itself/); assert.match(h2.label, /not its owner/); assert.match(h2.label, /no TIN|not available/);
  assert.doesNotMatch(h2.label, /partner’s owner|partner's owner/);
  assert.match(entry('form_1065', 'k1.item_e_f').label, /its owner/);
  assert.deepEqual([entry('form_1065', 'k1.item_h2_is_de').scope, entry('form_1065', 'k1.item_h2_is_de').answer], ['owner', 'yesno']);
  // The review's probe: with no partner facts, H2 was 'always' and 'required'. Now it waits on each partner's answer.
  const none = stateOf('form_1065', {}, 'k1.item_h2');
  assert.deepEqual([none.state, none.waitsOn], ['unresolved', 'k1.item_h2_is_de']);
  // Per partner: required for the disregarded-entity partner, not for the individual; the entry is required while any partner needs it.
  const owners = { 'interest:1': { 'k1.item_h2_is_de': true }, 'interest:2': { 'k1.item_h2_is_de': false } };
  const each = stateOf('form_1065', { owners }, 'k1.item_h2');
  assert.deepEqual([each.state, each.owners], ['required', [{ owner: 'interest:1', state: 'required' }, { owner: 'interest:2', state: 'not_required' }]]);
  assert.equal(stateOf('form_1065', { owners: { 'interest:2': { 'k1.item_h2_is_de': false } } }, 'k1.item_h2').state, 'not_required');
  assert.equal(stateOf('form_1065', { owners: { 'interest:1': {} } }, 'k1.item_h2').state, 'unresolved');
  // A partner's answer is never read from the return's own facts, and a return-wide rule may not depend on one partner's answer.
  assert.equal(stateOf('form_1065', { 'k1.item_h2_is_de': true }, 'k1.item_h2').state, 'unresolved');
  assert.match(validateManifest('form_1065', [...filingManifest('form_1065', 2025), { key: 'z.z', label: 'z', kind: 'form', source: 'engine', status: 'supported', scope: 'return', when: { yes: 'k1.item_h2_is_de' } }]).join(' '),
    /z\.z: k1\.item_h2_is_de is answered per owner; a return-wide rule cannot read it/);
  // Every K-1 entry is per owner.
  for (const rt of ['form_1065', 'form_1120s']) for (const e of filingManifest(rt, 2025).filter(x => x.key.startsWith('k1.'))) assert.equal(e.scope, 'owner', `${rt} ${e.key}`);
  // Form 1120-S K-1 item F2 is per shareholder too.
  assert.deepEqual(entry('form_1120s', 'k1.item_f2').when, { yes: 'k1.item_f2_applies' });
  const sh = stateOf('form_1120s', { owners: { 'interest:1': { 'k1.item_f2_applies': false } } }, 'k1.item_f2');
  assert.deepEqual(sh.owners, [{ owner: 'interest:1', state: 'not_required' }]);
  // Contributed built-in gain or loss property (item M "Yes") needs a statement that rests on section 704(c): unsupported, per partner.
  const m = stateOf('form_1065', { owners: { 'interest:1': { 'k1.item_m': true } } }, 'k1.item_m_statement');
  assert.deepEqual([m.state, m.owners[0].state], ['unsupported', 'unsupported']);
});

test('the other manifest gaps of the same class: subanswers and attachments the forms call for (Codex t1-r2 B4)', () => {
  // 1065 Schedule B line 14 asks for the number of Forms 8805; lines 21, 27 and 28 call for attachments or details Tax Books does not produce.
  assert.deepEqual([entry('form_1065', 'schB.q14_8805_count').answer, entry('form_1065', 'schB.q14_8805_count').when], ['count', { yes: 'schB.q14_foreign_partners' }]);
  for (const [key, q] of [['blocked.721c', 'schB.q21_721c'], ['stmt.707_8', 'schB.q27_707_8'], ['blocked.7874', 'schB.q28_7874']]) {
    assert.deepEqual([entry('form_1065', key).status, entry('form_1065', key).when], ['unsupported', { yes: q }], key);
  }
  // 1065 K-1 item K: the lower-tier and guarantee checkboxes are answered for each partner.
  for (const k of ['k1.item_k2_lower_tier', 'k1.item_k3_guarantees']) assert.deepEqual([entry('form_1065', k).answer, entry('form_1065', k).scope], ['yesno', 'owner'], k);
  // 1120-S item G: Form 2553 is attached when the election is made this year and it was not already filed.
  assert.equal(stateOf('form_1120s', { 'p1.item_g_electing_s': true, 'p1.item_g_2553_filed': false }, 'form.2553').state, 'unsupported');
  assert.equal(stateOf('form_1120s', { 'p1.item_g_electing_s': true, 'p1.item_g_2553_filed': true }, 'form.2553').state, 'not_required');
  // 1120-S Schedule K line 12d asks for the type of section 59(e)(2) expenditure beside the amount.
  assert.equal(stateOf('form_1120s', { 'amount:f1120s.k.12d': '4000' }, 'schK.q12d_59e_type').state, 'required');
  // 1120-S line 23a (excess net passive income or LIFO recapture tax) and the credit lines on both returns have no Tax Books computation or form.
  assert.equal(stateOf('form_1120s', { 'amount:f1120s.p1.23a': '100' }, 'tax.p1_23a').state, 'unsupported');
  const credits = rt => conditionNames(entry(rt, 'form.credit_forms').when);
  assert.deepEqual(credits('form_1065'), ['f1065.k.15a', 'f1065.k.15b', 'f1065.k.15c', 'f1065.k.15d', 'f1065.k.15e', 'f1065.k.15f'].map(x => `amount:${x}`));
  assert.deepEqual(credits('form_1120s'), ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(x => `amount:f1120s.k.13${x}`));
});

// Codex t1-r3 N4/N5: Form 1065 page 1 lines 24-32a and Schedule B line 1's Other detail have explicit rules.
test('1065 tax-and-payment lines 24-32a are declared, each blocking when it applies; Schedule B line 1 Other requires its description', () => {
  const q = ['tax.q24_lookback_8697', 'tax.q25_lookback_8866', 'tax.q26_bba_aar', 'tax.q27_other_taxes', 'tax.q29_elective_payment', 'tax.q30_payment'];
  const allNo = Object.fromEntries(q.map(k => [k, false]));
  assert.equal(stateOf('form_1065', allNo, 'tax.p1_28_32a').state, 'not_required');
  assert.equal(stateOf('form_1065', {}, 'tax.p1_28_32a').state, 'unresolved', 'unanswered is never an empty tax section');
  for (const [k, entryKey] of [['tax.q24_lookback_8697', 'tax.p1_24_form_8697'], ['tax.q25_lookback_8866', 'tax.p1_25_form_8866'], ['tax.q26_bba_aar', 'tax.p1_26_imputed_underpayment'],
    ['tax.q27_other_taxes', 'tax.p1_27_other_taxes'], ['tax.q29_elective_payment', 'tax.p1_29_elective_payment'], ['tax.q30_payment', 'tax.p1_30_payment']]) {
    const facts = { ...allNo, [k]: true };
    assert.equal(stateOf('form_1065', facts, entryKey).state, 'unsupported', entryKey);
    assert.equal(stateOf('form_1065', facts, 'tax.p1_28_32a').state, 'unsupported', `${k} makes lines 28-32a apply`);
  }
  // Line 1: the six boxes as printed; f "Other" needs its description; e "Foreign partnership" is outside v1.
  assert.deepEqual(entry('form_1065', 'schB.q1_entity_type').choices.map(([k]) => k), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.equal(stateOf('form_1065', { 'schB.q1_entity_type': 'f' }, 'schB.q1_other').state, 'required');
  assert.equal(stateOf('form_1065', { 'schB.q1_entity_type': 'c' }, 'schB.q1_other').state, 'not_required');
  assert.equal(stateOf('form_1065', {}, 'schB.q1_other').state, 'unresolved');
  assert.equal(stateOf('form_1065', { 'schB.q1_entity_type': 'e' }, 'blocked.foreign_partnership').state, 'unsupported');
  // A choice condition must name a declared choice of a choice question.
  const extra = (when) => validateManifest('form_1065', [...filingManifest('form_1065', 2025), { key: 'z.z', label: 'z', kind: 'form', source: 'engine', status: 'supported', scope: 'return', when }]).join(' ');
  assert.match(extra({ is: ['schB.q1_entity_type', 'g'] }), /g is not a declared choice of schB\.q1_entity_type/);
  assert.match(extra({ is: ['tax.q27_other_taxes', 'yes'] }), /not a choice/);
});

// Codex t1-r4 N4: a prepayment with no tax due still blocks; unanswered keeps the section unresolved.
// Codex t1-r4 N6: an answer outside a choice question's declared choices is refused, never read as "not this choice".
test('line 30 payment is its own question; invalid choice answers are refused; choice conditions are validated by operator', () => {
  const others = { 'tax.q24_lookback_8697': false, 'tax.q25_lookback_8866': false, 'tax.q26_bba_aar': false, 'tax.q27_other_taxes': false, 'tax.q29_elective_payment': false };
  assert.equal(stateOf('form_1065', { ...others, 'tax.q30_payment': true }, 'tax.p1_28_32a').state, 'unsupported', 'a prepayment with nothing due');
  assert.equal(stateOf('form_1065', others, 'tax.p1_28_32a').state, 'unresolved', 'payment not yet answered');
  assert.equal(stateOf('form_1065', { ...others, 'tax.q30_payment': 'unknown' }, 'tax.p1_28_32a').state, 'unresolved');
  for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) assert.ok(stateOf('form_1065', { 'schB.q1_entity_type': k }, 'schB.q1_other'));
  for (const bad of [null, '', true, 0, 'g', [], {}, 'Other', 'Foreign partnership']) {
    assert.throws(() => filingManifestFor('form_1065', 2025, { 'schB.q1_entity_type': bad }), /schB\.q1_entity_type must be one of a, b, c, d, e, f/, JSON.stringify(bad));
  }
  const extra = (when) => validateManifest('form_1065', [...filingManifest('form_1065', 2025), { key: 'z.z', label: 'z', kind: 'form', source: 'engine', status: 'supported', scope: 'return', when }]).join(' ');
  assert.match(extra({ is: ['hasRental', 'f'] }), /hasRental is not a choice question/);
  assert.match(extra({ all: [{ is: ['schB.q1_entity_type', 'f'] }, { yes: 'schB.q1_entity_type' }] }), /read both as a choice and another way/);
  assert.match(extra({ is: ['no.such_question', 'f'] }), /unknown choice question no\.such_question/);
});
