// test/tax-mapping-disregarded.test.js — a disregarded company's Mapping link leads to the return that includes its books (its books are
// never mapped on its own period); without an including return it goes back to its tax page with the reason; nothing is posted there.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './app-harness.js';
import { createCompany } from '../lib/data/companies.js';
import { saveProfile, openPeriod } from '../lib/tax/periods.js';
import { saveActivity, listActivities, includeBooks } from '../lib/tax/activities.js';

let app, pool, orgId;
const profile = (entityId, returnType, extra = {}) => saveProfile(pool, { orgId, entityId, fields: { returnType, taxMethodDefault: 'cash', bookBasisDefault: 'cash', yearEndMonth: 12, ...extra }, reason: 'setup', actor: 'test' });
before(async () => { app = await startApp({ env: { SETTINGS_KEY: 'ab'.repeat(32) } }); pool = app.db.pool; orgId = app.ids.orgId; });
after(async () => { await app.close(); });

test('a disregarded company’s mapping page sends the person to the including return, or back to its tax page with the reason', async () => {
  const parent = await createCompany(pool, { orgId, name: 'Parent Holdings', timeZone: 'America/Chicago' });
  const kid = await createCompany(pool, { orgId, name: 'Kid Feed Co', timeZone: 'America/Chicago' });
  const loner = await createCompany(pool, { orgId, name: 'Loner Co', timeZone: 'America/Chicago' });
  await profile(parent, 'form_1065');
  for (const e of [kid, loner]) await profile(e, 'disregarded', { activityKind: 'trade' });
  const returnId = await openPeriod(pool, { orgId, entityId: parent, year: 2026, actor: 'test' });
  for (const e of [kid, loner]) await openPeriod(pool, { orgId, entityId: e, year: 2026, actor: 'test' });
  await saveActivity(pool, { orgId, entityId: parent, fields: { kind: 'trade', name: 'Kid Feed Co', schedule: 'p1', from: '2020-01-01', to: '', disposedOn: '' } });
  const [act] = await listActivities(pool, { orgId, entityId: parent });
  await includeBooks(pool, { orgId, entityId: parent, returnId, activityId: act.activity_id, sourceEntityId: kid, approvedBy: 'test' });

  let res = await app.get(`/tax/${kid}/2026/mapping`);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), `/tax/${parent}/2026/mapping`);
  const page = await (await app.get(res.headers.get('location'))).text();
  assert.match(page, /Kid Feed Co’s books are mapped here, on Parent Holdings’s return/);

  res = await app.get(`/tax/${loner}/2026/mapping`);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), `/tax/${loner}/profile`);
  assert.match(await (await app.get(`/tax/${loner}/profile`)).text(), /not included in a return for 2026 yet/);

  // Nothing is posted on a disregarded company's own period.
  res = await app.post(`/tax/${kid}/2026/mapping/bind`, { source_entity_id: String(kid), account_id: '1' });
  assert.equal(res.status, 409);
});
