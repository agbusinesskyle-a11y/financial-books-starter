// test/copy-books.test.js — the copy moves the importer tables from a reference database into an empty copy keeping ids, and refuses mismatches.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb } from './harness.js';
import { readQboExport } from '../lib/import/qbo-read.js';
import { importQboCompany } from '../lib/import/qbo-import.js';
import { writeExport, OPEN } from './qbo-fixture.js';

let src, dst, dir, srcFile, dstFile;
const run = args => promisify(execFile)(process.execPath, ['scripts/copy-books.mjs', ...args, '--companies', join(dir, 'companies.json'), '--exports', join(dir,'exports')], { env: { ...process.env, ALLOW_SUPERUSER: '1' } });
// The source must look like a reference import — importer tables only. Build it with the importer itself from a synthetic export
// (the helpers writeExport/OPEN live in test/qbo-fixture.js, extracted from test/import-qbo.test.js in this task; that test imports them from there).
before(async () => {
  src = await freshDb(); dst = await freshDb();
  for (const d of [src, dst]) await d.pool.query("INSERT INTO org (slug, name) VALUES ('sample', 'Sample')");
  const { rows: [{ org_id: orgId }] } = await src.pool.query('SELECT org_id FROM org');
  dir = await mkdtemp(join(tmpdir(), 'fb-copy-'));
  await writeFile(join(dir, 'companies.json'), JSON.stringify(['Sample company A']));
  await writeExport(join(dir, 'exports','sample-company-a','export'));
  const data = { ...await readQboExport(join(dir, 'exports','sample-company-a','export')), openItems: OPEN.map(o => ({ ...o })), hasAging: { ar: true, ap: true } };
  await importQboCompany(src.pool, { orgId, companyName: 'Sample company A', data, actor: 'tester' });
  srcFile = join(dir, 'src.url'); dstFile = join(dir, 'dst.url');
  await writeFile(srcFile, src.url); await writeFile(dstFile, dst.url);
});
after(async () => { await src.drop(); await dst.drop(); await rm(dir, { recursive: true, force: true }); });

test('dry run reports the plan; --apply copies the importer tables with their ids and resets sequences', async () => {
  const dry = await run([srcFile, dstFile]);
  assert.match(dry.stdout, /txn\s+\d+/);
  assert.match(dry.stdout, /Dry run/);
  assert.equal((await dst.pool.query('SELECT count(*)::int n FROM txn')).rows[0].n, 0);
  const out = await run([srcFile, dstFile, '--apply']);
  assert.match(out.stdout, /copied and verified/);
  const a = (await src.pool.query('SELECT txn_id, total_cents FROM txn ORDER BY txn_id')).rows;
  const b = (await dst.pool.query('SELECT txn_id, total_cents FROM txn ORDER BY txn_id')).rows;
  assert.deepEqual(b, a);
  const { rows: [{ next }] } = await dst.pool.query("SELECT nextval('txn_txn_id_seq') AS next");
  assert.equal(Number(next), a.at(-1).txn_id + 1);
  assert.equal((await dst.pool.query('SELECT count(*)::int n FROM (SELECT txn_id FROM posting GROUP BY txn_id HAVING sum(amount_cents) <> 0) x')).rows[0].n, 0);
});

test('refuses a target that already has books, and a source holding practice-only state', async () => {
  await assert.rejects(run([srcFile, dstFile, '--apply']), e => /target already has rows in txn/.test(e.stderr) && e.code === 1);
  await src.pool.query("INSERT INTO ai_settings (org_id, provider, models, web_search, updated_by) SELECT org_id, 'off', '{}', false, 't' FROM org");
  const empty = await freshDb();
  try {
    const emptyFile = join(dir, 'empty.url'); await writeFile(emptyFile, empty.url);
    await empty.pool.query("INSERT INTO org (slug, name) VALUES ('sample', 'Sample')");
    await assert.rejects(run([srcFile, emptyFile, '--apply']), e => /source has practice-only state in ai_settings/.test(e.stderr) && e.code === 1);
  } finally { await empty.drop(); }
});
