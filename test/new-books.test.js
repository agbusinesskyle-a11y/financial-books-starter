import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { freshDb } from './harness.js';
import { startBooks, STANDARD_ACCOUNTS } from '../lib/data/companies.js';
import { createApp } from '../services/app/index.js';

// Starting your own empty books (scripts/new-books.js): the org named by APP_ORG and its first company.
let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.drop(); });

test('startBooks makes the org and an empty first company with the standard chart of accounts', async () => {
  const { orgId, entityId } = await startBooks(db.pool, { slug: 'mybooks', companyName: 'Example Fireworks LLC', timeZone: 'America/Denver' });
  const { rows: [org] } = await db.pool.query('SELECT slug, name FROM org WHERE org_id = $1', [orgId]);
  assert.deepEqual(org, { slug: 'mybooks', name: 'Example Fireworks LLC' });
  const { rows: [e] } = await db.pool.query('SELECT name, time_zone FROM entity WHERE entity_id = $1', [entityId]);
  assert.deepEqual(e, { name: 'Example Fireworks LLC', time_zone: 'America/Denver' });
  const { rows: names } = await db.pool.query('SELECT name FROM account WHERE entity_id = $1', [entityId]);
  for (const [name] of STANDARD_ACCOUNTS) assert.ok(names.some(r => r.name === name), name);
  const { rows: [{ n }] } = await db.pool.query('SELECT count(*)::int AS n FROM txn WHERE entity_id = $1', [entityId]);
  assert.equal(n, 0);
  await assert.rejects(startBooks(db.pool, { slug: 'mybooks', companyName: 'Again' }), /already exist/);
  await assert.rejects(startBooks(db.pool, { slug: 'My Books', companyName: 'X' }), /lowercase/);
});

test('the app opens the new books (DEV_NO_AUTH) and shows the empty company', async () => {
  const server = http.createServer(createApp({ pool: db.pool, env: { APP_ORG: 'mybooks', DEV_NO_AUTH: '1', RUN_JOBS: '0' } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/customers`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Example Fireworks LLC/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
