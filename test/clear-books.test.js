import { PG_DUMP } from './pg-clients.js';
// test/clear-books.test.js — the clear refuses without a matching carry-over file and a dump, and leaves users, org and migrations alone.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADMIN_URL, freshDb } from './harness.js';
import { generateSample } from '../lib/seed/generate.js';
import { writeSample } from '../lib/data/seed.js';
import { saveCarryOver } from '../lib/rebuild/carry-over.js';

let db, dir, carry, dump;
const run = args => promisify(execFile)(process.execPath, ['scripts/clear-books.mjs', ...args, '--rehearsed', dump+'.receipt.json'], { env: { ...process.env, DATABASE_URL: db.url, ALLOW_SUPERUSER: '1' } });
before(async () => {
  db = await freshDb();
  await writeSample(db.pool, generateSample({ asOf: '2026-10-12' }));
  await db.pool.query("INSERT INTO app_user (org_id, name, email, role, all_companies, active) SELECT org_id, 'Owner', 'owner@example.com', 'admin', true, true FROM org");
  dir = await mkdtemp(join(tmpdir(), 'fb-clear-'));
  carry = join(dir, 'carry.json'); dump = join(dir, 'before.dump');
  await writeFile(carry, JSON.stringify(await saveCarryOver(db.pool, { orgSlug: 'sample' })));
  await new Promise(r => setTimeout(r, 20));
  await promisify(execFile)(PG_DUMP, ['-Fc', '-d', db.url, '-f', dump]);
  const admin = join(dir, 'admin.url'); await writeFile(admin, ADMIN_URL);
  await promisify(execFile)(process.execPath,['scripts/dump-rehearse.mjs',dump,admin]);
});
after(async () => { await db.drop(); await rm(dir, { recursive: true, force: true }); });

test('refuses without a carry-over file or dump, and when the carry-over names another org', async () => {
  await assert.rejects(run(['--apply']), e => e.code === 2);
  await assert.rejects(run(['--carry-over', carry, '--apply']), e => /--dump/.test(e.stderr) && e.code === 2);
  const other = join(dir, 'other.json');
  await writeFile(other, JSON.stringify({ ...JSON.parse(await (await import('node:fs/promises')).readFile(carry, 'utf8')), orgSlug: 'someone-else' }));
  await assert.rejects(run(['--carry-over', other, '--dump', dump, '--apply']), e => /carry-over is for org “someone-else”/.test(e.stderr) && e.code === 1);
});

test('dry run lists tables and changes nothing; --apply empties the books and keeps users, org and migrations', async () => {
  const dry = await run(['--carry-over', carry, '--dump', dump]);
  assert.match(dry.stdout, /txn\s+\d+/);
  assert.match(dry.stdout, /Dry run/);
  assert.ok((await db.pool.query('SELECT count(*)::int n FROM txn')).rows[0].n > 0);
  const out = await run(['--carry-over', carry, '--dump', dump, '--apply']);
  assert.match(out.stdout, /cleared \d+ tables/);
  for (const t of ['txn', 'posting', 'account', 'entity', 'customer', 'vendor']) assert.equal((await db.pool.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n, 0, t);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM app_user')).rows[0].n, 1);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM org')).rows[0].n, 1);
  assert.ok((await db.pool.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n >= 65);
  assert.equal((await db.pool.query("SELECT last_value FROM entity_entity_id_seq")).rows[0].last_value, 1);
});
