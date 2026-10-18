// test/tax-manual.test.js — the manual provider's store (spec §4.7, §0 rule 2): which typed items a return needs (the manual lines its T3
// schedules read, per rental property too; the slots T1 gave the manual provider; the K-1 answer), never an engine line; entered, not
// applicable or nothing (unresolved); statement rows named; the K-1 answer takes only "none", and not for a company that holds an interest.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { t2Db, company, period, activity } from './tax-t3-fixtures.js';
import { manualNeeds, saveManualItem, clearManualItem, markRemainingNotApplicable, listManualItems, K1_ANSWER, t3Lines } from '../lib/tax/manual.js';
import { catalogFor } from '../lib/tax/catalog/index.js';
import { assignProvider } from '../lib/tax/providers.js';
import { saveInterest } from '../lib/tax/ownership.js';
import { saveParty } from '../lib/tax/parties.js';
import { ValidationError } from '../lib/data/writes.js';

let t, pool, orgId, H, ret, rental;
const RET = () => ({ return_id: ret, entity_id: H.entityId, return_type: 'form_1065', form_edition: 2025, period_start: '2025-01-01', period_end: '2025-12-31' });
const S = () => ({ ...H, returnId: ret });
before(async () => {
  t = await t2Db(); pool = t.pool; orgId = t.orgId;
  H = { orgId, entityId: await company(pool, orgId, 'Hazel Partners') };
  ret = await period(pool, H, 2025, 'form_1065', { taxMethod: 'accrual' });
  rental = await activity(pool, H, { name: 'Sample warehouse', kind: 'rental', schedule: 'f8825' });
});
after(async () => { await t.db.drop(); });

test('the T3 schedules read every line of page 1, K, L, M-1, the analysis and 1125-A, and the lines their formulas reach (Form 8825 through K line 2)', () => {
  const reach = t3Lines(catalogFor('form_1065', 2025));
  for (const id of ['f1065.p1.16a', 'f1065.k.12', 'f1065.L.9b', 'f1065.m1.4c', 'f1065.anal.1', 'f1125a.main.7', 'f8825.main.21', 'books.ni.total']) assert.ok(reach.has(id), id);
  for (const id of ['f1065.m2.1', 'cap.wp.begin', 'k1_1065.box.1']) assert.ok(!reach.has(id), id);
});

test('the typed items a return needs, per rental property; engine lines are never typed; the K-1 answer is an item of its own', async () => {
  const keys = (await manualNeeds(pool, { orgId, ret: RET() })).map(n => n.key);
  for (const k of ['f1065.p1.16a|activity', 'f1065.p1.6|activity', 'f1065.k.12|activity', 'f8825.main.21|activity', `f8825.main.14|activity=act:${rental}|activity`, K1_ANSWER]) assert.ok(keys.includes(k), k);
  for (const k of ['books.ni.total|activity', 'bridge.m1.dep_addback|activity', 'se.wp.total|activity', 'f1120s.m2.aaa.1|activity', 'f1065.m1.4c|activity']) assert.ok(!keys.includes(k), k);
  await assert.rejects(saveManualItem(pool, { ...S(), itemKey: 'books.ni.total|activity', status: 'entered', amount: '1', enteredBy: 'tester' }), /not a typed item/);
  await assert.rejects(saveManualItem(pool, { ...S(), itemKey: K1_ANSWER, status: 'entered', amount: '1', enteredBy: 'tester' }), /stage T4/);
});

