import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb } from './harness.js';
import { createApp } from '../services/app/index.js';
import { resetDemo, demoProblems } from '../lib/data/demo.js';
import { mintToken } from '../lib/integration/tokens.js';
import { setupIntegrationItems } from '../lib/integration/item-setup.js';

const env = { DEMO_MODE: '1' };
const catalog = { version: 1, map_sha256: 'a'.repeat(64), items: [] };
async function demo(t) {
  const db = await freshDb();
  t.after(() => db.drop());
  await resetDemo(db.pool, { env, asOf: '2026-10-20', log: () => {} });
  const company = (await db.pool.query('SELECT org_id,entity_id,name FROM entity ORDER BY entity_id LIMIT 1')).rows[0];
  return { ...db, company, scope: { orgId: company.org_id, entityId: company.entity_id } };
}

test('public demo refuses every API and token settings route without creating integration state', async t => {
  const db = await demo(t);
  const app = createApp({ pool: db.pool, env });
  await app.ready;
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const before = async () => Promise.all(['api_token', 'external_ref', 'integration_setting', 'txn', 'audit_log'].map(async table =>
    (await db.pool.query(`SELECT to_jsonb(x) row FROM ${table} x ORDER BY to_jsonb(x)::text`)).rows));
  const original = await before();
  for (const method of ['GET', 'POST', 'DELETE']) {
    for (const path of ['/api/integration/v1', '/api/integration/v1/companies', '/api/integration/v1/invoices',
      '/api/integration/v1/bills', '/api/integration/v1/customer-payments', '/api/integration/v1/bill-payments',
      '/api/integration/v1/settlements', '/api/integration/v1/documents/sample/settlement',
      '/settings/integrations', '/settings/integrations/tokens', '/settings/integrations/policy', '/settings/integrations/tokens/1/revoke']) {
      const response = await fetch(base + path, { method, redirect: 'manual' });
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.match(await response.text(), /demo/i);
    }
  }
  assert.deepEqual(await before(), original);
  // Even a valid credential inserted after the app's cached demo check cannot reach authentication.
  const token = await mintToken(db.pool, { ...db.scope, name: 'Sample connector', source: 'sample', scopes: ['documents:write'], actor: 'tester' });
  const withToken = await before();
  for (const [method, path] of [['GET', '/companies'], ['POST', '/invoices']]) {
    const response = await fetch(base + '/api/integration/v1' + path, {
      method, headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: '{}' } : {}),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'demo_disabled');
  }
  assert.deepEqual(await before(), withToken, 'valid credentials do not change integration state or token counters');
});

test('demo integrity check detects credentials, integration policies and external links', async t => {
  const db = await demo(t);
  assert.deepEqual(await demoProblems(db.pool), []);
  const token = await mintToken(db.pool, { ...db.scope, name: 'Sample connector', source: 'sample', scopes: ['settlements:read'], actor: 'tester' });
  assert.ok((await demoProblems(db.pool)).some(p => /API tokens/.test(p)));
  await assert.rejects(resetDemo(db.pool, { env, log: () => {} }), /API tokens/);
  assert.equal((await db.pool.query('SELECT token_id FROM api_token')).rows[0].token_id, token.tokenId);
  await db.pool.query('DELETE FROM api_token');
  // Minting also creates a disabled policy; it must remain detectable after the credential is removed.
  assert.ok((await demoProblems(db.pool)).some(p => /integration settings/.test(p)));
  await db.pool.query('DELETE FROM integration_setting');
  const txn = (await db.pool.query('SELECT txn_id FROM txn WHERE entity_id=$1 LIMIT 1', [db.scope.entityId])).rows[0];
  await db.pool.query(`INSERT INTO external_ref(org_id,entity_id,source,source_ref,txn_id,request_hash)
    VALUES($1,$2,'sample','sample:1',$3,$4)`, [db.scope.orgId, db.scope.entityId, txn.txn_id, 'a'.repeat(64)]);
  assert.ok((await demoProblems(db.pool)).some(p => /integration links/.test(p)));
});

test('item setup refuses demo mode and marked databases before applying a catalog', async t => {
  const db = await demo(t);
  const dir = await mkdtemp(join(tmpdir(), 'sample-integration-demo-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'sample-items.json');
  await writeFile(file, JSON.stringify(catalog));
  const args = { orgSlug: 'sample', companyName: db.company.name, catalog };
  await assert.rejects(setupIntegrationItems(db.pool, args), /public demo/);
  const tables = ['item', 'integration_setting', 'api_token', 'audit_log', 'demo_marker'];
  const snapshot = () => Promise.all(tables.map(async table =>
    (await db.pool.query(`SELECT to_jsonb(x) row FROM ${table} x ORDER BY to_jsonb(x)::text`)).rows));
  const original = await snapshot();
  for (const mode of ['0', '1']) for (const apply of [false, true]) {
    await assert.rejects(promisify(execFile)(process.execPath, ['scripts/setup-integration-items.mjs',
      '--org', 'sample', '--company', db.company.name, '--app-map', file,
      ...(apply ? ['--apply', '--approved-hash', 'a'.repeat(64)] : [])], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DATABASE_URL: db.url, ALLOW_SUPERUSER: '1', DEMO_MODE: mode },
      windowsHide: true, timeout: 30_000,
    }), error => error.code === 1 && /demo/i.test(error.stderr));
  }
  assert.deepEqual(await snapshot(), original);
});
