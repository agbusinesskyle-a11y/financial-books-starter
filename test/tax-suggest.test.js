// test/tax-suggest.test.js — rule and history suggestions, the "sure" test, accept one, accept all sure.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { t2Db, company, acct, je, period, activity } from './tax-t2-fixtures.js';
import { coverage } from '../lib/tax/coverage.js';
import { saveBindings, listBindings, listDefaults } from '../lib/tax/bindings.js';
import { suggestionsFor, acceptSuggestion, acceptAllSure, findDecision, isSure, rulesFor, ruleFor, decisionKey, RULES_VERSION } from '../lib/tax/suggest.js';
import { catalogContext, checkTarget } from '../lib/tax/destinations.js';

test('every rule names a destination its own catalog accepts for that kind of account', () => {
  for (const [rt, sch] of [['form_1065', 'p1'], ['form_1065', 'f8825'], ['form_1120s', 'p1'], ['form_1120s', 'f8825'], ['household_1040', 'sch_c'], ['household_1040', 'sch_e1'], ['household_1040', 'none'], ['household_1040', 'sch_f']]) {
    const ctx = catalogContext({ return_type: rt, form_edition: 2025 });
    for (const r of rulesFor(rt, sch)) for (const type of r.types) for (const m of r.measurements) {
      assert.doesNotThrow(() => checkTarget(ctx, { treatment: r.treatment, destination: r.destination, measurement: m, accountType: type, memo: r.memo }), `${rt}/${sch} rule ${r.id} (${type}, ${m})`);
    }
  }
});

test('the first matching rule wins, specific before general', () => {
  const dest = (type, name, rt = 'form_1065', sch = 'p1', systemKey = null) => ruleFor(rulesFor(rt, sch), { type, name, systemKey })?.destination;
  assert.equal(dest('expense', 'Payroll Taxes'), 'f1065.p1.14');
  assert.equal(dest('expense', 'Wages'), 'f1065.p1.9');
  assert.equal(dest('expense', 'Officer wages'), 'f1065.p1.21', 'never an officer or partner payment as wages');
  assert.equal(dest('other_income', 'Interest Earned'), 'f1065.k.5');
  assert.equal(dest('fixed_asset', 'Accumulated Depreciation'), 'f1065.L.9b');
  assert.equal(dest('fixed_asset', 'Vehicles'), 'f1065.L.9a');
  // Independently expected accounting destinations (Codex B7): contra receivables, asset cost, ambiguous depreciation names, book COGS.
  const rule = (type, name, rt = 'form_1065', sch = 'p1') => ruleFor(rulesFor(rt, sch), { type, name, systemKey: null });
  assert.deepEqual([rule('accounts_receivable', 'Allowance for doubtful accounts').destination, rule('accounts_receivable', 'Allowance for doubtful accounts').confidence], ['f1065.L.2b', 'medium']);
  assert.equal(rule('other_current_asset', 'Allowance for Doubtful Accounts').destination, 'f1065.L.2b');
  assert.equal(rule('accounts_receivable', 'Accounts Receivable (A/R)').destination, 'f1065.L.2a');
  assert.deepEqual([rule('fixed_asset', 'Depreciation equipment').destination, rule('fixed_asset', 'Depreciation equipment').confidence], ['f1065.L.9b', 'low']);
  assert.deepEqual([rule('cost_of_goods_sold', 'Cost of Goods Sold').treatment, rule('cost_of_goods_sold', 'Cost of Goods Sold').destination], ['cogs_tieout', 'f1125a.main.8'], 'book COGS is a tie-out, not purchases');
  assert.deepEqual([rule('cost_of_goods_sold', 'Feed Purchases').treatment, rule('cost_of_goods_sold', 'Feed Purchases').destination], ['cogs_input', 'f1125a.main.2']);
  assert.equal(rule('cost_of_goods_sold', 'Cost of Goods Sold', 'household_1040', 'sch_c').destination, 'f1040.c.42');
  assert.equal(dest('income', 'Rents Received', 'form_1065', 'f8825'), 'f8825.main.2a');
  assert.equal(dest('expense', 'Repairs & Maintenance', 'form_1065', 'f8825'), 'f8825.main.11');
  assert.equal(dest('equity', 'Retained Earnings', 'form_1120s', 'p1', 'retained'), 'f1120s.L.24');
  assert.equal(ruleFor(rulesFor('household_1040', 'none'), { type: 'bank', name: 'Personal Checking', systemKey: null }).treatment, 'not_tax');
});

