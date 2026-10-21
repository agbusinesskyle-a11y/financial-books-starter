// test/carry-over.test.js — practice-only state is saved by natural keys and re-applied to a rebuilt copy; leftovers are reported, never dropped silently.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './harness.js';
import { generateSample } from '../lib/seed/generate.js';
import { writeSample } from '../lib/data/seed.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entityByName, accountByName, customerByName, vendorByName } from '../lib/rebuild/keys.js';

let db, ids;
before(async () => { db = await freshDb(); ids = await writeSample(db.pool, generateSample({ asOf: '2026-10-12' })); });
after(async () => { await db.drop(); });

test('resolvers find rows by company and name, and say which name is missing', async () => {
  const { rows: [e] } = await db.pool.query('SELECT name FROM entity WHERE entity_id = $1', [ids.entityId]);
  const entity = await entityByName(db.pool, { orgId: ids.orgId, name: e.name });
  assert.equal(entity.entity_id, ids.entityId);
  const { rows: [a] } = await db.pool.query('SELECT name, type FROM account WHERE account_id = $1', [ids.accounts.checking]);
  assert.equal((await accountByName(db.pool, { orgId: ids.orgId, entityId: ids.entityId, name: a.name, type: a.type })).account_id, ids.accounts.checking);
  await assert.rejects(accountByName(db.pool, { orgId: ids.orgId, entityId: ids.entityId, name: a.name, type: 'credit_card' }), /is a bank account, not credit_card/);
  await assert.rejects(accountByName(db.pool, { orgId: ids.orgId, entityId: ids.entityId, name: 'No such account', type: 'bank' }), /No account “No such account”/);
  const { rows: [c] } = await db.pool.query('SELECT display_name FROM customer WHERE customer_id = $1', [ids.customers.hilltop]);
  assert.equal((await customerByName(db.pool, { orgId: ids.orgId, entityId: ids.entityId, name: c.display_name })).customer_id, ids.customers.hilltop);
  await assert.rejects(vendorByName(db.pool, { orgId: ids.orgId, entityId: ids.entityId, name: 'Nobody' }), /No vendor “Nobody”/);
});

import { saveCarryOver } from '../lib/rebuild/carry-over.js';
import { saveRule } from '../lib/bankfeed/rules.js';
import { saveLoanSetup } from '../lib/data/loans.js';

test('save records feed links and mappings, rules, loan flags and company details by name, and lists leftovers', async () => {
  const S = { orgId: ids.orgId, entityId: ids.entityId };
  await db.pool.query("UPDATE org SET ledgerline_org_id='00000000-0000-4000-8000-000000000001'");
  const { rows: [e] } = await db.pool.query('SELECT name FROM entity WHERE entity_id = $1', [ids.entityId]);
  // A linked company with one mapped and one unmapped feed account (what a pull would have created).
  await db.pool.query(`INSERT INTO ledgerline_link (org_id, entity_id, ll_entity_id, ll_entity_name, linked_by) VALUES ($1, $2, '00000000-0000-4000-8000-000000000011', 'Sample company A', 'tester')`, [S.orgId, S.entityId]);
  await db.pool.query(`INSERT INTO ledgerline_account (org_id, entity_id, ll_account_id, display_name, institution_name, mask, kind, currency, books_account_id, include, start_date, mapped_by, mapped_at)
    VALUES ($1, $2, '00000000-0000-4000-8000-000000000021', 'Checking', 'Sample Bank', '1234', 'checking', 'USD', $3, true, '2026-10-14', 'tester', now()),
           ($1, $2, '00000000-0000-4000-8000-000000000022', 'Old card', 'Sample Bank', '9999', 'credit_card', 'USD', NULL, false, NULL, 'tester', now())`, [S.orgId, S.entityId, ids.accounts.checking]);
  await saveRule(db.pool, { ...S, fields: { name: 'Payroll', money: 'out', conditions: [{ field: 'description', op: 'contains', value: 'PAYROLL' }], payee: `v:${ids.vendors.electric}`, accountId: ids.accounts.office, memo: '', memoMode: 'replace', mode: 'suggest', priority: '1', active: true, matchAll: true, llAccounts: ['00000000-0000-4000-8000-000000000021'], splits: [] }, actor: 'tester' });
  await saveLoanSetup(db.pool, { ...S, accountId: ids.accounts.equipment_loan, list: 'show', otherAccountId: null, openEntityIds: [] });
  await db.pool.query(`INSERT INTO ai_settings (org_id, provider, api_key_enc, models, web_search, updated_by) VALUES ($1, 'openrouter', 'v1:aaa:bbb:ccc', '{"vendor_research":"m"}', true, 'tester')`, [S.orgId]);
  await db.pool.query(`INSERT INTO vendor_research_attempt (org_id, entity_id, payee_key, at) VALUES ($1, $2, 'acme', now())`, [S.orgId, S.entityId]);

  const saved = await saveCarryOver(db.pool, { orgSlug: (await db.pool.query('SELECT slug FROM org WHERE org_id = $1', [S.orgId])).rows[0].slug });
  assert.equal(saved.version, 1);
  const co = saved.companies.find(c => c.name === e.name);
  assert.equal(co.feed.llEntityId, '00000000-0000-4000-8000-000000000011');
  const mapped = co.feed.accounts.find(a => a.llAccountId === '00000000-0000-4000-8000-000000000021');
  assert.deepEqual(mapped.books, { account: (await db.pool.query('SELECT name FROM account WHERE account_id = $1', [ids.accounts.checking])).rows[0].name, type: 'bank' });
  assert.equal(mapped.start, '2026-10-14');
  assert.equal(co.feed.accounts.find(a => a.llAccountId === '00000000-0000-4000-8000-000000000022').include, false);
  assert.equal(co.rules[0].name, 'Payroll');
  assert.deepEqual(co.rules[0].payee, { kind: 'vendor', name: (await db.pool.query('SELECT display_name FROM vendor WHERE vendor_id = $1', [ids.vendors.electric])).rows[0].display_name });
  assert.equal(co.rules[0].conditions[0].value, 'PAYROLL');
  assert.deepEqual(co.loans, [{ account: (await db.pool.query('SELECT name FROM account WHERE account_id = $1', [ids.accounts.equipment_loan])).rows[0].name, list: 'show', other: null }]);
  assert.equal(saved.org.ai.apiKeyEnc, 'v1:aaa:bbb:ccc');
  assert.deepEqual(co.researchAttempts.map(a => a.payeeKey), ['acme']);
  assert.deepEqual(saved.unclassified, []);
  assert.ok(Array.isArray(saved.leftovers));
  assert.ok(!JSON.stringify(saved).includes('"entity_id"'), 'no internal ids in the file');
  assert.equal(saved.orgSlug, 'sample');
  assert.equal(co.nativeTransactionCount, co.nativeTransactions.length);
});