test('entered (an amount, zero included, or named rows), not applicable, or nothing; the bulk answer marks only what was shown and not answered', async () => {
  await saveManualItem(pool, { ...S(), itemKey: 'f1065.p1.16a|activity', status: 'entered', amount: '0', enteredBy: 'tester' });
  await assert.rejects(saveManualItem(pool, { ...S(), itemKey: 'f1065.p1.6|activity', status: 'entered', amount: 'twelve', enteredBy: 'tester' }), e => e instanceof ValidationError && /like 1250\.00/.test(e.message));
  await saveManualItem(pool, { ...S(), itemKey: 'f1065.p1.6|activity', status: 'entered', amount: '-1234.56', enteredBy: 'tester' });
  await assert.rejects(saveManualItem(pool, { ...S(), itemKey: 'f1065.p1.6|activity', status: 'entered', amount: '1', enteredBy: '' }), /Say who decided/);
  let items = await listManualItems(pool, { orgId, returnId: ret });
  assert.deepEqual(items.map(i => [i.item_key, i.status, i.amount]), [['f1065.p1.16a|activity', 'entered', 0n], ['f1065.p1.6|activity', 'entered', -123456n]]);
  const shown = (await manualNeeds(pool, { orgId, ret: RET() })).map(n => n.key);
  assert.equal(await markRemainingNotApplicable(pool, { ...S(), keys: [...shown, 'f1065.p1.9|activity'], enteredBy: 'tester' }), shown.length - 3, 'not the two entered, the K-1 answer, or a key that is not an item');
  await clearManualItem(pool, { ...S(), itemKey: 'f1065.p1.16a|activity' });
  items = await listManualItems(pool, { orgId, returnId: ret });
  assert.equal(items.find(i => i.item_key === 'f1065.p1.16a|activity'), undefined, 'cleared: unresolved again');
  await assert.rejects(clearManualItem(pool, { ...S(), itemKey: 'f1065.p1.16a|activity' }), /Nothing was entered/);
});

test('a slot T1 gave the manual provider is a typed item; a company holding an interest in another of ours cannot answer "no K-1s"', async () => {
  await assignProvider(pool, { ...S(), slotKey: 'f1065.p1.1a|activity', providerKind: 'manual', schemaVersion: 1, sourceRef: { reason: 'reviewed receipts' }, sourceVersion: 'manual:receipts@1' });
  assert.ok((await manualNeeds(pool, { orgId, ret: RET() })).some(n => n.key === 'f1065.p1.1a|activity' && n.assigned));
  await saveManualItem(pool, { ...S(), itemKey: K1_ANSWER, status: 'not_applicable', enteredBy: 'tester' });
  const P = { orgId, entityId: await company(pool, orgId, 'Hazel Payer') };
  await period(pool, P, 2025, 'form_1065', { taxMethod: 'accrual' });
  await saveParty(pool, { orgId, fields: { kind: 'entity_in_org', name: 'Hazel Partners (as owner)', taxId: '', entityId: H.entityId }, env: {} });
  const { rows: [pt] } = await pool.query('SELECT party_id FROM tax_party WHERE org_id = $1 AND entity_id = $2', [orgId, H.entityId]);
  await saveInterest(pool, { ...P, fields: { partyId: pt.party_id, role: 'general_partner', from: '2020-01-01', to: null, profit: '1/2', loss: '1/2', capital: '1/2' }, actor: 'tester' });
  await assert.rejects(saveManualItem(pool, { ...S(), itemKey: K1_ANSWER, status: 'not_applicable', enteredBy: 'tester' }), /receives a K-1/);
});

test('the classified components of another line are typed items on both forms (Codex t3-plan-r1 B10): qualified dividends and investment income, each naming the line it is part of', async () => {
  const need = async (C, r, rt) => (await manualNeeds(pool, { orgId, ret: { return_id: r, entity_id: C.entityId, return_type: rt, form_edition: 2025, period_start: '2025-01-01', period_end: '2025-12-31' } }));
  const p = (await need(H, ret, 'form_1065')).filter(n => n.subsetOf).map(n => [n.key, n.subsetOf]);
  assert.deepEqual(p.sort(), [['f1065.k.11_inv|activity', 'f1065.k.11|activity'], ['f1065.k.6b|activity', 'f1065.k.6a|activity']]);
  const S = { orgId, entityId: await company(pool, orgId, 'Hazel Corp') };
  const sRet = await period(pool, S, 2025, 'form_1120s', { taxMethod: 'accrual' });
  const s = (await need(S, sRet, 'form_1120s')).filter(n => n.subsetOf).map(n => [n.key, n.subsetOf]);
  assert.deepEqual(s.sort(), [['f1120s.k.10_inv|activity', 'f1120s.k.10|activity'], ['f1120s.k.5b|activity', 'f1120s.k.5a|activity']]);
  await saveManualItem(pool, { ...S, returnId: sRet, itemKey: 'f1120s.k.5b|activity', status: 'entered', amount: '12.00', enteredBy: 'tester' });
  assert.deepEqual((await listManualItems(pool, { orgId, returnId: sRet })).map(i => [i.item_key, i.amount]), [['f1120s.k.5b|activity', 1200n]]);
});
