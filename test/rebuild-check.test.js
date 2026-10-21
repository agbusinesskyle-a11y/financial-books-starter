// test/rebuild-check.test.js — the yardstick passes on a sample copy and fails when a posting is knocked out of balance.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb } from './harness.js';
import { makeDb, q, dir, companyFile, exportsFolder } from './rebuild-fixture.js';

let db, file;
const run = args => promisify(execFile)(process.execPath, ['scripts/rebuild-check.mjs', ...args,'--companies',companyFile,'--exports',exportsFolder], { env: { ...process.env, ALLOW_SUPERUSER: '1' } });
before(async () => { db = await makeDb({imported:true}); file = db.file; });

test('passes on a consistent copy and reports the counts', async () => {
  const out = await run([file, '2026-10-12', '--out', join(dir, 'out.json')]);
  assert.match(out.stdout, /balanced: true/);
  assert.match(out.stdout, /period comparisons: \d+ nonzero: 0/);
  const j = JSON.parse(await (await import('node:fs/promises')).readFile(join(dir, 'out.json'), 'utf8'));
  assert.ok(j.checks.length >= 1);
});

test('fails when a posting no longer balances', async () => {
  await db.pool.query("ALTER TABLE posting DISABLE TRIGGER ALL");
  const { rows: [p] } = await db.pool.query('SELECT posting_id FROM posting ORDER BY posting_id LIMIT 1');
  await db.pool.query('UPDATE posting SET amount_cents = amount_cents + 1 WHERE posting_id = $1', [p.posting_id]);
  await assert.rejects(run([file, '2026-10-12']), e => /unbalanced transactions: 1/.test(e.stdout + e.stderr) && e.code === 1);
});
