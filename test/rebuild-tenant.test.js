import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { makeDb, q, invoke, copy, saved, apply, feed, dir, runFile, ll, la } from './rebuild-fixture.js';

test('R1 links must refuse a missing org ledgerline tenant',async()=>{
  const d=await makeDb(); const data=await saved(d);
  data.companies[0].feed={llEntityId:ll,llEntityName:'Sample feed',linkedBy:'tester',accounts:[]};
  await assert.rejects(apply(d,data,'links'),/ledgerline_org_id/);
  const rows=await q(d,'SELECT last_pull_at FROM ledgerline_link');
  console.log('R1',JSON.stringify({tenant:(await q(d,'SELECT ledgerline_org_id FROM org'))[0],links:rows}));
  assert.equal(rows.length,0,'must not persist a link without ledgerline_org_id');
});

test('links refuse a different saved tenant and accept the matching configured tenant',async()=>{
  const db=await makeDb(),data=await saved(db);
  data.companies[0].feed={llEntityId:ll,llEntityName:'Sample feed',accounts:[]};
  data.org.ledgerlineOrgId='00000000-0000-4000-8000-000000000001';
  await q(db,"UPDATE org SET ledgerline_org_id='00000000-0000-4000-8000-000000000002'");
  await assert.rejects(apply(db,data,'links'),/tenant does not match/);
  assert.equal((await q(db,'SELECT * FROM ledgerline_link')).length,0);
  await q(db,'UPDATE org SET ledgerline_org_id=$1',[data.org.ledgerlineOrgId]);
  await apply(db,data,'links');
  assert.deepEqual(await q(db,'SELECT last_pull_at FROM ledgerline_link'),[{last_pull_at:null}]);
});
