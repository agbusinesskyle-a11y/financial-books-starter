import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeDb, q, invoke, dir } from './rebuild-fixture.js';

test('S1/S2 complete transaction loss and absent or inconsistent import evidence refuse certification', async t => {
  for (const kind of ['deleted transaction', 'missing batch', 'wrong count', 'wrong date', 'duplicate batch']) await t.test(kind, async () => {
    const src = await makeDb({ imported: true }), dst = await makeDb({ entity: false });
    if (kind === 'deleted transaction') {
      await q(src, "SELECT set_config('fb.import','on',false)");
      const [{ txn_id: id }] = await q(src, "SELECT txn_id FROM txn WHERE doc_number='JE-1'");
      for (const table of ['posting', 'txn_line', 'txn']) await q(src, `DELETE FROM ${table} WHERE txn_id=$1`, [id]);
    } else if (kind === 'missing batch') await q(src, 'DELETE FROM import_batch');
    else if (kind === 'wrong count') await q(src, `UPDATE import_batch SET summary=jsonb_set(summary,'{transactions}','24')`);
    else if (kind === 'wrong date') await q(src, `UPDATE import_batch SET summary=jsonb_set(summary,'{to}','"2020-01-01"')`);
    else await q(src, `INSERT INTO import_batch(org_id,entity_id,source,company_name,summary,parity,imported_by)
      SELECT org_id,entity_id,source,company_name,summary,parity,imported_by FROM import_batch`);
    const companies = join(dir, 'expected.json'); await writeFile(companies, JSON.stringify(['Sample company A']));
    const copied = await invoke('copy-books', [src.file, dst.file, '--companies', companies, '--apply']);
    const checked = await invoke('rebuild-check', [src.file, '2026-10-20']);
    assert.equal(copied.code, 1, copied.stderr);
    assert.match(copied.stderr, /import_batch/);
    assert.equal(checked.code, 1, checked.stdout);
    assert.match(checked.stdout + checked.stderr, /import_batch/);
    assert.equal((await q(dst, 'SELECT count(*) n FROM entity'))[0].n, 0);
  });
});

test('copy requires the exact expected companies, accepting both map and array forms', async () => {
  const src = await makeDb({ imported: true }), dst = await makeDb({ entity: false });
  assert.equal((await invoke('copy-books', [src.file, dst.file])).code, 2);
  const companies = join(dir, 'coverage.json');
  for (const expected of [[], ['Sample company B'], ['Sample company A', 'Sample company B'], ['Sample company A', 'Sample company A']]) {
    await writeFile(companies, JSON.stringify(expected));
    const result = await invoke('copy-books', [src.file, dst.file, '--companies', companies, '--apply']);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /companies/);
  }
  for (const expected of [['Sample company A'], { companies: [{ fbName: 'Sample company A', qboName: 'Sample export A' }] }]) {
    await writeFile(companies, JSON.stringify(expected));
    const result = await invoke('copy-books', [src.file, dst.file, '--companies', companies]);
    assert.equal(result.code, 0, result.stderr);
  }
  const checked = await invoke('rebuild-check', [src.file, '2026-10-20']);
  assert.equal(checked.code, 0, checked.stderr);
});
