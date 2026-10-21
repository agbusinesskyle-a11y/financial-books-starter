import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, q, saved, feed, la } from './rebuild-fixture.js';

test('save reports manual and decided research as leftovers under the discard policy',async()=>{
  const db=await makeDb(); await feed(db);
  await q(db,`INSERT INTO bank_feed_item(org_id,entity_id,ll_transaction_id,ll_account_id,revision,pending,posted_date,amount_cents)
    VALUES(1,1,'00000000-0000-4000-8000-000000000031',$1,1,false,'2026-10-01',100)`,[la]);
  await q(db,`INSERT INTO vendor_research(org_id,entity_id,item_id,payee_key,status,created_by,auto,decision)
    VALUES(1,1,1,'sample manual','done','tester',false,NULL),
      (1,1,1,'sample decided','done','tester',true,'accepted'),
      (1,1,1,'sample automatic','done','tester',true,NULL)`);
  const data=await saved(db);
  assert.equal(data.leftovers.find(x=>x.table==='vendor_research')?.rows,2);
  assert.equal(data.discarded.find(x=>x.table==='vendor_research')?.rows,3);
});
