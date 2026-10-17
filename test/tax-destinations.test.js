// test/tax-destinations.test.js — pure: treatments, the picker, provisional catalogs, target and slot keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogContext, checkTarget, pickerOptions, targetKey, slotFor, parseWhat, describeTarget, DERIVED_LINES } from '../lib/tax/destinations.js';

const P = catalogContext({ return_type: 'form_1065', form_edition: 2025 });
const S = catalogContext({ return_type: 'form_1120s', form_edition: 2025 });
const H = catalogContext({ return_type: 'household_1040', form_edition: 2025 });
const t = (ctx, o) => checkTarget(ctx, { measurement: 'activity', accountType: 'expense', ...o });

test('a period whose edition has no catalog binds provisionally against the newest earlier edition; a disregarded period never binds', () => {
  assert.deepEqual(catalogContext({ return_type: 'form_1065', form_edition: 2026 }), { returnType: 'form_1065', edition: 2025, formEdition: 2026, provisional: true });
  assert.deepEqual(P, { returnType: 'form_1065', edition: 2025, formEdition: 2025, provisional: false });
  assert.throws(() => catalogContext({ return_type: 'disregarded', form_edition: 2025 }), /owner’s/);
  assert.throws(() => catalogContext({ return_type: 'form_1065', form_edition: 2024 }), /No catalog edition/);
});

test('inputs bind as form lines, statements as statement rows, typed items only beside them; computed, K-1 and M-1 lines never', () => {
  assert.equal(t(P, { treatment: 'input', destination: 'f1065.p1.9' }).line.id, 'f1065.p1.9');
  assert.throws(() => t(P, { treatment: 'input', destination: 'f1065.p1.21' }), /statement row/);
  assert.equal(t(P, { treatment: 'statement_row', destination: 'f1065.p1.21' }).line.kind, 'statement');
  assert.throws(() => t(P, { treatment: 'input', destination: 'f1065.p1.16a' }), /typed \(manual\) item/);
  assert.equal(t(P, { treatment: 'manual_feed', destination: 'f1065.p1.16a' }).line.kind, 'manual');
  assert.throws(() => t(P, { treatment: 'manual_feed', destination: 'f1065.p1.9' }), /not a typed item/);
  assert.throws(() => t(P, { treatment: 'input', destination: 'f1065.p1.22' }), /computed/);
  assert.throws(() => t(P, { treatment: 'statement_row', destination: 'f1065.p1.4' }), /K-1s received/);
  assert.throws(() => t(P, { treatment: 'input', destination: 'k1_1065.box.1' }), /not bound from the books/);
  assert.throws(() => t(P, { treatment: 'statement_row', destination: 'f1065.m1.2' }), /not bound from the books/);
  assert.throws(() => t(P, { treatment: 'input', destination: 'f1120s.p1.8' }), /not a line of this return/);
  assert.throws(() => t(P, { treatment: 'input', destination: 'f1065.k.16a' }), /answer, not an amount/);
});

