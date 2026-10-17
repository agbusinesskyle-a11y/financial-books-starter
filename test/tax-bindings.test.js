// test/tax-bindings.test.js — saving binding sets: whole, shares, amounts, scope, provider exclusivity, defaults, refusals.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { t2Db, company, acct, je, period, activity, party } from './tax-t2-fixtures.js';
import { saveBindings, clearBindings, listBindings, listDefaults, setFingerprint, EMPTY_SET } from '../lib/tax/bindings.js';
import { assignProvider } from '../lib/tax/providers.js';
import { measureAccounts } from '../lib/tax/measure.js';
import { baseVersion } from '../lib/tax/partition.js';

let t, pool, orgId, J, ret, A;
before(async () => {
  t = await t2Db(); pool = t.pool; orgId = t.orgId;
  J = { orgId, entityId: await company(pool, orgId, 'Juniper Partners') };
  ret = await period(pool, J, 2025, 'form_1065', { taxMethod: 'accrual' });
  A = {};
  for (const n of ['Checking', 'Services', 'Wages', 'Rent & Lease', 'Meals', 'Repairs & Maintenance', 'Owner’s Draw', 'Other Income']) A[n] = await acct(pool, J, n);
  await je(pool, J, '2024-12-01', [[A.Checking, 500000], [A.Services, -500000]]);
  await je(pool, J, '2025-03-01', [[A.Wages, 120000], [A.Checking, -120000]]);
  await je(pool, J, '2025-03-02', [[A['Rent & Lease'], 90000], [A.Checking, -90000]]);
  await je(pool, J, '2025-03-03', [[A.Meals, 30001], [A.Checking, -30001]]);
});
after(async () => { await t.db.drop(); });

const save = o => saveBindings(pool, { ...J, returnId: ret, sourceEntityId: J.entityId, actor: 'tester', ...o });
const rowsOf = async (accountId, measurement = 'activity') => (await listBindings(pool, { ...J, returnId: ret })).filter(b => b.account_id === accountId && b.measurement === measurement);
// The partition base the page shows for an account with no line attributions (lib/tax/partition.js baseVersion).
const version = async (accountId, m = 'activity') => baseVersion((await measureAccounts(pool, { orgId, sourceEntityId: J.entityId, periodStart: '2025-01-01', periodEnd: '2025-12-31' })).get(accountId).versions[m], []);

test('a whole binding records its slot, the measurement version and the catalog edition it was checked against', async () => {
  await save({ accountId: A.Wages, measurement: 'activity', rows: [{ treatment: 'input', destination: 'f1065.p1.9' }] });
  const [b] = await rowsOf(A.Wages);
  assert.deepEqual([b.slot_key, b.target_key, b.source_version, b.catalog_edition, b.override, b.source], ['f1065.p1.9|activity', 'input|f1065.p1.9|a=-|o=-|k=-', await version(A.Wages), 2025, false, 'person']);
  await save({ accountId: A.Checking, measurement: 'end', rows: [{ treatment: 'input', destination: 'f1065.L.1' }] });
  assert.equal((await rowsOf(A.Checking, 'end'))[0].slot_key, 'f1065.L.1|end');
  // Saving again replaces the set; it never adds a second whole row.
  await save({ accountId: A.Wages, measurement: 'activity', rows: [{ treatment: 'statement_row', destination: 'f1065.p1.21', rowLabel: 'Crew wages' }] });
  assert.deepEqual((await rowsOf(A.Wages)).map(b => [b.treatment, b.row_label]), [['statement_row', 'Crew wages']]);
});

