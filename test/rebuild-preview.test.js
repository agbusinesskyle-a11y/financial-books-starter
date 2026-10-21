import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { makeDb, q, invoke, copy, saved, apply, feed, dir, runFile, ll, la } from './rebuild-fixture.js';

test('R2 a books dry run must preserve sequences as well as table rows',async()=>{
  const d=await makeDb(); const data=await saved(d);
  data.companies[0].classes=[{name:'Sample class',parent:null,active:true}];
  const before=(await q(d,'SELECT last_value,is_called FROM class_class_id_seq'))[0];
  await apply(d,data,'books',true);
  const after=(await q(d,'SELECT last_value,is_called FROM class_class_id_seq'))[0];
  assert.equal((await q(d,'SELECT * FROM class')).length,0);
  console.log('R2',JSON.stringify({before,after}));
  assert.deepEqual(after,before);
});
