import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb } from './harness.js';
import { mvOrg, mvTxn, mvVendor, mvCustomer, mvApply, mvReadyViewers } from './morning-fixtures.js';
import { createMorningService, MORNING_SECTIONS } from '../lib/data/morning.js';
import { createMorningRuntime, withMorningComputation, morningJobAuthority, MorningTimeoutError } from '../lib/data/morning/locks.js';
import { readVisit, loadGeneration } from '../lib/data/morning/observe.js';
import { prepareItems } from '../lib/data/morning/items.js';
import { billsAndInvoices } from '../lib/data/morning/bills.js';
import { readHomeCurrencyScope } from '../lib/data/morning/balances.js';
import { readWindowEntries } from '../lib/data/morning/entries.js';
import { ownerResetViewer, removeSecondViewer, grantSecondViewer } from '../lib/data/morning/identity.js';
import { findOpenInvite, pendingSecret, completeInvite } from '../lib/data/users.js';
import { makeTotp } from '../lib/auth.js';
import { settingsKey } from '../lib/secrets.js';
import { morningPage } from '../lib/views/morning.js';

const A = 'Sample company A', B = 'Sample company B', H = 'Sample household A';
const N = new Date('2026-10-17T15:00:00Z'), before = new Date('2026-10-17T13:00:00Z');
const env = { NODE_ENV: 'test' };
const error = () => Object.assign(new Error('SELECT private_source: sample diagnostic'), { code: '42P01' });
const render = async (_tx, model) => JSON.stringify(model);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(t, { basic = true, second = false, companies = [A, B], households = [H] } = {}) {
  const db = await freshDb(); t.after(() => db.drop());
  const f = await mvOrg(db.pool, { companies, households });
  const actors = await mvReadyViewers(db.pool, { ...f, second });
  let time = N;
  const runtime = createMorningRuntime({ wall: () => time });
  const service = createMorningService({ runtime, env });
  const vendor = await mvVendor(db.pool, { orgId: f.orgId, entityId: f.entities[A], name: 'Sample vendor A' });
  const add = (type, cents, extra = {}) => mvTxn(db.pool, { orgId: f.orgId, entityId: f.entities[A], type,
    date: '2026-10-01', createdAt: N, totalCents: Math.abs(cents),
    vendorId: ['bill', 'bill_payment', 'expense'].includes(type) ? vendor : null,
    dueDate: type === 'bill' ? '2026-10-16' : null,
    postings: [{ accountId: f.accounts[A][type === 'bill' ? 'ap' : 'checking'], cents }], ...extra });
  const observe = (extra = {}, instance = service) => instance.observeMorning(db.pool, { identity: actors.owner, render, ...extra });
  const context = (kind = 'attention', resource = { rule: 'all' }, identity = actors.owner, gen = null) => ({
    sid: identity.sessionId, vk: identity.viewerKey, epoch: 1, gen, kind, resource, after: null, iat: +time,
  });
  const detail = (extra = {}, instance = service) => instance.readMorningDetail(db.pool, {
    identity: actors.owner, context: context(), pageRequest: { kind: 'attention', resource: { rule: 'all' } }, render, ...extra,
  });
  const inspect = async () => ({
    visits: (await db.pool.query('SELECT * FROM morning_visit ORDER BY viewer_key')).rows,
    generations: (await db.pool.query('SELECT * FROM morning_snapshot_generation ORDER BY generation_id')).rows,
    dismissals: (await db.pool.query('SELECT * FROM morning_dismissal ORDER BY viewer_key,item_key')).rows,
  });
  const storeDismissal = row => db.pool.query(`INSERT INTO morning_dismissal(org_id,viewer_key,item_key,item_version,rule_version,note)
    VALUES($1,'owner',$2,$3,1,'Sample note')`, [f.orgId, row.itemKey, row.version]);
  const c = { db, f, ...actors, runtime, service, add, observe, detail, context, inspect, storeDismissal, setTime: n => { time = n; } };
  if (basic) {
    for (const [company, key, cents] of [[A, 'checking', 100000], [A, 'savings', -4000], [A, 'card', -28000], [B, 'checking', 250000], [H, 'checking', 40000], [H, 'card', -10000]]) {
      await mvTxn(db.pool, { orgId: f.orgId, entityId: f.entities[company], type: 'journal_entry', date: '2026-10-16', createdAt: before,
        postings: [{ accountId: f.accounts[company][key], cents }] });
    }
    c.bill = await add('bill', -10000);
    await db.pool.query(`INSERT INTO ledgerline_link(org_id,entity_id,ll_entity_id,ll_entity_name,linked_by)
      VALUES($1,$2,$3,'Sample company A','the owner')`, [f.orgId, f.entities[A], randomUUID()]);
    c.feed = randomUUID();
    await db.pool.query(`INSERT INTO ledgerline_account(org_id,entity_id,ll_account_id,display_name,kind,books_account_id,include)
      VALUES($1,$2,$3,'Sample checking feed','depository',$4,true)`, [f.orgId, f.entities[A], c.feed, f.accounts[A].checking]);
    await db.pool.query(`INSERT INTO bank_feed_item(org_id,entity_id,ll_account_id,ll_transaction_id,revision,pending,posted_date,amount_cents,bank_state,review_state)
      VALUES($1,$2,$3,$4,1,false,'2026-10-17',100,'active','new')`, [f.orgId, f.entities[A], c.feed, randomUUID()]);
    await db.pool.query(`INSERT INTO tax_return(org_id,entity_id,return_type,form_edition,period_start,period_end,tax_method,book_basis)
      VALUES($1,$2,'household_1040',2025,'2025-01-01','2025-12-31','accrual','accrual')`, [f.orgId, f.entities[H]]);
    await db.pool.query(`INSERT INTO morning_floor(org_id,viewer_key,account_id,floor_cents) VALUES($1,'owner',$2,100000)`, [f.orgId, f.accounts[A].savings]);
  }
  return c;
}
function modelTest(name, fn, options) { test(name, async t => fn(await fixture(t, options), t)); }

