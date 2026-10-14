import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { occurrence, nextOnOrAfter, validateRule, describeRule } from '../lib/domain/schedule.js';
import { feeAmount, feeDates, describePolicy } from '../lib/domain/latefees.js';
import { saveTemplate, runRecurring, setTemplateActive } from '../lib/data/recurring.js';
import { savePolicy, runLateFees } from '../lib/data/latefees.js';
import { saveSalesDoc } from '../lib/data/writes.js';
import { runDailyJobs } from '../services/jobs/index.js';
import { startApp } from './app-harness.js';

const TODAY = '2026-10-12';

// ---- schedule math ----

test('monthly schedules keep the start day, clamped to short months', () => {
  const r = { unit: 'month', count: 1, start: '2026-01-31' };
  assert.deepEqual([0, 1, 2, 3, 13].map(k => occurrence(r, k)), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2027-02-28']);
  assert.equal(occurrence({ unit: 'year', count: 1, start: '2028-02-29' }, 1), '2029-02-28');
  assert.equal(occurrence({ unit: 'week', count: 2, start: '2026-10-12' }, 3), '2026-11-23');
});

test('next run on or after a date respects the end date', () => {
  const r = { unit: 'month', count: 1, start: '2026-01-15', end: '2026-12-31' };
  assert.equal(nextOnOrAfter(r, '2026-01-01'), '2026-01-15');
  assert.equal(nextOnOrAfter(r, '2026-10-12'), '2026-10-15');
  assert.equal(nextOnOrAfter(r, '2026-10-15'), '2026-10-15');
  assert.equal(nextOnOrAfter(r, '2026-12-16'), null);
  assert.equal(nextOnOrAfter({ unit: 'day', count: 3, start: '2020-01-01' }, '2026-10-12'), '2026-10-14'); // 10/11 is occurrence 825
});

test('rules validate and describe themselves', () => {
  assert.equal(validateRule({ unit: 'month', count: 1, start: TODAY }), null);
  assert.match(validateRule({ unit: 'fortnight', count: 1, start: TODAY }), /how often/);
  assert.match(validateRule({ unit: 'day', count: 0, start: TODAY }), /1 to 365/);
  assert.match(validateRule({ unit: 'day', count: 1, start: TODAY, end: '2026-01-01' }), /after the start/);
  assert.equal(describeRule({ unit: 'month', count: 1, start: '2026-10-01' }), 'Every month on the 1st');
  assert.equal(describeRule({ unit: 'week', count: 2, start: '2026-10-12' }), 'Every 2 weeks on Monday');
});

// ---- late-fee math ----

const policy = { fee_kind: 'flat', flat_cents: 2500, percent_bps: 0, grace_days: 5, repeat_every_days: null, max_fees_per_invoice: 1, effective_from: '2026-01-01' };

test('fee amounts', () => {
  assert.equal(feeAmount(policy, 99999), 2500);
  assert.equal(feeAmount({ ...policy, fee_kind: 'percent', percent_bps: 150 }, 10050), 151); // 150.75 rounds up
  assert.equal(feeAmount({ ...policy, fee_kind: 'percent', percent_bps: 150 }, 10030), 150); // 150.45 rounds down
});

test('fee dates: grace, repeat, max, effective date, already charged', () => {
  assert.deepEqual(feeDates(policy, '2026-10-01', '2026-10-06'), []);
  assert.deepEqual(feeDates(policy, '2026-10-01', '2026-10-07'), ['2026-10-07']);
  assert.deepEqual(feeDates(policy, '2026-10-01', '2026-12-31', ['2026-10-07']), []);
  const monthly = { ...policy, repeat_every_days: 30, max_fees_per_invoice: 3 };
  assert.deepEqual(feeDates(monthly, '2026-01-01', '2026-12-31'), ['2026-01-07', '2026-02-06', '2026-03-08']);
  assert.deepEqual(feeDates({ ...monthly, effective_from: '2026-02-10' }, '2026-01-01', '2026-12-31'), ['2026-03-08', '2026-04-07', '2026-05-07']);
  assert.deepEqual(feeDates(monthly, '2026-01-01', '2026-12-31', ['2026-01-07', '2026-02-06']), ['2026-03-08']);
  assert.match(describePolicy({ ...monthly, enabled: true }), /\$25\.00 charged once an invoice is more than 5 days past due, then every 30 days/);
});

// ---- recurring and late fees against the sample books ----

const outbox = [];
const mailer = { kind: 'smtp', from: 'billing@samplefeed.example', async send(m) { outbox.push(m); return { status: 'sent' }; } };
let app, scope, cust;
before(async () => {
  app = await startApp({ mailer });
  cust = app.ids.customers.hilltop;
  scope = { orgId: app.ids.orgId, entityId: app.ids.entityId };
});
after(async () => { await app.close(); });

const lines = [{ itemId: '', description: 'Monthly mineral delivery', quantity: '2', rate: '150' }];
const count = async (sql, params) => (await app.db.pool.query(sql, params)).rows[0].n;
const template = (fields, today = TODAY) => saveTemplate(app.db.pool, { ...scope, customerId: cust, today, actor: 'tester',
  fields: { name: 'Minerals', txnType: 'invoice', mode: 'scheduled', unit: 'month', count: '1', startDate: TODAY, lines, isNew: true, ...fields } });

test('scheduled template creates invoices, once per date, catching up missed months', async () => {
  const id = await template({});
  const run = today => runRecurring(app.db.pool, { ...scope, today });
  assert.deepEqual((await run(TODAY)).map(r => [r.runDate, r.outcome]), [[TODAY, 'created']]);
  assert.deepEqual(await run(TODAY), [], 'second run the same day does nothing');
  const runs = await run('2026-12-20');
  assert.deepEqual(runs.map(r => r.runDate), ['2026-11-12', '2026-12-12']);
  const txns = (await app.db.pool.query('SELECT txn_date, total_cents, due_date FROM txn WHERE recurring_template_id = $1 ORDER BY txn_date', [id])).rows;
  assert.deepEqual(txns.map(t => [t.txn_date, t.total_cents]), [[TODAY, 30000], ['2026-11-12', 30000], ['2026-12-12', 30000]]);
  assert.ok(txns.every(t => t.due_date > t.txn_date), 'customer terms set the due date');
  assert.equal((await app.db.pool.query('SELECT next_run_date FROM recurring_template WHERE template_id = $1', [id])).rows[0].next_run_date, '2027-01-12');
  assert.equal(await count(`SELECT count(*)::int AS n FROM activity_event WHERE customer_id = $1 AND summary LIKE '%from recurring template “Minerals”'`, [cust]), 3);
});

test('pausing skips runs; resuming starts from today', async () => {
  const id = await template({ name: 'Weekly hay', unit: 'week', startDate: '2026-10-14' });
  await setTemplateActive(app.db.pool, { ...scope, templateId: id, active: false, today: TODAY, actor: 'tester' });
  assert.deepEqual((await runRecurring(app.db.pool, { ...scope, today: '2026-11-30' })).filter(r => r.templateId === id), []);
  await setTemplateActive(app.db.pool, { ...scope, templateId: id, active: true, today: '2026-11-30', actor: 'tester' });
  assert.equal((await app.db.pool.query('SELECT next_run_date FROM recurring_template WHERE template_id = $1', [id])).rows[0].next_run_date, '2026-12-02');
});

test('reminder templates only remind; a broken template records a failure and moves on', async () => {
  const remind = await template({ name: 'Quarterly check-in', mode: 'reminder', unit: 'month', count: '3' });
  const broken = await template({ name: 'Broken' });
  await app.db.pool.query('UPDATE recurring_template_line SET rate_cents = 0, amount_cents = 0 WHERE template_id = $1', [broken]);
  const runs = await runRecurring(app.db.pool, { ...scope, today: TODAY });
  assert.deepEqual(runs.filter(r => r.templateId === remind).map(r => r.outcome), ['reminded']);
  assert.deepEqual(runs.filter(r => r.templateId === broken).map(r => r.outcome), ['failed']);
  assert.equal(await count('SELECT count(*)::int AS n FROM txn WHERE recurring_template_id = ANY($1)', [[remind, broken]]), 0);
  assert.equal(await count(`SELECT count(*)::int AS n FROM activity_event WHERE kind = 'recurring_reminder'`), 1);
  assert.match((await app.db.pool.query('SELECT error FROM recurring_run WHERE template_id = $1', [broken])).rows[0].error, /more than \$0\.00/);
});

test('the daily job auto-sends and is safe to run twice', async () => {
  await template({ name: 'Auto', autoSend: true, startDate: '2026-10-13' });
  outbox.length = 0;
  const now = () => new Date('2026-10-13T15:00:00Z');
  const first = await runDailyJobs({ pool: app.db.pool, mailer, now });
  assert.ok(first.created >= 1);
  assert.equal(outbox.filter(m => /^Invoice/.test(m.subject)).length, first.sent);
  assert.ok(first.sent >= 1);
  const second = await runDailyJobs({ pool: app.db.pool, mailer, now });
  assert.deepEqual([second.created, second.sent], [0, 0]);
});

test('late fees: grace period, idempotent, per-customer switch', async () => {
  // Fees on from Oct 12: $25 once, 2 days' grace.
  await savePolicy(app.db.pool, { ...scope, today: TODAY, fields: { enabled: '1', feeKind: 'flat', flat: '25', graceDays: '2' } });
  const prairie = app.ids.customers.prairie;
  const inv = await saveSalesDoc(app.db.pool, { ...scope, customerId: prairie, type: 'invoice', actor: 'tester', txnDate: '2026-10-01', dueDate: '2026-10-13',
    lines: [{ description: 'Feed', quantity: '1', rate: '500' }] });
  const feesOn = async id => (await app.db.pool.query(`SELECT txn_date, total_cents, open_cents FROM txn WHERE type = 'late_fee' AND source_txn_id = $1`, [id])).rows;
  await runLateFees(app.db.pool, { ...scope, today: '2026-10-15' });
  assert.deepEqual(await feesOn(inv), []);
  await runLateFees(app.db.pool, { ...scope, today: '2026-10-16' });
  assert.deepEqual(await feesOn(inv), [{ txn_date: '2026-10-16', total_cents: 2500, open_cents: 2500 }]);
  assert.equal(await runLateFees(app.db.pool, { ...scope, today: '2026-10-16' }), 0);
  assert.equal(await runLateFees(app.db.pool, { ...scope, today: '2026-11-30' }) >= 0, true);
  assert.equal((await feesOn(inv)).length, 1, 'one-time fee stays one');
  // A customer with late fees off never gets one.
  const off = app.ids.customers.redriver;
  await app.db.pool.query('UPDATE customer SET late_fees_enabled = false WHERE customer_id = $1', [off]);
  const inv2 = await saveSalesDoc(app.db.pool, { ...scope, customerId: off, type: 'invoice', actor: 'tester', txnDate: '2026-10-01', dueDate: '2026-10-13',
    lines: [{ description: 'Feed', quantity: '1', rate: '500' }] });
  await runLateFees(app.db.pool, { ...scope, today: '2026-11-30' });
  assert.deepEqual(await feesOn(inv2), []);
  // Nothing was back-charged for dates before the policy started.
  assert.equal(await count(`SELECT count(*)::int AS n FROM txn WHERE type = 'late_fee' AND source_txn_id IS NOT NULL AND txn_date < '2026-10-12'`), 0);
  // The invoice with a fee can't be deleted out from under it.
  const del = await app.post(`/txns/${inv}/delete`);
  assert.equal(del.headers.get('location'), `/txns/${inv}`);
});

// ---- screens ----

test('settings: terms, products and services, late fees', async () => {
  const terms = await (await app.get('/settings/terms')).text();
  assert.match(terms, /Net 30/);
  assert.equal((await app.post('/settings/terms', { name: 'Net 45', dueDays: '45' })).status, 303);
  assert.equal((await app.post('/settings/terms', { name: 'Net 45', dueDays: '45' })).status, 422);
  assert.equal((await app.post('/settings/terms', { name: 'Bad', dueDays: '999' })).status, 422);
  const used = (await app.db.pool.query('SELECT terms_id FROM customer WHERE terms_id IS NOT NULL LIMIT 1')).rows[0].terms_id;
  const blocked = await app.post(`/settings/terms/${used}/delete`);
  assert.equal(blocked.status, 422);
  assert.match(await blocked.text(), /is used by/);
  const net45 = (await app.db.pool.query(`SELECT terms_id FROM terms WHERE name = 'Net 45'`)).rows[0].terms_id;
  assert.equal((await app.post(`/settings/terms/${net45}/delete`)).status, 303);

  assert.equal((await app.post('/settings/items', { name: 'Salt block', kind: 'product', rate: '8.50', active: '1' })).status, 303);
  const item = (await app.db.pool.query(`SELECT item_id, rate_cents FROM item WHERE name = 'Salt block'`)).rows[0];
  assert.equal(item.rate_cents, 850);
  assert.match(await (await app.get('/settings/items')).text(), /Salt block/);
  assert.equal((await app.post(`/settings/items/${item.item_id}`, { name: 'Salt block', kind: 'product', rate: '9' })).status, 303);
  assert.equal((await app.db.pool.query('SELECT active FROM item WHERE item_id = $1', [item.item_id])).rows[0].active, false);
  assert.ok(!(await (await app.get(`/txns/new?type=invoice&customer=${cust}`)).text()).includes('Salt block'), 'inactive items are hidden from new invoices');

  assert.equal((await app.post('/settings/late-fees', { enabled: '1', feeKind: 'percent', percent: '1.5', graceDays: '10', repeat: '1', repeatDays: '30', maxFees: '3' })).status, 303);
  const lf = await (await app.get('/settings/late-fees')).text();
  assert.match(lf, /1\.5% of the open balance charged once an invoice is more than 10 days past due, then every 30 days/);
  assert.match(lf, /Counting from 10\/12\/26/, 'effective date kept from when fees were first turned on');
  assert.equal((await app.post('/settings/late-fees', { enabled: '1', feeKind: 'flat', flat: '0' })).status, 422);
});

test('recurring screens: create, edit, use, pause, delete', async () => {
  const c = app.ids.customers.crosstimbers;
  assert.match(await (await app.get(`/customers/${c}/recurring/new`)).text(), /New recurring template/);
  const form = new URLSearchParams({ name: 'Hay', txnType: 'invoice', mode: 'scheduled', unit: 'month', count: '1', startDate: '2026-11-01', endDate: '', termsId: '', memo: 'Hay delivery' });
  form.append('line_item', ''); form.append('line_desc', 'Round bales'); form.append('line_qty', '10'); form.append('line_rate', '65');
  assert.equal((await app.post(`/customers/${c}/recurring`, form)).status, 303);
  const tab = await (await app.get(`/customers/${c}?tab=recurring`)).text();
  assert.match(tab, /Every month on the 1st/);
  assert.match(tab, /11\/1\/26/);
  assert.match(tab, /\$650\.00/);
  const id = (await app.db.pool.query(`SELECT template_id FROM recurring_template WHERE customer_id = $1 AND name = 'Hay'`, [c])).rows[0].template_id;
  const use = await (await app.get(`/txns/new?template=${id}`)).text();
  assert.match(use, /New invoice/);
  assert.match(use, /value="Round bales"/);
  assert.match(use, /value="Hay delivery"/);
  const edit = await (await app.get(`/recurring/${id}/edit`)).text();
  assert.match(edit, /value="Round bales"/);
  form.set('name', '');
  assert.equal((await app.post(`/recurring/${id}`, form)).status, 422);
  assert.equal((await app.post(`/recurring/${id}/pause`)).status, 303);
  assert.match(await (await app.get(`/customers/${c}?tab=recurring`)).text(), /Resume/);
  assert.equal((await app.post(`/recurring/${id}/delete`)).status, 303);
  assert.equal(await count('SELECT count(*)::int AS n FROM recurring_template WHERE template_id = $1', [id]), 0);
});

test('customer Late Fees tab: policy, switch, charged fees', async () => {
  const c = app.ids.customers.prairie;
  const tab = await (await app.get(`/customers/${c}?tab=late-fees`)).text();
  assert.match(tab, /Late fees for .* are <strong>on<\/strong>/);
  assert.match(tab, /LF-\d{4}/);
  assert.equal((await app.post(`/customers/${c}/late-fees`, { enabled: '0' })).status, 303);
  assert.match(await (await app.get(`/customers/${c}?tab=late-fees`)).text(), /are <strong>off<\/strong>/);
});
