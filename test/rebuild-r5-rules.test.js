import { PG_DUMP } from './pg-clients.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeDb,q,invoke,copy,saved,apply,feed,dir,runFile,rehearse } from './rebuild-fixture.js';
import { saveRule,listRules,ruleFits } from '../lib/bankfeed/rules.js';
import { saveClass } from '../lib/data/accounting.js';
import { validateCarryCounts } from '../lib/rebuild/carry-validation.js';

test('V1 instructed feeds-books-feeds retry preserves tied automatic precedence',async()=>{
  const src=await makeDb({imported:true}),dst=await makeDb({imported:true});
  for(const db of [src,dst]) { await q(db,"UPDATE org SET ledgerline_org_id='00000000-0000-4000-8000-000000000001'"); await feed(db); }
  await saveClass(src.pool,{orgId:1,entityId:1,fields:{name:'Sample department',active:true,parentId:null}});
  const [{class_id:classId}]=await q(src,"SELECT class_id FROM class WHERE name='Sample department'");
  const accounts=Object.fromEntries((await q(src,'SELECT name,account_id FROM account')).map(a=>[a.name,a.account_id]));
  for(const [category,cls] of [['Fuel',classId],['Repairs',null]]) await saveRule(src.pool,{orgId:1,entityId:1,actor:'review-test',fields:{name:`Sample ${category}`,money:'out',priority:'100',mode:'auto',accountId:accounts[category],classId:cls,
    conditions:[{field:'description',op:'contains',value:'SAMPLE REFUEL'}]}});
  const item={amount_cents:-1234,description:'SAMPLE REFUEL',bank_text:'SAMPLE REFUEL'};
  const first=async db=>(await listRules(db.pool,{orgId:1,entityId:1})).find(r=>ruleFits(r,item));
  const before=await first(src),data=await saved(src);
  await validateCarryCounts(src.pool,data);
  const firstFeeds=await apply(dst,data,'feeds');
  assert.ok(firstFeeds.skipped.some(s=>s.name==='Sample Fuel'));
  const interim=await listRules(dst.pool,{orgId:1,entityId:1});
  const books=await apply(dst,data,'books');
  assert.ok(books.applied.some(s=>s.what==='class'));
  const secondFeeds=await apply(dst,data,'feeds'),after=await first(dst);
  assert.equal(secondFeeds.skipped.length,0);
  assert.equal(secondFeeds.decisions.length,0);
  assert.equal(secondFeeds.leftovers.length,0);
  console.log('V1',JSON.stringify({before:before.account_name,after:after.account_name,initialSkips:firstFeeds.skipped,finalSkips:secondFeeds.skipped,finalDecisions:secondFeeds.decisions,finalLeftovers:secondFeeds.leftovers,sourceRules:(await listRules(src.pool,{orgId:1,entityId:1})).map(r=>({id:r.rule_id,name:r.name,priority:r.priority})),targetRules:(await listRules(dst.pool,{orgId:1,entityId:1})).map(r=>({id:r.rule_id,name:r.name,priority:r.priority}))}));
  assert.equal(after.account_name,before.account_name,'documented retry silently reverses automatic rule winner');
  assert.deepEqual(interim,[],'no incomplete automatic rule set may be enabled');
  const order=await q(dst,'SELECT priority,rule_id,name FROM bank_rule ORDER BY priority,rule_id');
  assert.deepEqual(order.map(r=>[r.priority,r.name]),data.companies[0].rules.map(r=>[r.priority,r.name]));
  const again=await apply(dst,data,'feeds');
  assert.deepEqual(again.skipped,[]);assert.deepEqual(again.decisions,[]);
  assert.deepEqual(await q(dst,'SELECT priority,rule_id,name FROM bank_rule ORDER BY priority,rule_id'),order);
});