modelTest('code-r1 B2: unsafe comparison retains the complete observation and displays unavailable', async c => {
  const n = Number.MAX_SAFE_INTEGER;
  c.setTime(before);
  const old = await c.add('journal_entry', -n, { createdAt: new Date('2026-10-17T12:00:00Z') });
  assert.equal((await c.observe()).model.complete, true);
  const saved = await c.inspect();
  await c.db.pool.query('DELETE FROM txn WHERE txn_id=$1', [old]);
  await c.add('journal_entry', n, { createdAt: new Date('2026-10-17T14:00:00Z') });
  c.setTime(N);
  const result = await c.observe({ render: async (_tx, model) => String(morningPage(model, {
    csrf: 'sample', ctxToken: 'sample', links: { can: () => false, entityId: 0, url: () => '/morning/entries' },
  })) });
  assert.equal(result.model.money.grand.availableCents, n, 'current amount is individually safe');
  assert.equal(result.model.entries.totals.windowNetAvailableCents, n, 'window is individually safe');
  assert.equal(result.model.money.changes.availableChangeCents, null);
  assert.equal(result.model.money.status, 'incomplete');
  assert.equal(result.model.complete, false);
  assert.deepEqual(await c.inspect(), saved, 'no generation, pointer or timestamp advances');
  const row = new RegExp(`<tr data-account-id="${c.f.accounts[A].checking}">([^]*?)</tr>`).exec(result.html)[1];
  assert.match(row, /Unavailable available/);
  assert.doesNotMatch(row, /\+\$0\.00 available/);
}, { basic: false });
modelTest('code-r1 N2: observing publication seals its exact child vector', async c => {
  assert.equal((await c.observe()).model.complete,true);
  const generation=(await c.inspect()).generations[0];
  assert.equal(generation.sealed,true);
  await assert.rejects(c.db.pool.query('DELETE FROM morning_snapshot_account WHERE generation_id=$1',[generation.generation_id]),/sealed/);
});
const digest = async c => {
  const { rows: [pref] } = await c.db.pool.query("UPDATE morning_preference SET enabled=true,phone='+16025550100',settings_version=settings_version+1 WHERE org_id=$1 AND viewer_key='owner' RETURNING settings_version", [c.f.orgId]);
  const authority = morningJobAuthority({ orgId: c.f.orgId, viewerKey: 'owner', membershipEpoch: 1, settingsVersion: pref.settings_version });
  return withMorningComputation(c.db.pool, { orgId: c.f.orgId, viewerKey: 'owner', jobAuthority: authority, purpose: 'digest', runtime: c.runtime }, async (tx, { N: captured, budget }) => {
    const visit = await readVisit(tx, { orgId: c.f.orgId, viewerKey: 'owner' });
    const comparison = visit.latestId ? await loadGeneration(tx, { orgId: c.f.orgId, viewerKey: 'owner', generationId: visit.latestId }) : null;
    return c.service.computeMorning(tx, { orgId: c.f.orgId, viewerKey: 'owner', N: captured, comparison,
      prefs: { detailThresholdCents: 0, floors: new Map(), thresholds: new Map() }, purpose: 'digest', budget });
  });
};

