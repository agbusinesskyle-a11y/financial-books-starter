import { PG_DUMP } from './pg-clients.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeDb,q,invoke,copy,saved,apply,feed,dir,runFile,rehearse } from './rebuild-fixture.js';
import { validateCarryCounts } from '../lib/rebuild/carry-validation.js';
import { saveRule,listRules,ruleFits } from '../lib/bankfeed/rules.js';

test('U8 tied rule precedence is business content and must survive a validated carry file',async()=>{
  const src=await makeDb({imported:true}),ref=await makeDb({imported:true});
  await q(src,"UPDATE org SET ledgerline_org_id='00000000-0000-4000-8000-000000000001'");await feed(src);
  const accounts=Object.fromEntries((await q(src,'SELECT name,account_id FROM account')).map(a=>[a.name,a.account_id]));
  for(const category of ['Fuel','Repairs']) await saveRule(src.pool,{orgId:1,entityId:1,actor:'review-test',fields:{name:`Sample ${category}`,money:'out',priority:'100',mode:'auto',accountId:accounts[category],
    conditions:[{field:'description',op:'contains',value:'SAMPLE REFUEL'}]}});
  const item={amount_cents:-1234,description:'SAMPLE REFUEL',bank_text:'SAMPLE REFUEL'};
  const first=async db=>(await listRules(db.pool,{orgId:1,entityId:1})).find(r=>ruleFits(r,item));
  const original=await first(src);assert.equal(original.account_name,'Fuel');
  const data=await saved(src);data.companies[0].rules.reverse();
  let validated=true;try{await validateCarryCounts(src.pool,data);}catch{validated=false;}
  const carry=join(dir,'u8-carry.json'),dump=join(dir,'u8.dump');await writeFile(carry,JSON.stringify(data));
  await runFile(PG_DUMP,['-Fc','-d',src.url,'-f',dump]);const receipt=await rehearse(dump);
  const clear=await invoke('clear-books',['--carry-over',carry,'--dump',dump,'--rehearsed',receipt,'--apply'],src);
  let restored=null,report=null;
  if(clear.code===0) {
    const copied=await copy(ref,src);assert.equal(copied.code,0,copied.stderr);
    await feed(src);report=await apply(src,data,'feeds');restored=await first(src);
  }
  console.log('U8',JSON.stringify({validated,clear:clear.code,clearError:clear.stderr,before:original.account_name,after:restored?.account_name,mode:restored?.mode,skipped:report?.skipped,decisions:report?.decisions,leftovers:report?.leftovers}));
  assert.ok(clear.code!==0 || restored.account_name===original.account_name,'validated reorder changed the winning automatic rule from Fuel to Repairs');
  assert.equal(validated,false);
  assert.match(clear.stderr,/rules\[0\].*content mismatch/);
  assert.equal((await first(src)).account_name,'Fuel');
});

test('rule save and fresh restore preserve priority then insertion precedence, including ties',async()=>{
  const src=await makeDb({imported:true}),dst=await makeDb({imported:true});
  for (const db of [src,dst]) {
    await q(db,"UPDATE org SET ledgerline_org_id='00000000-0000-4000-8000-000000000001'");
    await feed(db);
  }
  const accounts=Object.fromEntries((await q(src,'SELECT name,account_id FROM account')).map(a=>[a.name,a.account_id]));
  for (const [name,priority,category] of [['Sample late',200,'Fuel'],['Sample Z first',100,'Fuel'],['Sample A second',100,'Repairs']]) {
    await saveRule(src.pool,{orgId:1,entityId:1,actor:'review-test',fields:{name,money:'out',priority:String(priority),mode:'auto',accountId:accounts[category],
      conditions:[{field:'description',op:'contains',value:'SAMPLE REFUEL'}]}});
  }
  const data=await saved(src);
  assert.deepEqual(data.companies[0].rules.map(r=>r.name),['Sample Z first','Sample A second','Sample late']);
  await validateCarryCounts(src.pool,data);
  const report=await apply(dst,data,'feeds');
  assert.deepEqual(report.skipped,[]);
  const after=await listRules(dst.pool,{orgId:1,entityId:1});
  assert.deepEqual(after.map(r=>r.name),data.companies[0].rules.map(r=>r.name));
  assert.equal(after.find(r=>ruleFits(r,{amount_cents:-1234,description:'SAMPLE REFUEL',bank_text:'SAMPLE REFUEL'})).account_name,'Fuel');
});
