import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { makeDb, q, invoke, copy, saved, apply, feed, dir, runFile, ll, la } from './rebuild-fixture.js';

test('R7 copy and yardstick must detect a transaction missing all its postings',async()=>{
  const src=await makeDb({imported:true}),dst=await makeDb({entity:false});
  await q(src,"DELETE FROM posting WHERE txn_id IN (SELECT txn_id FROM txn WHERE doc_number='JE-1')");
  const copied=await copy(src,dst);
  const checked=await invoke('rebuild-check',[src.file,'2026-10-20','--out',join(dir,'r7-check.json')]);
  const missing=(await q(src,"SELECT count(*) n FROM txn t WHERE t.total_cents>0 AND t.type NOT IN ('estimate','purchase_order') AND t.voided_at IS NULL AND NOT EXISTS (SELECT 1 FROM posting p WHERE p.txn_id=t.txn_id)"))[0].n;
  console.log('R7',JSON.stringify({copy:copied.code,check:checked.code,missing,stderr:checked.stderr}));
  assert.equal(missing,1);
  assert.notEqual(copied.code,0);
  assert.equal((await q(dst,'SELECT count(*) n FROM entity'))[0].n,0);
  assert.notEqual(checked.code,0,'yardstick must fail despite balanced remaining postings');
});