modelTest('first look model', async c => {
  await c.add('expense', -1000000);
  const r = await c.observe(); assert.equal(r.status, 'ok'); const m = r.model;
  assert.equal(m.firstLook, true); assert.equal(m.comparison, null);
  assert.deepEqual([m.attention.counts.newPayees, m.attention.counts.large, m.attention.counts.duplicateGroups], [0, 0, 0]);
  assert.equal(m.attention.counts.bills, 1); assert.equal(m.attention.counts.bankLines, 1);
  assert.equal(m.attention.counts.taxReminders, 5); assert.equal(m.attention.counts.floors, 1);
  assert.equal(m.money.grand.cashCents, -614000); assert.equal(m.money.personal.count, 1);
  assert.deepEqual(MORNING_SECTIONS, ['money','entries','transfers','bank','bills','tax','floors','alerts','duplicates','dismissals','freshness']);
});
modelTest('section failure is unavailable, not zero', async c => {
  const service = createMorningService({ runtime: c.runtime, env, deps: { billsAndInvoices: async () => { throw error(); } } });
  const { model } = await c.observe({}, service);
  assert.ok(model.attention.unavailable.includes('bills')); assert.equal(model.attention.counts.bills, null);
  assert.equal(model.complete, false); assert.equal(model.money.grand.cashCents, 386000); assert.equal(model.attention.counts.bankLines, 1);
  assert.doesNotMatch(JSON.stringify(model), /private_source|42P01|SELECT/);
  assert.match(model.diagnostics.bills, /^[0-9a-f]{8}$/);
});
modelTest('incomplete money suppresses the grand total', async c => {
  await c.add('journal_entry', 9007199254740000);
  await c.add('journal_entry', 9007199254740000, { postings: [{ accountId: c.f.accounts[A].savings, cents: 9007199254740000 }] });
  const { model } = await c.observe(); assert.equal(model.money.status, 'incomplete');
  assert.equal(model.money.grand.cashCents, null); assert.equal(model.complete, false);
});
modelTest('observing GET advances only when complete', async c => {
  const service = createMorningService({ runtime: c.runtime, env, deps: { billsAndInvoices: async () => { throw error(); } } });
  await c.observe({}, service); await c.observe({}, service);
  assert.equal((await c.inspect()).generations.length, 0);
  assert.equal((await c.observe()).model.complete, true); assert.equal((await c.inspect()).generations.length, 1);
});
modelTest('import commits between actual reads', async c => {
  await c.add('journal_entry', 1000, { createdAt: before }); c.setTime(before); await c.observe();
  c.setTime(N);
  const service = createMorningService({ runtime: c.runtime, env, hooks: { afterSection: async name => {
    if (name === 'money') { await c.add('expense', -5000); await c.add('bill', -10000); }
  } } });
  const r = await c.observe({}, service);
  assert.equal(r.model.money.grand.cashCents, 1000); assert.equal(r.model.attention.counts.bills, 0);
  assert.equal(r.model.entries.totals.aboveCount, 0);
  const saved = (await c.db.pool.query(`SELECT signed_cents FROM morning_snapshot_account WHERE generation_id=(SELECT latest_generation_id FROM morning_visit WHERE org_id=$1 AND viewer_key='owner') AND observed_account_id=$2`, [c.f.orgId, c.f.accounts[A].checking])).rows[0];
  assert.equal(saved.signed_cents, 1000);
  await c.db.pool.query("UPDATE morning_preference SET detail_threshold_cents=0,settings_version=settings_version+1 WHERE org_id=$1", [c.f.orgId]);
  const next = (await c.observe()).model;
  assert.equal(next.money.grand.cashCents, -4000); assert.equal(next.attention.counts.bills, 1);
  assert.equal(next.attention.totals.bill.openCents, 10000); assert.equal(next.entries.page[0].netCents, -5000);
}, { basic: false });
modelTest('jobs and detail never advance', async c => {
  await c.observe(); const initial = await c.inspect();
  await c.detail(); await digest(c); assert.deepEqual(await c.inspect(), initial);
});
modelTest('detail computes only the requested section and its financial dependencies', async c => {
  c.setTime(before); await c.observe(); c.setTime(N);
  await c.add('expense', -100000); await c.add('expense', -100000);
  const summary = await c.observe();
  await c.storeDismissal(summary.model.attention.page.find(row => row.rule === 'bank'));
  const state = await c.inspect();
  const gen = summary.model.comparison.generationId;
  const group = summary.model.attention.page.find(row => row.rule === 'duplicate').itemKey;
  for (const [kind, resource, expected] of [
    ['entries', null, ['money', 'entries', 'transfers']],
    ['account', { accountId: c.f.accounts[A].checking }, ['money', 'entries', 'transfers']],
    ['attention', { rule: 'bill' }, ['bills', 'dismissals']],
    ['attention', { rule: 'alerts' }, ['money', 'floors', 'alerts', 'dismissals']],
    ['duplicate-members', { groupKey: group }, ['duplicates']],
    ['duplicate-pairs', { groupKey: group }, ['duplicates']],
  ]) {
    const sections = new Set();
    const service = createMorningService({ runtime: c.runtime, env, hooks: { afterSection: name => sections.add(name) } });
    const result = await c.detail({ context: c.context(kind, resource, c.owner, gen), pageRequest: { kind, resource } }, service);
    assert.equal(result.status, 'ok'); assert.equal(result.model.complete, true);
    assert.deepEqual([...sections].sort(), [...expected].sort(), kind);
    if (kind === 'entries') assert.equal(result.model.entries.totals.aboveCount, summary.model.entries.totals.aboveCount);
    if (kind === 'attention' && resource.rule === 'bill') {
      assert.equal(result.model.attention.counts.bills, 1);
      assert.equal(result.model.attention.totals.bill.openCents, 10000);
      assert.equal(result.model.attention.counts.bankLines, null, 'uncomputed counts never become known zeros');
      assert.equal(result.model.dismissed.matchingCount, null, 'uncomputed rules cannot establish whole-view folds');
    }
    if (resource?.rule === 'alerts') {
      assert.equal(result.model.attention.counts.newPayees, 1);
      assert.equal(result.model.attention.counts.floors, 1);
    }
    if (kind.startsWith('duplicate-')) assert.equal(result.model.detail.pairCount, 1);
  }
  assert.deepEqual(await c.inspect(), state);
});
modelTest('summary reuses one posting-net and typed-party relation across window rules', async c => {
  c.setTime(before); await c.observe(); c.setTime(N); await c.add('expense', -100000);
  const scans = [];
  await c.observe({ hooks: { beforeQuery: ({ text }) => {
    if (/sum\(p\.amount_cents\)/i.test(text)) scans.push(text);
  } } });
  assert.equal(scans.length, 2, 'one balance scan plus one shared posting-net scan');
});
modelTest('a rolled-back posting relation is rebuilt for later sections in the same snapshot', async c => {
  c.setTime(before); await c.observe(); c.setTime(N);
  await c.add('expense', -100000); await c.add('expense', -100000);
  const state = await c.inspect();
  const service = createMorningService({ runtime: c.runtime, env, deps: {
    readWindowEntries: async (tx, options) => { await readWindowEntries(tx, options); throw error(); },
  } });
  const { model } = await c.observe({}, service);
  assert.equal(model.complete, false); assert.equal(model.entries, null);
  assert.equal(model.attention.counts.newPayees, 1); assert.equal(model.attention.counts.duplicateGroups, 1);
  assert.deepEqual(model.attention.unavailable, ['entries']);
  assert.deepEqual(await c.inspect(), state);
});
modelTest('denied inside the snapshot', async c => {
  const initial = await c.inspect();
  const r = await c.observe({ identity: c.second, hooks: { beforeAcquire: () => removeSecondViewer(c.db.pool, { orgId: c.f.orgId, actorCtx: c.owner, userId: c.second.userId }) } });
  assert.deepEqual(r, { status: 'denied', reason: 'stale_session' });
  assert.equal((await c.inspect()).generations.length, initial.generations.length);
}, { second: true });

