import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb,q,saved,apply,feed } from './rebuild-fixture.js';
import { saveRule } from '../lib/bankfeed/rules.js';
import { saveClass,saveLocation } from '../lib/data/accounting.js';
import { validateCarryCounts } from '../lib/rebuild/carry-validation.js';
import { saveJournalEntry } from '../lib/data/ledger-tools.js';

test('V3 legitimate same-named subclasses validate against their unchanged save',async()=>{
  const db=await makeDb({imported:true});
  for (const parent of ['Sample operations','Sample administration']) {
    await saveClass(db.pool,{orgId:1,entityId:1,fields:{name:parent,parentId:null}});
    const [{class_id:parentId}]=await q(db,'SELECT class_id FROM class WHERE name=$1',[parent]);
    await saveClass(db.pool,{orgId:1,entityId:1,fields:{name:'Sample shared department',parentId}});
  }
  const data=await saved(db);let error=null;
  try { await validateCarryCounts(db.pool,data); } catch(e) {error=e.message;}
  console.log('V3',JSON.stringify({classes:data.companies[0].classes,error,retainedClasses:(await q(db,'SELECT count(*) n FROM class'))[0].n}));
  assert.equal(error,null,'name-only normalization rejects valid subclasses under different parents');
});

test('class paths survive shuffled save/apply, duplicate leaves, rule references and reruns',async()=>{
  const src=await makeDb({imported:true}),dst=await makeDb({imported:true});
  for(const db of [src,dst]) {
    await q(db,"UPDATE org SET ledgerline_org_id='00000000-0000-4000-8000-000000000001'");await feed(db);
  }
  const scope={orgId:1,entityId:1},leaf='Sample shared department';
  await saveClass(src.pool,{...scope,fields:{name:leaf}});
  for(const parent of ['Sample operations','Sample administration']) {
    await saveClass(src.pool,{...scope,fields:{name:parent}});
    const [{class_id:parentId}]=await q(src,'SELECT class_id FROM class WHERE name=$1',[parent]);
    await saveClass(src.pool,{...scope,fields:{name:leaf,parentId}});
    const [{class_id:classId}]=await q(src,'SELECT class_id FROM class WHERE parent_id=$1',[parentId]);
    if(parent==='Sample administration') await saveClass(src.pool,{...scope,classId,fields:{name:leaf,parentId,active:false}});
    const [{account_id:accountId}]=await q(src,"SELECT account_id FROM account WHERE name='Fuel'");
    await saveRule(src.pool,{...scope,actor:'tester',fields:{name:parent,money:'out',accountId,classId,
      conditions:[{field:'description',op:'contains',value:'SAMPLE REFUEL'}]}});
  }
  await saveLocation(src.pool,{...scope,fields:{name:'Sample location'}});
  const data=await saved(src);data.companies[0].classes.reverse();
  await validateCarryCounts(src.pool,data);
  assert.deepEqual(data.companies[0].rules.map(r=>r.class),[
    `Sample operations:${leaf}`,`Sample administration:${leaf}`]);
  const changed=structuredClone(data);changed.companies[0].rules[0].class=`Sample administration:${leaf}`;
  await assert.rejects(validateCarryCounts(src.pool,changed),/content mismatch/);
  const shape=`SELECT c.name,p.name AS parent,c.active FROM class c LEFT JOIN class p ON p.class_id=c.parent_id ORDER BY parent NULLS FIRST,c.name`;
  for(let i=0;i<2;i++) {
    assert.deepEqual((await apply(dst,data,'books')).skipped,[]);
    const result=await apply(dst,data,'feeds');assert.deepEqual(result.skipped,[]);assert.deepEqual(result.decisions,[]);
    assert.deepEqual(await q(dst,shape),await q(src,shape));
    assert.deepEqual((await saved(dst)).companies[0].rules.map(r=>r.class),data.companies[0].rules.map(r=>r.class));
    assert.deepEqual((await saved(dst)).companies[0].locations,data.companies[0].locations);
  }
});

test('native transaction class identity includes the parent path',async()=>{
  const src=await makeDb({imported:true}),scope={orgId:1,entityId:1};
  const ids=[];
  for(const parent of ['Sample operations','Sample administration']) {
    await saveClass(src.pool,{...scope,fields:{name:parent}});
    const [{class_id:parentId}]=await q(src,'SELECT class_id FROM class WHERE name=$1',[parent]);
    await saveClass(src.pool,{...scope,fields:{name:'Sample shared department',parentId}});
    ids.push((await q(src,'SELECT class_id FROM class WHERE parent_id=$1',[parentId]))[0].class_id);
  }
  const [t]=await q(src,"SELECT * FROM txn WHERE doc_number='JE-1'");
  const lines=await q(src,'SELECT * FROM txn_line WHERE txn_id=$1 ORDER BY line_no',[t.txn_id]);
  await q(src,"SELECT set_config('fb.import','on',false)");
  await q(src,'UPDATE txn SET source=NULL WHERE txn_id=$1',[t.txn_id]);
  await saveJournalEntry(src.pool,{...scope,txnId:t.txn_id,txnDate:t.txn_date,docNumber:t.doc_number,actor:'tester',
    lines:lines.map((l,i)=>({accountId:l.account_id,debit:l.amount_cents>0?(l.amount_cents/100).toFixed(2):'',
      credit:l.amount_cents<0?(-l.amount_cents/100).toFixed(2):'',classId:ids[i]}))});
  const data=await saved(src),native=data.companies[0].nativeTransactions[0];
  assert.equal(native.identityRepresentable,true);
  assert.deepEqual(native.lines.map(l=>l.class),['Sample operations:Sample shared department','Sample administration:Sample shared department']);
  await validateCarryCounts(src.pool,data);
});
