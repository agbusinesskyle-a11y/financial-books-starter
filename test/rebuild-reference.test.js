import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { makeDb, q, invoke, copy, saved, apply, feed, dir, runFile, ll, la } from './rebuild-fixture.js';

test('reference requires import coverage for every entity and imported applications', async () => {
  const src = await makeDb({imported:true}), dst = await makeDb({entity:false});
  await q(src, "INSERT INTO entity(org_id,name) VALUES(1,'Sample missing import')");
  let result = await copy(src,dst);
  assert.equal(result.code,1);
  assert.match(result.stderr,/import_batch/);
  await q(src,"DELETE FROM entity WHERE name='Sample missing import'");
  await q(src,"SELECT set_config('fb.import','on',false)");
  await q(src,'UPDATE application SET source=NULL');
  assert.ok((await q(src,'SELECT * FROM application')).length);
  result = await copy(src,dst);
  assert.equal(result.code,1);
  assert.match(result.stderr,/application/);
  assert.equal((await q(dst,'SELECT count(*) n FROM entity'))[0].n,0);
});

test('yardstick refuses companies without transactions', async () => {
  const db = await makeDb();
  const result = await invoke('rebuild-check',[db.file,'2026-10-20']);
  assert.equal(result.code,1);
  assert.match(result.stderr,/zero transactions/);
});

test('R6 copy must refuse native state inside importer tables',async()=>{
  const src=await makeDb({imported:true}),dst=await makeDb({entity:false});
  // The importer-owned tables may also contain valid site-made transactions.
  await q(src,"SELECT set_config('fb.import','on',false)");
  await q(src,"UPDATE txn SET source=NULL WHERE doc_number='JE-1'");
  const result=await copy(src,dst);
  console.log('R6',JSON.stringify({code:result.code,stderr:result.stderr,native:(await q(dst,'SELECT count(*) n FROM txn WHERE source IS NULL'))[0].n}));
  assert.notEqual(result.code,0);
});

test('R12 empty reference source and empty books must not be certified as rebuilt',async()=>{
  const src=await makeDb({entity:false}),dst=await makeDb({entity:false});
  const copied=await copy(src,dst),checked=await invoke('rebuild-check',[dst.file,'2026-10-20']);
  console.log('R12',JSON.stringify({copy:copied.code,check:checked.code,entities:(await q(dst,'SELECT count(*) n FROM entity'))[0].n,imports:(await q(dst,'SELECT count(*) n FROM import_batch'))[0].n}));
  assert.notEqual(copied.code,0);
  assert.notEqual(checked.code,0);
});