async function freshEnrollment(c, action) {
  const key = settingsKey({ SETTINGS_KEY: 'ab'.repeat(32) });
  const args = { orgId: c.f.orgId, userId: c.second.userId, actorCtx: c.owner, key, now: N };
  let result;
  if (action === 'reset') result = await ownerResetViewer(c.db.pool, args);
  else { await removeSecondViewer(c.db.pool, args); result = await grantSecondViewer(c.db.pool, args); }
  const invite = await findOpenInvite(c.db.pool, { token: result.token, orgSlug: 'mvtest', now: N });
  const secret = await pendingSecret(c.db.pool, { invite, key });
  await completeInvite(c.db.pool, { token: result.token, orgSlug: 'mvtest', key, now: N,
    password: 'sample password 1', password2: 'sample password 1', code: makeTotp(secret).generate({ timestamp: +N }) });
}
for (const kind of ['page', 'account', 'entries', 'attention', 'duplicate-members', 'duplicate-pairs', 'dismissed']) {
  for (const action of ['reset', 'remove/regrant']) modelTest(`final authority for each operation: ${kind} after ${action}`, async c => {
    let financial = 0;
    const hooks = { beforeAcquire: () => freshEnrollment(c, action), beforeQuery: ({ text }) => {
      if (/\b(posting|mv_attention|morning_snapshot_account)\b/.test(text)) financial++;
    } };
    const resource = kind === 'account' ? { accountId: c.f.accounts[A].checking } : kind === 'attention' ? { rule: 'all' }
      : kind.startsWith('duplicate-') ? { groupKey: 'duplicate:sample' } : kind === 'dismissed' ? { fold: 'matching' } : null;
    const r = kind === 'page' ? await c.observe({ identity: c.second, hooks }) : await c.detail({ identity: c.second,
      context: c.context(kind, resource, c.second), pageRequest: { kind, resource }, hooks });
    assert.deepEqual(r, { status: 'denied', reason: 'stale_session' }); assert.equal(financial, 0);
    const state = await c.inspect(); assert.equal(state.generations.length, 0); assert.equal(state.visits.length, 0); assert.equal(state.dismissals.length, 0);
    assert.equal((await c.db.pool.query('SELECT count(*)::int n FROM morning_floor WHERE viewer_key=$1', [c.second.viewerKey])).rows[0].n, 0);
  }, { basic: false, second: true });
}
for (const [state, reason] of [['pending_enrollment', 'pending'], ['disabled', 'not_viewer']]) {
  modelTest(`final authority for valid-generation ${state}`, async c => {
    await c.db.pool.query('UPDATE morning_viewer SET enrollment_state=$1 WHERE org_id=$2 AND viewer_key=$3', [state, c.f.orgId, c.second.viewerKey]);
    assert.deepEqual(await c.observe({ identity: c.second }), { status: 'denied', reason });
    assert.deepEqual(await c.detail({ identity: c.second }), { status: 'denied', reason });
  }, { basic: false, second: true });
}
modelTest('complete vs known', async c => {
  await c.db.pool.query('UPDATE tax_return SET form_edition=2026 WHERE org_id=$1', [c.f.orgId]);
  const r = await c.observe(); assert.equal(r.model.complete, true); assert.equal(r.model.coverageKnown, false);
  const tax = r.model.attention.page.find(x => x.display.kind === 'unsupported_edition'); await c.storeDismissal(tax);
  assert.equal((await c.observe()).model.coverageKnown, false);
  const state = await c.inspect(); c.setTime(new Date(+N + 3600000));
  const service = createMorningService({ runtime: c.runtime, env, deps: { taxAttention: async () => { throw error(); } } });
  const failed = await c.observe({}, service);
  assert.equal(failed.model.complete, false); assert.equal(failed.model.attention.counts.taxReminders, null);
  assert.deepEqual(await c.inspect(), state);
  const recovered = await c.observe(); assert.equal(recovered.model.comparison.generationId, state.visits[0].latest_generation_id);
  assert.equal((await c.inspect()).generations.length, state.generations.length + 1);
});
modelTest('deadline/render/commit failures', async c => {
  await c.observe(); const state = await c.inspect();
  let mono = 0; const runtime = createMorningRuntime({ wall: () => N, mono: () => mono });
  const timed = createMorningService({ runtime, env, hooks: { afterSection: () => { mono = 16000; } } });
  await assert.rejects(c.observe({}, timed), MorningTimeoutError); assert.deepEqual(await c.inspect(), state);
  await assert.rejects(c.observe({ render: async () => { throw new Error('Sample outer navigation failure'); } }), /outer navigation/);
  assert.deepEqual(await c.inspect(), state);
  await assert.rejects(c.observe({ hooks: { beforeQuery: ({ text }) => { if (text === 'COMMIT') throw new Error('Sample COMMIT failure'); } } }), /COMMIT failure/);
  assert.deepEqual(await c.inspect(), state);
});
modelTest('shared runtime bounds mixed page/detail/digest/dismiss computations', async c => {
  await c.db.pool.query("UPDATE morning_preference SET enabled=true,phone='+16025550100',settings_version=settings_version+1 WHERE org_id=$1", [c.f.orgId]);
  const entered = deferred(), release = deferred(); let active = 0, maximum = 0;
  const running = new Set(); const counts = new Map();
  const run = (purpose, identity, hold = false) => withMorningComputation(c.db.pool, {
    orgId: c.f.orgId, viewerKey: identity.viewerKey, purpose, runtime: c.runtime,
    ...(purpose === 'digest' ? { jobAuthority: morningJobAuthority({ orgId: c.f.orgId, viewerKey: identity.viewerKey, membershipEpoch: 1, settingsVersion: 2 }) } : { identity }),
  }, async () => {
    assert.equal(running.has(identity.viewerKey), false); running.add(identity.viewerKey); active++; maximum = Math.max(maximum, active);
    counts.set(purpose, (counts.get(purpose) ?? 0) + 1);
    if (hold) { entered.resolve(); await release.promise; }
    await new Promise(r => setTimeout(r, 10)); active--; running.delete(identity.viewerKey);
  });
  const first = run('page', c.owner, true); await entered.promise;
  const pending = [run('detail', c.owner), run('digest', c.owner), run('dismiss', c.owner), run('detail', c.second)];
  release.resolve(); await Promise.all([first, ...pending]); assert.ok(maximum <= 2); assert.equal(counts.size, 4);
}, { basic: false, second: true });
modelTest('R2-1 failed bill loading preserves unavailable dismissals and observation', async c => {
  const m = (await c.observe()).model;
  const bill = m.attention.page.find(x => x.rule === 'bill'), bank = m.attention.page.find(x => x.rule === 'bank');
  await c.storeDismissal(bill); await c.storeDismissal(bank); const initial = await c.inspect();
  const service = createMorningService({ runtime: c.runtime, env, deps: { billsAndInvoices: async () => { throw error(); } } });
  const failed = (await c.observe({}, service)).model;
  assert.equal(failed.dismissed.matchingCount, null); assert.equal(failed.dismissed.staleCount, null);
  assert.equal(failed.attention.counts.bankLines, 0); assert.equal(failed.attention.counts.bills, null);
  for (const fold of ['matching', 'stale']) {
    const d = await c.detail({ context: c.context('dismissed', { fold }), pageRequest: { kind: 'dismissed', resource: { fold } } }, service);
    assert.equal(d.model.dismissed.page.some(x => x.itemKey === bill.itemKey), false);
    if (fold === 'matching') assert.equal(d.model.dismissed.page[0].itemKey, bank.itemKey);
  }
  assert.deepEqual(await c.inspect(), initial);
  const recovered = (await c.detail({ context: c.context('dismissed', { fold: 'matching' }), pageRequest: { kind: 'dismissed', resource: { fold: 'matching' } } })).model;
  assert.equal(recovered.dismissed.matchingCount, 2); assert.equal(recovered.dismissed.staleCount, 0);
  assert.equal(recovered.dismissed.page.find(x => x.itemKey === bill.itemKey).version, bill.version);
  const payment = await c.add('bill_payment', -10000);
  await mvApply(c.db.pool, { orgId: c.f.orgId, creditTxnId: payment, chargeTxnId: c.bill, cents: 10000, on: '2026-10-17' });
  const paid = (await c.detail({ context: c.context('dismissed', { fold: 'stale' }), pageRequest: { kind: 'dismissed', resource: { fold: 'stale' } } })).model;
  assert.equal(paid.dismissed.staleCount, 1); assert.equal(paid.dismissed.page[0].itemKey, bill.itemKey);
  assert.deepEqual(Object.keys(paid.dismissed.page[0]).sort(), ['dismissedAt', 'itemKey', 'note']);
});
modelTest('R2-2 mixed home currency documents retain counts but no mixed AP/AR totals', async c => {
  for (const company of [A, B]) {
    const entityId = c.f.entities[company], vendorId = await mvVendor(c.db.pool, { orgId: c.f.orgId, entityId, name: 'Sample vendor B' }),
      customerId = await mvCustomer(c.db.pool, { orgId: c.f.orgId, entityId, name: 'Sample customer A' });
    for (const type of ['bill', 'invoice']) await mvTxn(c.db.pool, { orgId: c.f.orgId, entityId, type, date: '2026-10-01', dueDate: '2026-10-16',
      vendorId: type === 'bill' ? vendorId : null, customerId: type === 'invoice' ? customerId : null, totalCents: 10000,
      postings: [{ accountId: c.f.accounts[company][type === 'bill' ? 'ap' : 'ar'], cents: type === 'bill' ? -10000 : 10000 }] });
  }
  for (const home of ['EUR', '', 'XYZ']) {
    await c.db.pool.query(`INSERT INTO currency_settings(org_id,entity_id,turned_on_by,home) VALUES($1,$2,'the owner',$3)
      ON CONFLICT(org_id,entity_id) DO UPDATE SET home=excluded.home`, [c.f.orgId, c.f.entities[B], home]);
    const { model } = await c.detail(); assert.equal(model.attention.counts.bills, 2); assert.equal(model.attention.counts.overdueInvoices, 2);
    for (const rule of ['bill', 'invoice']) {
      assert.equal(model.attention.totals[rule].openCents, null);
      const rows = model.attention.page.filter(x => x.rule === rule);
      assert.equal(rows.find(x => x.entityId === c.f.entities[A]).openCents, 10000);
      const unsupported = rows.find(x => x.entityId === c.f.entities[B]); assert.equal(unsupported.openCents, null);
      assert.equal(unsupported.display.open, null); assert.equal(unsupported.display.coverage, 'unsupported_home_currency');
    }
    assert.equal(model.coverageKnown, false);
  }
}, { basic: false });
modelTest('R2-2 unsupported home cannot infer transfers or duplicates from equal cents', async c => {
  c.setTime(before); await c.observe(); c.setTime(N);
  await c.add('expense',-10000);
  const entityId=c.f.entities[B],vendorId=await mvVendor(c.db.pool,{orgId:c.f.orgId,entityId,name:'Sample vendor B'});
  for(const cents of [10000,-10000,-10000])await mvTxn(c.db.pool,{orgId:c.f.orgId,entityId,type:cents>0?'journal_entry':'expense',
    date:'2026-10-01',createdAt:N,vendorId:cents<0?vendorId:null,totalCents:10000,postings:[{accountId:c.f.accounts[B].checking,cents}]});
  const supported=(await c.observe()).model; assert.equal(supported.transfers.count,1); assert.equal(supported.attention.counts.duplicateGroups,1);
  for(const home of ['EUR','','XYZ']){
    await c.db.pool.query(`INSERT INTO currency_settings(org_id,entity_id,turned_on_by,home) VALUES($1,$2,'the owner',$3)
      ON CONFLICT(org_id,entity_id) DO UPDATE SET home=excluded.home`,[c.f.orgId,entityId,home]);
    const m=(await c.observe()).model;assert.equal(m.firstLook,false);assert.equal(m.transfers.count,0);
    assert.equal(m.attention.counts.duplicateGroups,0);assert.equal(m.coverageKnown,false);
  }
}, {basic:false});
modelTest('bill store refuses reuse with a different company scope', async c => {
  await withMorningComputation(c.db.pool, { orgId: c.f.orgId, viewerKey: 'owner', identity: c.owner, purpose: 'detail', runtime: c.runtime }, async tx => {
    const store = await prepareItems(tx, { orgId: c.f.orgId, viewerKey: 'owner', budget: tx });
    const currencyScope = await readHomeCurrencyScope(tx, { orgId: c.f.orgId });
    const options = { orgId: c.f.orgId, today: '2026-10-17', store, budget: tx, mode: 'relation', currencyScope };
    await billsAndInvoices(tx, { ...options, entityIds: [c.f.entities[A]] });
    await assert.rejects(billsAndInvoices(tx, { ...options, entityIds: [c.f.entities[B]] }), /document context/);
  });
});
modelTest('detail validates kind resource session and retained generation before source reads', async c => {
  let reads = 0;
  const service = createMorningService({ runtime: c.runtime, env, hooks: { afterSection: () => { reads++; } } });
  for (const context of [{ ...c.context(), vk: '12345' }, { ...c.context(), sid: 'another-session' }, { ...c.context(), gen: randomUUID() },
    { ...c.context(), kind: 'entries', resource: null }, { ...c.context(), resource: { rule: 'bill' } }, { ...c.context(), iat: +N - 3600001 }]) {
    assert.deepEqual(await c.detail({ context }, service), { status: 'expired' });
  }
  assert.equal(reads, 0);
});
modelTest('fatal connection and no-state errors never render a replacement snapshot', async c => {
  for (const code of ['08006', undefined]) {
    const service = createMorningService({ runtime: c.runtime, env, deps: { billsAndInvoices: async () => { throw Object.assign(new Error('Sample connection error'), { code }); } } });
    let rendered = false;
    await assert.rejects(c.observe({ render: async () => { rendered = true; } }, service)); assert.equal(rendered, false);
    assert.equal((await c.inspect()).generations.length, 0);
  }
});
test('production refuses loader and hook injection', () => {
  assert.throws(() => createMorningService({ env: { NODE_ENV: 'production' }, deps: { billsAndInvoices() {} } }), /production/);
  assert.throws(() => createMorningService({ env: { NODE_ENV: 'production' }, hooks: { afterSection() {} } }), /production/);
});