test('share splits are exact fractions totalling 1; dollar splits total the measurement exactly', async () => {
  await save({ accountId: A['Rent & Lease'], measurement: 'activity', split: 'shares', rows: [{ treatment: 'input', destination: 'f1065.p1.13', share: '2/3' }, { treatment: 'statement_row', destination: 'f1065.p1.21', share: '1/3' }] });
  assert.deepEqual((await rowsOf(A['Rent & Lease'])).map(b => `${b.share_num_text}/${b.share_den_text}`).sort(), ['1/3', '2/3']);
  await assert.rejects(save({ accountId: A['Rent & Lease'], measurement: 'activity', split: 'shares', rows: [{ treatment: 'input', destination: 'f1065.p1.13', share: '1/3' }, { treatment: 'statement_row', destination: 'f1065.p1.21', share: '1/3' }] }), /total 2\/3; they must total exactly 1/);
  await assert.rejects(save({ accountId: A['Rent & Lease'], measurement: 'activity', split: 'shares', rows: [{ treatment: 'input', destination: 'f1065.p1.13', share: '0.5' }, { treatment: 'statement_row', destination: 'f1065.p1.21', share: '1/2' }] }), /share looks like 1\/3 or 25%/);
  await save({ accountId: A.Meals, measurement: 'activity', split: 'amounts', rows: [{ treatment: 'statement_row', destination: 'f1065.p1.21', amount: '150.01' }, { treatment: 'input', destination: 'f1065.k.18c', amount: '150.00' }] });
  assert.deepEqual((await rowsOf(A.Meals)).map(b => b.amount_text).sort(), ['15000', '15001']);
  await assert.rejects(save({ accountId: A.Meals, measurement: 'activity', split: 'amounts', rows: [{ treatment: 'statement_row', destination: 'f1065.p1.21', amount: '150.00' }, { treatment: 'input', destination: 'f1065.k.18c', amount: '150.00' }] }), /total \$300\.00; the activity left after line attributions is \$300\.01/);
  await assert.rejects(save({ accountId: A.Meals, measurement: 'activity', split: 'amounts', makeDefault: true, rows: [{ treatment: 'statement_row', destination: 'f1065.p1.21', amount: '150.01' }, { treatment: 'input', destination: 'f1065.k.18c', amount: '150.00' }] }), /not a reusable default/);
  await assert.rejects(save({ accountId: A.Meals, measurement: 'activity', split: 'shares', rows: [{ treatment: 'statement_row', destination: 'f1065.p1.21', share: '1/2' }, { treatment: 'statement_row', destination: 'f1065.p1.21', share: '1/2' }] }), /appears once/);
  await assert.rejects(save({ accountId: A.Meals, measurement: 'activity', split: 'whole', rows: [{ treatment: 'statement_row', destination: 'f1065.p1.21' }, { treatment: 'input', destination: 'f1065.k.18c' }] }), /one destination/);
});

test('a save refuses a measurement that moved since the page showed it', async () => {
  const repairs = A['Repairs & Maintenance'];
  const shown = await version(repairs);
  await je(pool, J, '2025-05-01', [[repairs, 2500], [A.Checking, -2500]]);
  await assert.rejects(save({ accountId: repairs, measurement: 'activity', expectVersion: shown, rows: [{ treatment: 'input', destination: 'f1065.p1.11' }] }), /changed since the page was shown/);
  await save({ accountId: repairs, measurement: 'activity', expectVersion: await version(repairs), rows: [{ treatment: 'input', destination: 'f1065.p1.11' }] });
});

test('routing is not authority (B1): a provider assigned to a bound slot leaves the routing in place, and a books routing to a provider’s slot is kept', async () => {
  await assignProvider(pool, { ...J, returnId: ret, slotKey: 'f1065.p1.12|activity', providerKind: 'manual', schemaVersion: 1, sourceVersion: 'manual:9@v1' });
  await save({ accountId: A.Wages, measurement: 'activity', rows: [{ treatment: 'input', destination: 'f1065.p1.12' }] });
  assert.equal((await rowsOf(A.Wages))[0].slot_key, 'f1065.p1.12|activity');
  await assignProvider(pool, { ...J, returnId: ret, slotKey: 'f1065.p1.11|activity', providerKind: 'cash_layer', schemaVersion: 1, sourceVersion: 'cash:1@v1' });
  assert.equal((await rowsOf(A['Repairs & Maintenance']))[0].slot_key, 'f1065.p1.11|activity', 'the repairs routing survives the cash layer taking the slot');
  await assert.rejects(assignProvider(pool, { ...J, returnId: ret, slotKey: 'f1065.p1.11|activity', providerKind: 'manual', schemaVersion: 1, sourceVersion: 'manual:10@v1' }), /already has a provider/, 'two competing authorities are refused (T1)');
  await save({ accountId: A.Wages, measurement: 'activity', rows: [{ treatment: 'input', destination: 'f1065.p1.9' }] });
});