test('V1E real save-dump-rehearse-clear-copy and instructed retry preserve rule winner',async()=>{
  const src=await makeDb({imported:true}),ref=await makeDb({imported:true});
  assert.equal((await invoke('rebuild-check',[ref.file,'2026-10-20'])).code,0);
  await q(src,"UPDATE org SET ledgerline_org_id='00000000-0000-4000-8000-000000000001'"); await feed(src);
  await saveClass(src.pool,{orgId:1,entityId:1,fields:{name:'Sample department',active:true,parentId:null}});
  const [{class_id:classId}]=await q(src,"SELECT class_id FROM class WHERE name='Sample department'");
  const accounts=Object.fromEntries((await q(src,'SELECT name,account_id FROM account')).map(a=>[a.name,a.account_id]));
  for(const [category,cls] of [['Fuel',classId],['Repairs',null]]) await saveRule(src.pool,{orgId:1,entityId:1,actor:'review-test',fields:{name:`Sample ${category}`,money:'out',priority:'100',mode:'auto',accountId:accounts[category],classId:cls,
    conditions:[{field:'description',op:'contains',value:'SAMPLE REFUEL'}]}});
  const item={amount_cents:-1234,description:'SAMPLE REFUEL',bank_text:'SAMPLE REFUEL'};
  const first=async db=>(await listRules(db.pool,{orgId:1,entityId:1})).find(r=>ruleFits(r,item));
  const original=await first(src),data=await saved(src);
  assert.equal(data.leftovers.length,0);
  assert.equal(data.unclassified.length,0);
  await validateCarryCounts(src.pool,data);
  const carry=join(dir,'v1e-carry.json'),dump=join(dir,'v1e.dump');
  await writeFile(carry,JSON.stringify(data));
  await runFile(PG_DUMP,['-Fc','-d',src.url,'-f',dump]);
  const receipt=await rehearse(dump);
  const cleared=await invoke('clear-books',['--carry-over',carry,'--dump',dump,'--rehearsed',receipt,'--apply'],src);
  assert.equal(cleared.code,0,cleared.stderr);
  const copied=await copy(ref,src);assert.equal(copied.code,0,copied.stderr);
  const links=await apply(src,data,'links');assert.equal(links.skipped.length,0);
  // Simulate only the scheduler's account discovery in this isolated test; no external feed is contacted.
  await q(src,"INSERT INTO ledgerline_account(org_id,entity_id,ll_account_id,display_name,kind,currency) VALUES(1,1,'00000000-0000-4000-8000-000000000021','Sample account','checking','USD')");
  const feeds1=await apply(src,data,'feeds');
  assert.ok(feeds1.skipped.some(s=>s.name==='Sample Fuel'));
  const interim=await listRules(src.pool,{orgId:1,entityId:1});
  const books=await apply(src,data,'books');assert.deepEqual(books.skipped,[]);
  const feeds2=await apply(src,data,'feeds');
  assert.deepEqual(feeds2.skipped,[]);assert.deepEqual(feeds2.decisions,[]);assert.deepEqual(feeds2.leftovers,[]);
  const after=await first(src),yardstick=await invoke('rebuild-check',[src.file,'2026-10-20']);
  assert.equal(yardstick.code,0,yardstick.stderr);
  console.log('V1E',JSON.stringify({clear:cleared.code,copy:copied.code,yardstick:yardstick.code,before:original.account_name,after:after.account_name,firstSkips:feeds1.skipped,finalReport:feeds2}));
  assert.equal(after.account_name,original.account_name,'fully controlled rebuild and instructed retry change the automatic accounting winner');
  assert.deepEqual(interim,[],'the first feeds pass must not enable the later tied rule');
});

async function rulePair() {
  const src=await makeDb({imported:true}),dst=await makeDb({imported:true});
  for(const db of [src,dst]) {
    await q(db,"UPDATE org SET ledgerline_org_id='00000000-0000-4000-8000-000000000001'");await feed(db);
  }
  const accounts=Object.fromEntries((await q(src,'SELECT name,account_id FROM account')).map(a=>[a.name,a.account_id]));
  for(const category of ['Fuel','Repairs']) await saveRule(src.pool,{orgId:1,entityId:1,actor:'tester',fields:{
    name:`Sample ${category}`,money:'out',priority:'100',mode:'auto',accountId:accounts[category],
    conditions:[{field:'description',op:'contains',value:'SAMPLE REFUEL'}]}});
  return {src,dst,data:await saved(src)};
}