test('“sure” is high confidence only, and never meals, travel, insurance, taxes, contributions, owners, interest, equity or inventory', () => {
  const base = { confidence: 'high', treatment: 'input', destination: 'f1065.p1.11', accountName: 'Repairs & Maintenance', accountType: 'expense' };
  assert.equal(isSure(base), true);
  assert.equal(isSure({ ...base, confidence: 'medium' }), false);
  for (const accountName of ['Meals', 'Travel', 'Insurance', 'Taxes & Licenses', 'Charitable Contributions', 'Owner’s Draw', 'Interest Paid', 'Partner Loan']) assert.equal(isSure({ ...base, accountName }), false, accountName);
  for (const accountType of ['equity', 'inventory']) assert.equal(isSure({ ...base, accountType }), false, accountType);
  for (const destination of ['f1065.p1.14', 'f1065.p1.15', 'f1065.k.5', 'f1065.k.13a', 'f1065.L.21', 'f1065.L.3', 'f1120s.L.19']) assert.equal(isSure({ ...base, destination }), false, destination);
  for (const treatment of ['equity_event', 'guaranteed_payment', 'k1_booked', 'cogs_input', 'not_tax']) assert.equal(isSure({ ...base, treatment }), false, treatment);
});

let t, pool, orgId, X, ret, A, sib;
before(async () => {
  t = await t2Db(); pool = t.pool; orgId = t.orgId;
  X = { orgId, entityId: await company(pool, orgId, 'Aspen Partners') };
  ret = await period(pool, X, 2025, 'form_1065', { taxMethod: 'accrual' });
  A = {};
  for (const n of ['Checking', 'Services', 'Wages', 'Meals', 'Interest Earned', 'Repairs & Maintenance']) A[n] = await acct(pool, X, n);
  A.Deposits = await acct(pool, X, 'Deposits Held', 'other_current_asset');
  await je(pool, X, '2024-05-01', [[A.Checking, 100000], [A.Services, -100000]]);
  for (const [n, c] of [['Wages', 30000], ['Meals', 5000], ['Repairs & Maintenance', 7000], ['Deposits', 20000]]) await je(pool, X, '2025-02-01', [[A[n], c], [A.Checking, -c]]);
  await je(pool, X, '2025-02-02', [[A.Checking, 1500], [A['Interest Earned'], -1500]]);
  // Sibling companies' defaults: two partnerships agree on "Deposits Held" and on "Repairs & Maintenance"; an S corporation's default
  // for "Deposits Held" is another return type and never counts.
  sib = [];
  for (const [name, rt] of [['Birch Partners', 'form_1065'], ['Elm Partners', 'form_1065'], ['Fir Sample Corp', 'form_1120s']]) {
    const S = { orgId, entityId: await company(pool, orgId, name) };
    const r = await period(pool, S, 2025, rt);
    const dep = await acct(pool, S, 'Deposits Held', 'other_current_asset'), rep = await acct(pool, S, 'Repairs & Maintenance');
    const save = (accountId, measurement, row) => saveBindings(pool, { ...S, returnId: r, sourceEntityId: S.entityId, accountId, measurement, rows: [row], makeDefault: true, actor: 'tester' });
    if (rt === 'form_1065') { await save(dep, 'end', { treatment: 'statement_row', destination: 'f1065.L.6' }); await save(rep, 'activity', { treatment: 'statement_row', destination: 'f1065.p1.21' }); }
    else await save(dep, 'end', { treatment: 'statement_row', destination: 'f1120s.L.14' });
    sib.push(S.entityId);
  }
});
after(async () => { await t.db.drop(); });
const all = () => [X.entityId, ...sib];
const sugg = async (companyIds = all()) => suggestionsFor(pool, { orgId, cov: await coverage(pool, { ...X, returnId: ret }), companyIds });
const find = (list, accountId, measurement) => list.find(s => s.accountId === accountId && s.measurement === measurement);