test('a decision is saved only against the binding set and the account it was made for (B7)', async () => {
  // Every field a person decides is in the fingerprint (Codex r2 B5): the same target with another memo or label is another set.
  const row = { target_key: 'not_tax|-|a=-|o=-|k=-', share_num_text: null, share_den_text: null, amount_text: null, row_label: null, memo: 'first reason' };
  assert.notEqual(setFingerprint([row]), setFingerprint([{ ...row, memo: 'second reason' }]));
  assert.notEqual(setFingerprint([row]), setFingerprint([{ ...row, row_label: 'A label' }]));
  const now = (await listBindings(pool, { ...J, returnId: ret })).filter(b => b.account_id === A.Wages && b.measurement === 'activity');
  assert.notEqual(setFingerprint(now), EMPTY_SET);
  await assert.rejects(save({ accountId: A.Wages, measurement: 'activity', expectSet: EMPTY_SET, rows: [{ treatment: 'input', destination: 'f1065.p1.11' }] }), /Someone changed this mapping/);
  await assert.rejects(save({ accountId: A.Wages, measurement: 'activity', expectAccount: { name: 'Repairs', type: 'expense' }, rows: [{ treatment: 'input', destination: 'f1065.p1.11' }] }), /renamed or changed type/);
  await save({ accountId: A.Wages, measurement: 'activity', expectSet: setFingerprint(now), expectAccount: { name: 'Wages', type: 'expense' }, rows: [{ treatment: 'input', destination: 'f1065.p1.9' }] });
});

test('dollar splits are refused where the cash layer decides the base amount (B3): a cash-method return’s activity', async () => {
  const K = { orgId, entityId: await company(pool, orgId, 'Juniper Cash Partners') };
  const kRet = await period(pool, K, 2025, 'form_1065', { taxMethod: 'cash' });
  const kMeals = await acct(pool, K, 'Meals'), kBank = await acct(pool, K, 'Checking');
  await je(pool, K, '2025-03-03', [[kMeals, 30000], [kBank, -30000]]);
  const rows = [{ treatment: 'statement_row', destination: 'f1065.p1.21', amount: '150.00' }, { treatment: 'input', destination: 'f1065.k.18c', amount: '150.00' }];
  await assert.rejects(saveBindings(pool, { ...K, returnId: kRet, sourceEntityId: K.entityId, accountId: kMeals, measurement: 'activity', split: 'amounts', rows, actor: 'tester' }), /cash layer recognizes/);
  await saveBindings(pool, { ...K, returnId: kRet, sourceEntityId: K.entityId, accountId: kMeals, measurement: 'activity', split: 'shares', rows: rows.map(r => ({ ...r, amount: null, share: '1/2' })), actor: 'tester' });
});

test('activities: a per-activity line needs one in effect for the period and on that line’s schedule; other lines take none', async () => {
  const trade = await activity(pool, J, { name: 'Juniper trade', schedule: 'p1' });
  const sold = await activity(pool, J, { name: 'Juniper old rental', kind: 'rental', schedule: 'f8825', from: '2019-01-01', disposedOn: '2024-06-30' });
  const rental = await activity(pool, J, { name: 'Juniper rental', kind: 'rental', schedule: 'f8825', from: '2021-01-01' });
  const row = activityId => [{ treatment: 'input', destination: 'f8825.main.2a', activityId }];
  await assert.rejects(save({ accountId: A['Other Income'], measurement: 'activity', rows: row(null) }), /Choose the activity/);
  await assert.rejects(save({ accountId: A['Other Income'], measurement: 'activity', rows: row(trade) }), /not reported on this form/);
  await assert.rejects(save({ accountId: A['Other Income'], measurement: 'activity', rows: row(sold) }), /not in effect in this period/);
  await save({ accountId: A['Other Income'], measurement: 'activity', rows: row(rental) });
  assert.equal((await rowsOf(A['Other Income']))[0].slot_key, `f8825.main.2a|activity=act:${rental}|activity`);
  // An aggregate line keeps no activity dimension, but the source activity is kept as provenance (B6): T3 and T4 read it.
  await save({ accountId: A.Wages, measurement: 'activity', rows: [{ treatment: 'input', destination: 'f1065.p1.9', activityId: trade }] });
  const [w] = await rowsOf(A.Wages);
  assert.deepEqual([w.slot_key, w.activity_id], ['f1065.p1.9|activity', trade]);
  await assert.rejects(save({ accountId: A.Wages, measurement: 'activity', rows: [{ treatment: 'input', destination: 'f1065.p1.9', activityId: sold }] }), /not in effect/);
  await save({ accountId: A.Wages, measurement: 'activity', rows: [{ treatment: 'input', destination: 'f1065.p1.9' }] });
});