test('owner-specific lines come from their own records; COGS lines only through the COGS workpaper, in their roles (B6)', () => {
  for (const id of Object.keys(DERIVED_LINES).filter(i => i.startsWith('f1065'))) assert.throws(() => t(P, { treatment: 'input', destination: id, interestPartyId: 1 }), /comes from/, id);
  assert.throws(() => t(P, { treatment: 'input', destination: 'f1125a.main.2', accountType: 'cost_of_goods_sold' }), /COGS workpaper input/);
  assert.equal(t(P, { treatment: 'cogs_input', destination: 'f1125a.main.2', accountType: 'cost_of_goods_sold' }).activity, true);
  assert.throws(() => t(P, { treatment: 'cogs_input', destination: 'f1065.p1.9' }), /Form 1125-A/);
  assert.throws(() => checkTarget(P, { treatment: 'cogs_input', destination: 'f1125a.main.2', accountType: 'inventory', measurement: 'end' }), /tax inventory/);
  assert.equal(checkTarget(H, { treatment: 'cogs_input', destination: 'f1040.c.36', accountType: 'cost_of_goods_sold', measurement: 'activity' }).activity, true);
  // Opening and closing inventory are tax inventory, established on the workpaper: never routed from an account's activity or balance.
  for (const id of ['f1125a.main.1', 'f1125a.main.7']) {
    assert.throws(() => t(P, { treatment: 'cogs_input', destination: id, accountType: 'cost_of_goods_sold' }), /tax inventory is established/, id);
    assert.throws(() => t(P, { treatment: 'cogs_input', destination: id, accountType: 'income' }), /tax inventory is established/, `${id} from income`);
  }
  assert.throws(() => checkTarget(H, { treatment: 'cogs_input', destination: 'f1040.c.41', accountType: 'cost_of_goods_sold', measurement: 'activity' }), /tax inventory is established/);
  // Book cost of goods sold is a tie-out compared with line 8, never purchases.
  const tie = t(P, { treatment: 'cogs_tieout', destination: 'f1125a.main.8', accountType: 'cost_of_goods_sold' });
  assert.deepEqual([tie.line.id, tie.activity], ['f1125a.main.8', true]);
  assert.throws(() => t(P, { treatment: 'cogs_tieout', destination: 'f1125a.main.2', accountType: 'cost_of_goods_sold' }), /compared with Form 1125-A line 8/);
  assert.throws(() => checkTarget(P, { treatment: 'cogs_tieout', destination: 'f1125a.main.8', accountType: 'inventory', measurement: 'end' }), /expense account’s activity/);
  assert.equal(slotFor(P, { treatment: 'cogs_tieout', line: tie.line, measurement: 'activity', activityId: 3 }), null, 'a comparison feeds no slot');
});

test('classified components of another line are not split off as consuming inputs (B6)', () => {
  assert.throws(() => t(P, { treatment: 'input', destination: 'f1065.k.6b', accountType: 'other_income' }), /classified part of another line: bind the account to K\.6a/);
  assert.throws(() => t(P, { treatment: 'input', destination: 'f1065.k.11_inv', accountType: 'other_income' }), /classified part/);
  assert.throws(() => t(S, { treatment: 'input', destination: 'f1120s.k.5b', accountType: 'other_income' }), /classified part/);
  assert.equal(t(P, { treatment: 'input', destination: 'f1065.k.6a', accountType: 'other_income' }).line.id, 'f1065.k.6a');
});

test('measurements follow the account and the line', () => {
  assert.throws(() => checkTarget(P, { treatment: 'input', destination: 'f1065.p1.9', accountType: 'expense', measurement: 'end' }), /starts at zero every year/);
  assert.throws(() => checkTarget(P, { treatment: 'input', destination: 'f1065.L.1', accountType: 'bank', measurement: 'activity' }), /balance-sheet account’s activity/);
  assert.throws(() => checkTarget(P, { treatment: 'input', destination: 'f1065.p1.1a', accountType: 'other_current_liability', measurement: 'end' }), /takes the activity in the period, not the ending balance/);
  assert.equal(checkTarget(P, { treatment: 'input', destination: 'f1065.L.1', accountType: 'bank', measurement: 'end' }).line.id, 'f1065.L.1');
});

test('owners, guaranteed payments, K-1 income and not-on-the-return each say what they need', () => {
  const eq = { treatment: 'equity_event', destination: 'distribution_cash', accountType: 'equity', measurement: 'activity' };
  assert.throws(() => checkTarget(P, eq), /owner/);
  assert.equal(checkTarget(P, { ...eq, interestPartyId: 3 }).interest, true);
  assert.throws(() => checkTarget(P, { ...eq, destination: 'gift', interestPartyId: 3 }), /kind of equity event/);
  assert.throws(() => checkTarget(H, { ...eq, interestPartyId: 3 }), /partnership or S corporation return/);
  assert.throws(() => checkTarget(S, { treatment: 'guaranteed_payment', destination: 'services', accountType: 'expense', measurement: 'activity', interestPartyId: 3 }), /partnership item/);
  assert.equal(checkTarget(P, { treatment: 'guaranteed_payment', destination: 'services', accountType: 'expense', measurement: 'activity', interestPartyId: 3 }).interest, true);
  assert.throws(() => t(P, { treatment: 'k1_booked', accountType: 'other_income' }), /partnership or S corporation whose K-1/);
  assert.equal(t(P, { treatment: 'k1_booked', accountType: 'other_income', k1IssuerPartyId: 4 }).k1, true);
  assert.throws(() => t(P, { treatment: 'not_tax' }), /memo is required/);
  assert.equal(t(P, { treatment: 'not_tax', memo: 'Owner’s personal expense, reimbursed' }).line, null);
});