test('rule first, then history from sibling companies of the same return type; agreement raises confidence, disagreement lowers it', async () => {
  const list = await sugg();
  const at = (id, m) => find(list, id, m);
  assert.deepEqual([at(A.Checking, 'end').destination, at(A.Checking, 'end').confidence, at(A.Checking, 'end').sure], ['f1065.L.1', 'high', true]);
  assert.deepEqual([at(A.Wages, 'activity').destination, at(A.Wages, 'activity').sure], ['f1065.p1.9', true]);
  assert.deepEqual([at(A.Meals, 'activity').destination, at(A.Meals, 'activity').sure], ['f1065.p1.21', false]);
  assert.deepEqual([at(A['Interest Earned'], 'activity').destination, at(A['Interest Earned'], 'activity').confidence, at(A['Interest Earned'], 'activity').sure], ['f1065.k.5', 'high', false]);
  const rep = at(A['Repairs & Maintenance'], 'activity');
  assert.deepEqual([rep.source, rep.destination, rep.confidence, rep.sure, rep.alternatives[0].source, rep.alternatives[0].destination], ['rule', 'f1065.p1.11', 'medium', false, 'history', 'f1065.p1.21']);
  const dep = at(A.Deposits, 'end');
  assert.deepEqual([dep.destination, dep.confidence, dep.sure], ['f1065.L.6', 'high', true]);
  assert.equal(at(A.Deposits, 'begin'), undefined, 'a zero beginning needs no binding, so nothing is suggested for it');
  // Only companies the person may open count as history.
  const mine = await sugg([X.entityId]);
  assert.deepEqual([find(mine, A.Deposits, 'end').confidence, find(mine, A['Repairs & Maintenance'], 'activity').confidence], ['medium', 'high']);
});

test('accept all sure takes exactly the sure suggestions shown, records source, rule version and the version shown, and makes them defaults', async () => {
  const sure = (await sugg()).filter(s => s.sure);
  assert.equal((await acceptAllSure(pool, { ...X, returnId: ret, companyIds: all(), shown: [], actor: 'tester' })).accepted, 0, 'nothing shown, nothing accepted');
  const r = await acceptAllSure(pool, { ...X, returnId: ret, companyIds: all(), shown: sure.map(s => s.decision), actor: 'tester' });
  assert.deepEqual([r.accepted, r.skipped.length], [sure.length, 0]);
  const bound = await listBindings(pool, { ...X, returnId: ret });
  const checking = bound.find(b => b.account_id === A.Checking && b.measurement === 'end');
  assert.deepEqual([checking.source, checking.confidence, checking.source_detail.rulesVersion], ['rule', 'high', RULES_VERSION]);
  assert.ok(!bound.some(b => b.account_id === A.Meals), 'a medium suggestion is never accepted by “Accept all sure”');
  assert.ok((await listDefaults(pool, X)).some(d => d.account_id === A.Wages && d.destination === 'f1065.p1.9'));
  const { rows } = await pool.query(`SELECT status, source, source_version, shown_cents::text AS cents FROM tax_binding_suggestion WHERE org_id = $1 AND return_id = $2 ORDER BY suggestion_id`, [orgId, ret]);
  assert.equal(rows.length, sure.length);
  assert.ok(rows.every(x => x.status === 'accepted' && x.source_version.length === 32));
  assert.ok(rows.some(x => x.cents === '30000'), 'the wages amount shown is recorded');
});

test('a suggestion accepted after its account moved is refused (the version shown no longer holds)', async () => {
  const meals = find(await sugg(), A.Meals, 'activity');
  await je(pool, X, '2025-03-01', [[A.Meals, 999], [A.Checking, -999]]);
  await assert.rejects(acceptSuggestion(pool, { ...X, returnId: ret, companyIds: all(), decision: meals.decision, actor: 'tester' }), /changed since the page was shown/);
});