// This is the Task 14 gate, not a rerun of the accepted Task 0 prototype.
test('statement budget', async t => {
  const measurements = [];
  for (const size of [2, 20]) {
    const companies = Array.from({ length: size }, (_, i) => i === 0 ? A : `Sample company ${i + 1}`);
    const c = await fixture(t, { basic: false, companies, households: [] });
    await c.db.pool.query(`INSERT INTO account(org_id,entity_id,name,type)
      SELECT $1,e.entity_id,'Sample bank '||n,'bank' FROM entity e CROSS JOIN generate_series(1,17)n WHERE e.org_id=$1`, [c.f.orgId]);
    await c.db.pool.query(`INSERT INTO vendor(org_id,entity_id,display_name)
      SELECT $1,e.entity_id,'Sample vendor '||n FROM entity e CROSS JOIN generate_series(1,10)n WHERE e.org_id=$1 AND NOT(e.entity_id=$2 AND n=1)`, [c.f.orgId, c.f.entities[A]]);
    await c.add('expense', -100000); await c.add('expense', -100000);
    const bankAccounts=(await c.db.pool.query("SELECT account_id FROM account WHERE org_id=$1 AND type='bank'",[c.f.orgId])).rows;
    for(const kind of ['summary','dismissed','duplicate-members','duplicate-pairs','limitations']){
    const statements = [], counters = { financial: 0, facadeCalls: 0, roundTrips: 0 };
    const measuredPool={connect:async()=>{const client=await c.db.pool.connect();return {
      query(...args){counters.roundTrips++;return client.query(...args);},release:(...args)=>client.release(...args)};}};
    await withMorningComputation(measuredPool, { orgId: c.f.orgId, viewerKey: 'owner', identity: c.owner, purpose: 'detail', runtime: c.runtime }, async raw => {
      const tx = { ...raw, query: async (text, values) => {
        counters.facadeCalls++; const sql = text.trim();
        if (/^(SELECT|WITH|CREATE TEMP|CREATE OR REPLACE TEMP VIEW|CREATE INDEX|INSERT|UPDATE|DELETE)/.test(sql)) { counters.financial++; statements.push(sql.split('\n')[0]); }
        // Count executed nested SQL, not function definitions. Hash scans run even with an empty input.
        if (!/^CREATE OR REPLACE FUNCTION/.test(sql)) {
          if (sql.includes('pg_temp.mv_bank_hash()')) counters.financial++;
          if (sql.includes('pg_temp.mv_hash_groups(')) counters.financial++;
          if (sql.includes('pg_temp.mv_pair_work(')) counters.financial++;
        }
        return raw.query(text, values);
      } };
      const comparison = { generationId: randomUUID(), capturedAt: before,
        accounts:kind==='summary'?[]:[{accountId:9999999,entityId:c.f.entities[A],name:'Sample removed bank',type:'bank',active:true,signedCents:0,todayCents:0}],
        companies:Object.entries(c.f.entities).map(([name,entityId])=>({name,entityId,isPersonal:false})) };
      const pageRequest=kind==='summary'?{}:kind==='dismissed'?{kind,resource:{fold:'stale'}}
        :kind==='limitations'?{kind:'attention',resource:{rule:'limitations',sourceKey:`none:${c.f.entities[A]}`}}
          :{kind,resource:{groupKey:'duplicate:sample'}};
      const m = await c.service.computeMorning(tx, { orgId: c.f.orgId, viewerKey: 'owner', N, comparison,
        prefs: { detailThresholdCents: 50000, floors: new Map(kind==='summary'?[]:bankAccounts.map(r=>[r.account_id,100000])), thresholds: new Map() }, purpose: 'detail', budget: tx,pageRequest });
      assert.equal(m.complete, true);
    });
    measurements.push({ companies: size,kind, ...counters, statements });
    }
  }
  t.diagnostic(JSON.stringify(measurements));
  const exact = {summary:23,dismissed:22,'duplicate-members':11,'duplicate-pairs':12,limitations:5};
  for (const m of measurements) assert.equal(m.financial, exact[m.kind], `${m.companies} companies / ${m.kind}`);
  for(let i=0;i<5;i++)assert.equal(measurements[i].financial, measurements[i+5].financial);
});
