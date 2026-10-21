import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { makeDb, q, invoke, copy, saved, apply, feed, dir, runFile, ll, la } from './rebuild-fixture.js';

test('R3 native transactions with different posting vectors must remain decisions',async()=>{
  const d=await makeDb({imported:true}); const data=await saved(d);
  const t=(await q(d,"SELECT * FROM txn WHERE doc_number='JE-1'"))[0];
  assert.ok(t);
  data.companies[0].nativeTransactions=[{type:t.type,date:t.txn_date,docNumber:t.doc_number,totalCents:t.total_cents,party:{kind:'vendor',name:'Sample different vendor'},postings:[{account:'Fuel',cents:t.total_cents},{account:'Visa',cents:-t.total_cents}],memo:'Different economic event',feedItems:[]}];
  const report=await apply(d,data);
  console.log('R3',JSON.stringify(report));
  assert.ok(report.decisions.some(x=>x.docNumber===t.doc_number));
  assert.match(report.decisions[0].why,/different party\/postings/);
});

test('native matching requires exact null document, full vector, and one-to-one unambiguous identity', async () => {
  const db = await makeDb({imported:true});
  const [t] = await q(db,"SELECT * FROM txn WHERE doc_number='JE-1'");
  await q(db,"SELECT set_config('fb.import','on',false)");
  await q(db,'UPDATE txn SET source=NULL WHERE txn_id=$1',[t.txn_id]);
  const data = await saved(db), co = data.companies[0], native=co.nativeTransactions[0], postings=native.postings;
  await q(db,"UPDATE txn SET source='qbo_import' WHERE txn_id=$1",[t.txn_id]);
  co.nativeTransactions = [{...native,postings:[...postings].reverse()},native];
  let report = await apply(db,data);
  assert.equal(report.skipped.filter(x=>x.why==='present in the QuickBooks import').length,1);
  assert.match(report.decisions[0].why,/already matched/);
  co.nativeTransactions = [{...native,docNumber:null}];
  report = await apply(db,data);
  assert.equal(report.decisions.length,1,'null document is not a wildcard');
  await q(db,"SELECT set_config('fb.import','on',false)");
  await q(db,'UPDATE txn SET doc_number=NULL WHERE txn_id=$1',[t.txn_id]);
  const [duplicate] = await q(db,`INSERT INTO txn(org_id,entity_id,type,txn_date,total_cents,open_cents,source)
    VALUES(1,1,$1,$2,$3,0,'qbo_import') RETURNING txn_id`,[t.type,t.txn_date,t.total_cents]);
  await q(db,`INSERT INTO posting(org_id,entity_id,txn_id,account_id,txn_date,amount_cents)
    SELECT org_id,entity_id,$1,account_id,txn_date,amount_cents FROM posting WHERE txn_id=$2`,[duplicate.txn_id,t.txn_id]);
  report = await apply(db,data);
  assert.match(report.decisions[0].why,/ambiguous/);
  assert.equal(report.skipped.filter(x=>/present/.test(x.why)).length,0);
});