test('an accepted decision is exactly the one shown (B7): a renamed account, another mapper’s save or a replay is refused', async () => {
  A.Crew = await acct(pool, X, 'Repair Crew', 'expense');
  await je(pool, X, '2025-04-01', [[A.Crew, 6000], [A.Checking, -6000]]);
  const shown = (await sugg([X.entityId])).find(s => s.accountId === A.Crew);
  assert.deepEqual([shown.destination, shown.sure], ['f1065.p1.11', true]);
  // Renamed without a posting changing: the same key would now save wages — refused, and the page must be looked at again.
  await pool.query(`UPDATE account SET name = 'Temporary salaries' WHERE account_id = $1`, [A.Crew]);
  assert.equal(await findDecision(pool, { ...X, returnId: ret, companyIds: [X.entityId], decision: shown.decision }), null);
  assert.equal((await acceptAllSure(pool, { ...X, returnId: ret, companyIds: [X.entityId], shown: [shown.decision], actor: 'tester' })).accepted, 0);
  await assert.rejects(acceptSuggestion(pool, { ...X, returnId: ret, companyIds: [X.entityId], decision: shown.decision, actor: 'tester' }), /changed since the page was shown/);
  assert.ok(!(await listBindings(pool, { ...X, returnId: ret })).some(b => b.account_id === A.Crew), 'nothing was saved');
  await pool.query(`UPDATE account SET name = 'Repair Crew' WHERE account_id = $1`, [A.Crew]);
  // Another mapper saves an intentional mapping after the page was shown: the stale suggestion does not overwrite it.
  const again = (await sugg([X.entityId])).find(s => s.accountId === A.Crew);
  await saveBindings(pool, { ...X, returnId: ret, sourceEntityId: X.entityId, accountId: A.Crew, measurement: 'activity', rows: [{ treatment: 'statement_row', destination: 'f1065.p1.21' }], actor: 'other mapper' });
  await assert.rejects(acceptSuggestion(pool, { ...X, returnId: ret, companyIds: [X.entityId], decision: again.decision, actor: 'tester' }), /changed since the page was shown/);
  assert.equal((await listBindings(pool, { ...X, returnId: ret })).find(b => b.account_id === A.Crew).destination, 'f1065.p1.21');
  // A replayed key, after the decision was accepted once, finds nothing to accept.
  await pool.query('DELETE FROM tax_binding WHERE account_id = $1', [A.Crew]);
  const fresh = (await sugg([X.entityId])).find(s => s.accountId === A.Crew);
  assert.equal((await acceptAllSure(pool, { ...X, returnId: ret, companyIds: [X.entityId], shown: [fresh.decision], actor: 'tester' })).accepted, 1);
  const replay = await acceptAllSure(pool, { ...X, returnId: ret, companyIds: [X.entityId], shown: [fresh.decision], actor: 'tester' });
  assert.deepEqual([replay.accepted, replay.stale], [0, 1]);
  assert.equal(decisionKey({ ...fresh, destination: 'f1065.p1.9' }) === fresh.decision, false, 'the key covers the destination');
});

test('drift between lookup and save is refused (Codex r2 B7): the history behind the confidence, or the activity the suggestion would use', async () => {
  // Shown: the repairs rule, high, no history. Then a sibling partnership's default for the same name disagrees: same rule, same
  // destination, lower confidence — not the decision that was shown.
  A.Shop = await acct(pool, X, 'Shop Repairs', 'expense');
  await je(pool, X, '2025-05-01', [[A.Shop, 700], [A.Checking, -700]]);
  const shown = find(await sugg(), A.Shop, 'activity');
  assert.deepEqual([shown.destination, shown.confidence], ['f1065.p1.11', 'high']);
  const B = { orgId, entityId: sib[0] };
  const bRet = Number((await pool.query('SELECT return_id FROM tax_return WHERE org_id = $1 AND entity_id = $2', [orgId, B.entityId])).rows[0].return_id);
  await saveBindings(pool, { ...B, returnId: bRet, sourceEntityId: B.entityId, accountId: await acct(pool, B, 'Shop Repairs', 'expense'), measurement: 'activity',
    rows: [{ treatment: 'statement_row', destination: 'f1065.p1.21' }], makeDefault: true, actor: 'sibling mapper' });
  const now = find(await sugg(), A.Shop, 'activity');
  assert.deepEqual([now.destination, now.confidence], ['f1065.p1.11', 'medium']);
  await assert.rejects(acceptSuggestion(pool, { ...X, returnId: ret, companyIds: all(), decision: shown.decision, actor: 'tester' }), /changed since the page was shown/);
  // An activity-specific suggestion: one activity in effect, so it is chosen; a second one appears before the save — refused.
  await activity(pool, X, { name: 'Aspen trade' });
  A.Seed = await acct(pool, X, 'Seed Purchases', 'cost_of_goods_sold');
  await je(pool, X, '2025-05-02', [[A.Seed, 900], [A.Checking, -900]]);
  const seed = find(await sugg(), A.Seed, 'activity');
  assert.deepEqual([seed.treatment, seed.destination, typeof seed.activityId], ['cogs_input', 'f1125a.main.2', 'number']);
  await activity(pool, X, { name: 'Aspen second trade' });
  await assert.rejects(acceptSuggestion(pool, { ...X, returnId: ret, companyIds: all(), decision: seed.decision, actor: 'tester' }), /changed since the page was shown/);
  assert.ok(!(await listBindings(pool, { ...X, returnId: ret })).some(b => [A.Shop, A.Seed].includes(b.account_id)), 'nothing was saved');
  // The key names its return.
  assert.notEqual(decisionKey({ ...shown, returnId: shown.returnId + 1 }), shown.decision);
});
