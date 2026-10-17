// test/tax-t2-isolation.test.js — T2 never writes to the ledger, and forged ids of another company or organization are refused.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { t2Db, company, acct, je, lineOf, period, activity, party } from './tax-t2-fixtures.js';
import { saveBindings, clearBindings, attributeLine, removeAttribution, copyForward, resolveReferences, listBindings, listAttributions } from '../lib/tax/bindings.js';
import { coverage } from '../lib/tax/coverage.js';
import { suggestionsFor, acceptAllSure } from '../lib/tax/suggest.js';
import { measureLines } from '../lib/tax/measure.js';

let t, pool, orgId, L, ret, A, other;
before(async () => {
  t = await t2Db(); pool = t.pool; orgId = t.orgId;
  L = { orgId, entityId: await company(pool, orgId, 'Lark Partners') };
  ret = await period(pool, L, 2025, 'form_1065', { taxMethod: 'accrual' });
  A = {};
  for (const n of ['Checking', 'Services', 'Wages', 'Rent & Lease', 'Owner’s Draw']) A[n] = await acct(pool, L, n);
  A.t1 = await je(pool, L, '2025-02-01', [[A.Checking, 90000], [A.Services, -90000]]);
  await je(pool, L, '2025-03-01', [[A.Wages, 30000], [A['Rent & Lease'], 12000], [A.Checking, -42000]]);
  const { rows: [o] } = await pool.query(`INSERT INTO org (slug, name) VALUES ('t2_iso', 'Isolation Sample Org') RETURNING org_id`);
  other = { orgId: Number(o.org_id) };
  other.entityId = await company(pool, other.orgId, 'Other Org Partners');
  other.ret = await period(pool, other, 2025, 'form_1065');
  other.wages = await acct(pool, other, 'Wages');
  other.party = await party(pool, other.orgId, 'Other Org Owner');
  other.act = await activity(pool, other, { name: 'Other org trade' });
});
after(async () => { await t.db.drop(); });

const ledgerHash = async () => (await pool.query(`SELECT
  md5(coalesce((SELECT string_agg(posting_id || ':' || txn_id || ':' || account_id || ':' || amount_cents || ':' || txn_date, ',' ORDER BY posting_id) FROM posting), '')) AS postings,
  md5(coalesce((SELECT string_agg(txn_id || ':' || txn_version(txn_id), ',' ORDER BY txn_id) FROM txn), '')) AS txns,
  md5(coalesce((SELECT string_agg(application_id || ':' || amount_cents || ':' || applied_on, ',' ORDER BY application_id) FROM application), '')) AS applications`)).rows[0];

test('T2 never writes to the ledger: postings, transactions and applications hash the same after every T2 operation', async () => {
  const before = await ledgerHash();
  const scope = { ...L, returnId: ret, sourceEntityId: L.entityId, actor: 'tester' };
  await saveBindings(pool, { ...scope, accountId: A.Wages, measurement: 'activity', rows: [{ treatment: 'input', destination: 'f1065.p1.9' }], makeDefault: true });
  await saveBindings(pool, { ...scope, accountId: A['Rent & Lease'], measurement: 'activity', split: 'shares', rows: [{ treatment: 'input', destination: 'f1065.p1.13', share: '1/3' }, { treatment: 'statement_row', destination: 'f1065.p1.21', share: '2/3' }] });
  const shown = (await measureLines(pool, { orgId, sourceEntityId: L.entityId, accountIds: [A.Checking], periodStart: '2025-01-01', periodEnd: '2025-12-31' })).get(A.Checking).find(l => l.txnId === Number(A.t1));
  const lineId = await attributeLine(pool, { ...scope, accountId: A.Checking, txnId: A.t1, lineNo: await lineOf(pool, A.t1, A.Checking), expectTxnVersion: shown.txnVersion, target: { treatment: 'not_tax', memo: 'Owner funds deposited' } });
  await removeAttribution(pool, { ...scope, bindingLineId: lineId });
  await copyForward(pool, { ...L, returnId: ret, actor: 'tester' });
  await resolveReferences(pool, { ...L, returnId: ret });
  const cov = await coverage(pool, { ...L, returnId: ret });
  const list = await suggestionsFor(pool, { orgId, cov, companyIds: [L.entityId] });
  await acceptAllSure(pool, { ...L, returnId: ret, companyIds: [L.entityId], shown: list.filter(s => s.sure).map(s => s.decision), actor: 'tester' });
  await clearBindings(pool, { ...scope, accountId: A.Wages, measurement: 'activity' });
  assert.deepEqual(await ledgerHash(), before);
});

test('forged ids of another company or organization are refused, or list nothing', async () => {
  const save = o => saveBindings(pool, { ...L, returnId: ret, sourceEntityId: L.entityId, measurement: 'activity', rows: [{ treatment: 'input', destination: 'f1065.p1.9' }], actor: 'tester', ...o });
  await assert.rejects(save({ accountId: other.wages }), /Account not found/);
  await assert.rejects(save({ returnId: other.ret, accountId: A.Wages }), /Period not found/);
  await assert.rejects(save({ sourceEntityId: other.entityId, accountId: other.wages }), /not included in this return/);
  await assert.rejects(save({ accountId: A['Owner’s Draw'], rows: [{ treatment: 'equity_event', destination: 'distribution_cash', interestPartyId: other.party }] }), /Owner not found/);
  await assert.rejects(save({ accountId: A.Services, rows: [{ treatment: 'input', destination: 'f8825.main.2a', activityId: other.act }] }), /Activity not found on this return/);
  await assert.rejects(saveBindings(pool, { ...other, returnId: ret, sourceEntityId: other.entityId, accountId: other.wages, measurement: 'activity', rows: [{ treatment: 'input', destination: 'f1065.p1.9' }], actor: 'tester' }), /Period not found/);
  assert.deepEqual(await listBindings(pool, { orgId: other.orgId, entityId: other.entityId, returnId: ret }), []);
  assert.deepEqual(await listAttributions(pool, { orgId, entityId: other.entityId, returnId: ret }), []);
  assert.equal(await coverage(pool, { orgId: other.orgId, entityId: L.entityId, returnId: ret }), null);
  // The database refuses what the module would: another organization's account on this return.
  await assert.rejects(pool.query(`INSERT INTO tax_binding (org_id, return_id, source_entity_id, account_id, measurement, treatment, destination, target_key, source_version, catalog_edition)
    VALUES ($1,$2,$3,$4,'activity','input','f1065.p1.9','input|f1065.p1.9|a=-|o=-|k=-','v',2025)`, [orgId, ret, L.entityId, other.wages]), /another company than the source|foreign key/);
});