test('per-activity and per-owner lines name their dimension; target and slot keys are canonical; an unresolved dimension never guesses a slot', () => {
  const n = checkTarget(P, { treatment: 'input', destination: 'f8825.main.2a', accountType: 'income', measurement: 'activity' });
  assert.equal(n.activity, true);
  assert.equal(slotFor(P, { treatment: 'input', line: n.line, measurement: 'activity', activityId: 12 }), 'f8825.main.2a|activity=act:12|activity');
  assert.equal(slotFor(P, { treatment: 'input', line: n.line, measurement: 'activity', activityId: null }), null);
  const o = checkTarget(S, { treatment: 'input', destination: 'f1120s.L.19', accountType: 'long_term_liability', measurement: 'end', interestPartyId: 8 });
  assert.equal(slotFor(S, { treatment: 'input', line: o.line, measurement: 'end', interestId: null }), null);
  assert.equal(slotFor(S, { treatment: 'input', line: o.line, measurement: 'end', interestId: 31 }), 'f1120s.L.19|interest=i:31|end');
  assert.equal(slotFor(P, { treatment: 'equity_event', line: null, measurement: 'activity' }), null);
  assert.equal(targetKey({ treatment: 'input', destination: 'f1065.p1.9' }), 'input|f1065.p1.9|a=-|o=-|k=-');
  assert.equal(targetKey({ treatment: 'equity_event', destination: 'distribution_cash', interestPartyId: 5 }), 'equity_event|distribution_cash|a=-|o=5|k=-');
  assert.deepEqual(parseWhat('statement_row:f1065.p1.21'), { treatment: 'statement_row', destination: 'f1065.p1.21' });
  assert.deepEqual(parseWhat('not_tax:'), { treatment: 'not_tax', destination: null });
  assert.deepEqual(parseWhat('k1_booked:'), { treatment: 'k1_booked', destination: null }, 'a treatment name with a digit');
  assert.throws(() => parseWhat('something:else'), /Choose where/);
  assert.equal(describeTarget(P, { treatment: 'input', destination: 'f1065.p1.9' }), 'p1.9 Salaries and wages (other than to partners)');
  assert.equal(describeTarget(P, { treatment: 'equity_event', destination: 'distribution_cash' }), 'Distribution: cash');
  assert.equal(describeTarget(P, { treatment: 'cogs_tieout', destination: 'f1125a.main.8' }), '1125-A line 8 Cost of goods sold (book COGS, compared)');
});

test('the picker groups destinations by section and offers only what the account can take', () => {
  const groups = pickerOptions(P, 'expense');
  assert.ok(groups.some(g => g.label === 'Page 1: income and deductions'));
  assert.ok(!groups.some(g => g.label === 'Schedule L: balance sheet'));
  const exp = groups.flatMap(g => g.options.map(o => o.value));
  for (const v of ['input:f1065.p1.9', 'statement_row:f1065.p1.21', 'manual_feed:f1065.p1.16a', 'guaranteed_payment:services', 'cogs_input:f1125a.main.2', 'cogs_tieout:f1125a.main.8', 'not_tax:']) assert.ok(exp.includes(v), v);
  for (const v of ['input:f1065.p1.10', 'input:f1065.p1.22', 'input:f1065.L.1', 'cogs_input:f1125a.main.1', 'cogs_input:f1125a.main.7', 'input:f1065.k.6b']) assert.ok(!exp.includes(v), v);
  assert.ok(!exp.some(v => v.includes('k1_1065') || v.includes('.m1.')));
  const bank = pickerOptions(P, 'bank').flatMap(g => g.options.map(o => o.value));
  assert.ok(bank.includes('input:f1065.L.1') && bank.includes('equity_event:distribution_cash') && !bank.includes('input:f1065.p1.9'));
  const household = pickerOptions(H, 'bank').flatMap(g => g.options.map(o => o.value));
  assert.deepEqual(household, ['k1_booked:', 'not_tax:'], 'a household has no balance sheet: its balances are not on the return');
  assert.ok(groups.flatMap(g => g.options).every(o => o.label.length <= 70), 'option labels stay short enough for a phone');
});
