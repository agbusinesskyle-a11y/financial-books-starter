import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { makeDb, q, invoke, copy, saved, apply, feed, dir, runFile, ll, la } from './rebuild-fixture.js';

test('R9 item reorder point must survive save/apply or be listed as unhandled',async()=>{
  const src=await makeDb(),dst=await makeDb();
  await q(src,"INSERT INTO item(org_id,entity_id,name,kind,rate_cents,reorder_point) VALUES(1,1,'Sample inventory','inventory',1234,25)");
  const data=await saved(src); const report=await apply(dst,data);
  const item=(await q(dst,"SELECT reorder_point FROM item WHERE name='Sample inventory'"))[0];
  console.log('R9',JSON.stringify({saved:data.companies[0].items,leftovers:data.leftovers,item,report}));
  assert.equal(Number(item.reorder_point),25);
});