test('every unresolved rule is reported and no rules in any company are restored',async()=>{
  const {dst,data}=await rulePair(),co=data.companies[0],base=co.rules[0];
  co.rules=[
    {...base,name:'Sample missing category',account:'Sample absent account'},
    {...base,name:'Sample missing class',class:'Sample absent class'},
    {...base,name:'Sample missing location',location:'Sample absent location'},
    {...base,name:'Sample missing feed',llAccountIds:['00000000-0000-4000-8000-000000000099']},
    {...base,name:'Sample missing split',splits:[{account:'Fuel',percentBp:5000},{account:'Sample absent split',percentBp:5000}]},
    {...base,name:'Sample missing payee',payee:{kind:'vendor',name:'Sample absent vendor'}},
    {...base,name:'Sample valid rule'},
  ];
  // An otherwise independent company's rules must also wait for this pass.
  await q(dst,"INSERT INTO entity(org_id,name) VALUES(1,'Sample company B')");
  await q(dst,"INSERT INTO account(org_id,entity_id,name,type) VALUES(1,2,'Fuel','expense')");
  data.companies.push({...co,name:'Sample company B',feed:null,rules:[{...base,name:'Sample other company'}]});
  const sequence=await q(dst,'SELECT last_value,is_called FROM bank_rule_rule_id_seq');
  const result=await apply(dst,data,'feeds');
  for(const r of co.rules.slice(0,6)) assert.ok(result.skipped.some(s=>s.what==='rule'&&s.name===r.name&&s.why),r.name);
  assert.equal(result.applied.filter(s=>s.what==='rule').length,0);
  assert.deepEqual(await q(dst,'SELECT * FROM bank_rule'),[]);
  assert.deepEqual(await q(dst,'SELECT last_value,is_called FROM bank_rule_rule_id_seq'),sequence,'preflight must precede any insert');
});

test('an existing later tied rule refuses completion with a precedence decision and no writes',async()=>{
  const {dst,data}=await rulePair();
  const partial=structuredClone(data);partial.companies[0].rules.shift();
  assert.deepEqual((await apply(dst,partial,'feeds')).skipped,[]);
  const before=await q(dst,'SELECT * FROM bank_rule ORDER BY priority,rule_id');
  for(let i=0;i<2;i++) {
    const result=await apply(dst,data,'feeds');
    assert.ok(result.decisions.some(d=>d.what==='rule set'&&/precedence/i.test(d.why)));
    assert.equal(result.applied.filter(a=>a.what==='rule').length,0);
    assert.deepEqual(await q(dst,'SELECT * FROM bank_rule ORDER BY priority,rule_id'),before);
  }
});

test('an existing safe prefix completes in saved precedence and reruns retain ids',async()=>{
  const {dst,data}=await rulePair();
  const partial=structuredClone(data);partial.companies[0].rules.pop();
  assert.deepEqual((await apply(dst,partial,'feeds')).skipped,[]);
  let order;
  for(let i=0;i<2;i++) {
    const result=await apply(dst,data,'feeds');
    assert.deepEqual(result.skipped,[]);assert.deepEqual(result.decisions,[]);
    const current=await q(dst,'SELECT rule_id,priority,name FROM bank_rule ORDER BY priority,rule_id');
    if(order) assert.deepEqual(current,order);
    order=current;
  }
  assert.deepEqual((await q(dst,'SELECT name FROM bank_rule ORDER BY priority,rule_id')).map(r=>r.name),data.companies[0].rules.map(r=>r.name));
});

test('readback catches changed priority and rolls back the entire rule set',async()=>{
  const {dst,data}=await rulePair();
  // Simulate a writer/database transformation after the dependency preflight.
  await q(dst,`CREATE FUNCTION sample_rule_priority() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.name='Sample Repairs' THEN NEW.priority=0; END IF; RETURN NEW; END $$`);
  await q(dst,'CREATE TRIGGER sample_rule_priority BEFORE INSERT ON bank_rule FOR EACH ROW EXECUTE FUNCTION sample_rule_priority()');
  const result=await apply(dst,data,'feeds');
  assert.ok(result.decisions.some(d=>d.what==='rule set'&&/precedence/i.test(d.why)));
  assert.equal(result.applied.filter(a=>a.what==='rule').length,0);
  assert.deepEqual(await q(dst,'SELECT * FROM bank_rule'),[]);
});

test('feeds preview includes rules even when no feed link was saved',async()=>{
  const {dst,data}=await rulePair();data.companies[0].feed=null;
  const result=await apply(dst,data,'feeds',true);
  assert.deepEqual(result.planned.filter(r=>r.what==='rule').map(r=>r.name),data.companies[0].rules.map(r=>r.name));
  assert.deepEqual(await q(dst,'SELECT * FROM bank_rule'),[]);
});
