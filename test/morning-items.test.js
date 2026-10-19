import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb } from './harness.js';
import { mvOrg, mvReadyViewers } from './morning-fixtures.js';
import { withMorningComputation, createMorningRuntime } from '../lib/data/morning/locks.js';
import { prepareItems, putItems, pageItems, foldCurrentItems, findCurrentItem, readCoverage, canonical, itemVersion, versionFacts, RULE_VERSIONS } from '../lib/data/morning/items.js';
import { ValidationError } from '../lib/data/writes.js';

function itemTest(name,fn){test(name,async t=>{
  const db=await freshDb();t.after(()=>db.drop());const f=await mvOrg(db.pool),{owner}=await mvReadyViewers(db.pool,{...f,second:false});
  const run=work=>withMorningComputation(db.pool,{identity:owner,orgId:f.orgId,viewerKey:'owner',purpose:'detail',runtime:createMorningRuntime()},work);
  await fn({pool:db.pool,f,run});
});}
const bill=(id,open=100)=>({itemKey:`bill:1:${String(id).padStart(3,'0')}`,rule:'bill',entityId:null,version:itemVersion('bill',{open}),severity:0,due:'2026-10-01',companySort:'sample',openCents:open,dueBill:true,display:{id,openCents:open}});
async function dismiss(pool,f,rows){for(const r of rows)await pool.query("INSERT INTO morning_dismissal(org_id,viewer_key,item_key,item_version,rule_version,note) VALUES($1,'owner',$2,$3,1,'Sample note')",[f.orgId,r.itemKey,r.version]);}
itemTest('full-set folds refill pages and count before LIMIT',async({pool,f,run})=>{
  const rows=Array.from({length:120},(_,i)=>bill(i+1));await dismiss(pool,f,[...rows.slice(0,10),...rows.slice(60,70)]);
  await run(async(tx,{budget})=>{
    const store=await prepareItems(tx,{orgId:f.orgId,viewerKey:'owner',budget,availableRules:Object.keys(RULE_VERSIONS)});await putItems(tx,{store,rows,budget});
    let p=await pageItems(tx,{store});assert.equal(p.counts.bills,100);assert.equal(p.totals.bill.openCents,10000);assert.deepEqual(p.page.map(r=>r.display.id),Array.from({length:50},(_,i)=>i+11));
    p=await pageItems(tx,{store,after:p.next});assert.deepEqual(p.page.map(r=>r.display.id),Array.from({length:50},(_,i)=>i+71));assert.equal(p.next,null);
    assert.deepEqual(await foldCurrentItems(tx,{store}),{matching:20,stale:0,unavailable:0,complete:true});
    assert.equal((await findCurrentItem(tx,{store,itemKey:rows[119].itemKey})).display.id,120);
    await tx.query('DELETE FROM mv_attention WHERE item_key=$1',[rows[60].itemKey]);await putItems(tx,{store,rows:[bill(61,101)]});
    p=await pageItems(tx,{store});assert.equal(p.counts.bills,101);assert.equal(p.totals.bill.openCents,10101);
    assert.deepEqual(await foldCurrentItems(tx,{store}),{matching:19,stale:1,unavailable:0,complete:true});
    const stale=await pageItems(tx,{store,fold:'stale'});assert.equal(stale.page.length,1);assert.deepEqual(Object.keys(stale.page[0]).sort(),['dismissedAt','itemKey','note']);
    await tx.query('DELETE FROM mv_attention WHERE item_key=$1',[rows[119].itemKey]);p=await pageItems(tx,{store});assert.equal(p.counts.bills,100);assert.equal(p.totals.bill.openCents,10001);
  });
});
itemTest('failed rule is unavailable, never stale; recovery and actual payment differ',async({pool,f,run})=>{
  const b=bill(1),bank={...bill(2),itemKey:'bank:1:2',rule:'bank',units:3};await dismiss(pool,f,[b,bank]);
  const c=randomUUID(),l=randomUUID();
  await pool.query("INSERT INTO morning_snapshot_generation(org_id,viewer_key,generation_id,captured_at,as_of_date) VALUES($1,'owner',$2,'2026-10-17T12:00:00Z','2026-10-17'),($1,'owner',$3,'2026-10-17T13:00:00Z','2026-10-17')",[f.orgId,c,l]);
  await pool.query("INSERT INTO morning_visit(org_id,viewer_key,comparison_generation_id,latest_generation_id,reuse_anchor_at,latest_shown_at) VALUES($1,'owner',$2,$3,'2026-10-17T13:00:00Z','2026-10-17T13:00:00Z')",[f.orgId,c,l]);
  const visitBefore=(await pool.query('SELECT * FROM morning_visit')).rows;
  const before=(await pool.query('SELECT * FROM morning_dismissal ORDER BY item_key')).rows;
  await run(async(tx,{budget})=>{
    const store=await prepareItems(tx,{orgId:f.orgId,viewerKey:'owner',budget,availableRules:['bank'],unavailableRules:['bill']});
    await tx.query('SAVEPOINT bill_load');await assert.rejects(tx.query('SELECT 1/0'));await tx.query('ROLLBACK TO SAVEPOINT bill_load');
    await putItems(tx,{store,rows:[bank]});
    assert.deepEqual(await foldCurrentItems(tx,{store}),{matching:null,stale:null,unavailable:1,complete:false});
    assert.equal((await pageItems(tx,{store,fold:'stale'})).page.length,0);
    const all=await pageItems(tx,{store,fold:'matching'});assert.equal(all.complete,false);assert.equal(all.counts.bills,null);assert.equal(all.page.length,1);
    const banks=await pageItems(tx,{store,fold:'matching',rule:'bank'});assert.equal(banks.counts.bankLines,3);assert.equal(banks.complete,true);
    assert.equal(store.ruleAvailable('bill'),false);
  });
  assert.deepEqual((await pool.query('SELECT * FROM morning_dismissal ORDER BY item_key')).rows,before);
  assert.deepEqual((await pool.query('SELECT * FROM morning_visit')).rows,visitBefore);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM morning_snapshot_generation')).rows[0].n,2);
  for(const paid of [false,true])await run(async(tx,{budget})=>{
    const store=await prepareItems(tx,{orgId:f.orgId,viewerKey:'owner',budget,availableRules:Object.keys(RULE_VERSIONS)});await putItems(tx,{store,rows:paid?[bank]:[b,bank]});
    assert.deepEqual(await foldCurrentItems(tx,{store}),{matching:paid?1:2,stale:paid?1:0,unavailable:0,complete:true});
  });
});
itemTest('coverage survives dismissal; limits, cursors and store authority are validated',async({pool,f,run})=>{
  const row={...bill(1),rule:'tax-coverage',itemKey:'tax-coverage:1:period:2026',coverageUnknown:true};await dismiss(pool,f,[row]);
  await run(async(tx,{budget})=>{
    const store=await prepareItems(tx,{orgId:f.orgId,viewerKey:'owner',budget,availableRules:Object.keys(RULE_VERSIONS)});await putItems(tx,{store,rows:[row]});
    assert.deepEqual(await readCoverage(tx,{store}),{known:false,byKind:{'tax-coverage':1},unknownCount:1});
    assert.equal((await pageItems(tx,{store})).page.length,0);
    for(const opts of [{limit:51},{limit:0},{after:{severity:0}},{rule:'bad'},{fold:'bad'},{store:{}}])await assert.rejects(pageItems(tx,{store,...opts}),ValidationError);
  });
});
itemTest('nullable due keyset preserves full canonical order',async({f,run})=>{
  await run(async(tx,{budget})=>{
    const store=await prepareItems(tx,{orgId:f.orgId,viewerKey:'owner',budget,availableRules:Object.keys(RULE_VERSIONS)});
    await putItems(tx,{store,rows:[{...bill(1),due:null},{...bill(2),companySort:'A'},{...bill(3),companySort:'B'},{...bill(4),severity:5,due:null}]});
    let after=null;const ids=[];do{const p=await pageItems(tx,{store,limit:1,after});ids.push(p.page[0].display.id);after=p.next;}while(after);
    assert.deepEqual(ids,[2,3,1,4]);
  });
});
itemTest('stale pages count only stored stale records and have no current financial aggregates',async({pool,f,run})=>{
  await dismiss(pool,f,[bill(1),bill(2),bill(3)]);
  await run(async(tx,{budget})=>{
    const store=await prepareItems(tx,{orgId:f.orgId,viewerKey:'owner',budget,availableRules:Object.keys(RULE_VERSIONS)});
    await putItems(tx,{store,rows:[bill(1),bill(2,101),bill(4,500)]});
    const p=await pageItems(tx,{store,fold:'stale',limit:1});
    assert.equal(p.counts.stale,2);assert.equal(p.page.length,1);assert.ok(p.next);
    for(const [key,value] of Object.entries(p.counts))if(key!=='stale')assert.equal(value,null,key);
    for(const total of Object.values(p.totals))assert.equal(total.openCents,null);
    const next=await pageItems(tx,{store,fold:'stale',limit:1,after:p.next});
    assert.equal(next.counts.stale,2);assert.equal(next.page.length,1);assert.equal(next.next,null);
    store.setRuleAvailability('bill',false);
    const unknown=await pageItems(tx,{store,fold:'stale'});assert.equal(unknown.counts.stale,null);assert.equal(unknown.complete,false);assert.equal(unknown.page.length,0);
    const bank=await pageItems(tx,{store,fold:'stale',rule:'bank'});assert.equal(bank.counts.stale,0);assert.equal(bank.complete,true);
  });
});
itemTest('stale continuation preserves timestamp microseconds across page boundaries',async({pool,f,run})=>{
  const rows=Array.from({length:120},(_,i)=>bill(i+1));await dismiss(pool,f,rows);
  await pool.query("UPDATE morning_dismissal SET dismissed_at='2026-10-17T12:00:00.123456Z' WHERE org_id=$1",[f.orgId]);
  await run(async(tx,{budget})=>{
    const store=await prepareItems(tx,{orgId:f.orgId,viewerKey:'owner',budget,availableRules:Object.keys(RULE_VERSIONS)});
    let after=null;const keys=[];
    do{const p=await pageItems(tx,{store,fold:'stale',after});keys.push(...p.page.map(r=>r.itemKey));after=p.next;}while(after);
    assert.deepEqual(keys,rows.map(r=>r.itemKey));
  });
});
test('canonical cause versions ignore incidental presentation facts',()=>{
  assert.equal(canonical({z:[{b:2,a:1}],a:0}),' {"a":0,"z":[{"a":1,"b":2}]}'.trim());
  const b={rule:'bill',open:100,due:'2026-10-17',approval:'awaiting',reasons:['due','awaiting'],severity:1};
  assert.deepEqual(versionFacts(b),{open:100,due:'2026-10-17',approval:'awaiting',reasons:['awaiting','due'],severity:1});
  assert.equal(itemVersion('bill',versionFacts(b)),itemVersion('bill',versionFacts({...b,memo:'Sample changed memo',kind:'added'})));
  assert.notEqual(itemVersion('bill',versionFacts(b)),itemVersion('bill',versionFacts({...b,open:101})));
  assert.equal(versionFacts({rule:'bank',version:'a'.repeat(64)}),'a'.repeat(64));
});