import { applyCarryOver } from '../lib/rebuild/carry-over.js';

test('apply (books phase) restores company details, loan flags, org settings and research attempts on a copy, and reports account renames and FB-only transactions as decisions', async () => {
  // A second database plays the rebuilt copy: same sample, no practice-only state.
  const target = await freshDb();
  try {
    const tids = await writeSample(target.pool, generateSample({ asOf: '2026-10-12' }));
    const saved = await saveCarryOver(db.pool, { orgSlug: 'sample' });
    // Pretend the source had renamed an account and entered one transaction QuickBooks never saw.
    const co = saved.companies[0];
    co.accountChanges.push({ kind: 'renamed', name: 'Checking (Chase)', before: { name: 'Checking' }, type: 'bank', active: true, parent: null, number: null });
    co.nativeTransactions.push({ type: 'journal_entry', date: '2026-10-13', docNumber: 'JE-0002', totalCents: 105180, memo: 'opening', party: null, postings: [], feedItems: [] });
    const report = await applyCarryOver(target.pool, { data: saved, phase: 'books', actor: 'carry-over test', env: process.env, dryRun: false });
    const { rows: [e] } = await target.pool.query('SELECT loan_list FROM account WHERE account_id = $1', [tids.accounts.equipment_loan]);
    assert.equal(e.loan_list, 'show');
    assert.equal((await target.pool.query('SELECT provider FROM ai_settings')).rows[0].provider, 'openrouter');
    assert.equal((await target.pool.query('SELECT count(*)::int n FROM vendor_research_attempt')).rows[0].n, 1);
    assert.ok(report.decisions.some(d => d.kind === 'renamed' && d.before === 'Checking'));
    assert.ok(report.decisions.some(d => d.docNumber === 'JE-0002'));
    assert.equal(report.applied.filter(a => a.what === 'loan').length, 1);
    // Reruns preserve these business values and decisions; writer metadata may advance.
    const again = await applyCarryOver(target.pool, { data: saved, phase: 'books', actor: 'carry-over test', env: process.env, dryRun: false });
    assert.equal((await target.pool.query('SELECT count(*)::int n FROM vendor_research_attempt')).rows[0].n, 1);
    assert.deepEqual(again.decisions.map(d => d.docNumber ?? d.name), report.decisions.map(d => d.docNumber ?? d.name));
  } finally { await target.drop(); }
});

test('dry run applies nothing', async () => {
  const target = await freshDb();
  try {
    await writeSample(target.pool, generateSample({ asOf: '2026-10-12' }));
    const saved = await saveCarryOver(db.pool, { orgSlug: 'sample' });
    const report = await applyCarryOver(target.pool, { data: saved, phase: 'books', actor: 'carry-over test', env: process.env, dryRun: true });
    assert.ok(report.planned.length > 0);
    assert.equal(report.applied.length, 0);
    assert.equal((await target.pool.query('SELECT count(*)::int n FROM ai_settings')).rows[0].n, 0);
  } finally { await target.drop(); }
});