test('owner references are kept as parties and stay pending until the owner’s interest for the period is on file', async () => {
  const owner = await party(pool, orgId, 'Pat Sample Owner');
  await save({ accountId: A['Owner’s Draw'], measurement: 'activity', rows: [{ treatment: 'equity_event', destination: 'distribution_cash', interestPartyId: owner }] });
  const [b] = await rowsOf(A['Owner’s Draw']);
  assert.deepEqual([b.interest_party_id, b.interest_id, b.slot_key], [owner, null, null]);
  assert.match(b.pending[0].reason, /not on file yet/);
  await assert.rejects(save({ accountId: A['Owner’s Draw'], measurement: 'activity', rows: [{ treatment: 'equity_event', destination: 'distribution_cash', interestPartyId: 999999 }] }), /Owner not found/);
  await assert.rejects(save({ accountId: A['Other Income'], measurement: 'activity', rows: [{ treatment: 'k1_booked', k1IssuerPartyId: owner }] }), /must be a partnership or S corporation/);
});

test('defaults: makeDefault stores the set for later periods; a period-local change is marked as an override', async () => {
  await save({ accountId: A.Checking, measurement: 'begin', makeDefault: true, rows: [{ treatment: 'input', destination: 'f1065.L.1' }] });
  const defs = (await listDefaults(pool, J)).filter(d => d.account_id === A.Checking);
  assert.deepEqual(defs.map(d => [d.measurement, d.destination, d.return_type, d.activity_rule]), [['begin', 'f1065.L.1', 'form_1065', 'none']]);
  await save({ accountId: A.Checking, measurement: 'begin', rows: [{ treatment: 'statement_row', destination: 'f1065.L.6' }] });
  assert.equal((await rowsOf(A.Checking, 'begin'))[0].override, true);
  assert.equal((await listDefaults(pool, J)).filter(d => d.account_id === A.Checking)[0].destination, 'f1065.L.1', 'the default is unchanged');
});

test('closed periods, disregarded periods, other companies and unknown accounts refuse; clearing removes one set only', async () => {
  const D = { orgId, entityId: await company(pool, orgId, 'Juniper Child LLC') };
  const dRet = await period(pool, D, 2025, 'disregarded');
  const childWages = await acct(pool, D, 'Wages');
  await assert.rejects(saveBindings(pool, { ...D, returnId: dRet, sourceEntityId: D.entityId, accountId: childWages, measurement: 'activity', rows: [{ treatment: 'input', destination: 'f1065.p1.9' }], actor: 'tester' }), /owner’s/);
  await assert.rejects(save({ sourceEntityId: D.entityId, accountId: childWages, measurement: 'activity', rows: [{ treatment: 'input', destination: 'f1065.p1.9' }] }), /not included in this return/);
  await assert.rejects(save({ accountId: childWages, measurement: 'activity', rows: [{ treatment: 'input', destination: 'f1065.p1.9' }] }), /Account not found/);
  await assert.rejects(saveBindings(pool, { ...D, returnId: ret, sourceEntityId: J.entityId, accountId: A.Wages, measurement: 'activity', rows: [{ treatment: 'input', destination: 'f1065.p1.9' }], actor: 'tester' }), /Period not found/);
  await clearBindings(pool, { ...J, returnId: ret, sourceEntityId: J.entityId, accountId: A.Checking, measurement: 'begin' });
  assert.equal((await rowsOf(A.Checking, 'begin')).length, 0);
  assert.equal((await rowsOf(A.Checking, 'end')).length, 1, 'the ending balance keeps its binding');
  await assert.rejects(clearBindings(pool, { ...J, returnId: ret, sourceEntityId: J.entityId, accountId: A.Checking, measurement: 'begin' }), /Nothing was bound/);
  await pool.query(`UPDATE tax_return SET status = 'review' WHERE org_id = $1 AND return_id = $2`, [orgId, ret]);
  await assert.rejects(save({ accountId: A.Wages, measurement: 'activity', rows: [{ treatment: 'input', destination: 'f1065.p1.9' }] }), /no longer change/);
  await pool.query(`UPDATE tax_return SET status = 'open' WHERE org_id = $1 AND return_id = $2`, [orgId, ret]);
});