test('apply (feeds phase) re-links, waits for pulled accounts, then maps and replays rules by name', async () => {
  const target = await freshDb();
  try {
    const tids = await writeSample(target.pool, generateSample({ asOf: '2026-10-12' }));
    const saved = await saveCarryOver(db.pool, { orgSlug: 'sample' });
    await target.pool.query('UPDATE org SET ledgerline_org_id = $1', ['00000000-0000-4000-8000-000000000001']);
    const links = await applyCarryOver(target.pool, { data: saved, phase: 'links', actor: 'carry-over test', env: process.env, dryRun: false });
    assert.equal(links.applied.filter(a => a.what === 'link').length, 1);
    assert.equal((await target.pool.query('SELECT last_pull_at FROM ledgerline_link')).rows[0].last_pull_at, null);
    // The app's first pull would create these rows; the test plays the pull.
    await target.pool.query(`INSERT INTO ledgerline_account (org_id, entity_id, ll_account_id, display_name, institution_name, mask, kind, currency)
      VALUES ($1, $2, '00000000-0000-4000-8000-000000000021', 'Checking', 'Sample Bank', '1234', 'checking', 'USD'),
             ($1, $2, '00000000-0000-4000-8000-000000000022', 'Old card', 'Sample Bank', '9999', 'credit_card', 'USD')`, [tids.orgId, tids.entityId]);
    const feeds = await applyCarryOver(target.pool, { data: saved, phase: 'feeds', actor: 'carry-over test', env: process.env, dryRun: false, waitMinutes: 0 });
    const { rows } = await target.pool.query('SELECT ll_account_id::text id, books_account_id, include, start_date FROM ledgerline_account ORDER BY 1');
    assert.equal(rows[0].books_account_id, tids.accounts.checking);
    assert.equal(rows[0].start_date, '2026-10-14');
    assert.equal(rows[1].include, false);
    const { rows: [rule] } = await target.pool.query('SELECT name, account_id, payee, mode FROM bank_rule');
    assert.equal(rule.name, 'Payroll');
    assert.equal(rule.account_id, tids.accounts.office);
    assert.equal(rule.payee, `v:${tids.vendors.electric}`);
    assert.equal(feeds.skipped.length, 0);
  } finally { await target.drop(); }
});

test('apply (feeds phase) refuses to wait forever and names the company still without pulled accounts', async () => {
  const target = await freshDb();
  try {
    await writeSample(target.pool, generateSample({ asOf: '2026-10-12' }));
    const saved = await saveCarryOver(db.pool, { orgSlug: 'sample' });
    await target.pool.query("UPDATE org SET ledgerline_org_id='00000000-0000-4000-8000-000000000001'");
    await assert.rejects(applyCarryOver(target.pool, { data: saved, phase: 'feeds', actor: 'carry-over test', env: process.env, dryRun: false, waitMinutes: 0 }), /no feed accounts yet/);
  } finally { await target.drop(); }
});

test('carry-over CLI saves JSON and defaults to a books dry run that leaves the target unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fb-carry-'));
  const tmpFile = join(dir, 'carry.json');
  const target = await freshDb();
  try {
    await writeSample(target.pool, generateSample({ asOf: '2026-10-12' }));
    const run = promisify(execFile);
    await run(process.execPath, ['scripts/carry-over.mjs', 'save', tmpFile, '--org', 'sample'],
      { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, DATABASE_URL: db.url, ALLOW_SUPERUSER: '1' } });
    const saved = JSON.parse(await readFile(tmpFile, 'utf8'));
    assert.equal(saved.version, 1);
    assert.equal(saved.orgSlug, 'sample');
    const before = await saveCarryOver(target.pool, { orgSlug: 'sample' });
    const dry = await run(process.execPath, ['scripts/carry-over.mjs', 'apply', tmpFile, '--phase', 'books'],
      { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, DATABASE_URL: target.url, ALLOW_SUPERUSER: '1', APP_ORG: 'sample' } });
    assert.match(dry.stdout, /Dry run/);
    const after = await saveCarryOver(target.pool, { orgSlug: 'sample' });
    assert.deepEqual({ ...after, savedAt: before.savedAt }, before);
    assert.equal((await target.pool.query('SELECT count(*)::int n FROM ai_settings')).rows[0].n, 0);
  } finally { await target.drop(); await rm(dir, { recursive: true, force: true }); }
});

test('carry-over CLI requires --org or APP_ORG and reports without printing saved secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fb-carry-'));
  const file = join(dir, 'carry.json');
  const env = { ...process.env, DATABASE_URL: db.url, ALLOW_SUPERUSER: '1', APP_ORG: '' };
  const run = args => promisify(execFile)(process.execPath, ['scripts/carry-over.mjs', ...args], { env, maxBuffer: 16 * 1024 * 1024 });
  try {
    await assert.rejects(run(['save', file]), e => e.code === 2 && /--org.*APP_ORG/.test(e.stderr));
    await run(['save', file, '--org', 'sample']);
    const out = await run(['report', file, '--org', 'sample']);
    const report = JSON.parse(out.stdout);
    assert.equal(report.counts.companies, 1);
    assert.ok(Array.isArray(report.decisions));
    assert.ok(!out.stdout.includes('v1:aaa:bbb:ccc'));
    await assert.rejects(run(['report', file, '--org', 'someone-else']), e => e.code === 1 && /carry-over:/.test(e.stderr));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
